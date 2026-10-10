// Live calls as call_tasks rows. Unlike simulated calls, nothing is scheduled ahead: state events
// are appended at now() as the real call progresses (webhook tools + polling), and tick() applies
// them like any other event, so booking side effects, calendar and notifications are unchanged.
import { one, pool, q } from "../db";
import { TRANSITIONS } from "../calls/machine";
import type { CallState, Lang } from "../types";
import { dialOut, ensureLiveSchema, fetchConversation, type LiveConversation } from "./agent";

/** What the person playing the receptionist sees on screen. */
export interface LiveSheet { office: string; patient: string; openings: string[]; plans: string[]; hours: string; current: string | null }
interface LiveRow { conversation_id?: string; call_sid?: string | null; n?: number; polled?: number; answered?: boolean; done?: boolean; sheet: LiveSheet; dialed_at: number }

const POLL_MS = 1500;
const RING_LIMIT_MS = 75_000;

/** Append state events, skipping any that aren't a legal next step. Serialized per call. */
export async function pushStates(callId: string, steps: { state: CallState; payload?: Record<string, unknown>; text?: string }[]) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [callId]);
    const last = await c.query<{ to_state: CallState }>("SELECT to_state FROM call_events WHERE call_id=$1 AND to_state IS NOT NULL ORDER BY at DESC, id DESC LIMIT 1", [callId]);
    let cur: CallState = last.rows[0]?.to_state ?? "QUEUED";
    const pushed: CallState[] = [];
    for (const s of steps) {
      if (!TRANSITIONS[cur].includes(s.state)) continue;
      await c.query("INSERT INTO call_events (call_id, at, to_state, speaker, text, payload) VALUES ($1, clock_timestamp(), $2, $3, $4, $5)",
        [callId, s.state, s.text ? "system" : null, s.text ?? null, s.payload ? JSON.stringify(s.payload) : null]);
      cur = s.state;
      pushed.push(s.state);
    }
    await c.query("COMMIT");
    return { state: cur, pushed };
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

export async function currentState(callId: string): Promise<CallState> {
  const r = await one<{ to_state: CallState }>("SELECT to_state FROM call_events WHERE call_id=$1 AND to_state IS NOT NULL ORDER BY at DESC, id DESC LIMIT 1", [callId]);
  return r?.to_state ?? "QUEUED";
}

const answeredSteps = (lang: Lang) => [{ state: "DIALING" as const }, { state: "RINGING" as const }, { state: "HUMAN" as const, text: lang === "en" ? "A person answered (live)" : "Contestó una persona (en vivo)" }, { state: "NEGOTIATING" as const }];
export const markAnswered = (callId: string, lang: Lang) => pushStates(callId, answeredSteps(lang));

/** Create the task, dial, and return its id; null if the call couldn't be placed (caller falls back to a simulated call). */
export async function placeLiveCall(o: { requestId: string; providerId: string; purpose: string; appointmentId: string | null; lang: Lang; prompt: string; sheet: LiveSheet }) {
  await ensureLiveSchema();
  const live: LiveRow = { sheet: o.sheet, dialed_at: Date.now() };
  const call = await one<{ id: string }>(
    "INSERT INTO call_tasks (request_id, provider_id, purpose, scenario, started_at, appointment_id, live) VALUES ($1,$2,$3,'live',now(),$4,$5) RETURNING id",
    [o.requestId, o.providerId, o.purpose, o.appointmentId, JSON.stringify(live)]);
  const id = call!.id;
  try {
    const d = await dialOut(id, o.prompt, o.lang);
    await q("UPDATE call_tasks SET live = live || $2::jsonb WHERE id=$1", [id, JSON.stringify(d)]);
    await pushStates(id, [{ state: "DIALING", text: o.lang === "en" ? "Calling your phone (live)…" : "Llamando a tu teléfono (en vivo)…" }]);
    console.log(`[live] ${o.purpose} call ${id} → conversation ${d.conversation_id}`);
    return id;
  } catch (e) {
    console.warn("[live] dial failed, falling back to a simulated call:", (e as Error).message);
    await q("DELETE FROM call_tasks WHERE id=$1", [id]);
    return null;
  }
}

/** Advance live calls from the conversation's status and transcript. Called from tick(); throttled per call. */
export async function pollLiveCalls(requestId: string, lang: Lang) {
  const now = Date.now();
  const claimed = await q<{ id: string; live: LiveRow }>(
    `UPDATE call_tasks SET live = jsonb_set(live, '{polled}', to_jsonb($2::bigint)) WHERE request_id=$1 AND live ? 'conversation_id'
       AND NOT coalesce((live->>'done')::boolean, false) AND coalesce((live->>'polled')::bigint, 0) < $3 RETURNING id, live`,
    [requestId, now, now - POLL_MS]);
  await Promise.all(claimed.map((c) => pollOne(c.id, c.live, lang).catch((e) => console.warn("[live] poll", (e as Error).message))));
}

async function pollOne(callId: string, live: LiveRow, lang: Lang) {
  const conv: LiveConversation = await fetchConversation(live.conversation_id!);
  const said = conv.transcript.filter((t) => t.message?.trim());
  const answered = live.answered || conv.status === "in-progress" || said.some((t) => t.role === "user");
  const ended = ["processing", "done", "failed"].includes(conv.status);

  if (!answered) {
    if (ended || Date.now() - live.dialed_at > RING_LIMIT_MS) {
      await pushStates(callId, [{ state: "DIALING" }, { state: "RINGING" }, { state: "NO_ANSWER", text: lang === "en" ? "No answer" : "No contestaron" }, { state: "GAVE_UP" }]);
      await q("UPDATE call_tasks SET live = live || '{\"done\":true}'::jsonb WHERE id=$1", [callId]);
    } else await pushStates(callId, [{ state: "RINGING", text: lang === "en" ? "Ringing…" : "Sonando…" }]);
    return;
  }
  if (!live.answered) await markAnswered(callId, lang);

  // transcript lines: the agent is CitaYa, the "user" is the person playing the receptionist
  const from = live.n ?? 0;
  for (const t of said.slice(from)) {
    await q("INSERT INTO call_events (call_id, at, speaker, text) VALUES ($1, clock_timestamp(), $2, $3)", [callId, t.role === "agent" ? "agent" : "office", t.message!.trim()]);
  }
  const patch: Partial<LiveRow> = { answered: true, n: said.length };

  if (ended) {
    // close out whatever the conversation left open
    const cur = await currentState(callId);
    const tail: CallState[] = cur === "HUMAN" ? ["NEGOTIATING", "NO_FIT", "COMPLETED"]
      : cur === "NEGOTIATING" || cur === "SLOT_OFFERED" ? ["NO_FIT", "COMPLETED"] : ["COMPLETED"];
    await pushStates(callId, tail.map((state) => ({ state })));
    patch.done = true;
  }
  await q("UPDATE call_tasks SET live = live || $2::jsonb WHERE id=$1", [callId, JSON.stringify(patch)]);
}

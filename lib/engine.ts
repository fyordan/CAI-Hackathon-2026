// Orchestration: requests, calls (simulated), booking side effects, rebooking, cancellation.
// Serverless-friendly: call timelines are stored as rows; tick() lazily applies due events,
// so any request (SSE poll, page refresh) advances state consistently.
import { one, pool, q } from "./db";
import { addDays, allowedDates, daysText, formatDate, localDate, longDate, toISO, weekdayOf } from "./dates";
import { virtualNow } from "./demo";
import { detectLang, effectiveEarliest, effectiveLatest } from "./brain/rules";
import { noFitReply, runTurn, type TurnResult } from "./brain/turn";
import { generateTimeline, type Scenario, type ScenarioCtx, type Step } from "./calls/scenarios";
import { dialogueSteps, receptionistFor, voiceDialogue, writeDialogue, type DialogueFacts, type DialogueKind } from "./calls/dialogue";
import { validatePath } from "./calls/machine";
import { background } from "./background";
import { openrouterConfigured } from "./ai/openrouter";
import { elevenConfigured } from "./voice/elevenlabs";
import { buildIcs, googleConfigured, pushToGoogle, type InviteInput } from "./calendar";
import { decideRebook } from "./rebook";
import { INSURERS } from "./personas";
import { loadPersona } from "./profiles";
import { searchProviders, SHORTLIST_SIZE } from "./search";
import { emptyQuery, SPECIALTY_LABEL, type Candidate, type Lang, type Persona, type Provider, type ProviderQuery } from "./types";

type Msg = { role: "user" | "assistant" | "system"; text: string; at: string; kind?: string };
interface RequestRow { id: string; persona_id: string; query: ProviderQuery; expecting: string | null; status: string; messages: Msg[]; shortlist: Candidate[]; seed: number }

export const getRequest = (id: string) => one<RequestRow>("SELECT * FROM care_requests WHERE id = $1", [id]);
const today = async () => localDate((await virtualNow()).toISOString());

export async function createRequest(personaId: string) {
  const p = await loadPersona(personaId);
  const query: ProviderQuery = { ...emptyQuery(), insurance: p.insurance, patient_is_requester: !p.patient };
  const hello = p.lang === "en"
    ? `Hi ${p.name.split(" ")[0]}. Tell me what's going on and when you can go. I'll find offices near you and call them for you.`
    : p.patient
      ? `Hola ${p.name.split(" ")[0]}. Cuéntame qué necesita ${p.patient.name.split(" ")[0] === "Ernesto" ? "Don Ernesto" : p.patient.name} y cuándo puede ir. Busco oficinas cerca y las llamo por ustedes.`
      : `Hola ${p.name.split(" ")[0]}. Cuéntame qué te pasa y cuándo puedes ir. Busco oficinas cerca y las llamo por ti.`;
  const row = await one<{ id: string }>("INSERT INTO care_requests (persona_id, query, messages) VALUES ($1,$2,$3) RETURNING id",
    [p.id, JSON.stringify(query), JSON.stringify([{ role: "assistant", text: hello, at: new Date().toISOString() }])]);
  return row!.id;
}

export async function chatTurn(requestId: string, text: string): Promise<{ turn: TurnResult; shortlist: Candidate[]; persona: Persona }> {
  const r = await getRequest(requestId);
  if (!r) throw new Error("request not found");
  const persona = await loadPersona(r.persona_id);
  const firstUser = r.messages.find((m) => m.role === "user")?.text ?? text;
  const convLang: Lang = persona.lang === "en" || detectLang(firstUser) === "en" ? "en" : "es";
  // only "ready" if the last list actually had offices to call (a no-fit list asked a different question)
  const ready = r.status === "ready" && r.shortlist.some((c) => c.included);
  const busy = ["calling", "booked"].includes(r.status);
  const turn = await runTurn({ text, today: await today(), persona, query: r.query, expecting: r.expecting as never, convLang, history: r.messages.filter((m) => m.role !== "system"), ready });
  const shortlist = turn.action === "emergency" ? r.shortlist : await searchProviders(turn.query, persona, persona.lang === "en" ? "en" : "es");
  // nothing fits → never dial an empty list, and replace the model's reply (it can't see the
  // shortlist, so it may offer or promise calls) with one that says what to relax
  if (!busy && (turn.action === "call" || turn.action === "search") && !shortlist.some((c) => c.included)) {
    turn.action = "search";
    turn.reply = noFitReply(shortlist.map((c) => c.excluded_reason), turn.query, turn.lang);
  }
  // calls already running or booked: never start a second round from chat
  if (busy && (turn.action === "call" || turn.wantsCall)) {
    turn.action = "search";
    turn.reply = r.status === "booked"
      ? (turn.lang === "en" ? "You're already booked. Check the calls panel for the details." : "Ya tienes la cita separada. Mira el panel de llamadas para los detalles.")
      : (turn.lang === "en" ? "I'm already calling the offices. I'll let you know as soon as one confirms." : "Ya estoy llamando a las oficinas. Te aviso en cuanto una confirme.");
  }
  const now = new Date().toISOString();
  const messages = [...r.messages, { role: "user", text, at: now }, { role: "assistant", text: turn.reply, at: now, kind: turn.action }];
  await q("UPDATE care_requests SET query=$2, expecting=$3, messages=$4, shortlist=$5, status=$6 WHERE id=$1",
    [requestId, JSON.stringify(turn.query), turn.expecting, JSON.stringify(messages), JSON.stringify(shortlist),
      turn.action === "emergency" ? "emergency" : busy ? r.status : turn.action === "search" || turn.action === "call" ? "ready" : "drafting"]);
  if (turn.action === "call") await startCalls(requestId);
  return { turn, shortlist, persona };
}

// ---------- seeded randomness ----------
function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const hash = (s: string) => [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) | 0, 7);

// Marisol's demo is pinned so the stage run is identical every time.
const MARISOL_SCRIPT: Record<string, Scenario> = {
  "pod-caguas": "no_answer", "pod-hatorey": "hero", "pod-mendez": "busy_nofit", "pod-gurabo": "ivr_nofit", "pod-trujillo": "voicemail",
};

function openTime(p: Provider, date: string, q: ProviderQuery) {
  const h = p.hours.find((x) => x.weekday === weekdayOf(date));
  if (!h) return null;
  const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
  const win = q.time_windows.find((w) => toMin(w.start) < toMin(h.closes) - 30 && toMin(w.end) > toMin(h.opens) + 30);
  if (q.time_windows.length && !win) return null;
  const start = Math.max(toMin(h.opens) + 30, win ? toMin(win.start) : 0);
  const m = Math.ceil(start / 30) * 30;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** Office-side "truth" for a synthetic office: first fitting opening a few weeks out. */
function syntheticOffer(p: Provider, q: ProviderQuery, day0: string, r: () => number): string | null {
  const from = addDays(effectiveEarliest(q, day0), q.asap ? 4 + Math.floor(r() * 4) : 9 + Math.floor(r() * 10));
  const to = effectiveLatest(q) ?? addDays(day0, 90);
  const dates = allowedDates(from <= to ? from : effectiveEarliest(q, day0), to, q.days_of_week);
  for (const d of dates) { const t = openTime(p, d, q); if (t) return toISO(d, t); }
  return null;
}
function laterThanDeadline(p: Provider, q: ProviderQuery, day0: string): string {
  const after = addDays(effectiveLatest(q) ?? addDays(day0, 60), 14);
  const d = allowedDates(after, addDays(after, 30), q.days_of_week).find((x) => p.hours.some((h) => h.weekday === weekdayOf(x))) ?? after;
  return d;
}

function ctxFor(persona: Persona, query: ProviderQuery, lang: Lang): ScenarioCtx {
  return {
    lang,
    patient: persona.patient?.name ?? persona.name,
    specialty: SPECIALTY_LABEL[query.specialty!][lang].toLowerCase(),
    days: query.days_of_week.length ? daysText(query.days_of_week, lang) : "",
    insurance: query.insurance ? INSURERS[query.insurance]?.name ?? query.insurance : "",
  };
}

async function insertTimeline(callId: string, start: number, steps: ReturnType<typeof generateTimeline>) {
  const sorted = [...steps].sort((a, b) => a.t - b.t);
  for (const s of sorted) {
    await q("INSERT INTO call_events (call_id, at, to_state, speaker, text, payload) VALUES ($1,$2,$3,$4,$5,$6)",
      [callId, new Date(start + s.t * 1000).toISOString(), s.state ?? null, s.speaker ?? null, s.text ?? null, s.payload ? JSON.stringify(s.payload) : null]);
  }
}

async function createCall(requestId: string, providerId: string, purpose: string, scenario: Scenario, steps: ReturnType<typeof generateTimeline>, startOffsetSec = 0, appointmentId: string | null = null) {
  const start = Date.now() + startOffsetSec * 1000;
  const audio = steps.find((s) => s.payload?.audio)?.payload?.audio as string | undefined;
  const call = await one<{ id: string }>(
    "INSERT INTO call_tasks (request_id, provider_id, purpose, scenario, started_at, audio, appointment_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id",
    [requestId, providerId, purpose, scenario, new Date(start).toISOString(), audio ?? null, appointmentId]);
  await insertTimeline(call!.id, start, steps);
  return call!.id;
}

// ---------- unscripted calls: header now, conversation written + voiced in the background ----------
const DIALOGUE_KIND: Partial<Record<Scenario, DialogueKind>> = { success: "book", busy_nofit: "nofit", ivr_nofit: "nofit", rebook: "rebook", cancel: "cancel" };

function factsFor(persona: Persona, query: ProviderQuery, provider: { id: string; name: string }, lang: Lang, sc: ScenarioCtx): DialogueFacts {
  const tw = query.time_windows.map((w) => `${w.start}-${w.end}`).join(" o ");
  const latest = effectiveLatest(query);
  return {
    lang, office: provider.name, receptionist: receptionistFor(hash(provider.id)),
    patient: sc.patient, caller_relation: persona.patient ? `${persona.name}, who is the patient's family (the patient is their ${persona.patient.relation})` : null,
    specialty: sc.specialty, reason: null, notes: query.notes ?? [], days: sc.days, timeText: tw || null,
    deadlineText: query.asap ? (lang === "en" ? "as soon as possible" : "lo antes posible") : latest ? `${query.deadline_label ?? ""} (${lang === "en" ? "no later than" : "a más tardar"} ${formatDate(latest, lang)})`.trim() : null,
    insurance: sc.insurance, offerText: sc.offerText, laterText: sc.laterText, currentText: sc.currentText,
  };
}

function wantsAudio(kind: DialogueKind) {
  const mode = process.env.CALL_AUDIO || "featured"; // featured | all | off  (free ElevenLabs tier: 10k chars/month)
  return elevenConfigured() && (mode === "all" || (mode === "featured" && kind !== "nofit"));
}

async function createLiveCall(requestId: string, provider: { id: string; name: string }, purpose: string, scenario: Scenario, sc: ScenarioCtx, facts: DialogueFacts, startOffsetSec = 0, appointmentId: string | null = null) {
  const template = generateTimeline(scenario, sc);
  const kind = DIALOGUE_KIND[scenario];
  if (!kind || !openrouterConfigured()) return createCall(requestId, provider.id, purpose, scenario, template, startOffsetSec, appointmentId);
  const tHuman = template.find((x) => x.state === "HUMAN")!.t;
  // keep the phone "ringing" until the conversation is ready; pickup is inserted with it
  const header = template.filter((x) => x.t < tHuman && !(x.speaker === "agent" || (x.speaker === "office" && x.state !== "IVR")));
  const rest = template.filter((x) => !header.includes(x));
  const callId = await createCall(requestId, provider.id, purpose, scenario, header, startOffsetSec, appointmentId);
  const start = Date.now() + startOffsetSec * 1000;
  const effect = (template.find((x) => x.payload?.effect && x.payload.effect !== "waitlist")?.payload ?? {}) as Record<string, unknown>;
  background(`call:${callId}`, async () => {
    let steps: Step[] | null = null;
    const lines = await writeDialogue(kind, facts).catch(() => null);
    if (lines) {
      let voiced: Awaited<ReturnType<typeof voiceDialogue>> | null = null;
      if (wantsAudio(kind)) voiced = await voiceDialogue(lines, facts).catch((e) => { console.warn("[call audio] failed", e.message); return null; });
      const t0 = Math.max(tHuman + 0.4, (Date.now() - start) / 1000 + 0.8);
      const d = dialogueSteps(lines, t0, effect, voiced?.timings);
      const pickup: Step = { t: t0 - 0.3, state: "HUMAN", speaker: "system", text: facts.lang === "en" ? "A person answered" : "Contestó una persona" };
      steps = [pickup, ...d.steps, { t: d.end + 0.3, state: "COMPLETED" }];
      if (voiced) {
        steps.unshift({ t: t0, payload: { audio: voiced.src, audio_start: true } });
        await q("UPDATE call_tasks SET audio=$2 WHERE id=$1", [callId, voiced.src]);
      }
      try { validatePath([...header, ...steps].filter((x) => x.state).map((x) => x.state!)); } catch (e) { console.warn("[dialogue] invalid path", (e as Error).message); steps = null; }
    }
    if (!steps) {
      // template fallback, shifted so nothing lands in the past
      const shift = Math.max(0, (Date.now() - start) / 1000 + 0.5 - (rest[0]?.t ?? 0));
      steps = rest.map((x) => ({ ...x, t: x.t + shift }));
    }
    await insertTimeline(callId, start, steps);
  });
  return callId;
}

export async function startCalls(requestId: string) {
  const r = await getRequest(requestId);
  if (!r) throw new Error("request not found");
  const existing = await one("SELECT id FROM call_tasks WHERE request_id=$1 AND purpose='book' LIMIT 1", [requestId]);
  if (existing) return;
  const persona = await loadPersona(r.persona_id);
  const lang: Lang = persona.lang;
  const day0 = await today();
  const list = r.shortlist.filter((c) => c.included).slice(0, SHORTLIST_SIZE);
  if (!list.length) throw new Error("empty shortlist");
  const ctx = ctxFor(persona, r.query, lang);
  const pinned = persona.id === "marisol" && list.some((c) => MARISOL_SCRIPT[c.id]);
  // generic: one office ends up offering a fitting slot (highest-ranked with a decent answer rate)
  const successId = (list.find((c) => c.answer_rate >= 0.6) ?? list[0]).id;
  const pool: Scenario[] = ["no_answer", "busy_nofit", "ivr_nofit", "voicemail"];
  let i = 0;
  for (const c of list) {
    const pr = rng(r.seed + hash(c.id));
    let scenario: Scenario = pinned ? MARISOL_SCRIPT[c.id] ?? "no_answer" : c.id === successId ? "success" : pool[Math.floor(pr() * pool.length)];
    const sc: ScenarioCtx = { ...ctx };
    if (scenario === "hero") {
      const slot = await one<{ starts_at: Date }>("SELECT starts_at FROM provider_slots WHERE provider_id=$1 AND status='open' ORDER BY starts_at LIMIT 1", [c.id]);
      sc.offerISO = slot ? new Date(slot.starts_at).toISOString() : toISO("2026-11-19", "10:00");
    } else if (scenario === "success") {
      const offer = syntheticOffer(c, r.query, day0, pr);
      if (!offer) scenario = "ivr_nofit";
      else { sc.offerISO = offer; sc.offerText = longDate(offer, lang); }
    }
    if (scenario === "busy_nofit" || scenario === "ivr_nofit") sc.laterText = longDate(laterThanDeadline(c, r.query, day0), lang, false);
    if (scenario === "hero") await createCall(requestId, c.id, "book", scenario, generateTimeline(scenario, sc), i * 0.35);
    else await createLiveCall(requestId, c, "book", scenario, sc, factsFor(persona, r.query, c, lang, sc), i * 0.35);
    i++;
  }
  await q("UPDATE care_requests SET status='calling' WHERE id=$1", [requestId]);
}

// ---------- applying due events ----------
export async function tick(requestId: string) {
  const due = await q<{ id: string }>(
    `SELECT e.id FROM call_events e JOIN call_tasks t ON t.id = e.call_id
     WHERE t.request_id = $1 AND e.applied = false AND e.at <= now() ORDER BY e.at, e.id`, [requestId]);
  for (const d of due) {
    const ev = await one<{ id: string; call_id: string; to_state: string | null; payload: Record<string, unknown> | null }>(
      "UPDATE call_events SET applied = true WHERE id = $1 AND applied = false RETURNING id, call_id, to_state, payload", [d.id]);
    if (!ev) continue; // another poller claimed it
    if (ev.to_state) await q("UPDATE call_tasks SET state=$2, attempt = attempt + CASE WHEN $2='DIALING' THEN 1 ELSE 0 END WHERE id=$1", [ev.call_id, ev.to_state]);
    const effect = ev.payload?.effect as string | undefined;
    if (effect) await applyEffect(requestId, ev.call_id, effect, ev.payload!);
  }
  const open = await one<{ n: string }>("SELECT count(*) n FROM call_tasks WHERE request_id=$1 AND state NOT IN ('COMPLETED','GAVE_UP')", [requestId]);
  if (Number(open?.n) === 0) {
    await q("UPDATE care_requests SET status = CASE WHEN status='calling' THEN 'exhausted' ELSE status END WHERE id=$1", [requestId]);
  }
}

async function inviteFor(apptId: string): Promise<InviteInput & { delivery: string }> {
  const a = await one<{ id: string; starts_at: Date; calendar_seq: number; status: string; name: string; address: string; phone: string; persona_id: string; specialty: string }>(
    `SELECT a.*, p.name, p.address, p.phone, p.specialty, r.persona_id FROM appointments a JOIN providers p ON p.id=a.provider_id JOIN care_requests r ON r.id=a.request_id WHERE a.id=$1`, [apptId]);
  const persona = await loadPersona(a!.persona_id);
  const who = persona.patient?.name ?? persona.name;
  const spec = SPECIALTY_LABEL[a!.specialty as keyof typeof SPECIALTY_LABEL].es;
  const inv: InviteInput = {
    uid: `${a!.id}@citaya.demo`, title: `Cita de ${spec.toLowerCase()} · ${a!.name}`, location: a!.address,
    description: `Paciente: ${who}\nOficina: ${a!.name} (${a!.phone})\nReservada por CitaYa (demo). Llegue 15 minutos antes con su tarjeta del plan.`,
    startsAt: new Date(a!.starts_at).toISOString(), minutes: 30, attendee: persona.email, sequence: a!.calendar_seq,
    status: a!.status === "cancelled" ? "CANCELLED" : "CONFIRMED",
  };
  const delivery = googleConfigured() ? await pushToGoogle(inv) : "ics";
  return { ...inv, delivery };
}

async function writeCalendar(apptId: string) {
  const inv = await inviteFor(apptId);
  const end = new Date(new Date(inv.startsAt).getTime() + inv.minutes * 60_000).toISOString();
  const existing = await one("SELECT id FROM calendar_events WHERE appointment_id=$1", [apptId]);
  if (existing) {
    await q("UPDATE calendar_events SET starts_at=$2, ends_at=$3, status=$4, sequence=$5, delivery=$6, updated_at=now() WHERE appointment_id=$1",
      [apptId, inv.startsAt, end, inv.status, inv.sequence, inv.delivery]);
  } else {
    await q("INSERT INTO calendar_events (appointment_id, uid, attendee, title, location, starts_at, ends_at, status, sequence, delivery) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
      [apptId, inv.uid, inv.attendee, inv.title, inv.location, inv.startsAt, end, inv.status, inv.sequence, inv.delivery]);
  }
}

export async function icsFor(apptId: string) {
  return buildIcs(await inviteFor(apptId));
}

async function notify(requestId: string, kind: string, text: string, payload: Record<string, unknown> = {}) {
  await q("INSERT INTO notifications (request_id, kind, text, payload) VALUES ($1,$2,$3,$4)", [requestId, kind, text, JSON.stringify(payload)]);
}

async function applyEffect(requestId: string, callId: string, effect: string, payload: Record<string, unknown>) {
  const call = await one<{ provider_id: string; appointment_id: string | null }>("SELECT provider_id, appointment_id FROM call_tasks WHERE id=$1", [callId]);
  const r = await getRequest(requestId);
  const lang: Lang = (await loadPersona(r!.persona_id)).lang;
  if (effect === "book") {
    const startsAt = payload.starts_at as string;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const slot = await client.query(
        `INSERT INTO provider_slots (provider_id, starts_at, status) VALUES ($1,$2,'ours')
         ON CONFLICT (provider_id, starts_at) DO UPDATE SET status='ours' RETURNING id`, [call!.provider_id, startsAt]);
      const appt = await client.query(
        "INSERT INTO appointments (request_id, provider_id, slot_id, starts_at, status) VALUES ($1,$2,$3,$4,'booked') ON CONFLICT DO NOTHING RETURNING id",
        [requestId, call!.provider_id, slot.rows[0].id, startsAt]);
      if (!appt.rows.length) { await client.query("ROLLBACK"); return; } // someone already booked this request
      await client.query("INSERT INTO watchers (appointment_id) VALUES ($1)", [appt.rows[0].id]);
      await client.query("UPDATE call_tasks SET appointment_id=$2 WHERE id=$1", [callId, appt.rows[0].id]);
      await client.query("UPDATE care_requests SET status='booked' WHERE id=$1", [requestId]);
      await client.query("COMMIT");
      await writeCalendar(appt.rows[0].id);
      await notify(requestId, "booked", lang === "en" ? `Booked ${longDate(startsAt, "en")}. Invite sent.` : `Cita confirmada ${longDate(startsAt, "es")}. Invitación enviada.`, { appointment_id: appt.rows[0].id });
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  } else if (effect === "rebook") {
    const a = await one<{ id: string; starts_at: Date; slot_id: string }>("SELECT * FROM appointments WHERE id=$1", [call!.appointment_id]);
    const startsAt = payload.starts_at as string;
    const slot = await one<{ id: string }>(
      `INSERT INTO provider_slots (provider_id, starts_at, status) VALUES ($1,$2,'ours') ON CONFLICT (provider_id, starts_at) DO UPDATE SET status='ours' RETURNING id`, [call!.provider_id, startsAt]);
    // book-then-release: the old slot is only released after the new one is ours
    await q("UPDATE appointments SET previous_starts_at = starts_at, starts_at=$2, slot_id=$3, calendar_seq = calendar_seq + 1 WHERE id=$1", [a!.id, startsAt, slot!.id]);
    await q("UPDATE provider_slots SET status='open', release_at=NULL WHERE id=$1", [a!.slot_id]);
    await writeCalendar(a!.id);
    await notify(requestId, "rebooked",
      lang === "en" ? `Moved earlier: ${longDate(new Date(a!.starts_at).toISOString(), "en")} → ${longDate(startsAt, "en")}. Calendar updated.`
        : `Te moví a una cita más temprano: ${longDate(new Date(a!.starts_at).toISOString(), "es")} → ${longDate(startsAt, "es")}. Calendario actualizado.`,
      { appointment_id: a!.id, from: a!.starts_at, to: startsAt });
  } else if (effect === "cancel") {
    const a = await one<{ id: string; slot_id: string; starts_at: Date }>("SELECT * FROM appointments WHERE id=$1", [call!.appointment_id]);
    await q("UPDATE appointments SET status='cancelled', calendar_seq = calendar_seq + 1 WHERE id=$1", [a!.id]);
    await q("UPDATE provider_slots SET status='open', release_at=NULL WHERE id=$1", [a!.slot_id]);
    await q("UPDATE watchers SET active=false WHERE appointment_id=$1", [a!.id]);
    await q("UPDATE care_requests SET status='cancelled' WHERE id=$1", [requestId]);
    await writeCalendar(a!.id);
    await notify(requestId, "cancelled", lang === "en" ? "Appointment cancelled with the office. No no-show, and the slot went back to their waitlist." : "Cita cancelada con la oficina. No quedas como no-show y el espacio vuelve a su lista de espera.", { appointment_id: a!.id });
  }
}

// ---------- background rebooking scan ----------
export async function rebookScan(requestId: string) {
  const r = await getRequest(requestId);
  const appt = await one<{ id: string; provider_id: string; starts_at: Date }>("SELECT a.* FROM appointments a JOIN watchers w ON w.appointment_id=a.id WHERE a.request_id=$1 AND a.status='booked' AND w.active", [requestId]);
  if (!r || !appt) return { action: "none", reason: "no_active_watch" };
  const persona = await loadPersona(r.persona_id);
  const lang = persona.lang;
  const now = await virtualNow();
  // offices release cancelled appointments over time (seeded "truth"; the agent finds them by calling)
  await q("UPDATE provider_slots SET status='open', release_at=NULL WHERE status='booked' AND release_at IS NOT NULL AND release_at <= $1", [now.toISOString()]);
  const waitlisted = await q<{ provider_id: string }>("SELECT DISTINCT provider_id FROM call_tasks t WHERE t.request_id=$1 AND EXISTS (SELECT 1 FROM call_events e WHERE e.call_id=t.id AND e.to_state='WAITLISTED')", [requestId]);
  const providers = [appt.provider_id, ...waitlisted.map((w) => w.provider_id)];
  const slots = await q<{ provider_id: string; starts_at: Date }>("SELECT * FROM provider_slots WHERE status='open' AND provider_id = ANY($1) ORDER BY starts_at", [providers]);
  const current = new Date(appt.starts_at).toISOString();
  for (const s of slots) {
    const iso = new Date(s.starts_at).toISOString();
    const d = decideRebook(current, iso, r.query, now);
    if (d.action === "skip") continue;
    if (d.action === "ask") { await notify(requestId, "ask_rebook", `¿La movemos a ${longDate(iso, lang)}?`); return d; }
    const ctx = ctxFor(persona, r.query, lang);
    const hero = persona.id === "marisol" && s.provider_id === "pod-hatorey";
    const scenario: Scenario = hero ? "rebook_hero" : "rebook";
    const rsc: ScenarioCtx = { ...ctx, offerISO: iso, offerText: longDate(iso, lang), currentText: longDate(current, lang) };
    const prov = await one<{ id: string; name: string }>("SELECT id, name FROM providers WHERE id=$1", [s.provider_id]);
    if (hero) await createCall(requestId, s.provider_id, "rebook", scenario, generateTimeline(scenario, rsc), 0.5, appt.id);
    else await createLiveCall(requestId, prov!, "rebook", scenario, rsc, factsFor(persona, r.query, prov!, lang, rsc), 0.5, appt.id);
    await notify(requestId, "scan", lang === "en" ? "Background check found an earlier opening. Calling to move you." : "La revisión automática encontró un espacio más temprano. Llamando para moverte.");
    return { action: "rebook", reason: d.reason, slot: iso };
  }
  await notify(requestId, "scan", lang === "en" ? "Checked again: no earlier openings that fit yet." : "Revisé otra vez: todavía no hay nada más temprano que te funcione.");
  return { action: "none", reason: "no_better_slot" };
}

export async function cancelAppointment(requestId: string) {
  const r = await getRequest(requestId);
  const appt = await one<{ id: string; provider_id: string; starts_at: Date }>("SELECT * FROM appointments WHERE request_id=$1 AND status='booked'", [requestId]);
  if (!r || !appt) throw new Error("no booked appointment");
  const pending = await one("SELECT id FROM call_tasks WHERE appointment_id=$1 AND purpose='cancel' AND state NOT IN ('COMPLETED','GAVE_UP')", [appt.id]);
  if (pending) return; // idempotent
  const persona = await loadPersona(r.persona_id);
  const iso = new Date(appt.starts_at).toISOString();
  // the pre-rendered audio says "jueves 29 de octubre", so only use it when that is the date being cancelled
  const hero = persona.id === "marisol" && appt.provider_id === "pod-hatorey" && localDate(iso) === "2026-10-29";
  const scenario: Scenario = hero ? "cancel_hero" : "cancel";
  const csc: ScenarioCtx = { ...ctxFor(persona, r.query, persona.lang), currentText: longDate(iso, persona.lang) };
  const prov = await one<{ id: string; name: string }>("SELECT id, name FROM providers WHERE id=$1", [appt.provider_id]);
  if (hero) await createCall(requestId, appt.provider_id, "cancel", scenario, generateTimeline(scenario, csc), 0.3, appt.id);
  else await createLiveCall(requestId, prov!, "cancel", scenario, csc, factsFor(persona, r.query, prov!, persona.lang, csc), 0.3, appt.id);
}

// ---------- snapshot for the UI ----------
export async function snapshot(requestId: string) {
  const r = await getRequest(requestId);
  if (!r) return null;
  const tasks = await q(`SELECT t.id, t.provider_id, p.name AS provider_name, p.phone, t.purpose, t.scenario, t.state, t.attempt, t.started_at, t.audio,
      (SELECT e.at FROM call_events e WHERE e.call_id=t.id AND e.payload ? 'audio' LIMIT 1) AS audio_at
    FROM call_tasks t JOIN providers p ON p.id=t.provider_id WHERE t.request_id=$1 ORDER BY t.started_at`, [requestId]);
  const events = await q(`SELECT e.id, e.call_id, e.at, e.to_state, e.speaker, e.text, e.payload FROM call_events e JOIN call_tasks t ON t.id=e.call_id
    WHERE t.request_id=$1 AND e.applied ORDER BY e.at, e.id`, [requestId]);
  const appointment = await one(`SELECT a.*, p.name AS provider_name, p.address, p.phone FROM appointments a JOIN providers p ON p.id=a.provider_id
    WHERE a.request_id=$1 ORDER BY (a.status='booked') DESC, a.created_at DESC LIMIT 1`, [requestId]);
  const calendar = appointment ? await one("SELECT * FROM calendar_events WHERE appointment_id=$1", [appointment.id]) : null;
  const notifications = await q("SELECT * FROM notifications WHERE request_id=$1 ORDER BY id", [requestId]);
  const vnow = await virtualNow();
  return { request: { id: r.id, persona_id: r.persona_id, query: r.query, status: r.status, messages: r.messages, shortlist: r.shortlist, expecting: r.expecting },
    tasks, events, appointment, calendar, notifications, virtual_now: vnow.toISOString(), calendar_mode: googleConfigured() ? "google" : "ics" };
}

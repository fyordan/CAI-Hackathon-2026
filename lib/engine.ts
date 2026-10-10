// Orchestration: requests, calls (simulated), booking side effects, rebooking, cancellation.
// Serverless-friendly: call timelines are stored as rows; tick() lazily applies due events,
// so any request (SSE poll, page refresh) advances state consistently.
import { one, pool, q } from "./db";
import { addDays, allowedDates, daysText, formatDate, localDate, longDate, toISO, weekdayOf } from "./dates";
import { virtualNow } from "./demo";
import { detectLang, effectiveEarliest, effectiveLatest } from "./brain/rules";
import { noFitReply, runTurn, type TurnResult } from "./brain/turn";
import { generateTimeline, type Scenario, type ScenarioCtx, type Step } from "./calls/scenarios";
import { dialogueSteps, receptionistFor, voiceDialogue, writeDialogue, type DialogueFacts, type DialogueKind, type GenLine } from "./calls/dialogue";
import { runConversation, type CallBrief, type CallKind, type Opening } from "./calls/conversation";
import { validatePath } from "./calls/machine";
import { background } from "./background";
import { openrouterConfigured } from "./ai/openrouter";
import { elevenConfigured } from "./voice/elevenlabs";
import { buildIcs, googleConfigured, pushToGoogle, type InviteInput } from "./calendar";
import { decideRebook, slotSatisfies } from "./rebook";
import { hoursText } from "@/components/format";
import { INSURERS } from "./personas";
import { loadPersona } from "./profiles";
import { searchProviders, SHORTLIST_SIZE } from "./search";
import { ensureLiveSchema, liveSettings, livePrompt } from "./live/agent";
import { markAnswered, placeLiveCall, pollLiveCalls, pushStates } from "./live/calls";
import { sendWhatsApp } from "./live/twilio";
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

// ---------- office calendars for AI-to-AI calls ----------
type Brief = Omit<CallBrief, "kind" | "facts">;

/** The agent's calendar check: null when a slot works for the patient, else why not (read by the agent model). */
function checker(query: ProviderQuery, day0: string, now: Date, current?: string) {
  const far = query.asap && !effectiveLatest(query) ? addDays(day0, 30) : null;
  return (iso: string): string | null => {
    if (current && new Date(iso) >= new Date(current)) return "it is not earlier than the current appointment";
    const bad = slotSatisfies(iso, query, now);
    if (bad === "day") return `the patient can only go ${daysText(query.days_of_week, "en")}`;
    if (bad === "deadline") return `it is after the patient's deadline (${formatDate(effectiveLatest(query)!, "en")})`;
    if (bad === "time") return `it is outside the patient's hours (${query.time_windows.map((w) => `${w.start}-${w.end}`).join(" or ")})`;
    if (bad) return bad === "notice" ? "it is too soon to make it" : "the office is closed that day";
    if (far && localDate(iso) > far) return "it is too far out for 'as soon as possible'";
    return null;
  };
}

function briefFor(p: Provider, lang: Lang, isos: string[], check: (iso: string) => string | null): Brief {
  const openings: Opening[] = [...new Set(isos)].sort().map((iso, i) => ({ id: `O${i + 1}`, iso, text: longDate(iso, lang) }));
  return { openings, hours: hoursText(p.hours, lang), plans: p.insurers.map((i) => INSURERS[i]?.name ?? i), check };
}

/** Office hours + 1h on a date, or null when closed. */
function slotOn(p: Provider, date: string) {
  const h = p.hours.find((x) => x.weekday === weekdayOf(date));
  if (!h) return null;
  const m = Number(h.opens.slice(0, 2)) * 60 + Number(h.opens.slice(3)) + 60;
  return toISO(date, `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`);
}

/** An earlier opening that breaks one of the patient's constraints, so the agent has something to turn down. */
function distractor(p: Provider, day0: string, offer: string, check: (iso: string) => string | null) {
  for (let d = addDays(day0, 3); d < localDate(offer); d = addDays(d, 1)) {
    const iso = slotOn(p, d);
    if (iso && check(iso) && !/too soon|closed/.test(check(iso)!)) return iso;
  }
  return null;
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

// ---------- answered calls: header now, AI-to-AI conversation + voice in the background ----------
const DIALOGUE_KIND: Partial<Record<Scenario, DialogueKind>> = { success: "book", busy_nofit: "nofit", ivr_nofit: "nofit", rebook: "rebook", cancel: "cancel" };

function factsFor(persona: Persona, query: ProviderQuery, provider: { id: string; name: string }, lang: Lang, sc: ScenarioCtx): DialogueFacts {
  const tw = query.time_windows.map((w) => `${w.start}-${w.end}`).join(" o ");
  const latest = effectiveLatest(query);
  return {
    lang, office: provider.name, receptionist: receptionistFor(hash(provider.id)),
    patient: sc.patient, caller_relation: persona.patient ? `${persona.name}, who is the patient's family (the patient is their ${persona.patient.relation})` : null,
    specialty: sc.specialty, reason: null, notes: query.notes ?? [], days: sc.days, timeText: tw || null,
    // the exact last day, computed here (the models get the weekday arithmetic wrong)
    deadlineText: query.asap ? (lang === "en" ? "as soon as possible" : "lo antes posible") : latest ? `${query.deadline_label ? `${query.deadline_label}: ` : ""}${lang === "en" ? "the last day that works is" : "el último día que le sirve es"} ${longDate(latest, lang, false)}` : null,
    insurance: sc.insurance, offerText: sc.offerText, laterText: sc.laterText, currentText: sc.currentText,
  };
}

function wantsAudio(kind: DialogueKind) {
  const mode = process.env.CALL_AUDIO || "featured"; // featured | all | off  (free ElevenLabs tier: 10k chars/month)
  return elevenConfigured() && (mode === "all" || (mode === "featured" && kind !== "nofit"));
}

async function createLiveCall(requestId: string, provider: { id: string; name: string }, purpose: string, scenario: Scenario, sc: ScenarioCtx, facts: DialogueFacts, startOffsetSec = 0, appointmentId: string | null = null, brief?: Brief) {
  const template = generateTimeline(scenario, sc);
  const kind = DIALOGUE_KIND[scenario];
  if (!kind || !openrouterConfigured()) return createCall(requestId, provider.id, purpose, scenario, template, startOffsetSec, appointmentId);
  const tHuman = template.find((x) => x.state === "HUMAN")!.t;
  // keep the phone "ringing" until the conversation is ready; pickup is inserted with it
  const header = template.filter((x) => x.t < tHuman && !(x.speaker === "agent" || (x.speaker === "office" && x.state !== "IVR")));
  const rest = template.filter((x) => !header.includes(x));
  const callId = await createCall(requestId, provider.id, purpose, scenario, header, startOffsetSec, appointmentId);
  const start = Date.now() + startOffsetSec * 1000;
  let effect = (template.find((x) => x.payload?.effect && x.payload.effect !== "waitlist")?.payload ?? {}) as Record<string, unknown>;
  background(`call:${callId}`, async () => {
    let steps: Step[] | null = null;
    let lines: GenLine[] | null = null;
    let voiceKind: DialogueKind = kind;
    if (brief) {
      const conv = await runConversation({ ...brief, kind: purpose as CallKind, facts }).catch((e) => { console.warn("[conversation] failed", (e as Error).message); return null; });
      if (conv) {
        lines = conv.lines;
        if (conv.outcome === "booked") effect = { effect: purpose === "rebook" ? "rebook" : "book", starts_at: conv.startsAt };
        voiceKind = conv.outcome === "booked" ? (purpose === "rebook" ? "rebook" : "book") : conv.outcome === "cancelled" ? "cancel" : "nofit";
      }
    }
    if (!lines) lines = await writeDialogue(kind, facts).catch(() => null);
    if (lines) {
      let voiced: Awaited<ReturnType<typeof voiceDialogue>> | null = null;
      if (wantsAudio(voiceKind)) voiced = await voiceDialogue(lines, facts).catch((e) => { console.warn("[call audio] failed", e.message); return null; });
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

/** Enough to redo a live call as a simulated one (the brief's check is rebuilt from the request). */
interface Fallback { scenario: Scenario; sc: ScenarioCtx; isos: string[] }

/** With live mode on, place this call on a real phone instead; null means "simulate it as usual". */
async function tryLiveCall(requestId: string, provider: { id: string; name: string }, purpose: CallKind, appointmentId: string | null, facts: DialogueFacts, brief: Brief, fallback: Fallback) {
  if (!(await liveSettings()).calls) return null;
  const day0 = await today();
  return placeLiveCall({
    requestId, providerId: provider.id, purpose, appointmentId, lang: facts.lang,
    prompt: livePrompt({ kind: purpose, facts }, `${longDate(day0, "en", false)}, ${day0.slice(0, 4)}`),
    sheet: { office: provider.name, patient: facts.patient, openings: brief.openings.map((o) => o.text), plans: brief.plans, hours: brief.hours, current: facts.currentText ?? null },
    fallback,
  });
}

/** A live call failed or went unanswered: run the same office as a simulated call. */
async function simulateInstead(callId: string, fb: unknown) {
  const f = fb as Fallback | undefined;
  const t = await one<{ request_id: string; provider_id: string; purpose: string; appointment_id: string | null }>("SELECT request_id, provider_id, purpose, appointment_id FROM call_tasks WHERE id=$1", [callId]);
  if (!t || !f) return;
  const r = await getRequest(t.request_id);
  const persona = await loadPersona(r!.persona_id);
  const prov = await providerRow(t.provider_id);
  const now = await virtualNow();
  const appt = t.appointment_id ? await one<{ starts_at: Date }>("SELECT starts_at FROM appointments WHERE id=$1", [t.appointment_id]) : null;
  const check = t.purpose === "cancel" ? () => null : checker(r!.query, localDate(now.toISOString()), now, t.purpose === "rebook" && appt ? new Date(appt.starts_at).toISOString() : undefined);
  await createLiveCall(t.request_id, prov, t.purpose, f.scenario, f.sc, factsFor(persona, r!.query, prov, persona.lang, f.sc), 0.5, t.appointment_id, briefFor(prov, persona.lang, f.isos, check));
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
  const check = checker(r.query, day0, await virtualNow());
  // generic: one office ends up offering a fitting slot (highest-ranked with a decent answer rate)
  const successId = (list.find((c) => c.answer_rate >= 0.6) ?? list[0]).id;
  const pool: Scenario[] = ["no_answer", "busy_nofit", "ivr_nofit", "voicemail"];
  let i = 0;
  for (const c of list) {
    const pr = rng(r.seed + hash(c.id));
    let scenario: Scenario = c.id === successId ? "success" : pool[Math.floor(pr() * pool.length)];
    const sc: ScenarioCtx = { ...ctx };
    let isos: string[] = [];
    if (scenario === "success") {
      // a real open slot at this office if one fits (seeded demo data), else a synthetic one
      const open = await q<{ starts_at: Date }>("SELECT starts_at FROM provider_slots WHERE provider_id=$1 AND status='open' ORDER BY starts_at", [c.id]);
      const offer = open.map((x) => new Date(x.starts_at).toISOString()).find((iso) => !check(iso)) ?? syntheticOffer(c, r.query, day0, pr);
      if (!offer) scenario = "ivr_nofit";
      else { sc.offerISO = offer; sc.offerText = longDate(offer, lang); isos = [offer, distractor(c, day0, offer, check)].filter((x): x is string => !!x); }
    }
    if (scenario === "busy_nofit" || scenario === "ivr_nofit") {
      const later = laterThanDeadline(c, r.query, day0);
      sc.laterText = longDate(later, lang, false);
      // only openings that break a constraint, so this office can't book
      isos = [slotOn(c, later), slotOn(c, addDays(later, 7))].filter((x): x is string => !!x && !!check(x));
    }
    const facts = factsFor(persona, r.query, c, lang, sc), brief = briefFor(c, lang, isos, check);
    // live mode: the office that would book is a real call; the rest stay simulated
    if (!(scenario === "success" && await tryLiveCall(requestId, c, "book", null, facts, brief, { scenario, sc, isos }))) await createLiveCall(requestId, c, "book", scenario, sc, facts, i * 0.35, null, brief);
    i++;
  }
  await q("UPDATE care_requests SET status='calling' WHERE id=$1", [requestId]);
}

// ---------- applying due events ----------
export async function tick(requestId: string) {
  await ensureLiveSchema();
  const live = await one("SELECT 1 FROM call_tasks WHERE request_id=$1 AND live ? 'conversation_id' AND NOT coalesce((live->>'done')::boolean, false) LIMIT 1", [requestId]);
  if (live) {
    const r = await getRequest(requestId);
    await pollLiveCalls(requestId, (await loadPersona(r!.persona_id)).lang, simulateInstead);
  }
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
  if (["booked", "rebooked", "cancelled"].includes(kind) && (await liveSettings()).whatsapp) {
    // never let a message failure break the booking itself
    await whatsappText(requestId, kind, payload).then(sendWhatsApp).catch((e) => console.warn("[whatsapp]", (e as Error).message));
  }
}

const appUrl = () => process.env.APP_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "http://localhost:3000");

/** The message the patient's phone gets on WhatsApp when an appointment is booked, moved or cancelled. */
async function whatsappText(requestId: string, kind: string, payload: Record<string, unknown>) {
  const r = await getRequest(requestId);
  const persona = await loadPersona(r!.persona_id);
  const lang = persona.lang;
  const a = await one<{ starts_at: Date; name: string; address: string; phone: string }>(
    "SELECT a.starts_at, p.name, p.address, p.phone FROM appointments a JOIN providers p ON p.id=a.provider_id WHERE a.id=$1", [payload.appointment_id]);
  const when = longDate(new Date(a!.starts_at).toISOString(), lang);
  const patient = persona.patient?.name ?? persona.name;
  const specialty = r!.query.specialty ? SPECIALTY_LABEL[r!.query.specialty]?.[lang] ?? "" : "";
  const plan = r!.query.insurance ? INSURERS[r!.query.insurance]?.name ?? r!.query.insurance : null;
  const L = (es: string, en: string) => (lang === "en" ? en : es);
  const office = `🏥 ${a!.name}\n📍 ${a!.address}\n📞 ${a!.phone}`;
  const ics = `${L("Añadir al calendario", "Add to calendar")}: ${appUrl()}/api/requests/${requestId}/ics`;
  if (kind === "cancelled") return [`❌ *CitaYa* · ${L("Cita cancelada", "Appointment cancelled")}`, `${patient} · ${specialty}`, `📅 ${when}`, `🏥 ${a!.name}`, L("La oficina ya liberó el espacio. No queda como no-show.", "The office has released the slot, so it won't count as a no-show.")].join("\n");
  const head = kind === "rebooked"
    ? `⏩ *CitaYa* · ${L("Cita movida más temprano", "Moved to an earlier appointment")}\n${L("Antes", "Was")}: ${longDate(new Date(payload.from as string).toISOString(), lang)}`
    : `✅ *CitaYa* · ${L("Cita confirmada", "Appointment booked")}`;
  return [head, `${patient} · ${specialty}`, `📅 ${when}`, office, plan ? L(`Lleve su tarjeta de ${plan}.`, `Bring your ${plan} card.`) : null, ics].filter(Boolean).join("\n");
}

// ---------- live phone calls: the agent's webhook tools ----------
/** check_opening / book_opening / add_to_waitlist / confirm_cancelled, called by the ElevenLabs agent mid-call. */
export async function liveTool(callId: string, tool: string, datetime?: string): Promise<Record<string, unknown>> {
  const call = await one<{ request_id: string; purpose: string; appointment_id: string | null }>("SELECT request_id, purpose, appointment_id FROM call_tasks WHERE id=$1 AND live IS NOT NULL", [callId]);
  if (!call) return { ok: false, error: "unknown call" };
  const r = await getRequest(call.request_id);
  const lang = (await loadPersona(r!.persona_id)).lang;
  // a tool call means someone picked up, even if the poller hasn't seen it yet
  if ((await markAnswered(callId, lang)).state !== "NEGOTIATING") {
    return { ok: false, error: "This call is already settled. Thank them and end the call." };
  }
  if (tool === "cancel") {
    if (call.purpose !== "cancel") return { ok: false, error: "This call is not a cancellation." };
    await pushStates(callId, [{ state: "CANCELLED", payload: { effect: "cancel" } }]);
    return { ok: true, note: "Cancellation recorded. Thank them and end the call." };
  }
  if (tool === "waitlist") {
    await pushStates(callId, [{ state: "NO_FIT" }, { state: "WAITLISTED", payload: { effect: "waitlist" } }]);
    return { ok: true, note: "Waitlist recorded. Thank them and end the call." };
  }
  if (tool !== "check" && tool !== "book") return { ok: false, error: `unknown tool ${tool}` };
  if (call.purpose === "cancel") return { ok: false, error: "This call is a cancellation; don't book anything." };
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{1,2}):(\d{2})/.exec(datetime?.trim() ?? "");
  if (!m) return { ok: false, error: "Pass datetime as local Puerto Rico time, YYYY-MM-DDTHH:MM (24-hour)." };
  const iso = toISO(m[1], `${m[2].padStart(2, "0")}:${m[3]}`);
  const now = await virtualNow();
  const appt = call.purpose === "rebook" && call.appointment_id ? await one<{ starts_at: Date }>("SELECT starts_at FROM appointments WHERE id=$1", [call.appointment_id]) : null;
  const why = checker(r!.query, localDate(now.toISOString()), now, appt ? new Date(appt.starts_at).toISOString() : undefined)(iso);
  const when = longDate(iso, lang);
  if (tool === "check") return why ? { fits: false, when, reason: why } : { fits: true, when };
  if (why) return { booked: false, when, reason: `${why}. Don't take it; ask for something else.` };
  await pushStates(callId, [{ state: "SLOT_OFFERED", payload: { starts_at: iso } }, { state: "BOOKED", payload: { effect: call.purpose === "rebook" ? "rebook" : "book", starts_at: iso } }]);
  return { booked: true, when, note: call.purpose === "rebook" ? "Recorded. Confirm they'll release the old appointment, thank them and end the call." : "Recorded. Thank them and end the call." };
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

async function providerRow(id: string): Promise<Provider> {
  const p = await one<Provider & { insurers: string[] }>("SELECT * FROM providers WHERE id=$1", [id]);
  return p!;
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
    const rsc: ScenarioCtx = { ...ctx, offerISO: iso, offerText: longDate(iso, lang), currentText: longDate(current, lang) };
    const prov = await providerRow(s.provider_id);
    const brief = briefFor(prov, lang, [iso], checker(r.query, localDate(now.toISOString()), now, current));
    const facts = factsFor(persona, r.query, prov, lang, rsc);
    if (!await tryLiveCall(requestId, prov, "rebook", appt.id, facts, brief, { scenario: "rebook", sc: rsc, isos: [iso] })) await createLiveCall(requestId, prov, "rebook", "rebook", rsc, facts, 0.5, appt.id, brief);
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
  const csc: ScenarioCtx = { ...ctxFor(persona, r.query, persona.lang), currentText: longDate(iso, persona.lang) };
  const prov = await providerRow(appt.provider_id);
  const brief = briefFor(prov, persona.lang, [], () => null);
  const facts = factsFor(persona, r.query, prov, persona.lang, csc);
  if (!await tryLiveCall(requestId, prov, "cancel", appt.id, facts, brief, { scenario: "cancel", sc: csc, isos: [] })) await createLiveCall(requestId, prov, "cancel", "cancel", csc, facts, 0.3, appt.id, brief);
}

// ---------- snapshot for the UI ----------
export async function snapshot(requestId: string) {
  await ensureLiveSchema();
  const r = await getRequest(requestId);
  if (!r) return null;
  const tasks = await q(`SELECT t.id, t.provider_id, p.name AS provider_name, p.phone, t.purpose, t.scenario, t.state, t.attempt, t.started_at, t.audio, t.live,
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

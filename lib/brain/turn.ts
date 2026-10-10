// One conversational turn: safety screen → triage → extraction → ask-or-search decision.
import { daysText, formatDate } from "../dates";
import { INSURERS } from "../personas";
import { SPECIALTY_LABEL, type Lang, type Persona, type ProviderQuery, type Specialty } from "../types";
import { detectLang, effectiveLatest, extract, langHint, norm, redFlag, triage, type Expecting, type RedFlag } from "./rules";
import { llmTurn } from "./llm";

export interface TurnInput {
  text: string;
  today: string;
  persona: Persona;
  query: ProviderQuery;
  expecting: Expecting;
  /** conversation language, fixed by the first user message (Spanglish → Spanish) */
  convLang?: Lang;
  /** prior messages (oldest first) so the model can resolve "instead of Thursdays", "yes, call them" */
  history?: { role: string; text: string }[];
  /** shortlist already presented and we asked whether to call */
  ready?: boolean;
  /** language the reply must be in (decided deterministically, not by the model) */
  replyLang?: Lang;
}
export interface TurnResult {
  action: "ask" | "search" | "emergency" | "call";
  lang: Lang;
  patch: Partial<ProviderQuery>;
  query: ProviderQuery;
  missing: Expecting[];
  expecting: Expecting;
  reply: string;
  redFlag: RedFlag | null;
  engine: "rules" | "llm";
  alternatives: Specialty[];
  model?: string;
  llm_ms?: number;
  /** the user asked to place the calls, whether or not this turn starts them */
  wantsCall?: boolean;
}

export function missingSlots(q: ProviderQuery): Expecting[] {
  const m: Expecting[] = [];
  if (!q.specialty) m.push("specialty");
  if (!q.latest_date && !q.asap) m.push("timing");
  if (q.max_drive_min == null) m.push("drive");
  return m;
}

export async function runTurn(input: TurnInput): Promise<TurnResult> {
  const { text, today, persona, expecting } = input;
  const detected = detectLang(text);
  let lang: Lang = langHint(text) ?? input.convLang ?? (detected === "en" ? "en" : "es");
  input = { ...input, replyLang: lang };
  const flag = redFlag(text); // deterministic, always first, never delegated to a model
  if (flag) {
    return { action: "emergency", lang, patch: {}, query: input.query, missing: [], expecting: null, reply: emergencyReply(flag, lang), redFlag: flag, engine: "rules", alternatives: [] };
  }

  const llm = await llmTurn(input).catch(() => null);
  if (llm) {
    // the model can ADD an emergency the regex missed; it can never clear one (checked above)
    if (llm.out.emergency !== "none") {
      const f: RedFlag = { id: llm.out.emergency === "crisis" ? "self_harm_llm" : "medical_llm", crisis: llm.out.emergency === "crisis" };
      return { action: "emergency", lang, patch: {}, query: input.query, missing: [], expecting: null, reply: emergencyReply(f, lang), redFlag: f, engine: "llm", alternatives: [], model: llm.model, llm_ms: llm.ms };
    }
    const patch = withProfile(llm.patch, input);
    const query: ProviderQuery = { ...input.query, ...patch };
    const missing = missingSlots(query);
    const base = { lang, patch, query, missing, redFlag: null, engine: "llm" as const, alternatives: llm.alternatives, model: llm.model, llm_ms: llm.ms };
    // a reply in the wrong language (the model sometimes copies a Spanish example) falls back to the template
    const said = llm.out.reply.trim();
    const reply = said && langHint(said) === (lang === "en" ? "es" : "en") ? "" : said;
    if (missing.length) return { ...base, action: "ask", expecting: missing[0], reply: reply || askReply(missing[0], query, persona, lang) };
    // the model re-states fields it already knows; only real changes count as "the search changed"
    const changed = (Object.keys(llm.patch) as (keyof ProviderQuery)[]).some((k) => canon(llm.patch[k]) !== canon(input.query[k]));
    const confirm = llm.out.intent === "confirm_call" && input.ready === true && !changed;
    // a "yes, call" that changed the search shows the new list first; the model's "calling now" would be a false promise
    const promised = llm.out.intent === "confirm_call" && !confirm;
    return { ...base, action: confirm ? "call" : "search", wantsCall: llm.out.intent === "confirm_call", expecting: null, reply: promised || !reply ? readyReply(query, persona, lang) : reply };
  }

  const patch: Partial<ProviderQuery> = {};
  let alternatives: Specialty[] = [];
  if (!input.query.specialty || expecting === "specialty") {
    const tr = triage(text);
    if (tr.specialty) { patch.specialty = tr.specialty; patch.specialty_confidence = tr.confidence; alternatives = tr.alternatives; }
  }
  Object.assign(patch, extract(text, today, persona, input.query, expecting));
  withProfile(patch, input);

  const query: ProviderQuery = { ...input.query, ...patch };
  const missing = missingSlots(query);
  if (missing.length === 0) {
    const saidYes = Object.keys(extract(text, today, persona, input.query, null)).length === 0 && YES.test(norm(text));
    const yes = input.ready && saidYes;
    return { action: yes ? "call" : "search", wantsCall: saidYes, lang, patch, query, missing, expecting: null, reply: yes ? callingReply(lang) : readyReply(query, persona, lang), redFlag: null, engine: "rules", alternatives };
  }
  const next = missing[0];
  return { action: "ask", lang, patch, query, missing, expecting: next, reply: askReply(next, query, persona, lang), redFlag: null, engine: "rules", alternatives };
}

/** key-order-independent JSON (jsonb from Postgres reorders object keys) */
const canon = (v: unknown): string =>
  v === undefined ? "null" : JSON.stringify(v, (_, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));

const YES = /^(si|sí|dale|ok|okay|yes|yeah|sure|claro|perfecto|adelante|go ahead|llamalos|llama(los)?|call them)\b/;
const callingReply = (lang: Lang) => (lang === "en" ? "Calling the offices now. I'll let you know as soon as one confirms." : "Perfecto, ya estoy llamando a las oficinas. Te aviso en cuanto una confirme.");

function withProfile(patch: Partial<ProviderQuery>, input: TurnInput) {
  if (!input.query.insurance && !patch.insurance) patch.insurance = input.persona.insurance;
  if (input.persona.patient) patch.patient_is_requester = false;
  return patch;
}

function emergencyReply(f: RedFlag, lang: Lang) {
  if (f.crisis)
    return lang === "en"
      ? "I'm really glad you told me. You deserve support right now. Call or text 988 (Suicide & Crisis Lifeline), or Línea PAS at 1-800-981-0023. If you're in immediate danger, call 911. I won't book anything for this."
      : "Gracias por decírmelo. Mereces apoyo ahora mismo. Llama a la Línea PAS al 1-800-981-0023 o al 988 (llamada o texto). Si estás en peligro inmediato, llama al 911. No voy a sacar una cita para esto.";
  return lang === "en"
    ? "This could be an emergency. Call 911 or go to the nearest emergency room now. I can't diagnose this and I won't book an appointment for it."
    : "Esto puede ser una emergencia. Llama al 911 o ve a la sala de emergencias más cercana ahora. No puedo diagnosticar esto y no voy a sacar una cita para ello.";
}

function askReply(slot: Expecting, q: ProviderQuery, p: Persona, lang: Lang) {
  const who = p.patient ? (lang === "en" ? "his" : "su") : (lang === "en" ? "your" : "tu");
  const spec = q.specialty ? SPECIALTY_LABEL[q.specialty][lang].toLowerCase() : "";
  if (slot === "specialty")
    return lang === "en" ? "What's going on? Tell me the symptom or the kind of doctor you need." : "¿Qué te está pasando? Cuéntame el síntoma o qué tipo de médico necesitas.";
  if (slot === "timing")
    return lang === "en" ? `Got it, ${spec}. When do you need it by, or should I look for the earliest opening?`
      : `Entendido, ${spec}. ¿Para cuándo la necesitas, o busco lo más pronto posible?`;
  // drive
  const places = p.work ? (lang === "en" ? "from home or from work" : `desde ${who} casa o desde el trabajo`) : (lang === "en" ? `from ${who} home` : p.patient ? "desde su casa" : "desde tu casa");
  return lang === "en" ? `Got it. How many minutes are you willing to drive ${places}?`
    : `Perfecto, ${spec}${q.days_of_week.length ? ` ${daysText(q.days_of_week, "es")}` : ""}. ¿Hasta cuántos minutos manejarías ${places}?`;
}

type Blocker = "insurance" | "days" | "hours" | "drive" | "language" | "wheelchair" | "other";
const BLOCKERS: [Blocker, RegExp][] = [
  ["insurance", /^(no acepta|doesn't take)/i], ["days", /^(cerrado|closed)/i], ["hours", /^(horario|hours)/i],
  ["drive", /min|lejos|far/i], ["language", /ingl[eé]s|english/i], ["wheelchair", /silla|wheelchair/i],
];

/** Honest reply when every office was filtered out: say so, name the main reason, suggest what to relax. Never offers to call. */
export function noFitReply(reasons: (string | null)[], q: ProviderQuery, lang: Lang) {
  const counts = new Map<Blocker, number>();
  for (const r of reasons) {
    if (!r) continue;
    const b = BLOCKERS.find(([, re]) => re.test(r))?.[0] ?? "other";
    counts.set(b, (counts.get(b) ?? 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "other";
  const spec = q.specialty ? SPECIALTY_LABEL[q.specialty][lang].toLowerCase() : lang === "en" ? "that specialty" : "esa especialidad";
  const ins = q.insurance ? INSURERS[q.insurance]?.name ?? q.insurance : "";
  const en: Record<Blocker, string> = {
    insurance: `none of the nearby ${spec} offices take ${ins}. Want me to look a bit farther?`,
    days: `none of the ${spec} offices are open on the days you can go. Could another day work?`,
    hours: `none of the ${spec} offices are open at the time you need. Could you go at a different time, like mornings?`,
    drive: `the ${spec} offices that fit are all farther than ${q.max_drive_min} minutes. Want me to allow a longer drive?`,
    language: `none of the ${spec} offices that fit have an English-speaking clinician. Should I drop that requirement?`,
    wheelchair: `none of the ${spec} offices that fit are wheelchair accessible. Want me to look farther?`,
    other: `no ${spec} office fits everything you asked for. Which one can we loosen: day, time or distance?`,
  };
  const es: Record<Blocker, string> = {
    insurance: `ninguna oficina de ${spec} cerca acepta ${ins}. ¿Busco un poco más lejos?`,
    days: `ninguna oficina de ${spec} abre los días que puedes. ¿Te sirve otro día?`,
    hours: `ninguna oficina de ${spec} abre en el horario que necesitas. ¿Podrías ir en otro horario, como por la mañana?`,
    drive: `las oficinas de ${spec} que te sirven quedan a más de ${q.max_drive_min} minutos. ¿Amplío la distancia?`,
    language: `ninguna oficina de ${spec} que te sirve tiene médico que hable inglés. ¿Quito ese requisito?`,
    wheelchair: `ninguna oficina de ${spec} que te sirve tiene acceso para silla de ruedas. ¿Busco más lejos?`,
    other: `ninguna oficina de ${spec} cumple con todo lo que pediste. ¿Qué podemos ajustar: día, hora o distancia?`,
  };
  return lang === "en" ? `I haven't called anyone yet: ${en[top]}` : `Todavía no he llamado a nadie: ${es[top]}`;
}

function readyReply(q: ProviderQuery, p: Persona, lang: Lang) {
  const spec = SPECIALTY_LABEL[q.specialty!][lang].toLowerCase();
  const latest = effectiveLatest(q);
  const ins = q.insurance ? INSURERS[q.insurance]?.name : null;
  if (lang === "en") {
    const parts = [spec, q.days_of_week.length ? daysText(q.days_of_week, "en") : null,
      latest ? `by ${formatDate(latest, "en")}` : q.asap ? "earliest opening" : null,
      `within ${q.max_drive_min} min`, ins ? `taking ${ins}` : null, q.languages.includes("en") ? "English-speaking" : null].filter(Boolean);
    return `Here's your shortlist: ${parts.join(", ")}. Want me to call them for you?`;
  }
  const parts = [spec, q.days_of_week.length ? daysText(q.days_of_week, "es") : null,
    latest ? `hasta el ${formatDate(latest, "es")}` : q.asap ? "lo más pronto posible" : null,
    `a ${q.max_drive_min} min o menos`, ins ? `que acepten ${ins}` : null, q.wheelchair ? "con acceso para silla de ruedas" : null].filter(Boolean);
  return `Listo. Esta es la lista: ${parts.join(", ")}. ¿Llamo a las oficinas por ${p.patient ? "ustedes" : "ti"}?`;
}

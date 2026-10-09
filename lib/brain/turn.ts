// One conversational turn: safety screen → triage → extraction → ask-or-search decision.
import { daysText, formatDate } from "../dates";
import { INSURERS } from "../personas";
import { SPECIALTY_LABEL, type Lang, type Persona, type ProviderQuery, type Specialty } from "../types";
import { detectLang, effectiveLatest, extract, redFlag, triage, type Expecting, type RedFlag } from "./rules";
import { llmTurn } from "./llm";

export interface TurnInput {
  text: string;
  today: string;
  persona: Persona;
  query: ProviderQuery;
  expecting: Expecting;
  /** conversation language, fixed by the first user message (Spanglish → Spanish) */
  convLang?: Lang;
}
export interface TurnResult {
  action: "ask" | "search" | "emergency";
  lang: Lang;
  patch: Partial<ProviderQuery>;
  query: ProviderQuery;
  missing: Expecting[];
  expecting: Expecting;
  reply: string;
  redFlag: RedFlag | null;
  engine: "rules" | "llm";
  alternatives: Specialty[];
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
  const lang: Lang = input.convLang ?? (detected === "en" ? "en" : "es");
  const flag = redFlag(text); // deterministic, always first, never delegated to a model
  if (flag) {
    return { action: "emergency", lang, patch: {}, query: input.query, missing: [], expecting: null, reply: emergencyReply(flag, lang), redFlag: flag, engine: "rules", alternatives: [] };
  }

  let engine: "rules" | "llm" = "rules";
  let patch: Partial<ProviderQuery> = {};
  let alternatives: Specialty[] = [];
  const llm = await llmTurn(input).catch(() => null);
  if (llm) {
    engine = "llm";
    patch = llm.patch;
    alternatives = llm.alternatives;
  } else {
    if (!input.query.specialty || expecting === "specialty") {
      const tr = triage(text);
      if (tr.specialty) { patch.specialty = tr.specialty; patch.specialty_confidence = tr.confidence; alternatives = tr.alternatives; }
    }
    Object.assign(patch, extract(text, today, persona, input.query, expecting));
  }
  if (!input.query.insurance && !patch.insurance) patch.insurance = persona.insurance;
  if (persona.patient) patch.patient_is_requester = false;

  const query: ProviderQuery = { ...input.query, ...patch };
  const missing = missingSlots(query);
  if (missing.length === 0) {
    return { action: "search", lang, patch, query, missing, expecting: null, reply: readyReply(query, persona, lang), redFlag: null, engine, alternatives };
  }
  const next = missing[0];
  return { action: "ask", lang, patch, query, missing, expecting: next, reply: askReply(next, query, persona, lang), redFlag: null, engine, alternatives };
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

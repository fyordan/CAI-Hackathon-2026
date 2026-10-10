// LLM brain (OpenRouter, FAST_MODEL). One strict-JSON call per turn that:
//   1. classifies safety (OR-ed with the deterministic red-flag regex, never relaxes it)
//   2. classifies intent (giving info vs. "yes, call them")
//   3. returns a ProviderQuery patch with REPLACE semantics per field
//   4. writes the natural-language reply for the merged state
// Returns null on timeout / error → the rule-based brain in rules.ts answers instead.
import { z } from "zod";
import { chatJSON } from "../ai/openrouter";
import { addDays, thanksgiving, weekdayOf } from "../dates";
import { INSURERS } from "../personas";
import { SPECIALTIES, SPECIALTY_LABEL, type Lang, type ProviderQuery, type Specialty } from "../types";
import type { TurnInput } from "./turn";

const Day = z.enum(["mon", "tue", "wed", "thu", "fri", "sat"]);
const Out = z.object({
  emergency: z.enum(["none", "medical", "crisis"]),
  intent: z.enum(["info", "confirm_call", "decline_call", "chitchat", "off_topic"]),
  reply_lang: z.enum(["es", "en"]),
  specialty: z.enum(SPECIALTIES).nullable(),
  specialty_confidence: z.number().nullable(),
  alternatives: z.array(z.enum(SPECIALTIES)),
  days_of_week: z.array(Day).nullable(),
  time_windows: z.array(z.object({ start: z.string(), end: z.string() })).nullable(),
  earliest_date: z.string().nullable(),
  latest_date: z.string().nullable(),
  deadline_label: z.string().nullable(),
  asap: z.boolean().nullable(),
  max_drive_min: z.number().nullable(),
  drive_origins: z.array(z.enum(["home", "work"])).nullable(),
  languages: z.array(z.enum(["es", "en"])).nullable(),
  wheelchair: z.boolean().nullable(),
  notes: z.array(z.string()).nullable(),
  reply: z.string(),
});
export type LlmOut = z.infer<typeof Out>;

const WD_ES: Record<string, string> = { sun: "domingo", mon: "lunes", tue: "martes", wed: "miércoles", thu: "jueves", fri: "viernes", sat: "sábado" };

function calendar(today: string) {
  // the model is bad at date math; hand it a lookup table of the next 10 weeks
  const rows: string[] = [];
  for (let i = 0; i < 70; i += 7) {
    const week = Array.from({ length: 7 }, (_, j) => addDays(today, i + j)).map((d) => `${weekdayOf(d)} ${d}`);
    rows.push(week.join(", "));
  }
  return rows.join("\n");
}

function system(input: TurnInput) {
  const p = input.persona;
  const y = Number(input.today.slice(0, 4));
  const tg = thanksgiving(y) > input.today ? thanksgiving(y) : thanksgiving(y + 1);
  const specs = SPECIALTIES.map((s) => `${s} (${SPECIALTY_LABEL[s].es})`).join(", ");
  return `You are CitaYa, a warm, efficient Puerto Rican appointment assistant. You help people in Puerto Rico find and book a doctor's appointment; you will phone the offices for them. You never diagnose or give medical advice.

TODAY: ${weekdayOf(input.today)} ${input.today} (${WD_ES[weekdayOf(input.today)]}), timezone America/Puerto_Rico. Thanksgiving: ${tg}.
Next 10 weeks (use this for every date, never compute dates yourself):
${calendar(input.today)}

USER PROFILE: ${p.name}. Home: ${p.home.label}. Work: ${p.work ? p.work.label : "none"}. Insurance: ${INSURERS[p.insurance].name} (already known; never ask).${p.patient ? ` The user is a CAREGIVER booking for ${p.patient.name} (${p.patient.age}, their ${p.patient.relation}); "home" means the patient's home.` : ""}

CURRENT SEARCH (JSON): ${JSON.stringify(input.query)}
STATUS: ${input.ready ? "the shortlist is ready and we already asked whether to call the offices" : "still collecting details"}.

Return JSON:
- emergency: "medical" if the latest message describes a CURRENT possible emergency (chest pain/pressure now, stroke signs, can't breathe, heavy bleeding, seizure, unconscious, infant <3 months with fever, severe allergic reaction). "crisis" for suicidal thoughts or self-harm. Past history ("tuve dolor de pecho el año pasado", follow-ups) is "none".
- intent: "confirm_call" if they approve calling/booking ("sí", "dale", "llámalos", "go ahead", "yes please"), "decline_call" if they say not yet/no, "info" if they give or change details, "chitchat" for greetings/thanks, "off_topic" otherwise.
- reply_lang: "${input.replyLang ?? "es"}" (fixed).
- Search fields: return a value ONLY when the latest message (read with the conversation context) states or changes it; otherwise null. A non-null value REPLACES the current one (e.g. "Wednesdays instead of Thursdays" → ["wed"]).
  specialty: one of ${specs}. Pick the specialist a patient would book for the complaint (migraine → neurology; child → pediatrics unless dental or they ask for a pediatric subspecialist (pediatric dermatologist → dermatology); general checkup → family_medicine). alternatives: up to 2 other plausible ones.
  latest_date: last acceptable day, inclusive ("before Nov 20" → the 19th; "antes de Thanksgiving" → day before Thanksgiving; "in two weeks" → today+14). earliest_date only if they say "not before"/"next week" (next week = its Monday). deadline_label: the user's words for the deadline, short.
  asap: true for "lo antes posible"/"as soon as possible"/"earliest"/"whenever you can find".
  time_windows: 24h "HH:MM" local, e.g. mornings → 07:00-12:00, afternoons → 12:00-17:00, "after 4" → 16:00-18:00, "before 9" → 07:00-09:00.
  max_drive_min: minutes. drive_origins: ["home"], ["work"], or ["home","work"] for "either".
  languages: ["en"] if they need an English-speaking doctor. wheelchair: true if they need wheelchair/walker access.
  notes: preferences the search can't filter (doctor's gender, new vs. existing patient, reason details like "uña encarnada", parking, telehealth). Short phrases in Spanish, written for the receptionist. Return the FULL updated list (current: ${JSON.stringify(input.query.notes ?? [])}) or null if unchanged. Never promise these are guaranteed; say you'll ask the office.
- reply: what you say next, written ENTIRELY in ${input.replyLang === "en" ? "English" : "Spanish"}, 1-2 short sentences, natural spoken Puerto Rican Spanish (tú) or plain English. It will be read aloud, so no lists, emojis or markdown. Be warm but brief; acknowledge what they said in a few words, then:
  * When you mention the deadline, use the user's own words (e.g. "before Thanksgiving"), never a date you worked out; the app computes the exact last day.
  * If you just chose the specialty from symptoms the user described (they didn't name the doctor), say which specialist and why in a few plain words (e.g. "From what you describe, a neurologist is the right doctor." / "Por lo que cuentas, lo indicado es un neurólogo."). Never diagnose or name a disease as certain.
  * After applying your fields, the REQUIRED details are: specialty, timing (latest_date or asap), and max_drive_min. If any is still missing, ask ONLY for the first missing one, conversationally. Never ask for insurance, name or address.
  * If nothing is missing and intent is not confirm_call: say you found offices that match (briefly restate the key constraints) and ask if you should call them.
  * If intent is confirm_call and nothing is missing: say you're calling the offices now and will let them know.
  * If emergency is not "none": a short caring line; the app shows emergency numbers itself.
  * Off-topic: gently steer back to finding an appointment.`;
}

export async function llmTurn(input: TurnInput): Promise<{ out: LlmOut; patch: Partial<ProviderQuery>; alternatives: Specialty[]; model: string; ms: number } | null> {
  const history = (input.history ?? []).slice(-8).map((m) => ({ role: m.role === "user" ? ("user" as const) : ("assistant" as const), content: m.text }));
  const r = await chatJSON({
    tier: "fast",
    name: "turn",
    schema: Out,
    timeoutMs: Number(process.env.LLM_TIMEOUT_MS || 6000),
    messages: [{ role: "system", content: system(input) }, ...history, { role: "user", content: input.text }],
  });
  if (!r) return null;
  const o = r.data;
  const patch: Partial<ProviderQuery> = {};
  const keys = ["specialty", "specialty_confidence", "days_of_week", "time_windows", "earliest_date", "latest_date", "deadline_label", "asap", "max_drive_min", "drive_origins", "languages", "wheelchair", "notes"] as const;
  for (const k of keys) if (o[k] !== null) (patch as Record<string, unknown>)[k] = o[k];
  const isDate = (d: unknown) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= input.today;
  if ("latest_date" in patch && !isDate(patch.latest_date)) delete patch.latest_date;
  if ("earliest_date" in patch && !isDate(patch.earliest_date)) delete patch.earliest_date;
  if (patch.time_windows) patch.time_windows = patch.time_windows.filter((w) => /^\d\d:\d\d$/.test(w.start) && /^\d\d:\d\d$/.test(w.end) && w.start < w.end);
  if (patch.max_drive_min != null && (patch.max_drive_min < 5 || patch.max_drive_min > 180)) delete patch.max_drive_min;
  if (patch.specialty_confidence != null) patch.specialty_confidence = Math.max(0, Math.min(1, patch.specialty_confidence));
  if (patch.latest_date || patch.asap === false) patch.asap = patch.asap ?? false;
  if (patch.asap) patch.latest_date = patch.latest_date ?? null;
  if (patch.drive_origins && !input.persona.work) patch.drive_origins = ["home"];
  if (patch.drive_origins?.length === 2) patch.origin_logic = "any";
  if (patch.max_drive_min && !patch.drive_origins && input.query.drive_origins.length === 0) patch.drive_origins = input.persona.work ? ["home", "work"] : ["home"];
  return { out: o, patch, alternatives: o.alternatives.filter((s) => s !== o.specialty).slice(0, 2), model: r.model, ms: r.ms };
}

export const replyLang = (o: LlmOut): Lang => o.reply_lang;

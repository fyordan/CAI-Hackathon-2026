// Offline, deterministic "brain". This is what ran in the recorded demos (no LLM key here).
// It is a keyword/regex classifier + constraint extractor for Spanish, English and Spanglish.
// With OPENROUTER_API_KEY set, lib/brain/llm.ts is tried first and this stays the fallback
// and the safety net (red-flag screening ALWAYS runs here, before any model).
import { addDays, firstAllowedFrom, lastAllowedBefore, thanksgiving, weekdayOf } from "../dates";
import type { Lang, Persona, ProviderQuery, Specialty, TimeWindow, Weekday } from "../types";

export const norm = (s: string) =>
  s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();

// ---------- language ----------
const ES_WORDS = /\b(tengo|necesito|quiero|que|los|las|del|por|para|mi|una?|duele|salio|tiene|esta|pero|muy|hace|y|solo|antes|despues|minutos|casa|trabajo|cita|dolor|puedo|semana|hasta|de|con|lo|el|la)\b/g;
const EN_WORDS = /\b(i|need|my|is|it|the|with|who|speaks|within|minutes|home|work|before|after|appointment|weekdays|either|from|sometime|next|month|max|any|a|an|of)\b/g;
export function detectLang(text: string): Lang | "mixed" {
  const t = norm(text);
  const es = (t.match(ES_WORDS) || []).length;
  const en = (t.match(EN_WORDS) || []).length;
  if (es >= 2 && en >= 2) return "mixed";
  return en > es ? "en" : "es";
}

/** Clear language of a single message, or null when too short/ambiguous to tell (keep the conversation's). */
export function langHint(text: string): Lang | null {
  const t = norm(text);
  const es = (t.match(ES_WORDS) || []).length + (/[ñ¿¡]|\b(dale|si|claro|gracias|vale|pues|bueno)\b/.test(text.toLowerCase()) ? 1 : 0);
  const en = (t.match(EN_WORDS) || []).length;
  if (es === 0 && en === 0) return null;
  if (en === 0) return "es";
  if (es === 0) return "en";
  return es >= 2 * en ? "es" : null; // mixed / Spanglish → keep the conversation's language
}

// ---------- safety: red flags (runs before anything else) ----------
const RED_FLAGS: { id: string; re: RegExp; crisis?: boolean }[] = [
  { id: "chest_pain", re: /(dolor|presion|opresion|apreta\w*) (de|en el|en mi) pecho|pecho apretado|(me|le|nos) (duele|aprieta|arde) (mucho |bastante )?(el|en el) pecho|chest (pain|pressure|tightness)|pain in my chest|(my|his|her) chest (hurts|is tight)/ },
  { id: "stroke", re: /cara (caida|torcida|ladeada)|boca torcida|no puede hablar|habla enredad|no (puede|puedo) mover (el|la|un|una|medio)|face (is )?droop|drooping|can'?t (talk|speak) (right|properly)|slurred|can'?t move (his|her|my) (arm|leg|face)/ },
  { id: "breathing", re: /no puedo respirar|me falta el aire|falta de aire|me ahogo|can'?t breathe|shortness of breath|short of breath/ },
  { id: "bleeding", re: /no (para|deja) de sangrar|sangrando mucho|won'?t stop bleeding|bleeding a lot/ },
  { id: "self_harm", re: /me quiero morir|quiero morir|me quiero matar|no quiero vivir|suicid|kill myself|want to die|end my life|hacerme dano/, crisis: true },
  { id: "infant_fever", re: /(bebe|baby|recien nacid\w*|newborn)( de (\d|un|dos) (mes|meses|semanas))?.{0,40}(fiebre|fever)|(\d|un|dos) (mes|meses|semanas|month|months|weeks).{0,25}(fiebre|fever)/ },
  { id: "unconscious", re: /se desmayo|perdio el conocimiento|no responde|unconscious|passed out|not responding/ },
  { id: "seizure", re: /convulsion|convulsionando|seizure/ },
];
const HISTORY = /\b(tuve|tenia|el ano pasado|hace (\d+|un|dos|tres|varios) (anos|meses)|last year|i had|years ago|follow.?up|seguimiento)\b/;
const PRESENT = /\b(ahora|ahorita|en este momento|right now|now|hoy|today)\b/;

export interface RedFlag { id: string; crisis: boolean }
export function redFlag(text: string): RedFlag | null {
  const t = norm(text);
  for (const f of RED_FLAGS) {
    if (!f.re.test(t)) continue;
    if (!f.crisis && HISTORY.test(t) && !PRESENT.test(t)) continue; // "tuve dolor de pecho el año pasado"
    return { id: f.id, crisis: !!f.crisis };
  }
  return null;
}

// ---------- triage: symptom → specialty ----------
const KW: Record<Specialty, [RegExp, number][]> = {
  podiatry: [[/podiatr|podolog|una encarnada|unas encarnadas|ingrown|toenail|juanete|bunion|fascitis|plantar|pie diabetico|callo|hongos? en (las |los )?(unas|pies)|pies dormidos/, 3], [/\b(talon|heel)\b/, 2], [/\b(pie|pies|foot|feet)\b/, 1]],
  dermatology: [[/dermat|rash|sarpullido|erupcion|ronchas|eczema|psoriasis|acne/, 3], [/\b(lunar|mole|piel|skin|picazon|itch\w*)\b/, 2]],
  cardiology: [[/cardiolog|arritmia|arrhythm|palpitacion|palpitation|soplo|murmur/, 3], [/\b(corazon|heart|presion alta|hypertension)\b/, 2]],
  ob_gyn: [[/ginecolog|gyn\b|ob.?gyn|papanicolau|pap smear|embaraz|pregnan|prenatal/, 3], [/menstrua|\bperiod\b|annual exam|chequeo anual/, 1]],
  pediatrics: [[/pediatr/, 3]],
  ent: [[/otorrino|otitis|sinusitis|amigdal|tonsil|\bent\b/, 3], [/\b(oido|oidos|ear|ears|garganta|throat|sinus)\b/, 2]],
  ophthalmology: [[/oftalm|ophthalm|glaucom|catarat|cataract/, 3], [/\b(vista|ojo|ojos|eye|eyes|vision|nubla|blurry)\b/, 2]],
  gastroenterology: [[/gastro|reflujo|reflux|colonoscop|acidez|heartburn/, 3], [/\b(estomago|stomach|colon|diarrea|estrenimiento)\b/, 2]],
  endocrinology: [[/endocrin|tiroides|thyroid/, 3], [/\b(azucar|diabet\w*|hormona\w*)\b/, 2]],
  orthopedics: [[/ortoped|orthoped|fractur|esguince|sprain|tendinitis/, 3], [/\b(rodilla|knee|hombro|shoulder|hueso|bone|espalda|back pain|tobillo|ankle|cadera|hip)\b/, 2]],
  psychiatry: [[/psiquiatr|psychiatr|ansiedad|anxiety|depresion|depress|panico|panic/, 3], [/no duermo|insomnio|insomnia/, 2]],
  family_medicine: [[/medico primario|primary care|medico de cabecera|chequeo general|physical exam|generalista|\bpcp\b/, 3], [/\b(receta|refill|referido|referral)\b/, 1]],
  dentistry: [[/dentist|muela|diente|dientes|tooth|teeth|caries|encia|\bgum\b/, 3]],
  neurology: [[/neurolog|migrana|migraine|neuropat|epilepsi|vertigo|mareos?\b|dizz/, 3], [/\b(dolor de cabeza|headaches?|entumecid\w*|numbness)\b/, 2]],
  urology: [[/urolog|prostat|kidney stones?|piedras? en (el|los) rinon/, 3], [/\b(orinar|urinat\w*|vejiga|bladder)\b/, 2]],
  pulmonology: [[/neumolog|pulmonolog|asma\b|asthma|epoc|copd|apnea/, 3], [/\b(tos cronica|chronic cough|pulmon\w*|lungs?)\b/, 2]],
  urgent_care: [],
};
const CHILD = /\b(mi nena|mi nene|mi hij[oa]|mi bebe|my (son|daughter|kid|child|baby))\b|\b([1-9]|1[0-7]) (anos|years? old)\b/;

export interface Triage { specialty: Specialty | null; confidence: number; alternatives: Specialty[]; child: boolean }
export function triage(text: string): Triage {
  const t = norm(text);
  const scores = new Map<Specialty, number>();
  for (const [sp, rules] of Object.entries(KW) as [Specialty, [RegExp, number][]][]) {
    let s = 0;
    for (const [re, w] of rules) if (re.test(t)) s += w;
    if (s > 0) scores.set(sp, s);
  }
  // diabetic + feet → podiatry first; diabetes alone → endocrinology
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const child = CHILD.test(t);
  if (ranked.length === 0) return { specialty: child ? "pediatrics" : null, confidence: child ? 0.6 : 0, alternatives: [], child };
  let [top, topScore] = ranked[0];
  const second = ranked[1]?.[1] ?? 0;
  const alternatives = ranked.slice(1, 3).map(([s]) => s);
  if (child && top !== "pediatrics" && top !== "dentistry") {
    alternatives.unshift(top);
    top = "pediatrics";
  }
  const confidence = Math.min(0.97, Math.round((0.55 + 0.42 * (topScore - second) / Math.max(topScore, 1) + (topScore >= 3 ? 0.08 : 0)) * 100) / 100);
  return { specialty: top, confidence, alternatives: alternatives.slice(0, 2), child };
}

// ---------- constraint extraction ----------
const DAYS: [RegExp, Weekday][] = [
  [/\blunes\b|\bmondays?\b/, "mon"], [/\bmartes\b|\btuesdays?\b/, "tue"], [/\bmiercoles\b|\bwednesdays?\b/, "wed"],
  [/\bjueves\b|\bthursdays?\b/, "thu"], [/\bviernes\b|\bfridays?\b/, "fri"], [/\bsabados?\b|\bsaturdays?\b/, "sat"],
];
const NUM_WORDS: [RegExp, number][] = [
  [/cuarenta y cinco|forty.?five/, 45], [/veinticinco|twenty.?five/, 25], [/media hora|half (an )?hour/, 30],
  [/una hora|an hour|one hour/, 60], [/\bdiez\b|\bten\b/, 10], [/quince|fifteen/, 15], [/\bveinte\b|\btwenty\b/, 20],
  [/treinta|thirty/, 30], [/cuarenta|forty/, 40], [/cincuenta|fifty/, 50], [/sesenta|sixty/, 60],
];
const MONTHS: Record<string, number> = { enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12, january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };

export type Expecting = "specialty" | "timing" | "drive" | null;
const DONT_CARE = /\b(no se|lo que sea|no importa|cualquier cosa|whatever|don'?t know|doesn'?t matter|no preference)\b/;

export function extract(text: string, today: string, persona: Persona, current: ProviderQuery, expecting: Expecting): Partial<ProviderQuery> {
  const t = norm(text);
  const p: Partial<ProviderQuery> = {};

  // days of week
  if (/\b(entre semana|weekdays?|any weekday|dias de semana|lunes a viernes)\b/.test(t)) p.days_of_week = ["mon", "tue", "wed", "thu", "fri"];
  const days = DAYS.filter(([re]) => re.test(t)).map(([, d]) => d);
  if (days.length) p.days_of_week = days;

  // deadline / window
  const year = Number(today.slice(0, 4));
  if (/thanksgiving|accion de gracias|dia de dar gracias/.test(t)) {
    let tg = thanksgiving(year);
    if (tg <= today) tg = thanksgiving(year + 1);
    p.latest_date = addDays(tg, -1);
    p.deadline_label = /\b(es|antes)\b/.test(t) || detectLang(text) !== "en" ? "antes de Thanksgiving" : "before Thanksgiving";
  }
  const m = t.match(/(antes del?|before) (\d{1,2}) de (\w+)/) || t.match(/(before) (\w+) (\d{1,2})\b/);
  if (m) {
    const [day, mon] = /^\d/.test(m[2]) ? [Number(m[2]), MONTHS[m[3]]] : [Number(m[3]), MONTHS[m[2]]];
    if (mon && day) {
      let d = `${year}-${String(mon).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      if (d <= today) d = `${year + 1}${d.slice(4)}`;
      p.latest_date = addDays(d, -1);
      p.deadline_label = m[0];
    }
  }
  if (/(la semana que viene|la proxima semana|next week)/.test(t)) {
    let mon = addDays(today, 1);
    while (weekdayOf(mon) !== "mon") mon = addDays(mon, 1);
    p.earliest_date = mon; p.latest_date = addDays(mon, 5); p.deadline_label = /next week/.test(t) ? "next week" : "la semana que viene";
  }
  if (/(next month|in the next month|proximo mes|el mes que viene|en un mes|within a month)/.test(t)) {
    p.latest_date = addDays(today, 30); p.deadline_label = /month/.test(t) ? "within a month" : "en el próximo mes";
  }
  if (/(lo antes posible|lo mas pronto|cuanto antes|asap|as soon as possible|earliest|lo mas rapido)/.test(t)) p.asap = true;

  // time windows
  const tw: TimeWindow[] = [];
  const hr = (h: number, pmIfSmall: boolean) => (pmIfSmall && h < 7 ? h + 12 : h);
  const before = t.match(/(antes de las|before) (\d{1,2})(?::(\d\d))?\s*(am|pm)?/);
  const after = t.match(/(despues de las|after) (\d{1,2})(?::(\d\d))?\s*(am|pm)?/);
  if (before) tw.push({ start: "07:00", end: `${String(hr(Number(before[2]), before[4] === "pm")).padStart(2, "0")}:00` });
  if (after) tw.push({ start: `${String(hr(Number(after[2]), after[4] !== "am")).padStart(2, "0")}:00`, end: "18:00" });
  if (!before && !after) {
    if (/(por la manana|en la manana|mananas|in the morning|mornings)/.test(t)) tw.push({ start: "07:00", end: "12:00" });
    if (/(por la tarde|en la tarde|afternoons?)/.test(t)) tw.push({ start: "12:00", end: "17:00" });
  }
  if (tw.length) p.time_windows = tw;

  // drive time + origins
  let minutes: number | null = null;
  const num = t.match(/(\d{1,3})\s*(minutos|min|minutes|mins)\b/) || t.match(/\b(?:max|maximo|hasta|within|no mas de)\s*(\d{1,3})\b/);
  if (num) minutes = Number(num[1]);
  if (minutes === null && /(minutos|minutes|min\b|hora|hour|manejar|drive|casa|home|trabajo|work)/.test(t) || (minutes === null && expecting === "drive")) {
    for (const [re, v] of NUM_WORDS) if (re.test(t)) { minutes = v; break; }
    if (minutes === null && expecting === "drive") { const bare = t.match(/^\D*(\d{1,3})\D*$/); if (bare) minutes = Number(bare[1]); }
  }
  if (minutes !== null && minutes >= 5 && minutes <= 120) p.max_drive_min = minutes;
  const home = /\b(casa|home|house)\b/.test(t);
  const work = /\b(trabajo|work|job|oficina mia)\b/.test(t);
  const either = /\b(cualquiera|either|de los dos|both|any of them)\b/.test(t);
  if (persona.work && (either || (home && work))) { p.drive_origins = ["home", "work"]; p.origin_logic = "any"; }
  else if (home || (p.max_drive_min && !persona.work)) p.drive_origins = ["home"];
  else if (work && persona.work) p.drive_origins = ["work"];
  else if (p.max_drive_min && current.drive_origins.length === 0) p.drive_origins = persona.work ? ["home", "work"] : ["home"];

  // language / accessibility / caregiver
  if (/(que hable ingles|habla ingles|speaks english|english.?speaking|in english|en ingles)/.test(t)) p.languages = ["en"];
  if (/(que hable espanol|spanish.?speaking|speaks spanish)/.test(t)) p.languages = ["es"];
  if (/(silla de ruedas|wheelchair|accesible|accessible|andador|walker)/.test(t)) p.wheelchair = true;
  if (persona.patient || /\b(mi papa|mi mama|mi padre|mi madre|my (dad|mom|father|mother))\b/.test(t)) p.patient_is_requester = false;

  // insurance mentioned explicitly (persona profile provides the default)
  if (/triple.?s/.test(t)) p.insurance = /advantage/.test(t) ? "triple-s-advantage" : "triple-s";
  if (/\bmmm\b/.test(t)) p.insurance = /vital|reforma|gobierno|medicaid/.test(t) ? "mmm-vital" : "mmm-ma";
  if (/\bmcs\b|classicare/.test(t)) p.insurance = "mcs-classicare";
  if (/first medical/.test(t)) p.insurance = "first-medical-vital";

  // "I don't know / whatever" answers the pending question with a sensible default
  if (DONT_CARE.test(t)) {
    if (expecting === "drive" && p.max_drive_min == null) { p.max_drive_min = 30; p.drive_origins = persona.work ? ["home", "work"] : ["home"]; }
    if (expecting === "timing" && !p.latest_date && !p.asap) p.asap = true;
  }
  return p;
}

/** Last allowed appointment date given deadline + allowed weekdays. */
export function effectiveLatest(q: Pick<ProviderQuery, "latest_date" | "days_of_week">) {
  return q.latest_date ? lastAllowedBefore(addDays(q.latest_date, 1), q.days_of_week) : null;
}
export function effectiveEarliest(q: Pick<ProviderQuery, "earliest_date" | "days_of_week">, today: string) {
  return firstAllowedFrom(q.earliest_date ?? addDays(today, 1), q.days_of_week);
}

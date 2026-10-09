// ProviderQuery → SQL prefilter (parameterized, never model-written) → hard filters → rank.
import { q } from "./db";
import { estimateDriveMin, prefilterKm } from "./geo";
import { INSURERS } from "./personas";
import type { Candidate, Persona, Provider, ProviderQuery, Weekday } from "./types";

export const SHORTLIST_SIZE = 5;

/** Parameterized SQL. Specialty and every value are bound parameters. */
export function compileProviderQuery(query: ProviderQuery, origins: { lat: number; lng: number }[]) {
  if (!query.specialty) throw new Error("specialty required");
  const values: unknown[] = [query.specialty];
  const km = prefilterKm(Math.max(query.max_drive_min ?? 45, 45) + 10);
  const dist = origins.map((o) => {
    values.push(o.lat, o.lng);
    const a = values.length - 1, b = values.length;
    return `(6371 * 2 * asin(sqrt(power(sin(radians(lat - $${a}) / 2), 2) + cos(radians($${a})) * cos(radians(lat)) * power(sin(radians(lng - $${b}) / 2), 2))))`;
  });
  values.push(km);
  const text = `SELECT * FROM providers WHERE specialty = $1 AND (${dist.map((d) => `${d} <= $${values.length}`).join(" OR ")}) LIMIT 40`;
  return { text, values };
}

const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

export function opensOnAllowedDay(p: Provider, q: ProviderQuery) {
  const days = q.days_of_week.length ? q.days_of_week : (["mon", "tue", "wed", "thu", "fri", "sat"] as Weekday[]);
  return p.hours.some((h) => days.includes(h.weekday));
}
export function fitsTimeWindows(p: Provider, q: ProviderQuery) {
  if (!q.time_windows.length) return true;
  const days = q.days_of_week.length ? q.days_of_week : (["mon", "tue", "wed", "thu", "fri", "sat"] as Weekday[]);
  return p.hours.some((h) => days.includes(h.weekday) &&
    q.time_windows.some((w) => toMin(h.opens) < toMin(w.end) && toMin(w.start) < toMin(h.closes) - 20));
}

/** Pure: given providers, compute drive times, hard-filter, score and rank. */
export function rankCandidates(providers: Provider[], query: ProviderQuery, persona: Persona, lang: "es" | "en" = "es"): Candidate[] {
  const es = lang === "es";
  const origins: ("home" | "work")[] = query.drive_origins.length ? query.drive_origins : persona.work ? ["home", "work"] : ["home"];
  const cands: Candidate[] = providers.map((p) => {
    const dh = estimateDriveMin(persona.home, p);
    const dw = persona.work ? estimateDriveMin(persona.work, p) : null;
    const opts: [("home" | "work"), number][] = [];
    if (origins.includes("home")) opts.push(["home", dh]);
    if (origins.includes("work") && dw != null) opts.push(["work", dw]);
    opts.sort((a, b) => a[1] - b[1]);
    const max = query.max_drive_min;
    let reason: string | null = null;
    if (query.insurance && !p.insurers.includes(query.insurance)) reason = es ? `No acepta ${INSURERS[query.insurance]?.name ?? query.insurance}` : `Doesn't take ${INSURERS[query.insurance]?.name ?? query.insurance}`;
    else if (!opensOnAllowedDay(p, query)) reason = es ? "Cerrado los días que puedes" : "Closed on your days";
    else if (!fitsTimeWindows(p, query)) reason = es ? "Horario no coincide" : "Hours don't match";
    else if (max != null) {
      const ok = query.origin_logic === "all" ? opts.every(([, m]) => m <= max) : opts.some(([, m]) => m <= max);
      if (!ok) reason = es ? `A ${opts[0][1]} min (máx. ${max})` : `${opts[0][1]} min away (max ${max})`;
    } else if (opts[0][1] > 45) reason = es ? "Muy lejos" : "Too far";
    if (!reason && query.languages.length && !query.languages.some((l) => p.languages.includes(l))) reason = es ? "No atienden en inglés" : "No English-speaking clinician";
    if (!reason && query.wheelchair && !p.wheelchair) reason = es ? "Sin acceso para silla de ruedas" : "Not wheelchair accessible";
    const best = opts[0];
    const maxRef = max ?? 45;
    const score = reason ? 0 : Math.round((0.6 * (1 - best[1] / (maxRef + 5)) + 0.4 * p.answer_rate) * 1000) / 1000;
    return { ...p, drive_home_min: dh, drive_work_min: dw, best_origin: best[0], best_drive_min: best[1], included: !reason, excluded_reason: reason, score, rank: null };
  });
  const included = cands.filter((c) => c.included).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  included.forEach((c, i) => (c.rank = i + 1));
  const excluded = cands.filter((c) => !c.included && (c.best_drive_min ?? 99) <= 75).sort((a, b) => (a.best_drive_min ?? 0) - (b.best_drive_min ?? 0));
  return [...included, ...excluded];
}

export async function searchProviders(query: ProviderQuery, persona: Persona, lang: "es" | "en"): Promise<Candidate[]> {
  if (!query.specialty) return [];
  const origins = [persona.home, ...(persona.work ? [persona.work] : [])];
  const { text, values } = compileProviderQuery(query, origins);
  const rows = await q<Provider & { answer_rate: string }>(text, values);
  const providers = rows.map((r) => ({ ...r, answer_rate: Number(r.answer_rate) })) as Provider[];
  return rankCandidates(providers, query, persona, lang);
}

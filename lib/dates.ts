// Puerto Rico is on AST (UTC-4) all year, no DST. All local dates are "YYYY-MM-DD" strings.
import type { Lang, Weekday } from "./types";

export const PR_OFFSET = "-04:00";
export const PR_TZ = "America/Puerto_Rico";
const DAY = 86_400_000;
const WD: (Weekday | "sun")[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const toUTCDate = (d: string) => new Date(`${d}T12:00:00Z`);
const fmt = (x: Date) => x.toISOString().slice(0, 10);

export const addDays = (d: string, n: number) => fmt(new Date(toUTCDate(d).getTime() + n * DAY));
export const weekdayOf = (d: string) => WD[toUTCDate(d).getUTCDay()];
export const localDate = (iso: string) => fmt(new Date(new Date(iso).getTime() - 4 * 3600_000));
export const localTime = (iso: string) => new Date(new Date(iso).getTime() - 4 * 3600_000).toISOString().slice(11, 16);
export const toISO = (date: string, hhmm: string) => `${date}T${hhmm}:00${PR_OFFSET}`;

/** US Thanksgiving: 4th Thursday of November. 2026 → 2026-11-26 */
export function thanksgiving(year: number) {
  let d = `${year}-11-01`;
  while (weekdayOf(d) !== "thu") d = addDays(d, 1);
  return addDays(d, 21);
}

/** Last date strictly before `before` that falls on one of `days` (any Mon–Sat if empty). */
export function lastAllowedBefore(before: string, days: Weekday[]) {
  let d = addDays(before, -1);
  for (let i = 0; i < 14; i++) {
    const w = weekdayOf(d);
    if (w !== "sun" && (days.length === 0 || days.includes(w))) return d;
    d = addDays(d, -1);
  }
  return addDays(before, -1);
}

/** First allowed date on or after `from`. */
export function firstAllowedFrom(from: string, days: Weekday[]) {
  let d = from;
  for (let i = 0; i < 14; i++) {
    const w = weekdayOf(d);
    if (w !== "sun" && (days.length === 0 || days.includes(w))) return d;
    d = addDays(d, 1);
  }
  return from;
}

export function allowedDates(from: string, to: string, days: Weekday[]) {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const w = weekdayOf(d);
    if (w !== "sun" && (days.length === 0 || days.includes(w))) out.push(d);
  }
  return out;
}

const MES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DIA: Record<string, string> = { sun: "dom", mon: "lun", tue: "mar", wed: "mié", thu: "jue", fri: "vie", sat: "sáb" };
const DAYEN: Record<string, string> = { sun: "Sun", mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat" };

export function formatDate(d: string, lang: Lang) {
  const [, m, day] = d.split("-").map(Number);
  const w = weekdayOf(d);
  return lang === "es" ? `${DIA[w]} ${day} ${MES[m - 1]}` : `${DAYEN[w]} ${MON[m - 1]} ${day}`;
}

export function formatTime(hhmm: string) {
  const [h, m] = hhmm.split(":").map(Number);
  const ap = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${ap}`;
}

export const formatSlot = (iso: string, lang: Lang) => `${formatDate(localDate(iso), lang)} · ${formatTime(localTime(iso))}`;

export const DAY_NAME: Record<Weekday, { es: string; en: string }> = {
  mon: { es: "lunes", en: "Mondays" }, tue: { es: "martes", en: "Tuesdays" },
  wed: { es: "miércoles", en: "Wednesdays" }, thu: { es: "jueves", en: "Thursdays" },
  fri: { es: "viernes", en: "Fridays" }, sat: { es: "sábados", en: "Saturdays" },
};

const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const MONTHS_EN = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DIAS: Record<string, string> = { sun: "domingo", mon: "lunes", tue: "martes", wed: "miércoles", thu: "jueves", fri: "viernes", sat: "sábado" };
const DAYS_EN: Record<string, string> = { sun: "Sunday", mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday" };

/** "el jueves 19 de noviembre" / "Thursday, November 19" (+ time if iso has one) */
export function longDate(dateOrIso: string, lang: Lang, withTime = dateOrIso.length > 10) {
  const d = dateOrIso.length > 10 ? localDate(dateOrIso) : dateOrIso;
  const [, m, day] = d.split("-").map(Number);
  const w = weekdayOf(d);
  const time = withTime ? formatTime(localTime(dateOrIso)) : null;
  return lang === "es"
    ? `el ${DIAS[w]} ${day} de ${MESES[m - 1]}${time ? ` a las ${time}` : ""}`
    : `${DAYS_EN[w]}, ${MONTHS_EN[m - 1]} ${day}${time ? ` at ${time}` : ""}`;
}

/** "los jueves" · "entre semana" · "on Thursdays" · "on weekdays" */
export function daysText(days: Weekday[], lang: Lang) {
  const wk = ["mon", "tue", "wed", "thu", "fri"];
  if (days.length === 5 && wk.every((d) => days.includes(d as Weekday))) return lang === "en" ? "on weekdays" : "entre semana";
  return lang === "en" ? `on ${days.map((d) => DAY_NAME[d].en).join(" or ")}` : `los ${days.map((d) => DAY_NAME[d].es).join(" o ")}`;
}

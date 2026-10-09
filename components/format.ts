import { formatTime } from "@/lib/dates";
import type { Lang, Provider, Weekday } from "@/lib/types";

const ABBR: Record<Weekday, { es: string; en: string }> = {
  mon: { es: "lun", en: "Mon" }, tue: { es: "mar", en: "Tue" }, wed: { es: "mié", en: "Wed" },
  thu: { es: "jue", en: "Thu" }, fri: { es: "vie", en: "Fri" }, sat: { es: "sáb", en: "Sat" },
};
const ORDER: Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat"];
const short = (hhmm: string) => formatTime(hhmm).replace(":00", "").replace(" ", "");

/** "lun–vie 8AM–4PM; sáb 8AM–12PM" */
export function hoursText(hours: Provider["hours"], lang: Lang) {
  const sorted = [...hours].sort((a, b) => ORDER.indexOf(a.weekday) - ORDER.indexOf(b.weekday));
  const groups: { from: Weekday; to: Weekday; span: string }[] = [];
  for (const h of sorted) {
    const span = `${short(h.opens)}–${short(h.closes)}`;
    const g = groups[groups.length - 1];
    if (g && g.span === span && ORDER.indexOf(h.weekday) === ORDER.indexOf(g.to) + 1) g.to = h.weekday;
    else groups.push({ from: h.weekday, to: h.weekday, span });
  }
  return groups.map((g) => `${ABBR[g.from][lang]}${g.from !== g.to ? `–${ABBR[g.to][lang]}` : ""} ${g.span}`).join("; ");
}

export function hoursOn(hours: Provider["hours"], days: Weekday[], lang: Lang) {
  const sel = days.length ? hours.filter((h) => days.includes(h.weekday)) : hours;
  return sel.length ? hoursText(sel, lang) : lang === "es" ? "cerrado" : "closed";
}

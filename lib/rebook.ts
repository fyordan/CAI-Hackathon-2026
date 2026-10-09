// Rebooking rules: only move a booked appointment if the new slot is strictly better and
// still satisfies every hard constraint the patient gave us. Pure, unit-tested.
import { localDate, localTime, weekdayOf } from "./dates";
import { effectiveLatest } from "./brain/rules";
import type { ProviderQuery } from "./types";

export interface RebookOpts { minNoticeHours: number; preferEarlierSameDay: boolean; autoRebook: boolean }
export const DEFAULT_REBOOK: RebookOpts = { minNoticeHours: 24, preferEarlierSameDay: false, autoRebook: true };

export function slotSatisfies(iso: string, q: ProviderQuery, now: Date, minNoticeHours = 24): string | null {
  const d = localDate(iso);
  const w = weekdayOf(d);
  if (w === "sun") return "sunday";
  if (q.days_of_week.length && !q.days_of_week.includes(w)) return "day";
  const latest = effectiveLatest(q);
  if (latest && d > latest) return "deadline";
  if (q.time_windows.length) {
    const t = localTime(iso);
    if (!q.time_windows.some((tw) => t >= tw.start && t < tw.end)) return "time";
  }
  if (new Date(iso).getTime() < now.getTime() + minNoticeHours * 3600_000) return "notice";
  return null;
}

export type RebookDecision = { action: "rebook" | "ask" | "skip"; reason: string };

export function decideRebook(currentIso: string, candidateIso: string, q: ProviderQuery, now: Date, o: RebookOpts = DEFAULT_REBOOK): RebookDecision {
  if (new Date(candidateIso) >= new Date(currentIso)) return { action: "skip", reason: "not_earlier" };
  if (!o.preferEarlierSameDay && localDate(candidateIso) === localDate(currentIso)) return { action: "skip", reason: "same_day" };
  const bad = slotSatisfies(candidateIso, q, now, o.minNoticeHours);
  if (bad) return { action: "skip", reason: bad };
  return o.autoRebook ? { action: "rebook", reason: "earlier_and_valid" } : { action: "ask", reason: "auto_rebook_off" };
}

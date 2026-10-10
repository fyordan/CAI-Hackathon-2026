import { describe, expect, it } from "vitest";
import { thanksgiving, lastAllowedBefore, longDate } from "@/lib/dates";
import { estimateDriveMin } from "@/lib/geo";
import { compileProviderQuery, rankCandidates } from "@/lib/search";
import { buildProviders, ISLAND } from "@/lib/seed-data";
import { getPersona } from "@/lib/personas";
import { afterFailedAttempt, InvalidTransition, transition, validatePath } from "@/lib/calls/machine";
import { generateTimeline, type Scenario } from "@/lib/calls/scenarios";
import { decideRebook } from "@/lib/rebook";
import { buildGoogleEvent, buildIcs } from "@/lib/calendar";
import { emptyQuery, type ProviderQuery } from "@/lib/types";

const marisol = getPersona("marisol");
const MQ: ProviderQuery = { ...emptyQuery(), specialty: "podiatry", days_of_week: ["thu"], latest_date: "2026-11-25", max_drive_min: 30, drive_origins: ["home", "work"], insurance: "triple-s" };

describe("dates", () => {
  it("Thanksgiving 2026 is Thu Nov 26", () => expect(thanksgiving(2026)).toBe("2026-11-26"));
  it("last Thursday before it is Nov 19", () => expect(lastAllowedBefore("2026-11-26", ["thu"])).toBe("2026-11-19"));
  it("Spanish long date", () => expect(longDate("2026-11-19T10:00:00-04:00", "es")).toBe("el jueves 19 de noviembre a las 10:00 AM"));
});

describe("query compilation", () => {
  it("is parameterized and never interpolates values", () => {
    const { text, values } = compileProviderQuery(MQ, [marisol.home, marisol.work!]);
    expect(text).toContain("specialty = $1");
    expect(text).toMatch(/ OR /);
    expect(text).not.toContain("podiatry");
    expect(values[0]).toBe("podiatry");
  });
  it("requires a specialty", () => expect(() => compileProviderQuery(emptyQuery(), [marisol.home])).toThrow());
});

describe("ranking (Marisol)", () => {
  const pods = buildProviders().filter((p) => p.specialty === "podiatry");
  const ranked = rankCandidates(pods, MQ, marisol);
  const by = (id: string) => ranked.find((c) => c.id === id)!;
  it("R1 31 min from home but 16 from work is included with OR logic", () => {
    expect(by("pod-mendez").drive_home_min).toBeGreaterThan(30);
    expect(by("pod-mendez").included).toBe(true);
    expect(by("pod-mendez").best_origin).toBe("work");
  });
  it("R2 same office is excluded when both origins must fit", () => expect(rankCandidates(pods, { ...MQ, origin_logic: "all" }, marisol).find((c) => c.id === "pod-mendez")!.included).toBe(false));
  it("R3 closed Thursdays is excluded", () => expect(by("pod-cayey").excluded_reason).toMatch(/Cerrado/));
  it("R4 plan not accepted is excluded", () => expect(by("pod-carolina").excluded_reason).toMatch(/Triple-S/));
  it("R5 just over the drive limit is excluded", () => expect(by("pod-humacao").excluded_reason).toMatch(/32 min/));
  it("exactly the five scripted offices make the shortlist", () => expect(ranked.filter((c) => c.included).map((c) => c.id).sort()).toEqual(["pod-caguas", "pod-gurabo", "pod-hatorey", "pod-mendez", "pod-trujillo"]));
  it("drive estimate is symmetric and monotonic", () => {
    expect(estimateDriveMin(marisol.home, marisol.work!)).toBe(estimateDriveMin(marisol.work!, marisol.home));
    expect(estimateDriveMin(marisol.home, marisol.home)).toBe(3);
  });
});

describe("call state machine", () => {
  it("S1 rejects skipping straight to a human", () => expect(() => transition("DIALING", "HUMAN")).toThrow(InvalidTransition));
  it("S2 first failure retries with backoff", () => expect(afterFailedAttempt(1)).toEqual({ next: "RETRY_SCHEDULED", delaySec: 60 }));
  it("S3 gives up after 2 attempts", () => expect(afterFailedAttempt(2).next).toBe("GAVE_UP"));
  const ctx = { lang: "es" as const, patient: "Marisol Rivera", specialty: "podiatría", days: "los jueves", insurance: "Triple-S", offerISO: "2026-11-19T14:00:00.000Z", offerText: "x", laterText: "y", currentText: "z" };
  it.each(["hero", "rebook_hero", "cancel_hero", "success", "no_answer", "busy_nofit", "ivr_nofit", "voicemail", "rebook", "cancel"] as Scenario[])("scenario %s is a valid path", (s) => {
    const steps = generateTimeline(s, ctx);
    expect(() => validatePath(steps.filter((x) => x.state).map((x) => x.state!))).not.toThrow();
  });
  it("hero call books exactly once, with the offered slot", () => {
    const booked = generateTimeline("hero", ctx).filter((s) => s.payload?.effect === "book");
    expect(booked).toHaveLength(1);
    expect(booked[0].payload!.starts_at).toBe(ctx.offerISO);
  });
  it("S7 timelines are deterministic", () => expect(generateTimeline("busy_nofit", ctx)).toEqual(generateTimeline("busy_nofit", ctx)));
});

describe("rebooking only moves earlier when every constraint still holds", () => {
  const now = new Date("2026-10-12T10:00:00-04:00");
  const cur = "2026-11-19T10:00:00-04:00";
  it("B1 earlier Thursday at the same office → rebook", () => expect(decideRebook(cur, "2026-10-29T14:30:00-04:00", MQ, now).action).toBe("rebook"));
  it("B2 a Tuesday → skip", () => expect(decideRebook(cur, "2026-10-27T10:00:00-04:00", MQ, now)).toEqual({ action: "skip", reason: "day" }));
  it("B3 later (Thanksgiving) → skip", () => expect(decideRebook(cur, "2026-11-26T10:00:00-04:00", MQ, now).reason).toBe("not_earlier"));
  it("B5 earlier the same day → skip by default", () => expect(decideRebook("2026-10-29T14:30:00-04:00", "2026-10-29T09:00:00-04:00", MQ, now).reason).toBe("same_day"));
  it("B6 auto-rebook off → ask instead", () => expect(decideRebook(cur, "2026-10-29T14:30:00-04:00", MQ, now, { minNoticeHours: 24, preferEarlierSameDay: false, autoRebook: false }).action).toBe("ask"));
  it("B8 less than 24h notice → skip", () => expect(decideRebook(cur, "2026-10-15T09:00:00-04:00", MQ, new Date("2026-10-14T12:00:00-04:00")).reason).toBe("notice"));
});

describe("calendar", () => {
  const inv = { uid: "a@citaya.demo", title: "Cita de podiatría", location: "Calle 1, San Juan", description: "x", startsAt: "2026-11-19T14:00:00.000Z", minutes: 30, attendee: "marisol.demo@example.com", sequence: 0, status: "CONFIRMED" as const };
  it("ICS uses Puerto Rico wall time", () => expect(buildIcs(inv)).toContain("DTSTART;TZID=America/Puerto_Rico:20261119T100000"));
  it("cancellation is METHOD:CANCEL with a bumped sequence", () => {
    const ics = buildIcs({ ...inv, status: "CANCELLED", sequence: 2 });
    expect(ics).toContain("METHOD:CANCEL");
    expect(ics).toContain("SEQUENCE:2");
  });
  it("Google event is in AST with the attendee", () => {
    const ev = buildGoogleEvent(inv);
    expect(ev.start).toEqual({ dateTime: "2026-11-19T10:00:00-04:00", timeZone: "America/Puerto_Rico" });
    expect(ev.attendees).toEqual([{ email: "marisol.demo@example.com" }]);
  });
});

describe("island offices stay out of the scripted demos", () => {
  // persona → specialty it demos and the drive limit it asks for, plus a few minutes of margin
  const guard = [["marisol", "podiatry", 35], ["yadira", "cardiology", 30], ["javi", "dermatology", 45], ["javi", "gastroenterology", 35], ["ana", "ob_gyn", 25]] as const;
  it.each(guard)("%s never sees an added %s office", (id, sp, min) => {
    const p = getPersona(id);
    for (const r of ISLAND.filter((x) => x[2] === sp)) {
      const pt = { lat: r[4], lng: r[5] };
      expect(estimateDriveMin(p.home, pt), `${r[0]} from home`).toBeGreaterThan(min);
      if (p.work) expect(estimateDriveMin(p.work, pt), `${r[0]} from work`).toBeGreaterThan(min);
    }
  });
  it("ids are unique", () => { const ids = buildProviders().map((p) => p.id); expect(new Set(ids).size).toBe(ids.length); });
});

// Calendar invites. In this build invites are written to the local calendar_events "outbox"
// and offered as a real, standards-compliant .ics file (works in Google/Apple/Outlook).
// The Google Calendar API adapter below only runs when GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN
// are set (one OAuth'd demo account, sendUpdates=all). It was NOT exercised in this run.
import { PR_TZ } from "./dates";

export interface InviteInput {
  uid: string;
  title: string;
  location: string;
  description: string;
  startsAt: string; // ISO
  minutes: number;
  attendee: string;
  sequence: number;
  status: "CONFIRMED" | "CANCELLED";
}

const two = (n: number) => String(n).padStart(2, "0");
/** Local AST wall time formatted for ICS (TZID=America/Puerto_Rico). */
function icsLocal(iso: string) {
  const d = new Date(new Date(iso).getTime() - 4 * 3600_000);
  return `${d.getUTCFullYear()}${two(d.getUTCMonth() + 1)}${two(d.getUTCDate())}T${two(d.getUTCHours())}${two(d.getUTCMinutes())}00`;
}
const icsUTC = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");

export function buildIcs(i: InviteInput, now = new Date()) {
  const end = new Date(new Date(i.startsAt).getTime() + i.minutes * 60_000).toISOString();
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//CitaYa PR//Demo//ES", `METHOD:${i.status === "CANCELLED" ? "CANCEL" : "REQUEST"}`,
    "BEGIN:VTIMEZONE", `TZID:${PR_TZ}`, "BEGIN:STANDARD", "DTSTART:19700101T000000", "TZOFFSETFROM:-0400", "TZOFFSETTO:-0400", "TZNAME:AST", "END:STANDARD", "END:VTIMEZONE",
    "BEGIN:VEVENT", `UID:${i.uid}`, `SEQUENCE:${i.sequence}`, `DTSTAMP:${icsUTC(now)}`,
    `DTSTART;TZID=${PR_TZ}:${icsLocal(i.startsAt)}`, `DTEND;TZID=${PR_TZ}:${icsLocal(end)}`,
    `SUMMARY:${esc(i.title)}`, `LOCATION:${esc(i.location)}`, `DESCRIPTION:${esc(i.description)}`,
    `ATTENDEE;CN=${esc(i.attendee)};RSVP=TRUE:mailto:${i.attendee}`, `STATUS:${i.status}`,
    "BEGIN:VALARM", "TRIGGER:-PT30M", "ACTION:DISPLAY", "DESCRIPTION:Cita médica", "END:VALARM",
    "END:VEVENT", "END:VCALENDAR",
  ];
  return lines.join("\r\n") + "\r\n";
}

/** Google Calendar events.insert/patch body (sendUpdates=all is a query param). */
export function buildGoogleEvent(i: InviteInput) {
  const end = new Date(new Date(i.startsAt).getTime() + i.minutes * 60_000);
  const local = (d: Date) => new Date(d.getTime() - 4 * 3600_000).toISOString().slice(0, 19) + "-04:00";
  return {
    summary: i.title,
    location: i.location,
    description: i.description,
    start: { dateTime: local(new Date(i.startsAt)), timeZone: PR_TZ },
    end: { dateTime: local(end), timeZone: PR_TZ },
    attendees: [{ email: i.attendee }],
    reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 30 }] },
    extendedProperties: { private: { citaya_demo: "1" } },
    status: i.status === "CANCELLED" ? "cancelled" : "confirmed",
  };
}

export const googleConfigured = () => !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REFRESH_TOKEN);

async function googleToken() {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID!, client_secret: process.env.GOOGLE_CLIENT_SECRET!, refresh_token: process.env.GOOGLE_REFRESH_TOKEN!, grant_type: "refresh_token" }),
  });
  return (await r.json()).access_token as string;
}

/** Untested in this environment (no Google credentials). Inserts with sendUpdates=all so the attendee gets an email invite. */
export async function pushToGoogle(i: InviteInput): Promise<"google" | "failed"> {
  try {
    const token = await googleToken();
    const cal = encodeURIComponent(process.env.GOOGLE_CALENDAR_ID || "primary");
    const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${cal}/events?sendUpdates=all`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(buildGoogleEvent(i)),
    });
    return r.ok ? "google" : "failed";
  } catch {
    return "failed";
  }
}

// LIVE PHONE CALLS. With live mode on, one office per round is a real phone call: an ElevenLabs
// Conversational AI agent (Twilio number) dials LIVE_CALL_TO and a person plays the receptionist.
// The agent checks every offer with our webhook tools (/api/live/tool) and reports the booking,
// waitlist or cancellation through them; tick() polls the conversation for ringing/answered/ended
// and the transcript. The agent, its tools and the phone number are created by scripts/setup-live.ts.
import { one, pool, q } from "../db";
import { goalFor, type CallBrief } from "../calls/conversation";
import { whatsappConfigured } from "./twilio";

const API = "https://api.elevenlabs.io/v1/convai";

export const liveCallsConfigured = () =>
  !!(process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_AGENT_ID && process.env.ELEVENLABS_PHONE_NUMBER_ID && process.env.LIVE_CALL_TO && process.env.LIVE_TOOL_SECRET);

// ---------- settings (the on/off switches in the UI) ----------
let ensured: Promise<unknown> | null = null;
export function ensureLiveSchema() {
  ensured ??= pool.query(`CREATE TABLE IF NOT EXISTS live_settings (id int PRIMARY KEY DEFAULT 1, calls boolean NOT NULL DEFAULT false, whatsapp boolean NOT NULL DEFAULT false);
    ALTER TABLE call_tasks ADD COLUMN IF NOT EXISTS live jsonb;`).catch((e) => { ensured = null; throw e; });
  return ensured;
}

export interface LiveSettings { calls: boolean; whatsapp: boolean }

export async function liveSettings(): Promise<LiveSettings> {
  await ensureLiveSchema();
  const r = await one<LiveSettings>("SELECT calls, whatsapp FROM live_settings WHERE id=1");
  return { calls: !!r?.calls && liveCallsConfigured(), whatsapp: !!r?.whatsapp && whatsappConfigured() };
}

export async function setLiveSettings(s: Partial<LiveSettings>) {
  await ensureLiveSchema();
  await q(`INSERT INTO live_settings (id, calls, whatsapp) VALUES (1, coalesce($1, false), coalesce($2, false))
    ON CONFLICT (id) DO UPDATE SET calls = coalesce($1, live_settings.calls), whatsapp = coalesce($2, live_settings.whatsapp)`, [s.calls ?? null, s.whatsapp ?? null]);
  return liveSettings();
}

const mask = (n?: string) => (n ? `•••${n.replace(/\D/g, "").slice(-4)}` : null);
export async function liveStatus() {
  return { ...(await liveSettings()), configured: { calls: liveCallsConfigured(), whatsapp: whatsappConfigured() }, phone: mask(process.env.LIVE_CALL_TO), whatsapp_to: mask(process.env.WHATSAPP_TO) };
}

// ---------- the agent's per-call instructions ----------
export function livePrompt(b: Pick<CallBrief, "kind" | "facts">, todayText: string) {
  const f = b.facts;
  const lang = f.lang === "en" ? "English" : "Puerto Rican Spanish (use usted)";
  const tools = b.kind === "cancel"
    ? `- When the receptionist confirms the appointment is cancelled, call confirm_cancelled.`
    : `- Whenever the receptionist offers a date and time, call check_opening with it BEFORE you answer. If it doesn't fit, say why in plain words and ask for something else. If it fits, accept it.
- Once the receptionist confirms the appointment is booked, call book_opening with that same date and time. If it says it can't be booked, explain and keep looking.
- If nothing they have works, ask to be put on the cancellation list; when they agree, call add_to_waitlist.`;
  return `You are CitaYa, an automated scheduling assistant on a real phone call with the receptionist at ${f.office}, a doctor's office in Puerto Rico. You are calling on behalf of ${f.patient}${f.caller_relation ? ` (arranged by ${f.caller_relation})` : ""}. Speak ${lang}.
Today is ${todayText} (Puerto Rico time). Resolve relative dates ("el martes", "next week") from today; always pass tools a full local date and time.

GOAL: ${goalFor(b)}

WHAT YOU KNOW: patient ${f.patient}; ${f.specialty}; plan ${f.insurance || "not given"}.${f.notes.length ? ` Notes: ${f.notes.join("; ")}.` : ""}

HOW TO ACT
- The receptionist speaks first. Your first turn MUST say you are CitaYa, an automated assistant (not a person), calling on behalf of ${f.patient}, then say what you need.
${tools}
- Share only what's needed: specialty, availability, plan. Minimum health detail. Never invent a date of birth, ID or phone number; say the patient will bring the plan card and can confirm details at the visit.
- Keep every turn to one or two short sentences, warm and natural. Say dates and times the way people speak them.
- When everything is settled, thank them, say goodbye and end the call.`;
}

// ---------- ElevenLabs API ----------
async function el<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, { ...init, headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY!, "Content-Type": "application/json", ...init?.headers }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`ElevenLabs ${path} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json() as Promise<T>;
}

export async function dialOut(callId: string, prompt: string, lang: "es" | "en") {
  const r = await el<{ success: boolean; message: string; conversation_id: string | null; callSid: string | null }>("/twilio/outbound-call", {
    method: "POST",
    body: JSON.stringify({
      agent_id: process.env.ELEVENLABS_AGENT_ID,
      agent_phone_number_id: process.env.ELEVENLABS_PHONE_NUMBER_ID,
      to_number: process.env.LIVE_CALL_TO,
      conversation_initiation_client_data: {
        dynamic_variables: { call_id: callId },
        conversation_config_override: { agent: { language: lang, prompt: { prompt } } },
      },
      telephony_call_config: { ringing_timeout_secs: 40 },
    }),
  });
  if (!r.success || !r.conversation_id) throw new Error(`outbound call refused: ${r.message}`);
  return { conversation_id: r.conversation_id, call_sid: r.callSid };
}

export interface LiveConversation {
  status: "initiated" | "in-progress" | "processing" | "done" | "failed";
  transcript: { role: "user" | "agent"; message: string | null }[];
  metadata?: { call_duration_secs?: number; termination_reason?: string; error?: { reason?: string } | null };
}
export const fetchConversation = (id: string) => el<LiveConversation>(`/conversations/${id}`);

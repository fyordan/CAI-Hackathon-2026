// Unscripted call dialogue. REASONER_MODEL writes a natural phone conversation for the
// outcome the simulator already decided (book / no-fit+waitlist / rebook / cancel), tagged with
// the state-machine events at the right lines. ElevenLabs Text-to-Dialogue then voices it.
// Any failure falls back to the template lines in scenarios.ts, so a call never stalls.
import { z } from "zod";
import { chatJSON } from "../ai/openrouter";
import { clipId, putClip, renderDialogue, VOICES, type DialogueLine } from "../voice/elevenlabs";
import type { CallState, Lang } from "../types";
import type { Step } from "./scenarios";

export type DialogueKind = "book" | "nofit" | "rebook" | "cancel";

export interface DialogueFacts {
  lang: Lang;
  office: string;
  receptionist: { name: string; gender: "f" | "m" };
  patient: string;
  caller_relation: string | null; // "hija" when a caregiver booked
  specialty: string;
  reason: string | null;
  notes: string[];
  days: string;
  timeText: string | null;
  deadlineText: string | null;
  insurance: string;
  offerText?: string;   // book / rebook: the slot the office offers
  laterText?: string;   // nofit: first opening, which doesn't fit
  currentText?: string; // rebook / cancel: the existing appointment
}

const REQUIRED: Record<DialogueKind, CallState[]> = {
  book: ["SLOT_OFFERED", "BOOKED"],
  nofit: ["NO_FIT", "WAITLISTED"],
  rebook: ["SLOT_OFFERED", "BOOKED"],
  cancel: ["CANCELLED"],
};

const Line = z.object({
  speaker: z.enum(["agent", "office"]),
  text: z.string(),
  event: z.enum(["none", "SLOT_OFFERED", "BOOKED", "NO_FIT", "WAITLISTED", "CANCELLED"]),
});
const Out = z.object({ lines: z.array(Line) });

const GOAL: Record<DialogueKind, string> = {
  book: "The office has an opening that fits: offerText. The agent checks it fits, confirms insurance is accepted, the office books it. Tag the office line that first offers offerText with SLOT_OFFERED and the office line that confirms the booking with BOOKED. Afterwards the agent asks to be put on the cancellation list in case something earlier opens, thanks them, goodbye.",
  nofit: "The office's first opening is laterText, which does NOT fit the patient's constraints. The agent politely explains it doesn't work (tag that agent line NO_FIT) and asks to be added to the cancellation/wait list; the office agrees (tag that office line WAITLISTED). Short goodbye.",
  rebook: "The patient already has currentText at this office. The agent asks if anything earlier opened; the office offers offerText (tag SLOT_OFFERED), the agent takes it and asks them to release the old one, office confirms the change (tag BOOKED). Goodbye.",
  cancel: "The patient has currentText at this office and can't make it. The agent calls to cancel so the slot goes to someone else (no reason beyond 'no puede asistir'). The office confirms the cancellation (tag that office line CANCELLED). Goodbye.",
};

function prompt(kind: DialogueKind, f: DialogueFacts) {
  return `Write a realistic, natural phone call in ${f.lang === "en" ? "English" : "Puerto Rican Spanish (usted with the office)"} between "agent" (CitaYa, an automated scheduling assistant calling on behalf of a patient) and "office" (${f.receptionist.name}, receptionist at ${f.office}, a doctor's office in Puerto Rico).

FACTS (use exactly; never invent dates, times, prices or medical details):
${JSON.stringify(f, null, 1)}

GOAL: ${GOAL[kind]}

RULES:
- ${kind === "book" || kind === "nofit" ? "The office answers first with the office name and their own name." : "The office answers first, briefly."} In its first line the agent says it's an automated assistant calling on behalf of ${f.patient}${f.caller_relation ? ` (booking arranged by the patient's ${f.caller_relation})` : ""}.
- The agent states only what's needed: specialty, short reason if given, constraints (days, times, deadline), insurance, and any notes (ask about them as questions, e.g. "¿tienen doctora disponible?"). Minimum health detail.
- Sound like real people on the phone: short turns, contractions, small acknowledgements ("Ajá", "Déjeme ver…", "Perfecto"), the receptionist can ask one natural question (new patient? name?). The agent answers with the patient's name; it never invents a date of birth or ID (say the patient will bring the plan card).
- Say dates and times the way people speak them (e.g. "el jueves diecinueve a las diez de la mañana"). Spell numbers out as words.
- You may add at most 3 ElevenLabs v3 audio tags in square brackets where natural, like [warmly], [chuckles], [typing], [pause]. Never more than one per line.
- ${kind === "book" ? "7 to 9" : kind === "cancel" ? "4 to 5" : "5 to 7"} lines total. Keep turns short, like a real call: each line under 170 characters.
- event = "none" except the required tags: ${REQUIRED[kind].join(" then ")}, each exactly once, in that order.`;
}

const stripTags = (s: string) => s.replace(/\[[^\]]{1,30}\]\s*/g, "").trim();

export async function writeDialogue(kind: DialogueKind, f: DialogueFacts) {
  const r = await chatJSON({ tier: "reasoner", name: "call", schema: Out, timeoutMs: Number(process.env.DIALOGUE_TIMEOUT_MS || 12000), temperature: 0.8, messages: [{ role: "user", content: prompt(kind, f) }] });
  if (!r) return null;
  const lines = r.data.lines.filter((l) => l.text.trim());
  // a no-fit call where the office "offers" the too-late date is fine; just don't tag it as an offer
  if (kind === "nofit") for (const l of lines) if (l.event === "SLOT_OFFERED") l.event = "none";
  const events = lines.map((l) => l.event).filter((e) => e !== "none");
  if (JSON.stringify(events) !== JSON.stringify(REQUIRED[kind])) {
    console.warn(`[dialogue] ${kind} wrong events ${events.join(",")}; falling back`);
    return null;
  }
  if (lines.length < 3 || lines.length > 16) return null;
  console.log(`[dialogue] ${kind} ${lines.length} lines in ${r.ms}ms via ${r.model}`);
  return lines;
}

export type GenLine = z.infer<typeof Line>;

/** Turns dialogue lines into timeline steps starting at t0, using real audio timings when present. */
export function dialogueSteps(lines: GenLine[], t0: number, effect: Record<string, unknown>, timings?: { start: number; end: number }[]): { steps: Step[]; end: number } {
  const steps: Step[] = [];
  let t = t0;
  let negotiating = false;
  lines.forEach((l, i) => {
    const at = timings?.[i] ? t0 + timings[i].start : t;
    if (l.speaker === "agent" && !negotiating) { steps.push({ t: at, state: "NEGOTIATING" }); negotiating = true; }
    if (l.event !== "none" && !negotiating) { steps.push({ t: at, state: "NEGOTIATING" }); negotiating = true; }
    const step: Step = { t: at, speaker: l.speaker, text: stripTags(l.text) };
    if (l.event !== "none") {
      step.state = l.event;
      if (l.event === "SLOT_OFFERED") step.payload = { starts_at: effect.starts_at };
      if (l.event === "BOOKED" || l.event === "CANCELLED") step.payload = effect;
      if (l.event === "WAITLISTED") step.payload = { effect: "waitlist" };
    }
    steps.push(step);
    // reading speed fallback when there is no audio: ~14 chars/s + a breath between turns
    t = timings?.[i] ? t0 + timings[i].end + 0.25 : at + Math.max(1.6, stripTags(l.text).length / 14) + 0.5;
  });
  return { steps, end: t };
}

/** Voices the call with two ElevenLabs voices in one take; stores mp3 + cue sheet. */
export async function voiceDialogue(lines: GenLine[], f: DialogueFacts) {
  const officeVoice = f.receptionist.gender === "f" ? VOICES.officeF() : VOICES.officeM();
  const dl: DialogueLine[] = lines.map((l) => ({ speaker: l.speaker, text: l.text, voice: l.speaker === "agent" ? VOICES.agent() : officeVoice }));
  const id = clipId("dialogue", JSON.stringify(dl), f.lang);
  const t0 = Date.now();
  const audio = await renderDialogue(dl, f.lang);
  console.log(`[call audio] ${audio.duration.toFixed(1)}s of audio, ${dl.reduce((n, l) => n + l.text.length, 0)} chars, rendered in ${Date.now() - t0}ms`);
  const cues = lines.map((l, i) => ({ t: audio.segments[i]?.start ?? 0, speaker: l.speaker, text: stripTags(l.text), event: l.event === "none" ? null : l.event }));
  const meta = { name: id, duration: audio.duration, synthetic: true, voices: { agent: VOICES.agent(), office: officeVoice }, cues, peaks: peaks(audio.segments, audio.duration) };
  await putClip(id, audio.mp3, meta);
  return { src: `/api/audio/${id}.mp3`, timings: lines.map((_, i) => audio.segments[i] ?? { start: 0, end: 0 }), duration: audio.duration };
}

export function peaks(segs: { start: number; end: number }[], duration: number, n = 120) {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  return Array.from({ length: n }, (_, i) => {
    const t = (i / n) * duration;
    const talking = segs.some((s) => t >= s.start && t <= s.end);
    return talking ? Math.round((0.35 + rnd() * 0.65) * 100) / 100 : 0.04;
  });
}

const NAMES_F = ["Wanda", "Iris", "Carmen", "Yolanda", "Lizette", "Mildred", "Nilsa"];
const NAMES_M = ["Héctor", "Luis", "Ángel", "Edwin"];
export function receptionistFor(seed: number) {
  const m = seed % 4 === 3;
  const list = m ? NAMES_M : NAMES_F;
  return { name: list[Math.abs(seed) % list.length], gender: (m ? "m" : "f") as "f" | "m" };
}

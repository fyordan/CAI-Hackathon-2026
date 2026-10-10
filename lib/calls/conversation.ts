// AI-to-AI phone call. Two separate model sessions talk turn by turn:
//   office — the receptionist, who privately knows the office's calendar, hours and plans
//   agent  — CitaYa, who knows the patient's request and checks every offer against it
// Nobody scripts the outcome: the simulator only decides what is in the office's calendar
// (built from the request's real constraints); whether a slot is offered, turned down, booked
// or waitlisted comes out of the conversation. Offers are checked by code (slotSatisfies), so the
// agent can't "accept" something that breaks a constraint. State-machine events are derived from
// the actions afterwards. Any failure returns null and the caller falls back to the one-shot writer.
import { z } from "zod";
import { chatJSON } from "../ai/openrouter";
import type { DialogueFacts, GenLine } from "./dialogue";

export interface Opening { id: string; iso: string; text: string }
export type CallKind = "book" | "rebook" | "cancel";

export interface CallBrief {
  kind: CallKind;
  facts: DialogueFacts;
  openings: Opening[];                    // office's private calendar (book / rebook)
  hours: string;                          // "lun–vie 8AM–5PM"
  plans: string[];                        // insurer names the office accepts
  /** null when the slot works for the patient, else a short human reason it doesn't */
  check: (iso: string) => string | null;
}

export interface CallResult { lines: GenLine[]; outcome: "booked" | "waitlisted" | "nofit" | "cancelled"; startsAt: string | null }

const Turn = z.object({
  say: z.string(),
  action: z.enum(["none", "offer", "accept", "decline", "book", "waitlist", "cancelled", "end"]),
  opening_id: z.string(),
});
type TurnT = z.infer<typeof Turn>;
type Said = TurnT & { speaker: "agent" | "office" };

const MAX_TURNS = 14;
const lang = (f: DialogueFacts) => (f.lang === "en" ? "English" : "Puerto Rican Spanish (use usted)");

function officePrompt(b: CallBrief) {
  const f = b.facts;
  const cal = b.openings.length ? b.openings.map((o) => `- ${o.id}: ${o.text}`).join("\n") : "- (no openings)";
  return `You are ${f.receptionist.name}, the receptionist at ${f.office}, a doctor's office in Puerto Rico. You are on a phone call; reply with ONE short spoken turn in ${lang(f)}.
The caller is CitaYa, an automated scheduling assistant calling for a patient.

WHAT ONLY YOU KNOW
- Office hours: ${b.hours}
- Plans accepted: ${b.plans.join(", ")}
- Openings in your calendar, earliest first:
${cal}
${b.kind === "cancel" ? `- The patient has an appointment ${f.currentText}.` : ""}${b.kind === "rebook" ? `- The patient is already booked ${f.currentText}.` : ""}

HOW TO ACT
- Your first turn answers the phone with the office name and your name.
- Offer openings one at a time, earliest first, as a real receptionist would (action "offer", opening_id = its id). If the caller says it doesn't work, offer the next one. Never invent openings that aren't listed.
- If the caller accepts an opening, you may ask one natural question (new patient? full name?) and then confirm it (action "book", opening_id = that id).
- If nothing works, offer the cancellation list; when they agree, confirm it (action "waitlist").
${b.kind === "cancel" ? '- If they ask to cancel, confirm the cancellation (action "cancelled").\n' : ""}- If they ask about a plan, answer from the list above.
- After the call is settled, say a brief goodbye with action "end".
- Otherwise action "none" and opening_id "". Keep turns under 160 characters, natural and warm, with small acknowledgements (${f.lang === "en" ? '"Mm-hm", "Let me see…"' : '"Ajá", "Déjeme ver…"'}). Every word in ${lang(f)}.
- Say dates and times the way people speak them; spell numbers out as words.`;
}

/** What CitaYa is trying to get done on this call (shared with the live phone agent, lib/live/). */
export function goalFor(b: Pick<CallBrief, "kind" | "facts">) {
  const f = b.facts;
  return b.kind === "book"
    ? `Book a ${f.specialty} appointment that fits ALL of these: days ${f.days || "any weekday"}; times ${f.timeText || "office hours"}; ${f.deadlineText ? `timing ${f.deadlineText} (that last day itself is fine)` : "no deadline"}. Plan: ${f.insurance}.${f.notes.length ? ` Also ask about: ${f.notes.join("; ")}.` : ""} If nothing fits, ask to be put on the cancellation list.`
    : b.kind === "rebook"
      ? `The patient is booked ${f.currentText}. Ask whether anything earlier has opened. Take an earlier opening only if it fits; ask them to release the old one.`
      : `The patient is booked ${f.currentText} and can't make it. Cancel it so the slot goes to someone else (no reason beyond "no puede asistir").`;
}

function agentPrompt(b: CallBrief) {
  const f = b.facts;
  const goal = goalFor(b);
  return `You are CitaYa, an automated scheduling assistant on a phone call with a doctor's office, calling on behalf of ${f.patient}${f.caller_relation ? ` (arranged by ${f.caller_relation})` : ""}. Reply with ONE short spoken turn in ${lang(f)}.

GOAL: ${goal}

HOW TO ACT
- Your first turn MUST open by saying you are CitaYa, an automated assistant (not a person), calling on behalf of ${f.patient}; then say what you need.
- Share only what's needed: specialty, constraints, plan. Minimum health detail. Never invent a date of birth or ID; the patient will bring the plan card.
- After each offer you get a private [calendar check] note. Trust it: accept (action "accept", opening_id = that id) only if it says the opening fits; otherwise politely turn it down (action "decline", opening_id = that id) and ask for something else.
- If the office asks a question (new patient? name?), answer it and wait: end only after the office has confirmed the booking, the waitlist or the cancellation. Then thank them and end (action "end").
- Otherwise action "none" and opening_id "". Keep turns under 160 characters, natural, polite and brief.
- Say dates and times the way people speak them; spell numbers out as words.`;
}

/** The transcript from one side's point of view: its own lines are "assistant", the other side's are "user". */
function viewFor(me: "agent" | "office", b: CallBrief, said: Said[]) {
  const msgs = said.map((s) => {
    let content = s.say;
    if (me === "agent" && s.speaker === "office" && s.action === "offer") {
      const o = b.openings.find((x) => x.id === s.opening_id);
      if (o) { const bad = b.check(o.iso); content += `\n[calendar check: ${o.id} = ${o.text} → ${bad ? `does NOT fit (${bad})` : "fits every constraint"}]`; }
    }
    return { role: (s.speaker === me ? "assistant" : "user") as "assistant" | "user", content };
  });
  if (!msgs.length || msgs[msgs.length - 1].role === "assistant") msgs.push({ role: "user", content: me === "office" ? "(the phone rings; you pick up)" : "(your turn)" });
  return msgs;
}

export async function runConversation(b: CallBrief, budgetMs = Number(process.env.CONVERSATION_TIMEOUT_MS || 30000)): Promise<CallResult | null> {
  const t0 = Date.now();
  const said: Said[] = [];
  const sys = { office: officePrompt(b), agent: agentPrompt(b) };
  let speaker: "agent" | "office" = "office";
  let settled = false;
  let accepted = false; // agent took an opening the office hasn't confirmed yet
  for (let i = 0; i < MAX_TURNS; i++) {
    const left = budgetMs - (Date.now() - t0);
    if (left < 1500) { console.warn("[conversation] out of time"); return null; }
    const r = await chatJSON({ tier: "fast", name: `call_${speaker}`, schema: Turn, timeoutMs: Math.min(8000, left), temperature: 0.7,
      messages: [{ role: "system", content: sys[speaker] }, ...viewFor(speaker, b, said)] });
    if (!r || !r.data.say.trim()) return null;
    const turn: Said = { ...r.data, speaker };
    // an id that isn't in the calendar is just talk
    if (["offer", "accept", "decline", "book"].includes(turn.action) && !b.openings.some((o) => o.id === turn.opening_id)) turn.action = "none";
    said.push(turn);
    if (turn.speaker === "agent" && turn.action === "accept") accepted = true;
    // hanging up on an accepted-but-unconfirmed slot would lose it: let the office confirm first
    const early = turn.action === "end" && turn.speaker === "agent" && accepted && !settled;
    if ((turn.action === "end" && !early) || (settled && turn.speaker === "agent" && i > 2)) break;
    if (["book", "waitlist", "cancelled"].includes(turn.action)) settled = true;
    speaker = speaker === "office" ? "agent" : "office";
  }
  const result = toResult(b, said);
  if (result) console.log(`[conversation] ${b.kind} → ${result.outcome} in ${said.length} turns, ${Date.now() - t0}ms`);
  return result;
}

/** Derive state-machine events from what was actually said and done. */
export function toResult(b: CallBrief, said: Said[]): CallResult | null {
  const lines: GenLine[] = said.map((s) => ({ speaker: s.speaker, text: s.say.trim(), event: "none" }));
  const idx = (pred: (s: Said) => boolean, from = 0) => said.findIndex((s, i) => i >= from && pred(s));
  const lastIdx = (pred: (s: Said) => boolean) => { for (let i = said.length - 1; i >= 0; i--) if (pred(said[i])) return i; return -1; };

  if (b.kind === "cancel") {
    const c = idx((s) => s.speaker === "office" && s.action === "cancelled");
    if (c < 0) return null;
    lines[c].event = "CANCELLED";
    return { lines, outcome: "cancelled", startsAt: null };
  }

  const bk = idx((s) => s.speaker === "office" && s.action === "book");
  if (bk >= 0) {
    const opening = b.openings.find((o) => o.id === said[bk].opening_id)!;
    if (b.check(opening.iso)) { console.warn(`[conversation] office booked ${opening.id}, which doesn't fit; rejecting`); return null; }
    let off = idx((s) => s.speaker === "office" && s.action === "offer" && s.opening_id === opening.id);
    if (off < 0 || off >= bk) off = bk - 1; // booked without a formal offer: the turn before carries it
    if (off < 0) return null;
    lines[off].event = "SLOT_OFFERED";
    lines[bk].event = "BOOKED";
    return { lines, outcome: "booked", startsAt: opening.iso };
  }

  if (b.kind === "rebook") return null; // a move that didn't happen isn't worth showing; fall back
  const wl = idx((s) => s.speaker === "office" && s.action === "waitlist");
  let no = lastIdx((s) => s.speaker === "agent" && s.action === "decline");
  if (wl >= 0 && (no < 0 || no > wl)) no = lastIdx((s) => s.speaker === "agent" && said.indexOf(s) < wl);
  if (no < 0) no = lastIdx((s) => s.speaker === "agent");
  if (no < 0) return null;
  lines[no].event = "NO_FIT";
  if (wl > no) { lines[wl].event = "WAITLISTED"; return { lines, outcome: "waitlisted", startsAt: null }; }
  return { lines, outcome: "nofit", startsAt: null };
}

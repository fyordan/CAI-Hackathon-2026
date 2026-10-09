import type { CallState } from "../types";

export const TRANSITIONS: Record<CallState, CallState[]> = {
  QUEUED: ["DIALING"],
  DIALING: ["RINGING", "BUSY", "FAILED"],
  RINGING: ["HUMAN", "IVR", "NO_ANSWER", "VOICEMAIL"],
  IVR: ["HUMAN"],
  HUMAN: ["NEGOTIATING"],
  NEGOTIATING: ["SLOT_OFFERED", "NO_FIT", "CANCELLED"],
  SLOT_OFFERED: ["BOOKED", "NO_FIT"],
  NO_FIT: ["WAITLISTED", "COMPLETED"],
  BUSY: ["RETRY_SCHEDULED", "GAVE_UP"],
  FAILED: ["RETRY_SCHEDULED", "GAVE_UP"],
  NO_ANSWER: ["RETRY_SCHEDULED", "GAVE_UP"],
  VOICEMAIL: ["RETRY_SCHEDULED", "GAVE_UP"],
  RETRY_SCHEDULED: ["DIALING"],
  BOOKED: ["COMPLETED"],
  WAITLISTED: ["COMPLETED"],
  CANCELLED: ["COMPLETED"],
  GAVE_UP: [],
  COMPLETED: [],
};

export const MAX_ATTEMPTS = 2;
export const TERMINAL: CallState[] = ["COMPLETED", "GAVE_UP"];

export class InvalidTransition extends Error {}

export function transition(from: CallState, to: CallState): CallState {
  if (!TRANSITIONS[from].includes(to)) throw new InvalidTransition(`${from} → ${to}`);
  return to;
}

/** After a failed attempt: retry with exponential backoff, or give up. */
export function afterFailedAttempt(attempt: number, baseSec = 30): { next: CallState; delaySec: number | null } {
  return attempt < MAX_ATTEMPTS ? { next: "RETRY_SCHEDULED", delaySec: baseSec * 2 ** attempt } : { next: "GAVE_UP", delaySec: null };
}

/** Validate a whole timeline (used by tests and as a guard in the simulator). */
export function validatePath(states: CallState[]) {
  let s: CallState = "QUEUED";
  for (const n of states) s = transition(s, n);
  return s;
}

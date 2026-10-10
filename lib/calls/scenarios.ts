// SIMULATED PHONE CALLS. No real phone call is placed anywhere in this build.
// Each call is a deterministic timeline (seeded) of state changes + transcript lines. Answered
// calls are replaced by an AI-to-AI conversation (conversation.ts) when a model is configured;
// these template lines are the offline fallback.
import { validatePath } from "./machine";
import type { CallState, Lang } from "../types";

export interface Step {
  t: number; // seconds after call start
  state?: CallState;
  speaker?: "agent" | "office" | "system";
  text?: string;
  payload?: Record<string, unknown>;
}

export type Scenario = "success" | "no_answer" | "busy_nofit" | "ivr_nofit" | "voicemail" | "rebook" | "cancel";

export interface ScenarioCtx {
  lang: Lang;
  patient: string;
  specialty: string;
  days: string;            // "los jueves" / "on Thursdays" / ""
  insurance: string;
  offerISO?: string;       // slot the office offers (success)
  offerText?: string;      // human text for offer
  laterText?: string;      // first opening that does NOT fit (no-fit cases)
  currentText?: string;    // existing appointment (rebook/cancel)
}

const L = (lang: Lang, es: string, en: string) => (lang === "en" ? en : es);
const GAP = 2.6;

function talk(start: number, lines: [Step["speaker"], string, Partial<Step>?][]): Step[] {
  return lines.map(([speaker, text, extra], i) => ({ t: start + i * GAP, speaker, text, ...extra }));
}

function intro(c: ScenarioCtx) {
  return L(c.lang,
    `Buenos días, le habla CitaYa, un asistente automatizado, llamando de parte de ${c.patient}. Busco una cita de ${c.specialty}${c.days ? ` ${c.days}` : ""}.`,
    `Good morning, this is CitaYa, an automated assistant calling for ${c.patient}. I'm looking for a ${c.specialty} appointment${c.days ? ` ${c.days}` : ""}.`);
}

function noFitTail(t0: number, c: ScenarioCtx): Step[] {
  return [
    ...talk(t0, [
      ["agent", intro(c), { state: "NEGOTIATING" }],
      ["office", L(c.lang, `Lo primero que tengo es ${c.laterText}.`, `The first thing I have is ${c.laterText}.`)],
      ["agent", L(c.lang, "Eso no le funciona. ¿La pueden apuntar en la lista de cancelaciones?", "That doesn't work for her. Could you add her to the cancellation list?"), { state: "NO_FIT" }],
      ["office", L(c.lang, "Sí, la apunto.", "Sure, I'll add her."), { state: "WAITLISTED", payload: { effect: "waitlist" } }],
    ]),
    { t: t0 + 4 * GAP, state: "COMPLETED" },
  ];
}

export function generateTimeline(s: Scenario, c: ScenarioCtx): Step[] {
  const sys = (t: number, state: CallState, es: string, en: string, payload?: Step["payload"]): Step => ({ t, state, speaker: "system", text: L(c.lang, es, en), payload });
  let steps: Step[];
  switch (s) {
    case "success":
      steps = [sys(0.3, "DIALING", "Marcando…", "Dialing…"), sys(1.4, "RINGING", "Sonando…", "Ringing…"), sys(4, "HUMAN", "Contestó una persona", "A person answered"),
        ...talk(4.2, [
          ["office", L(c.lang, "Buenos días, ¿en qué le ayudo?", "Good morning, how can I help?")],
          ["agent", intro(c), { state: "NEGOTIATING" }],
          ["office", L(c.lang, `Tengo ${c.offerText}.`, `I have ${c.offerText}.`), { state: "SLOT_OFFERED", payload: { starts_at: c.offerISO } }],
          ["agent", L(c.lang, `Perfecto. ¿Aceptan ${c.insurance}?`, `Great. Do you take ${c.insurance}?`)],
          ["office", L(c.lang, "Sí. Queda separada.", "Yes. You're all set."), { state: "BOOKED", payload: { effect: "book", starts_at: c.offerISO } }],
          ["agent", L(c.lang, "Muchas gracias.", "Thank you so much.")],
        ]),
        { t: 4.2 + 6 * GAP, state: "COMPLETED" }];
      break;
    case "rebook":
      steps = [sys(0.3, "DIALING", "Marcando…", "Dialing…"), sys(1.4, "RINGING", "Sonando…", "Ringing…"), sys(3.5, "HUMAN", "Contestó una persona", "A person answered"),
        ...talk(3.7, [
          ["agent", L(c.lang, `Buenas, le habla CitaYa de parte de ${c.patient}. Tiene cita ${c.currentText}. ¿Se ha abierto algo antes?`, `Hi, this is CitaYa for ${c.patient}. She's booked ${c.currentText}. Has anything earlier opened up?`), { state: "NEGOTIATING" }],
          ["office", L(c.lang, `Sí, se abrió ${c.offerText}.`, `Yes, ${c.offerText} just opened.`), { state: "SLOT_OFFERED", payload: { starts_at: c.offerISO } }],
          ["agent", L(c.lang, "La tomamos y liberamos la anterior.", "We'll take it and release the old one.")],
          ["office", L(c.lang, "Hecho.", "Done."), { state: "BOOKED", payload: { effect: "rebook", starts_at: c.offerISO } }],
        ]),
        { t: 3.7 + 4 * GAP, state: "COMPLETED" }];
      break;
    case "cancel":
      steps = [sys(0.3, "DIALING", "Marcando…", "Dialing…"), sys(1.4, "RINGING", "Sonando…", "Ringing…"), sys(3.5, "HUMAN", "Contestó una persona", "A person answered"),
        ...talk(3.7, [
          ["agent", L(c.lang, `Buenas, le habla CitaYa de parte de ${c.patient}. Llamo para cancelar su cita ${c.currentText}, para que se la den a otro paciente.`, `Hi, this is CitaYa for ${c.patient}. I'm calling to cancel ${c.currentText} so someone else can have it.`), { state: "NEGOTIATING" }],
          ["office", L(c.lang, "Queda cancelada, gracias por avisar.", "It's cancelled, thanks for letting us know."), { state: "CANCELLED", payload: { effect: "cancel" } }],
        ]),
        { t: 3.7 + 2 * GAP, state: "COMPLETED" }];
      break;
    case "no_answer":
      steps = [sys(0.3, "DIALING", "Marcando…", "Dialing…"), sys(1.2, "RINGING", "Sonando…", "Ringing…"),
        sys(7, "NO_ANSWER", "Nadie contestó", "No answer"), sys(7.2, "RETRY_SCHEDULED", "Reintento programado (30 s reales; acelerado en demo)", "Retry scheduled (30 s real; sped up for demo)", { backoff_sec: 30 }),
        sys(13, "DIALING", "Reintentando…", "Retrying…", { attempt: 2 }), sys(14, "RINGING", "Sonando…", "Ringing…"),
        sys(20, "NO_ANSWER", "Nadie contestó otra vez", "No answer again"), sys(20.3, "GAVE_UP", "Sin respuesta tras 2 intentos", "No answer after 2 attempts")];
      break;
    case "voicemail":
      steps = [sys(0.3, "DIALING", "Marcando…", "Dialing…"), sys(1.2, "RINGING", "Sonando…", "Ringing…"),
        sys(6, "VOICEMAIL", "Buzón de voz: dejó mensaje sin datos de salud", "Voicemail: left a callback message, no health details"),
        sys(9, "RETRY_SCHEDULED", "Reintento programado (acelerado en demo)", "Retry scheduled (sped up for demo)", { backoff_sec: 30 }),
        sys(16, "DIALING", "Reintentando…", "Retrying…", { attempt: 2 }), sys(17, "RINGING", "Sonando…", "Ringing…"),
        sys(23, "NO_ANSWER", "Nadie contestó", "No answer"), sys(23.3, "GAVE_UP", "Sin respuesta tras 2 intentos", "No answer after 2 attempts")];
      break;
    case "busy_nofit":
      steps = [sys(0.3, "DIALING", "Marcando…", "Dialing…"), sys(1.0, "BUSY", "Línea ocupada", "Line busy"),
        sys(1.2, "RETRY_SCHEDULED", "Reintento programado (acelerado en demo)", "Retry scheduled (sped up for demo)", { backoff_sec: 30 }),
        sys(8, "DIALING", "Reintentando…", "Retrying…", { attempt: 2 }), sys(9, "RINGING", "Sonando…", "Ringing…"), sys(11.5, "HUMAN", "Contestó una persona", "A person answered"),
        ...noFitTail(11.7, c)];
      break;
    case "ivr_nofit":
      steps = [sys(0.3, "DIALING", "Marcando…", "Dialing…"), sys(1.2, "RINGING", "Sonando…", "Ringing…"),
        { t: 3, state: "IVR", speaker: "office", text: L(c.lang, "Gracias por llamar. Para citas, oprima 2.", "Thanks for calling. For appointments, press 2.") },
        { t: 5.5, speaker: "system", text: L(c.lang, "El agente marcó 2", "Agent pressed 2") },
        sys(8, "HUMAN", "Contestó una persona", "A person answered"), ...noFitTail(8.2, c)];
      break;
  }
  validatePath(steps.filter((x) => x.state).map((x) => x.state!)); // throws if a scenario is malformed
  return steps;
}

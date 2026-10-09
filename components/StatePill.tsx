import type { Lang } from "@/lib/types";

const LABEL: Record<string, { es: string; en: string; tone: string }> = {
  QUEUED: { es: "En cola", en: "Queued", tone: "idle" },
  DIALING: { es: "Marcando", en: "Dialing", tone: "wait" },
  RINGING: { es: "Sonando", en: "Ringing", tone: "wait" },
  BUSY: { es: "Ocupado", en: "Busy", tone: "warn" },
  FAILED: { es: "Falló", en: "Failed", tone: "warn" },
  NO_ANSWER: { es: "No contestan", en: "No answer", tone: "warn" },
  VOICEMAIL: { es: "Buzón de voz", en: "Voicemail", tone: "warn" },
  IVR: { es: "Menú telefónico", en: "Phone menu", tone: "wait" },
  HUMAN: { es: "Conectado", en: "Connected", tone: "talk" },
  NEGOTIATING: { es: "Hablando", en: "Talking", tone: "talk" },
  SLOT_OFFERED: { es: "Ofrecen espacio", en: "Slot offered", tone: "talk" },
  BOOKED: { es: "Confirmada", en: "Booked", tone: "ok" },
  NO_FIT: { es: "No cuadra", en: "Doesn't fit", tone: "muted" },
  WAITLISTED: { es: "En lista de espera", en: "Waitlisted", tone: "muted" },
  RETRY_SCHEDULED: { es: "Reintentará", en: "Will retry", tone: "warn" },
  GAVE_UP: { es: "Sin respuesta", en: "No response", tone: "muted" },
  CANCELLED: { es: "Cancelada", en: "Cancelled", tone: "ok" },
  COMPLETED: { es: "Terminada", en: "Done", tone: "muted" },
};

export function stateLabel(state: string, lang: Lang) {
  return LABEL[state]?.[lang] ?? state;
}

export function StatePill({ state, lang, outcome }: { state: string; lang: Lang; outcome?: string }) {
  const s = outcome ?? state;
  return <span className={`pill tone-${LABEL[s]?.tone ?? "idle"}`} data-state={s}>{stateLabel(s, lang)}</span>;
}

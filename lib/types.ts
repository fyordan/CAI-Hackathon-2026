// Shared domain types. The LLM (or the offline rule-based brain) only ever
// produces a ProviderQuery patch — never SQL, never free-form actions.

export const SPECIALTIES = [
  "podiatry", "dermatology", "cardiology", "family_medicine", "ob_gyn", "pediatrics",
  "orthopedics", "ophthalmology", "ent", "gastroenterology", "endocrinology",
  "psychiatry", "dentistry", "neurology", "urology", "pulmonology", "urgent_care",
] as const;
export type Specialty = (typeof SPECIALTIES)[number];

export const SPECIALTY_LABEL: Record<Specialty, { es: string; en: string; icon: string }> = {
  podiatry: { es: "Podiatría", en: "Podiatry", icon: "🦶" },
  dermatology: { es: "Dermatología", en: "Dermatology", icon: "🧴" },
  cardiology: { es: "Cardiología", en: "Cardiology", icon: "🫀" },
  family_medicine: { es: "Medicina de familia", en: "Family medicine", icon: "🩺" },
  ob_gyn: { es: "Ginecología", en: "OB-GYN", icon: "🌸" },
  pediatrics: { es: "Pediatría", en: "Pediatrics", icon: "🧸" },
  orthopedics: { es: "Ortopedia", en: "Orthopedics", icon: "🦴" },
  ophthalmology: { es: "Oftalmología", en: "Ophthalmology", icon: "👁️" },
  ent: { es: "Otorrinolaringología", en: "ENT", icon: "👂" },
  gastroenterology: { es: "Gastroenterología", en: "Gastroenterology", icon: "🫃" },
  endocrinology: { es: "Endocrinología", en: "Endocrinology", icon: "🧪" },
  psychiatry: { es: "Psiquiatría", en: "Psychiatry", icon: "🧠" },
  dentistry: { es: "Dentista", en: "Dentistry", icon: "🦷" },
  neurology: { es: "Neurología", en: "Neurology", icon: "🧠" },
  urology: { es: "Urología", en: "Urology", icon: "💧" },
  pulmonology: { es: "Neumología", en: "Pulmonology", icon: "🫁" },
  urgent_care: { es: "Sala de urgencias", en: "Urgent care", icon: "🚑" },
};

export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat";
export const WEEKDAYS: Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat"];
export type Lang = "es" | "en";

export interface TimeWindow { start: string; end: string } // "HH:MM" local AST

export interface ProviderQuery {
  specialty: Specialty | null;
  specialty_confidence: number | null;
  days_of_week: Weekday[];          // empty = any weekday
  time_windows: TimeWindow[];       // empty = office hours
  earliest_date: string | null;     // YYYY-MM-DD
  latest_date: string | null;       // YYYY-MM-DD inclusive
  deadline_label: string | null;    // what the user said, e.g. "antes de Thanksgiving"
  asap: boolean;
  max_drive_min: number | null;
  drive_origins: ("home" | "work")[];
  origin_logic: "any" | "all";
  insurance: string | null;         // insurer id
  languages: Lang[];                // required clinician languages
  wheelchair: boolean;
  patient_is_requester: boolean;
  notes?: string[];                 // preferences we can't filter on; the calling agent raises them
}

export const emptyQuery = (): ProviderQuery => ({
  specialty: null, specialty_confidence: null, days_of_week: [], time_windows: [],
  earliest_date: null, latest_date: null, deadline_label: null, asap: false,
  max_drive_min: null, drive_origins: [], origin_logic: "any", insurance: null,
  languages: [], wheelchair: false, patient_is_requester: true,
});

export interface Place { label: string; lat: number; lng: number }

export interface Persona {
  id: string;
  name: string;
  age: number;
  blurb: string;
  need?: string;                // one line shown on the persona picker
  lang: Lang;
  home: Place;
  work: Place | null;
  insurance: string;            // insurer id
  email: string;
  patient?: { name: string; age: number; relation: string }; // caregiver mode
  suggested: string[];          // example utterances shown in the UI
  defaults?: Partial<ProviderQuery>;
}

export interface Provider {
  id: string;
  name: string;
  specialty: Specialty;
  address: string;
  municipio: string;
  lat: number;
  lng: number;
  phone: string;
  languages: Lang[];
  wheelchair: boolean;
  services: string[];
  insurers: string[];
  hours: { weekday: Weekday; opens: string; closes: string }[];
  answer_rate: number;
}

export interface Candidate extends Provider {
  drive_home_min: number | null;
  drive_work_min: number | null;
  best_origin: "home" | "work" | null;
  best_drive_min: number | null;
  included: boolean;
  excluded_reason: string | null;
  score: number;
  rank: number | null;
}

export type CallState =
  | "QUEUED" | "DIALING" | "RINGING" | "BUSY" | "FAILED" | "NO_ANSWER" | "VOICEMAIL"
  | "IVR" | "HUMAN" | "NEGOTIATING" | "SLOT_OFFERED" | "BOOKED" | "NO_FIT" | "WAITLISTED"
  | "RETRY_SCHEDULED" | "GAVE_UP" | "CANCELLED" | "COMPLETED";

export type CallPurpose = "book" | "rebook" | "cancel";

export interface CallEvent {
  id: number;
  call_id: string;
  at: string;               // ISO, wall clock
  to_state: CallState | null;
  speaker: "agent" | "office" | "system" | null;
  text: string | null;
  payload: Record<string, unknown> | null;
}

export interface CallTask {
  id: string;
  provider_id: string;
  provider_name: string;
  purpose: CallPurpose;
  scenario: string;
  state: CallState;
  attempt: number;
  started_at: string;
  audio: string | null;     // /api/audio/<id>.mp3 when the call was voiced
}

export interface Appointment {
  id: string;
  request_id: string;
  provider_id: string;
  provider_name: string;
  address: string;
  starts_at: string;        // ISO with -04:00
  status: "booked" | "superseded" | "cancelled";
  calendar_seq: number;
  previous_starts_at: string | null;
}

// SYNTHETIC DIRECTORY. Every clinic name, phone number (787-555-xxxx), hour, accepted plan,
// language and opening below is invented for the demo. Coordinates are approximate town
// locations in Puerto Rico. Production plan: seed names/addresses/taxonomy from the CMS
// NPPES NPI Registry (state=PR) and verify hours/plans with each office.
import type { Lang, Provider, Specialty, Weekday } from "./types";

type Row = [id: string, name: string, sp: Specialty, municipio: string, lat: number, lng: number,
  hours: string, insurers: string, langs: string, extra?: { wheelchair?: boolean; answer?: number; services?: string[] }];

const ALL_PLANS = "triple-s,triple-s-advantage,mcs-classicare,mmm-ma,mmm-vital,first-medical-vital,menonita-vital";
const COMMERCIAL_MA = "triple-s,triple-s-advantage,mcs-classicare,mmm-ma";

const SERVICES: Record<Specialty, string[]> = {
  podiatry: ["uña encarnada / ingrown nail", "pie diabético", "fascitis plantar", "juanetes", "ortesis"],
  dermatology: ["rash / dermatitis", "evaluación de lunares", "acné", "biopsia de piel", "psoriasis"],
  cardiology: ["seguimiento de arritmia", "ecocardiograma", "Holter", "prueba de esfuerzo", "hipertensión"],
  ob_gyn: ["examen anual", "Papanicolau", "prenatal", "planificación familiar", "sonografía"],
  family_medicine: ["chequeo general", "recetas", "referidos", "vacunas", "laboratorios"],
  pediatrics: ["niño sano", "vacunas", "otitis", "asma pediátrica"],
  orthopedics: ["rodilla", "hombro", "fracturas", "infiltraciones"],
  ophthalmology: ["examen de la vista", "glaucoma", "cataratas", "retina diabética"],
  ent: ["oídos", "sinusitis", "amígdalas", "audiometría"],
  gastroenterology: ["reflujo", "endoscopía", "colonoscopía"],
  endocrinology: ["diabetes", "tiroides", "hormonas"],
  psychiatry: ["ansiedad", "depresión", "manejo de medicamentos", "telepsiquiatría"],
  dentistry: ["limpieza", "caries", "extracciones", "emergencia dental"],
  urgent_care: ["urgencias", "suturas", "rayos X"],
};

const ROWS: Row[] = [
  // ── Podiatry: Marisol's cluster (Caguas home, Hato Rey work) ──
  ["pod-caguas", "Clínica del Pie Caguas", "podiatry", "Caguas", 18.233, -66.039, "mon-fri 08:00-16:00", "triple-s,mmm-vital,first-medical-vital", "es", { answer: 0.3 }],
  ["pod-hatorey", "Foot & Ankle Hato Rey", "podiatry", "San Juan (Hato Rey)", 18.415, -66.056, "mon-fri 08:00-17:00", "triple-s,triple-s-advantage,mcs-classicare,mmm-ma", "es,en", { answer: 0.8 }],
  ["pod-mendez", "Dr. A. Méndez, DPM", "podiatry", "Bayamón", 18.399, -66.155, "mon-fri 07:30-15:30;sat 08:00-12:00", "triple-s,mmm-ma,mmm-vital", "es,en", { answer: 0.5 }],
  ["pod-gurabo", "Podiatría Integral Gurabo", "podiatry", "Gurabo", 18.256, -65.973, "mon-thu 08:00-16:00", "triple-s,menonita-vital", "es", { answer: 0.6 }],
  ["pod-trujillo", "Centro Podiátrico Trujillo Alto", "podiatry", "Trujillo Alto", 18.355, -66.007, "mon-fri 09:00-17:00", "triple-s,mcs-classicare", "es", { answer: 0.4 }],
  ["pod-cayey", "Podiatría Familiar Cayey", "podiatry", "Cayey", 18.112, -66.166, "mon-wed 08:00-16:00;fri 08:00-14:00", "triple-s,mmm-vital", "es", { answer: 0.7 }],
  ["pod-carolina", "Pie Sano Carolina", "podiatry", "Carolina", 18.38, -65.957, "mon-fri 08:00-16:00", "mmm-vital,first-medical-vital,menonita-vital", "es", { answer: 0.7 }],
  ["pod-humacao", "Humacao Foot Clinic", "podiatry", "Humacao", 18.1497, -65.827, "mon-fri 08:00-16:00", "triple-s,mcs-classicare", "es,en", { answer: 0.7 }],
  ["pod-ponce", "Podiatría del Sur", "podiatry", "Ponce", 18.012, -66.611, "mon-fri 08:00-16:00", ALL_PLANS, "es"],
  ["pod-mayaguez", "Centro del Pie Mayagüez", "podiatry", "Mayagüez", 18.201, -67.139, "mon-fri 08:00-16:00", ALL_PLANS, "es,en"],
  ["pod-arecibo", "Podiatría Norte Arecibo", "podiatry", "Arecibo", 18.472, -66.716, "mon-fri 08:00-16:00", COMMERCIAL_MA, "es"],
  ["pod-sanjuan", "Podiatría Santurce", "podiatry", "San Juan (Santurce)", 18.448, -66.068, "tue-sat 08:00-15:00", "mmm-ma,mcs-classicare", "es,en", { answer: 0.6 }],

  // ── Cardiology: Don Ernesto's cluster (Ponce) ──
  ["car-ponce1", "Centro Cardiovascular del Sur", "cardiology", "Ponce", 18.0135, -66.617, "mon-fri 07:00-15:00", "mcs-classicare,triple-s-advantage,mmm-ma", "es", { answer: 0.75 }],
  ["car-ponce2", "Dra. L. Santiago, Cardiología", "cardiology", "Ponce", 18.005, -66.62, "mon-thu 08:00-16:00", "triple-s,triple-s-advantage", "es,en", { answer: 0.6 }],
  ["car-juanadiaz", "Cardiología Juana Díaz", "cardiology", "Juana Díaz", 18.053, -66.507, "mon-fri 08:00-12:00", "mcs-classicare,mmm-ma,menonita-vital", "es", { answer: 0.5 }],
  ["car-penuelas", "Clínica del Corazón Peñuelas", "cardiology", "Peñuelas", 18.056, -66.722, "mon-fri 08:00-16:00", "mcs-classicare,mmm-ma", "es", { wheelchair: false, answer: 0.6 }],
  ["car-coamo", "Cardiología Coamo", "cardiology", "Coamo", 18.08, -66.357, "mon-fri 08:00-16:00", "mcs-classicare", "es", { answer: 0.7 }],
  ["car-ponce3", "Instituto Cardiaco Ponce", "cardiology", "Ponce", 18.0, -66.6, "mon-fri 13:00-18:00", "mcs-classicare,triple-s-advantage", "es", { answer: 0.6 }],
  ["car-sanjuan", "Cardiología Centro Médico", "cardiology", "San Juan (Río Piedras)", 18.391, -66.072, "mon-fri 07:00-15:00", ALL_PLANS, "es,en"],
  ["car-caguas", "Cardio Caguas", "cardiology", "Caguas", 18.236, -66.04, "mon-fri 08:00-16:00", COMMERCIAL_MA, "es"],

  // ── Dermatology: Javi's cluster (Bayamón home, Guaynabo work, Plan Vital) ──
  ["der-bayamon1", "Dermatología Bayamón Oeste", "dermatology", "Bayamón", 18.394, -66.165, "mon-fri 08:00-17:00", "triple-s,mmm-ma", "es", { answer: 0.7 }],
  ["der-bayamon2", "Clínica de la Piel Río Hondo", "dermatology", "Bayamón", 18.411, -66.17, "mon-fri 07:00-18:00", "mmm-vital,first-medical-vital,triple-s", "es,en", { answer: 0.6 }],
  ["der-guaynabo", "Dermatología Guaynabo", "dermatology", "Guaynabo", 18.357, -66.111, "mon-fri 07:30-18:30", "mmm-vital,mmm-ma,triple-s", "es,en", { answer: 0.5 }],
  ["der-catano", "Piel Sana Cataño", "dermatology", "Cataño", 18.44, -66.118, "mon-fri 09:00-15:00", "mmm-vital,menonita-vital", "es", { answer: 0.4 }],
  ["der-sanjuan", "Dermatología Condado", "dermatology", "San Juan (Condado)", 18.457, -66.073, "mon-fri 08:00-17:00", "triple-s,mcs-classicare", "es,en", { answer: 0.7 }],
  ["der-toabaja", "Dermatología Levittown", "dermatology", "Toa Baja", 18.444, -66.18, "mon-sat 07:00-19:00", "mmm-vital,first-medical-vital", "es", { answer: 0.55 }],
  ["der-caguas", "Derma Caguas", "dermatology", "Caguas", 18.234, -66.036, "mon-fri 08:00-16:00", COMMERCIAL_MA, "es"],
  ["der-ponce", "Dermatología del Sur", "dermatology", "Ponce", 18.01, -66.615, "mon-fri 08:00-16:00", ALL_PLANS, "es"],

  // ── OB-GYN: Ana Lucía's cluster (Dorado, English) ──
  ["obg-dorado1", "Dorado Women's Health", "ob_gyn", "Dorado", 18.461, -66.272, "mon-fri 08:00-16:00", "triple-s,mmm-ma", "es,en", { answer: 0.7 }],
  ["obg-dorado2", "Ginecología Dorado", "ob_gyn", "Dorado", 18.455, -66.262, "mon-fri 08:00-16:00", "triple-s,mmm-vital", "es", { answer: 0.6 }],
  ["obg-vegaalta", "Centro de la Mujer Vega Alta", "ob_gyn", "Vega Alta", 18.412, -66.331, "mon-thu 08:00-16:00", "triple-s,first-medical-vital", "es,en", { answer: 0.5 }],
  ["obg-toabaja", "OB-GYN Toa Baja", "ob_gyn", "Toa Baja", 18.444, -66.254, "mon-fri 08:00-17:00", "mcs-classicare,triple-s", "es", { answer: 0.6 }],
  ["obg-bayamon", "Bayamón Women's Clinic", "ob_gyn", "Bayamón", 18.398, -66.156, "mon-fri 07:00-15:00", "triple-s,mmm-ma", "es,en", { answer: 0.6 }],
  ["obg-sanjuan", "Ginecología Hato Rey", "ob_gyn", "San Juan (Hato Rey)", 18.42, -66.06, "mon-fri 08:00-16:00", ALL_PLANS, "es,en"],
  ["obg-caguas", "Centro de la Mujer Caguas", "ob_gyn", "Caguas", 18.235, -66.03, "mon-fri 08:00-16:00", ALL_PLANS, "es"],
];

// Filler so the rest of the island isn't empty (other specialties).
const FILL_TOWNS: [string, number, number][] = [
  ["San Juan", 18.4655, -66.1057], ["Bayamón", 18.3989, -66.1557], ["Caguas", 18.2342, -66.0356], ["Ponce", 18.0111, -66.6141],
  ["Mayagüez", 18.2013, -67.1397], ["Arecibo", 18.4724, -66.7157], ["Carolina", 18.3808, -65.9574], ["Humacao", 18.1497, -65.8274],
  ["Guaynabo", 18.3575, -66.111], ["Dorado", 18.4589, -66.2677], ["Fajardo", 18.3258, -65.6524], ["Aguadilla", 18.4275, -67.1541],
];
const FILL: [Specialty, string][] = [
  ["family_medicine", "Medicina de Familia"], ["pediatrics", "Pediatría"], ["orthopedics", "Ortopedia"], ["ophthalmology", "Centro de la Visión"],
  ["ent", "Otorrino"], ["gastroenterology", "Gastroenterología"], ["endocrinology", "Endocrinología"], ["psychiatry", "Salud Mental"],
  ["dentistry", "Dental"], ["urgent_care", "Urgencias"],
];

function parseHours(h: string) {
  const order: Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat"];
  const out: Provider["hours"] = [];
  for (const part of h.split(";")) {
    const [days, span] = part.trim().split(" ");
    const [opens, closes] = span.split("-");
    const [a, b] = days.split("-") as Weekday[];
    const i0 = order.indexOf(a), i1 = b ? order.indexOf(b) : i0;
    for (let i = i0; i <= i1; i++) out.push({ weekday: order[i], opens, closes });
  }
  return out;
}

let phone = 100;
const mk = (r: Row): Provider => ({
  id: r[0], name: r[1], specialty: r[2], municipio: r[3], lat: r[4], lng: r[5],
  address: `Calle Ficticia ${(phone * 7) % 300 + 1}, ${r[3]}, PR`,
  phone: `787-555-0${phone++}`,
  hours: parseHours(r[6]), insurers: r[7].split(","), languages: r[8].split(",") as Lang[],
  wheelchair: r[9]?.wheelchair ?? true, answer_rate: r[9]?.answer ?? 0.6,
  services: r[9]?.services ?? SERVICES[r[2]],
});

export function buildProviders(): Provider[] {
  phone = 100;
  const list = ROWS.map(mk);
  FILL.forEach(([sp, label], si) => {
    FILL_TOWNS.forEach(([town, lat, lng], ti) => {
      if ((si + ti) % 3 === 0) return; // not every town has every specialty
      const jitter = ((si * 13 + ti * 7) % 10) / 1000 - 0.005;
      list.push(mk([`${sp}-${ti}`, `${label} ${town}`, sp, town, lat + jitter, lng - jitter, ti % 2 ? "mon-fri 08:00-16:00" : "mon-fri 07:30-17:00;sat 08:00-12:00",
        ti % 3 ? ALL_PLANS : COMMERCIAL_MA, ti % 2 ? "es" : "es,en"]));
    });
  });
  return list;
}

/** Seeded office-side "truth" for the hero demo (the agent only learns it by calling). */
export const HERO_SLOTS = [
  { provider_id: "pod-hatorey", starts_at: "2026-11-05T10:00:00-04:00", status: "booked", release_at: null },
  { provider_id: "pod-hatorey", starts_at: "2026-11-19T10:00:00-04:00", status: "open", release_at: null },
  // someone else's appointment that gets cancelled "in 2 days" (virtual clock) → rebook target
  { provider_id: "pod-hatorey", starts_at: "2026-10-29T14:30:00-04:00", status: "booked", release_at: "2026-10-11T12:00:00-04:00" },
];

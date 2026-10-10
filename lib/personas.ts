import type { Persona } from "./types";

// Insurer names are real Puerto Rico carriers used only as filter labels.
// Which (synthetic) provider accepts which plan is made up.
export const INSURERS: Record<string, { name: string; program: string }> = {
  "triple-s": { name: "Triple-S Salud", program: "Commercial" },
  "triple-s-advantage": { name: "Triple-S Advantage", program: "Medicare Advantage" },
  "mcs-classicare": { name: "MCS Classicare", program: "Medicare Advantage" },
  "mmm-ma": { name: "MMM Healthcare", program: "Medicare Advantage" },
  "mmm-vital": { name: "MMM · Plan Vital", program: "Plan Vital (Medicaid)" },
  "first-medical-vital": { name: "First Medical · Plan Vital", program: "Plan Vital (Medicaid)" },
  "menonita-vital": { name: "Menonita · Plan Vital", program: "Plan Vital (Medicaid)" },
};

// All personas are fictional. Home/work points are approximate town locations.
export const PERSONAS: Persona[] = [
  {
    id: "marisol",
    name: "Marisol Rivera",
    age: 41,
    blurb: "Accountant. Lives in Caguas, works in Hato Rey. English.",
    need: "A painful ingrown toenail, Thursdays only, before Thanksgiving, ≤30 min from home or work",
    lang: "en",
    home: { label: "Home · Caguas", lat: 18.2385, lng: -66.026 },
    work: { label: "Work · Hato Rey", lat: 18.4225, lng: -66.059 },
    insurance: "triple-s",
    email: "marisol.demo@example.com",
    // no specialty named on purpose: the assistant infers podiatry from the symptom
    suggested: [
      "I have an ingrown toenail that's really hurting. I can only go on Thursdays, and I need it taken care of before Thanksgiving because I'll be away for two weeks.",
      "Thirty minutes, from home or from work.",
    ],
  },
  {
    id: "yadira",
    name: "Yadira Colón",
    age: 45,
    blurb: "Caregiver in Orlando booking for her father Don Ernesto (78) in Ponce. Spanish.",
    need: "Cardiology follow-up for her father, mornings, wheelchair access",
    lang: "es",
    home: { label: "Casa de Don Ernesto · Ponce", lat: 18.0111, lng: -66.6141 },
    work: null,
    insurance: "mcs-classicare",
    email: "yadira.demo@example.com",
    patient: { name: "Ernesto Colón", age: 78, relation: "padre" },
    suggested: [
      "Necesito un cardiólogo para el follow-up de mi papá, tiene arritmia. Por la mañana y con acceso para silla de ruedas.",
      "Lo antes posible. No más de 25 minutos de su casa.",
    ],
  },
  {
    id: "javi",
    name: "Javi Torres",
    age: 29,
    blurb: "Developer in Bayamón, office in Guaynabo. Speaks Spanglish. Plan Vital.",
    need: "Doesn't know which doctor: describes stomach symptoms by voice, weekdays, earliest opening",
    lang: "es",
    home: { label: "Casa · Bayamón", lat: 18.3989, lng: -66.1557 },
    work: { label: "Trabajo · Guaynabo", lat: 18.412, lng: -66.103 },
    insurance: "mmm-vital",
    email: "javi.demo@example.com",
    suggested: [
      "Oye, desde hace un mes me arde el estómago después de comer, sobre todo de noche, y me sube como un sabor agrio a la garganta. No sé qué médico me toca.",
      "Entre semana, lo antes posible. Hasta media hora de la casa o del trabajo.",
      "Dale, llámalos.",
    ],
  },
  {
    id: "ana",
    name: "Ana Lucía Bennett",
    age: 34,
    blurb: "Moved from Texas to Dorado, works remotely. English only.",
    need: "OB-GYN annual exam with an English-speaking doctor",
    lang: "en",
    home: { label: "Home · Dorado", lat: 18.4589, lng: -66.2677 },
    work: null,
    insurance: "triple-s",
    email: "ana.demo@example.com",
    suggested: [
      "I need my annual OB-GYN exam with a doctor who speaks English, sometime in the next month.",
      "Within 20 minutes of home.",
    ],
  },
];

export const getPersona = (id: string) => PERSONAS.find((p) => p.id === id) ?? PERSONAS[0];

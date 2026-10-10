import { describe, expect, it } from "vitest";
import { detectLang, effectiveLatest, extract, redFlag, triage } from "@/lib/brain/rules";
import { noFitReply, runTurn } from "@/lib/brain/turn";
import { getPersona } from "@/lib/personas";
import { emptyQuery, type ProviderQuery } from "@/lib/types";

const TODAY = "2026-10-09";
const marisol = getPersona("carmen"); // the podiatry case: Caguas home, Hato Rey work

describe("triage: symptom → specialty (ES / EN / Spanglish)", () => {
  const cases: [string, string, string?][] = [
    ["Tengo una uña encarnada que me duele", "podiatry"],
    ["My heel hurts every morning when I step out of bed", "podiatry"],
    ["Me salió un rash en los brazos que no se va", "dermatology"],
    ["I have this mole que ha cambiado de color", "dermatology"],
    ["Necesito mi follow-up del corazón, tengo arritmia", "cardiology"],
    ["Mi nena de 4 años tiene otitis otra vez", "pediatrics", "ent"],
    ["mi chequeo ginecológico anual", "ob_gyn"],
    ["Se me nubla la vista para leer", "ophthalmology"],
    ["Tengo reflujo hace meses", "gastroenterology"],
    ["Mi tiroides está fuera de control", "endocrinology"],
    ["Me duele la rodilla desde que jugué baloncesto", "orthopedics"],
    ["Ando con mucha ansiedad y no duermo", "psychiatry"],
    ["Necesito un médico primario nuevo", "family_medicine"],
    ["Me duele una muela", "dentistry"],
    ["Tengo los pies dormidos y soy diabético", "podiatry", "endocrinology"],
  ];
  it.each(cases)("%s → %s", (text, want, alt) => {
    const r = triage(text);
    expect(r.specialty).toBe(want);
    if (alt) expect(r.alternatives).toContain(alt);
  });
  it("unknown text yields no specialty", () => expect(triage("hola, buenas").specialty).toBeNull());
});

describe("red flags run before anything else", () => {
  it.each([
    ["Tengo dolor de pecho y el brazo izquierdo dormido", "chest_pain"],
    ["My dad's face is drooping and he can't talk right", "stroke"],
    ["No puedo respirar bien, me falta el aire", "breathing"],
    ["Me corté y no para de sangrar", "bleeding"],
    ["Me quiero morir, ya no aguanto", "self_harm"],
    ["Mi bebé de 2 meses tiene fiebre", "infant_fever"],
  ])("%s → %s", (text, id) => expect(redFlag(text)?.id).toBe(id));
  it.each([
    "Uña encarnada roja, con pus",
    "Tuve dolor de pecho el año pasado, necesito follow-up con cardiología",
    "Necesito un cardiólogo para el follow-up de mi papá, tiene arritmia",
  ])("not an emergency: %s", (text) => expect(redFlag(text)).toBeNull());
  it("crisis messages are flagged as crisis", () => expect(redFlag("I want to die")?.crisis).toBe(true));
  it("emergency turns never search", async () => {
    const r = await runTurn({ text: "me duele el pecho ahora mismo, dolor de pecho fuerte", today: TODAY, persona: marisol, query: emptyQuery(), expecting: null });
    expect(r.action).toBe("emergency");
    expect(r.reply).toMatch(/911/);
  });
});

describe("constraint extraction", () => {
  const q0 = emptyQuery();
  it("X1 Thursdays before Thanksgiving", () => {
    const p = extract("solo puedo los jueves y quiero resolverlo antes de Thanksgiving porque me voy dos semanas", TODAY, marisol, q0, null);
    expect(p.days_of_week).toEqual(["thu"]);
    expect(p.latest_date).toBe("2026-11-25");
    expect(effectiveLatest({ ...q0, ...p } as ProviderQuery)).toBe("2026-11-19");
  });
  it("X2 thirty minutes from home or work", () => {
    const p = extract("Treinta minutos, de mi casa o del trabajo.", TODAY, marisol, q0, "drive");
    expect(p).toMatchObject({ max_drive_min: 30, drive_origins: ["home", "work"], origin_logic: "any" });
  });
  it("X2b bare number when the drive question is pending", () => {
    expect(extract("25", TODAY, marisol, q0, "drive").max_drive_min).toBe(25);
  });
  it("X3 Spanglish time windows on weekdays", () => {
    const p = extract("Weekdays antes de las 9 o después de las 4, lo antes posible", TODAY, getPersona("javi"), q0, null);
    expect(p.days_of_week).toEqual(["mon", "tue", "wed", "thu", "fri"]);
    expect(p.time_windows).toEqual([{ start: "07:00", end: "09:00" }, { start: "16:00", end: "18:00" }]);
    expect(p.asap).toBe(true);
  });
  it("X4 English-speaking clinician", () => expect(extract("with a doctor who speaks English", TODAY, getPersona("ana"), q0, null).languages).toEqual(["en"]));
  it("X5 caregiver, mornings, wheelchair", () => {
    const p = extract("por la mañana y con acceso para silla de ruedas para mi papá", TODAY, getPersona("yadira"), q0, null);
    expect(p).toMatchObject({ time_windows: [{ start: "07:00", end: "12:00" }], wheelchair: true, patient_is_requester: false });
  });
  it("X6 government plan with MMM → Plan Vital", () => expect(extract("tengo el plan del gobierno, con MMM", TODAY, marisol, q0, null).insurance).toBe("mmm-vital"));
  it("X7 next week", () => expect(extract("la semana que viene", TODAY, marisol, q0, null)).toMatchObject({ earliest_date: "2026-10-12", latest_date: "2026-10-17" }));
  it("X8 'no sé' to the drive question uses a default instead of re-asking", () => expect(extract("no sé, lo que sea", TODAY, marisol, q0, "drive").max_drive_min).toBe(30));
  it("language detection", () => {
    expect(detectLang("Tengo una uña encarnada")).toBe("es");
    expect(detectLang("I need my annual exam")).toBe("en");
    expect(detectLang("Me salió un rash, I need a dermatologist for my arms")).toBe("mixed");
  });
});

describe("ask vs search", () => {
  it("D1 specialty only → asks one question", async () => {
    const r = await runTurn({ text: "Necesito un podiatra", today: TODAY, persona: marisol, query: { ...emptyQuery(), insurance: "triple-s" }, expecting: null });
    expect(r.action).toBe("ask");
    expect(r.missing).toEqual(["timing", "drive"]);
    expect(r.reply.match(/\?/g)?.length).toBe(1);
  });
  it("D2 Marisol's first message → asks only about driving", async () => {
    const r = await runTurn({ text: marisol.suggested[0], today: TODAY, persona: marisol, query: emptyQuery(), expecting: null });
    expect(r.action).toBe("ask");
    expect(r.expecting).toBe("drive");
  });
  it("D3 everything known → search, no question", async () => {
    const first = await runTurn({ text: marisol.suggested[0], today: TODAY, persona: marisol, query: emptyQuery(), expecting: null });
    const r = await runTurn({ text: marisol.suggested[1], today: TODAY, persona: marisol, query: first.query, expecting: first.expecting, convLang: "es" });
    expect(r.action).toBe("search");
    expect(r.query).toMatchObject({ specialty: "podiatry", days_of_week: ["thu"], max_drive_min: 30, insurance: "triple-s" });
  });
  it("Diego's story: a pediatric dermatologist is dermatology, Fridays, asap, 25 min from home", async () => {
    const m = getPersona("marisol");
    expect(triage(m.suggested[0]).specialty).toBe("dermatology");
    expect(triage("Mi nene necesita un dermatólogo pediátrico").specialty).toBe("dermatology");
    const first = await runTurn({ text: m.suggested[0], today: TODAY, persona: m, query: emptyQuery(), expecting: null });
    const r = await runTurn({ text: m.suggested[1], today: TODAY, persona: m, query: first.query, expecting: first.expecting, convLang: "en" });
    expect(r.action).toBe("search");
    expect(r.query).toMatchObject({ specialty: "dermatology", days_of_week: ["fri"], asap: true, max_drive_min: 25, insurance: "mmm-vital" });
  });
  it("Spanglish conversation keeps answering in Spanish", async () => {
    const r = await runTurn({ text: "Max 40 minutos from either", today: TODAY, persona: getPersona("javi"), query: { ...emptyQuery(), specialty: "dermatology", asap: true }, expecting: "drive", convLang: "es" });
    expect(r.reply).toMatch(/Listo/);
  });
});

describe("audit regressions (unscripted inputs)", () => {
  it.each([
    ["a mi mamá le duele el pecho ahora mismo", "chest_pain"],
    ["my chest hurts and my arm is numb", "chest_pain"],
    ["mi papá no puede mover el brazo izquierdo", "stroke"],
  ])("red flag: %s → %s", (text, id) => expect(redFlag(text)?.id).toBe(id));
  it("short English with 'me' is English", () => expect(detectLang("my tooth is killing me")).toBe("en"));
  it.each([
    ["tengo migraña", "neurology"],
    ["I keep getting dizzy spells", "neurology"],
    ["tengo asma y no se me controla", "pulmonology"],
  ])("triage: %s → %s", (text, want) => expect(triage(text).specialty).toBe(want));
});

describe("no office fits → honest reply, never a call promise", () => {
  const q: ProviderQuery = { ...emptyQuery(), specialty: "neurology", insurance: "mmm-vital", max_drive_min: 25 };
  it("names the dominant blocker (hours) in Spanish", () => {
    const r = noFitReply(["Horario no coincide", "No acepta MMM · Plan Vital", "Horario no coincide", "Horario no coincide"], q, "es");
    expect(r).toMatch(/^Todavía no he llamado/);
    expect(r).toMatch(/horario/);
    expect(r).not.toMatch(/llamo a las oficinas|empiezo a llamar/i);
  });
  it("drive blocker in English mentions the limit", () => {
    expect(noFitReply(["34 min away (max 25)", "41 min away (max 25)"], q, "en")).toMatch(/farther than 25 minutes/);
  });
  it("insurance blocker names the plan", () => {
    expect(noFitReply(["No acepta MMM · Plan Vital"], q, "es")).toMatch(/acepta MMM/);
  });
});

// Editable demo profiles. Built-in personas live in code (lib/personas.ts); edits to them and
// newly created personas are stored as rows here. "Restore" deletes the row, so the code
// version shows through again. Not truncated by demo reset.
import { z } from "zod";
import { one, q } from "./db";
import { INSURERS, PERSONAS } from "./personas";
import type { Persona } from "./types";

let ready: Promise<unknown> | null = null;
const ensure = () => (ready ??= q("CREATE TABLE IF NOT EXISTS personas (id text PRIMARY KEY, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())").catch((e) => { ready = null; throw e; }));

const builtIn = (id: string) => PERSONAS.find((p) => p.id === id) ?? null;

export async function listPersonas(): Promise<(Persona & { custom: boolean; edited: boolean })[]> {
  await ensure();
  const rows = await q<{ id: string; data: Persona }>("SELECT id, data FROM personas ORDER BY updated_at");
  const byId = new Map(rows.map((r) => [r.id, r.data]));
  const base = PERSONAS.map((p) => ({ ...(byId.get(p.id) ?? p), id: p.id, custom: false, edited: byId.has(p.id) }));
  const extra = rows.filter((r) => !builtIn(r.id)).map((r) => ({ ...r.data, id: r.id, custom: true, edited: false }));
  return [...base, ...extra];
}

export async function findPersona(id: string): Promise<Persona | null> {
  await ensure();
  const row = await one<{ data: Persona }>("SELECT data FROM personas WHERE id = $1", [id]);
  return row ? { ...row.data, id } : builtIn(id);
}

/** Engine-side lookup: never throws, falls back to the first built-in like getPersona(). */
export async function loadPersona(id: string): Promise<Persona> {
  return (await findPersona(id).catch(() => builtIn(id))) ?? PERSONAS[0];
}

const place = z.object({ label: z.string().trim().min(1).max(80), lat: z.number().min(17.8).max(18.6), lng: z.number().min(-67.4).max(-65.2) });
export const PersonaInput = z.object({
  name: z.string().trim().min(1).max(60),
  age: z.number().int().min(0).max(120),
  lang: z.enum(["es", "en"]),
  need: z.string().trim().max(140).optional(),
  home: place,
  work: place.nullable(),
  insurance: z.string().refine((x) => x in INSURERS, "unknown insurer"),
  email: z.email(),
  patient: z.object({ name: z.string().trim().min(1).max(60), age: z.number().int().min(0).max(120), relation: z.string().trim().min(1).max(30) }).nullable(),
  suggested: z.array(z.string().trim().min(1).max(400)).max(4),
});
export type PersonaInput = z.infer<typeof PersonaInput>;

const slug = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "persona";

export async function savePersona(id: string | null, input: PersonaInput): Promise<string> {
  await ensure();
  const pid = id ?? `${slug(input.name)}-${Math.random().toString(36).slice(2, 6)}`;
  const prev = id ? await findPersona(id) : null;
  const persona: Persona = {
    ...prev,
    id: pid,
    name: input.name, age: input.age, lang: input.lang, need: input.need || undefined,
    blurb: prev?.blurb ?? "",
    home: input.home, work: input.work, insurance: input.insurance, email: input.email,
    patient: input.patient ?? undefined,
    suggested: input.suggested,
  };
  await q("INSERT INTO personas (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()", [pid, JSON.stringify(persona)]);
  return pid;
}

/** Custom persona: removed. Built-in: edits discarded, original comes back. */
export async function deletePersona(id: string) {
  await ensure();
  await q("DELETE FROM personas WHERE id = $1", [id]);
}

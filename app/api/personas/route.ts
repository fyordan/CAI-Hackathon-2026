import { listPersonas, PersonaInput, savePersona } from "@/lib/profiles";
export const dynamic = "force-dynamic";
export async function GET() { return Response.json(await listPersonas()); }
export async function POST(req: Request) {
  const parsed = PersonaInput.safeParse(await req.json());
  if (!parsed.success) return Response.json({ error: parsed.error.issues }, { status: 400 });
  return Response.json({ id: await savePersona(null, parsed.data) });
}

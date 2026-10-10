import { deletePersona, findPersona, PersonaInput, savePersona } from "@/lib/profiles";
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };
export async function GET(_: Request, { params }: Ctx) {
  const p = await findPersona((await params).id);
  return p ? Response.json(p) : new Response("not found", { status: 404 });
}
export async function PUT(req: Request, { params }: Ctx) {
  const { id } = await params;
  if (!(await findPersona(id))) return new Response("not found", { status: 404 });
  const parsed = PersonaInput.safeParse(await req.json());
  if (!parsed.success) return Response.json({ error: parsed.error.issues }, { status: 400 });
  return Response.json({ id: await savePersona(id, parsed.data) });
}
export async function DELETE(_: Request, { params }: Ctx) {
  await deletePersona((await params).id);
  return Response.json({ ok: true });
}

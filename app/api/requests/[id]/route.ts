import { snapshot, tick } from "@/lib/engine";
export const dynamic = "force-dynamic";
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await tick(id);
  const s = await snapshot(id);
  return s ? Response.json(s) : new Response("not found", { status: 404 });
}

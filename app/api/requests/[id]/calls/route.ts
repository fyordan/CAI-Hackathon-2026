import { startCalls } from "@/lib/engine";
export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await startCalls(id);
  return Response.json({ ok: true });
}

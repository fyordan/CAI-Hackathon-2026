import { cancelAppointment } from "@/lib/engine";
export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await cancelAppointment(id);
  return Response.json({ ok: true });
}

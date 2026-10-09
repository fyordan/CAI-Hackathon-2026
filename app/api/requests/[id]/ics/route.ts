import { icsFor } from "@/lib/engine";
import { one } from "@/lib/db";
export const dynamic = "force-dynamic";
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const a = await one<{ id: string }>("SELECT id FROM appointments WHERE request_id=$1 ORDER BY (status='booked') DESC, created_at DESC LIMIT 1", [id]);
  if (!a) return new Response("no appointment", { status: 404 });
  return new Response(await icsFor(a.id), { headers: { "Content-Type": "text/calendar; charset=utf-8", "Content-Disposition": 'attachment; filename="cita.ics"' } });
}

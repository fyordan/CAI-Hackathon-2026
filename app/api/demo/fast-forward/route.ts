// Demo-only: jump the virtual clock and run the same handler a scheduled job (QStash) would call.
import { advanceClock } from "@/lib/demo";
import { rebookScan } from "@/lib/engine";
export async function POST(req: Request) {
  const { requestId, hours = 72 } = await req.json();
  const now = await advanceClock(hours);
  return Response.json({ virtual_now: now.toISOString(), scan: await rebookScan(requestId) });
}

// Live demo switches: real phone call for the booking office, WhatsApp on book/move/cancel.
// Numbers come from env (LIVE_CALL_TO, WHATSAPP_TO), never from the client.
import { liveStatus, setLiveSettings } from "@/lib/live/agent";
export const dynamic = "force-dynamic";

export async function GET() { return Response.json(await liveStatus()); }

export async function POST(req: Request) {
  const b = await req.json();
  await setLiveSettings({ calls: typeof b.calls === "boolean" ? b.calls : undefined, whatsapp: typeof b.whatsapp === "boolean" ? b.whatsapp : undefined });
  return Response.json(await liveStatus());
}

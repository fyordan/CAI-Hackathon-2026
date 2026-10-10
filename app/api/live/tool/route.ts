// Webhook tools for the live phone agent (ElevenLabs). Authenticated with a shared secret header
// that scripts/setup-live.ts puts on every tool; call_id comes from the call's dynamic variables.
import { timingSafeEqual } from "crypto";
import { liveTool } from "@/lib/engine";
export const dynamic = "force-dynamic";

const ok = (got: string | null) => {
  const want = process.env.LIVE_TOOL_SECRET;
  if (!want || !got || got.length !== want.length) return false;
  return timingSafeEqual(Buffer.from(got), Buffer.from(want));
};

export async function POST(req: Request) {
  if (!ok(req.headers.get("x-citaya-secret"))) return new Response("forbidden", { status: 403 });
  const { tool, call_id, datetime } = await req.json();
  const out = await liveTool(String(call_id), String(tool), datetime ? String(datetime) : undefined);
  console.log(`[live tool] ${tool} ${datetime ?? ""} →`, JSON.stringify(out));
  return Response.json(out);
}

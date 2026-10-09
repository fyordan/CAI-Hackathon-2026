// SSE: applies due call events and pushes a snapshot whenever something changed.
// Plain HTTP streaming (no WebSockets) so it runs on Vercel functions; the client reconnects.
import { snapshot, tick } from "@/lib/engine";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(ctrl) {
      let last = "";
      const until = Date.now() + 270_000;
      while (!req.signal.aborted && Date.now() < until) {
        try {
          await tick(id);
          const s = await snapshot(id);
          const body = JSON.stringify(s);
          if (body !== last) { ctrl.enqueue(enc.encode(`data: ${body}\n\n`)); last = body; }
          else ctrl.enqueue(enc.encode(`: ping\n\n`));
        } catch (e) {
          ctrl.enqueue(enc.encode(`event: error\ndata: ${JSON.stringify(String(e))}\n\n`));
        }
        await new Promise((r) => setTimeout(r, 350));
      }
      ctrl.close();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" } });
}

// One conversational turn, streamed as SSE so chips, shortlist and map update progressively.
// In offline/rules mode the computation is instant; the small gaps between chips are
// ARTIFICIAL pacing so the UI shows the same progressive build a streaming LLM produces.
import { chatTurn } from "@/lib/engine";
import { rankCandidates } from "@/lib/search";
import { q } from "@/lib/db";
import type { Provider, ProviderQuery } from "@/lib/types";
export const dynamic = "force-dynamic";

const ORDER: (keyof ProviderQuery)[][] = [["specialty", "specialty_confidence"], ["insurance"], ["patient_is_requester"], ["days_of_week"], ["latest_date", "deadline_label", "earliest_date"], ["asap"], ["time_windows"], ["max_drive_min", "drive_origins", "origin_logic"], ["languages"], ["wheelchair"]];

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { text } = await req.json();
  const before = (await q<{ query: ProviderQuery }>("SELECT query FROM care_requests WHERE id=$1", [id]))[0]?.query;
  const { turn, shortlist, persona } = await chatTurn(id, text);
  const pace = turn.engine === "rules" ? Number(process.env.DEMO_PACE_MS ?? 380) : 0;
  const lang = persona.lang === "en" ? "en" : "es";
  const enc = new TextEncoder();
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const stream = new ReadableStream({
    async start(ctrl) {
      const send = (event: string, data: unknown) => ctrl.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      send("meta", { engine: turn.engine, action: turn.action, paced_ms: pace });
      if (turn.action === "emergency") {
        send("emergency", { flag: turn.redFlag, reply: turn.reply });
        send("done", {});
        return ctrl.close();
      }
      await sleep(pace);
      // stream the query as a sequence of patches; re-rank the (already fetched) providers after each
      let partial: ProviderQuery = { ...before! };
      const providers = shortlist as unknown as Provider[];
      for (const group of ORDER) {
        const changed = group.filter((k) => JSON.stringify(turn.query[k]) !== JSON.stringify(partial[k]));
        if (!changed.length) continue;
        const patch = Object.fromEntries(group.map((k) => [k, turn.query[k]]));
        partial = { ...partial, ...patch };
        send("patch", { patch, query: partial });
        if (partial.specialty) send("shortlist", rankCandidates(providers, partial, persona, lang));
        await sleep(pace);
      }
      send("shortlist", shortlist);
      for (const w of turn.reply.split(/(\s+)/)) { send("token", w); if (pace) await sleep(18); }
      send("done", { action: turn.action, expecting: turn.expecting, missing: turn.missing });
      ctrl.close();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform" } });
}

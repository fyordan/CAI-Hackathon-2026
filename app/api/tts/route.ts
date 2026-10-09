// Spoken chat replies. GET so an <audio> element can start playing while bytes still stream in.
// Cached by content hash in Postgres: the same reply is only ever synthesized once.
import { elevenConfigured, getClip, putClip, speakStream, ttsClipId } from "@/lib/voice/elevenlabs";
export const dynamic = "force-dynamic";

const MAX_CHARS = Number(process.env.TTS_MAX_CHARS || 400); // free tier is 10k chars/month

export async function GET(req: Request) {
  if (!elevenConfigured()) return new Response("tts not configured", { status: 501 });
  const url = new URL(req.url);
  const text = (url.searchParams.get("text") ?? "").trim().slice(0, MAX_CHARS);
  const lang = url.searchParams.get("lang") === "en" ? "en" : "es";
  if (!text) return new Response("empty", { status: 400 });
  const id = ttsClipId(text, lang);
  const hit = await getClip(id);
  const headers = { "Content-Type": "audio/mpeg", "Cache-Control": "private, max-age=86400" };
  if (hit) return new Response(new Uint8Array(hit.data), { headers });
  try {
    const upstream = await speakStream(text, lang);
    const chunks: Uint8Array[] = [];
    const [toClient, toCache] = upstream.tee();
    (async () => {
      const r = toCache.getReader();
      for (;;) { const { value, done } = await r.read(); if (done) break; chunks.push(value); }
      await putClip(id, Buffer.concat(chunks), { kind: "tts", text, lang });
    })().catch((e) => console.warn("[tts] cache write failed", e.message));
    return new Response(toClient, { headers });
  } catch (e) {
    console.warn("[tts] failed", (e as Error).message);
    return new Response("tts failed", { status: 502 });
  }
}

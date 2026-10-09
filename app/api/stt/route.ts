// Mic audio (webm/opus from Chrome, mp4/aac from Safari) → ElevenLabs Scribe → text.
import { elevenConfigured, transcribe } from "@/lib/voice/elevenlabs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!elevenConfigured()) return Response.json({ error: "stt_not_configured" }, { status: 501 });
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof Blob) || file.size < 1000) return Response.json({ error: "empty_audio" }, { status: 400 });
  if (file.size > 10_000_000) return Response.json({ error: "audio_too_long" }, { status: 413 });
  const t0 = Date.now();
  try {
    const ext = file.type.includes("mp4") ? "m4a" : file.type.includes("ogg") ? "ogg" : "webm";
    const r = await transcribe(file, `mic.${ext}`);
    console.log(`[stt] ${Date.now() - t0}ms lang=${r.language} "${r.text.slice(0, 80)}"`);
    return Response.json({ ...r, ms: Date.now() - t0 });
  } catch (e) {
    console.warn("[stt] failed", (e as Error).message);
    return Response.json({ error: "stt_failed" }, { status: 502 });
  }
}

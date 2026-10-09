// Serves synthesized call audio from Postgres: /api/audio/<id>.mp3 (audio) and /api/audio/<id>.json
// (cue sheet in the same shape as public/calls/*.json, so CallPlayer treats both identically).
import { getClip } from "@/lib/voice/elevenlabs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params;
  const m = file.match(/^([a-f0-9]{32})\.(mp3|json)$/);
  if (!m) return new Response("not found", { status: 404 });
  const clip = await getClip(m[1]);
  if (!clip) return new Response("not found", { status: 404 });
  if (m[2] === "json") return Response.json(clip.meta ?? {});
  const data = new Uint8Array(clip.data);
  // Range support so the player can seek / join a call "live" mid-way
  const range = req.headers.get("range")?.match(/bytes=(\d*)-(\d*)/);
  const base = { "Content-Type": clip.mime, "Accept-Ranges": "bytes", "Cache-Control": "public, max-age=31536000, immutable" };
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), data.length - 1) : data.length - 1;
    return new Response(data.slice(start, end + 1), { status: 206, headers: { ...base, "Content-Range": `bytes ${start}-${end}/${data.length}`, "Content-Length": String(end - start + 1) } });
  }
  return new Response(data, { headers: { ...base, "Content-Length": String(data.length) } });
}

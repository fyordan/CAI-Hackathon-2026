// ElevenLabs: speech-to-text (Scribe), low-latency TTS for chat replies (Flash), and
// two-voice Text-to-Dialogue (v3) for the simulated office calls. Everything synthesized is
// cached in Postgres (audio_clips) by content hash, so replays cost no characters.
import { createHash } from "crypto";
import { one, q } from "../db";

const API = "https://api.elevenlabs.io/v1";
const key = () => process.env.ELEVENLABS_API_KEY ?? "";
export const elevenConfigured = () => !!process.env.ELEVENLABS_API_KEY;

// Free-tier accounts can only use premade voices via the API. On a paid plan, swap these for
// Puerto Rican voices from the library (e.g. "Leo - Corporate & Professional", "Veronica - Puerto Rican Spanish").
export const VOICES = {
  agent: () => process.env.ELEVENLABS_VOICE_AGENT || "iP95p4xoKVk53GoZ742B", // Chris: charming, down-to-earth
  officeF: () => process.env.ELEVENLABS_VOICE_OFFICE_F || "cgSgspJ2msm6clMCkdW9", // Jessica: warm
  officeM: () => process.env.ELEVENLABS_VOICE_OFFICE_M || "cjVigY5qzO86Huf0OWal", // Eric: smooth
};
const TTS_MODEL = () => process.env.ELEVENLABS_TTS_MODEL || "eleven_flash_v2_5";
const DIALOGUE_MODEL = () => process.env.ELEVENLABS_DIALOGUE_MODEL || "eleven_v3";
const STT_MODEL = () => process.env.ELEVENLABS_STT_MODEL || "scribe_v2";

export const clipId = (...parts: string[]) => createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 32);

export async function getClip(id: string) {
  return one<{ id: string; mime: string; data: Buffer; meta: Record<string, unknown> | null }>("SELECT * FROM audio_clips WHERE id=$1", [id]);
}
export async function putClip(id: string, data: Buffer, meta: Record<string, unknown> | null = null, mime = "audio/mpeg") {
  await q("INSERT INTO audio_clips (id, mime, data, meta) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data, meta=EXCLUDED.meta", [id, mime, data, meta ? JSON.stringify(meta) : null]);
}

/** Speech → text. Language is auto-detected (handles Spanglish); `lang` is only a hint for logging. */
export async function transcribe(file: Blob, filename: string): Promise<{ text: string; language: string | null }> {
  const form = new FormData();
  form.append("model_id", STT_MODEL());
  form.append("file", file, filename);
  form.append("tag_audio_events", "false");
  const res = await fetch(`${API}/speech-to-text`, { method: "POST", headers: { "xi-api-key": key() }, body: form });
  if (!res.ok) throw new Error(`stt ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  return { text: (j.text ?? "").trim(), language: j.language_code ?? null };
}

/** Streaming TTS for one chat reply. Returns the upstream body plus the cache id to fill. */
export async function speakStream(text: string, lang: "es" | "en") {
  const voice = VOICES.agent();
  const res = await fetch(`${API}/text-to-speech/${voice}/stream?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": key(), "Content-Type": "application/json" },
    body: JSON.stringify({ text, model_id: TTS_MODEL(), language_code: lang, voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.15, speed: 1.05 } }),
  });
  if (!res.ok || !res.body) throw new Error(`tts ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.body;
}
export const ttsClipId = (text: string, lang: string) => clipId("tts", TTS_MODEL(), VOICES.agent(), lang, text);

export interface DialogueLine { speaker: "agent" | "office"; text: string; voice: string }
export interface DialogueAudio { mp3: Buffer; segments: { index: number; start: number; end: number }[]; duration: number }

/**
 * Multi-voice dialogue with per-line timings (for the call cue sheet). Long calls are split into
 * contiguous chunks rendered in parallel and joined, which cuts a ~16 s render to ~half.
 */
export async function renderDialogue(lines: DialogueLine[], lang: "es" | "en"): Promise<DialogueAudio> {
  const n = Math.max(1, Math.min(Number(process.env.ELEVENLABS_CONCURRENCY || 2), Math.ceil(lines.length / 3)));
  const chunks = splitBalanced(lines, n);
  const parts = await Promise.all(chunks.map((c) => renderChunk(c.lines, lang)));
  const mp3s: Buffer[] = [];
  const segments: DialogueAudio["segments"] = [];
  let offset = 0;
  parts.forEach((p, k) => {
    const body = stripMp3Headers(p.mp3);
    mp3s.push(body);
    for (const s of p.segments) segments.push({ index: chunks[k].from + s.index, start: offset + s.start, end: offset + s.end });
    offset += body.length / 16000; // 128 kbps CBR → 16 kB/s
  });
  return { mp3: Buffer.concat(mp3s), segments, duration: offset };
}

function splitBalanced(lines: DialogueLine[], n: number) {
  const total = lines.reduce((a, l) => a + l.text.length, 0);
  const out: { from: number; lines: DialogueLine[] }[] = [];
  let cur: DialogueLine[] = [], from = 0, acc = 0;
  lines.forEach((l, i) => {
    cur.push(l);
    acc += l.text.length;
    if (out.length < n - 1 && acc >= (total * (out.length + 1)) / n && i < lines.length - 1) { out.push({ from, lines: cur }); from = i + 1; cur = []; }
  });
  out.push({ from, lines: cur });
  return out;
}

async function renderChunk(lines: DialogueLine[], lang: "es" | "en") {
  const res = await fetch(`${API}/text-to-dialogue/with-timestamps?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": key(), "Content-Type": "application/json" },
    body: JSON.stringify({ model_id: DIALOGUE_MODEL(), language_code: lang, inputs: lines.map((l) => ({ text: l.text, voice_id: l.voice })) }),
  });
  if (!res.ok) throw new Error(`dialogue ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  const segs: { dialogue_input_index: number; start_time_seconds: number; end_time_seconds: number }[] = j.voice_segments ?? [];
  // a line can be split into several segments; keep the first start / last end per line
  const byLine = new Map<number, { index: number; start: number; end: number }>();
  for (const s of segs) {
    const cur = byLine.get(s.dialogue_input_index);
    if (!cur) byLine.set(s.dialogue_input_index, { index: s.dialogue_input_index, start: s.start_time_seconds, end: s.end_time_seconds });
    else cur.end = Math.max(cur.end, s.end_time_seconds);
  }
  return { mp3: Buffer.from(j.audio_base64, "base64"), segments: [...byLine.values()].sort((a, b) => a.index - b.index) };
}

/** Drops the ID3 tag and the Xing/Info frame so concatenated chunks play as one CBR stream. */
function stripMp3Headers(b: Buffer) {
  let i = 0;
  if (b.subarray(0, 3).toString("latin1") === "ID3") i = 10 + ((b[6] << 21) | (b[7] << 14) | (b[8] << 7) | b[9]);
  if (b[i] === 0xff && (b[i + 1] & 0xe0) === 0xe0) {
    const head = b.subarray(i, i + 64).toString("latin1");
    if (head.includes("Info") || head.includes("Xing")) {
      const KBPS = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
      const SR = [44100, 48000, 32000];
      const br = KBPS[b[i + 2] >> 4] * 1000, sr = SR[(b[i + 2] >> 2) & 3], pad = (b[i + 2] >> 1) & 1;
      if (br && sr) i += Math.floor((144 * br) / sr) + pad;
    }
  }
  return b.subarray(i);
}

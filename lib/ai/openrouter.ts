// Thin OpenRouter client for strict-JSON calls. Two tiers, both configurable by env:
//   FAST_MODEL      low-latency model for per-turn decisions (extraction, intent, safety classifier)
//   REASONER_MODEL  writes the simulated phone-call dialogue (latency hidden behind "ringing")
// Each tier has a fallback model that OpenRouter routes to if the primary is down.
import { z } from "zod";

export const MODELS = {
  fast: () => [process.env.FAST_MODEL || "google/gemini-3.5-flash-lite", process.env.FAST_MODEL_FALLBACK || "anthropic/claude-haiku-5.5"],
  reasoner: () => [process.env.REASONER_MODEL || "google/gemini-3.5-flash-lite", process.env.REASONER_MODEL_FALLBACK || "anthropic/claude-sonnet-5.5"],
};

export const openrouterConfigured = () => !!process.env.OPENROUTER_API_KEY;

type ChatMsg = { role: "system" | "user" | "assistant"; content: string };

/** Returns parsed + validated JSON, or null on timeout / HTTP error / schema mismatch. */
export async function chatJSON<T extends z.ZodType>(opts: {
  tier: keyof typeof MODELS;
  schema: T;
  name: string;
  messages: ChatMsg[];
  timeoutMs: number;
  temperature?: number;
}): Promise<{ data: z.infer<T>; model: string; ms: number } | null> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return null;
  const [model, fallback] = MODELS[opts.tier]();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal: ctrl.signal,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "X-Title": "CitaYa PR" },
      body: JSON.stringify({
        model,
        models: [model, fallback],
        temperature: opts.temperature ?? 0,
        provider: { sort: "latency" },
        response_format: { type: "json_schema", json_schema: { name: opts.name, strict: true, schema: z.toJSONSchema(opts.schema, { target: "draft-7" }) } },
        messages: opts.messages,
      }),
    });
    if (!res.ok) {
      console.warn(`[openrouter] ${opts.name} HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return null;
    }
    const json = await res.json();
    const content: string = json.choices?.[0]?.message?.content ?? "";
    const raw = content.slice(content.indexOf("{"), content.lastIndexOf("}") + 1); // tolerate fences from fallback models
    const parsed = opts.schema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      console.warn(`[openrouter] ${opts.name} schema mismatch from ${json.model}:`, parsed.error.issues.slice(0, 3));
      return null;
    }
    return { data: parsed.data, model: json.model ?? model, ms: Date.now() - t0 };
  } catch (e) {
    console.warn(`[openrouter] ${opts.name} failed after ${Date.now() - t0}ms:`, (e as Error).message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

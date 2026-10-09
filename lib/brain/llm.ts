// Optional OpenRouter path. NOT exercised in the recorded demos (no API key / no network
// access to openrouter.ai from the build machine). Returns null → rule-based brain is used.
import { z } from "zod";
import { SPECIALTIES, type ProviderQuery, type Specialty } from "../types";
import type { TurnInput } from "./turn";

const Patch = z.object({
  specialty: z.enum(SPECIALTIES).nullable(),
  specialty_confidence: z.number().min(0).max(1).nullable(),
  alternatives: z.array(z.enum(SPECIALTIES)).max(2),
  days_of_week: z.array(z.enum(["mon", "tue", "wed", "thu", "fri", "sat"])).nullable(),
  time_windows: z.array(z.object({ start: z.string(), end: z.string() })).nullable(),
  latest_date: z.string().nullable(),
  deadline_label: z.string().nullable(),
  asap: z.boolean().nullable(),
  max_drive_min: z.number().int().nullable(),
  drive_origins: z.array(z.enum(["home", "work"])).nullable(),
  languages: z.array(z.enum(["es", "en"])).nullable(),
  wheelchair: z.boolean().nullable(),
});

export async function llmTurn(input: TurnInput): Promise<{ patch: Partial<ProviderQuery>; alternatives: Specialty[] } | null> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return null;
  const model = process.env.REASONER_MODEL || "openai/gpt-4o-mini";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Number(process.env.LLM_TIMEOUT_MS || 4000));
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal: ctrl.signal,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        temperature: 0,
        provider: { require_parameters: true },
        response_format: { type: "json_schema", json_schema: { name: "patch", strict: true, schema: z.toJSONSchema(Patch) } },
        messages: [
          { role: "system", content: `Extract appointment-search constraints for a Puerto Rico patient. Today is ${input.today} (America/Puerto_Rico). Never diagnose. Output only fields the latest message states or changes; null otherwise. latest_date is the last acceptable day (inclusive). Current query: ${JSON.stringify(input.query)}. Pending question: ${input.expecting ?? "none"}.` },
          { role: "user", content: input.text },
        ],
      }),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const parsed = Patch.safeParse(JSON.parse(json.choices[0].message.content));
    if (!parsed.success) return null;
    const { alternatives, ...rest } = parsed.data;
    const patch = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== null)) as Partial<ProviderQuery>;
    return { patch, alternatives };
  } finally {
    clearTimeout(timer);
  }
}

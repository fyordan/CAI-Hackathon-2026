// One-time setup for live demo calls (lib/live/). Creates or updates, in your ElevenLabs account:
//   - four webhook tools pointing at APP_URL/api/live/tool
//   - the "CitaYa live caller" agent using them
//   - the Twilio number, imported so the agent can dial out
// Safe to re-run (matches tools by name, the agent by ELEVENLABS_AGENT_ID, the number by digits).
//   npx tsx --env-file=.env.local scripts/setup-live.ts
// Needs: ELEVENLABS_API_KEY, APP_URL, LIVE_TOOL_SECRET, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER
const API = "https://api.elevenlabs.io/v1/convai";
const env = (k: string) => {
  const v = process.env[k];
  if (!v) { console.error(`missing ${k}`); process.exit(1); }
  return v;
};
const KEY = env("ELEVENLABS_API_KEY"), APP_URL = env("APP_URL").replace(/\/$/, ""), SECRET = env("LIVE_TOOL_SECRET");

async function el<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, { method, headers: { "xi-api-key": KEY, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 800)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

const DATETIME = { type: "string", description: "The opening the receptionist offered, as local Puerto Rico time in the form YYYY-MM-DDTHH:MM (24-hour), e.g. 2026-10-14T09:30." };
const TOOLS = [
  { name: "check_opening", tool: "check", datetime: true,
    description: "Check whether an opening the receptionist offered fits every one of the patient's constraints. Call it every time a date and time is offered, before you answer." },
  { name: "book_opening", tool: "book", datetime: true,
    description: "Record the appointment once the receptionist has confirmed it is booked. Only for an opening check_opening said fits." },
  { name: "add_to_waitlist", tool: "waitlist", datetime: false,
    description: "Record that the receptionist agreed to put the patient on the cancellation list because nothing fits." },
  { name: "confirm_cancelled", tool: "cancel", datetime: false,
    description: "Record that the receptionist confirmed the patient's appointment is cancelled." },
];

function toolConfig(t: (typeof TOOLS)[number]) {
  return {
    type: "webhook", name: t.name, description: t.description, response_timeout_secs: 10,
    api_schema: {
      url: `${APP_URL}/api/live/tool`, method: "POST",
      request_headers: { "x-citaya-secret": SECRET },
      request_body_schema: {
        type: "object", description: "Tool arguments",
        required: ["tool", "call_id", ...(t.datetime ? ["datetime"] : [])],
        properties: {
          tool: { type: "string", constant_value: t.tool },
          call_id: { type: "string", dynamic_variable: "call_id" },
          ...(t.datetime ? { datetime: DATETIME } : {}),
        },
      },
    },
  };
}

async function main() {
  // tools
  const existing = (await el<{ tools: { id: string; tool_config: { name: string } }[] }>("/tools")).tools;
  const toolIds: string[] = [];
  for (const t of TOOLS) {
    const found = existing.find((x) => x.tool_config.name === t.name);
    if (found) { await el(`/tools/${found.id}`, "PATCH", { tool_config: toolConfig(t) }); toolIds.push(found.id); console.log(`updated tool ${t.name}`); }
    else { const r = await el<{ id: string }>("/tools", "POST", { tool_config: toolConfig(t) }); toolIds.push(r.id); console.log(`created tool ${t.name}`); }
  }

  // agent (the real per-call prompt and language arrive as overrides when dialing)
  const agent = {
    name: "CitaYa live caller",
    conversation_config: {
      agent: {
        first_message: "", // wait for the receptionist to answer
        language: "es",
        dynamic_variables: { dynamic_variable_placeholders: { call_id: "test" } },
        prompt: {
          prompt: "You are CitaYa, an automated scheduling assistant calling a doctor's office in Puerto Rico on behalf of a patient. Say you are an automated assistant. Keep turns short.",
          llm: process.env.LIVE_AGENT_LLM || "gemini-3.5-flash",
          temperature: 0.4,
          tool_ids: toolIds,
          built_in_tools: { end_call: { type: "system", name: "end_call", description: "", params: { system_tool_type: "end_call" } } },
        },
      },
      ...(process.env.ELEVENLABS_VOICE_AGENT ? { tts: { voice_id: process.env.ELEVENLABS_VOICE_AGENT } } : {}),
    },
    platform_settings: { overrides: { conversation_config_override: { agent: { language: true, prompt: { prompt: true } } } } },
  };
  let agentId = process.env.ELEVENLABS_AGENT_ID;
  if (agentId) { await el(`/agents/${agentId}`, "PATCH", agent); console.log(`updated agent ${agentId}`); }
  else { agentId = (await el<{ agent_id: string }>("/agents/create", "POST", agent)).agent_id; console.log(`created agent ${agentId}`); }

  // phone number
  const number = env("TWILIO_PHONE_NUMBER");
  const digits = (n: string) => n.replace(/\D/g, "");
  const phones = await el<{ phone_number: string; phone_number_id: string }[]>("/phone-numbers");
  let phoneId = phones.find((p) => digits(p.phone_number) === digits(number))?.phone_number_id;
  if (phoneId) { await el(`/phone-numbers/${phoneId}`, "PATCH", { agent_id: agentId }); console.log(`phone ${number} already imported`); }
  else {
    phoneId = (await el<{ phone_number_id: string }>("/phone-numbers", "POST", {
      provider: "twilio", phone_number: number, label: "CitaYa live demo", sid: env("TWILIO_ACCOUNT_SID"), token: env("TWILIO_AUTH_TOKEN"), agent_id: agentId,
    })).phone_number_id;
    console.log(`imported phone ${number}`);
  }

  console.log(`\nAdd these to Vercel (and .env.local):\nELEVENLABS_AGENT_ID=${agentId}\nELEVENLABS_PHONE_NUMBER_ID=${phoneId}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });

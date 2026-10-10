"use client";
// Live demo switches: 📞 the booking office calls your phone · 💬 WhatsApp on book/move/cancel.
// Disabled (with a hint) until the env vars for that piece are set on the server.
import { useEffect, useState } from "react";

interface Status { calls: boolean; whatsapp: boolean; configured: { calls: boolean; whatsapp: boolean }; phone: string | null; whatsapp_to: string | null }

export function LiveToggle() {
  const [s, setS] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { fetch("/api/live/settings").then((r) => r.json()).then(setS).catch(() => {}); }, []);
  if (!s) return null;
  const flip = async (key: "calls" | "whatsapp") => {
    setBusy(true);
    const r = await fetch("/api/live/settings", { method: "POST", body: JSON.stringify({ [key]: !s[key] }) }).then((x) => x.json()).catch(() => null);
    if (r) setS(r);
    setBusy(false);
  };
  const pill = (key: "calls" | "whatsapp", icon: string, label: string, to: string | null, missing: string) => (
    <button className={`btn small live-pill ${s[key] ? "on" : ""}`} disabled={busy || !s.configured[key]} aria-pressed={s[key]} data-testid={`live-${key}`}
      title={s.configured[key] ? `${label}: ${s[key] ? "on" : "off"}${to ? ` (${to})` : ""}` : `Set ${missing} on the server to enable`}
      onClick={() => flip(key)}>
      {icon} {label} <b>{s[key] ? "ON" : "OFF"}</b>
    </button>
  );
  // tucked into a dropdown so it doesn't read as a product feature; the dot shows something is on
  return (
    <details className="live-settings" data-testid="live-settings">
      <summary>Live demo settings{(s.calls || s.whatsapp) && <span className="live-dot" aria-label="on" />}</summary>
      <div className="live-menu">
        {pill("calls", "📞", "Live call", s.phone, "ELEVENLABS_AGENT_ID, ELEVENLABS_PHONE_NUMBER_ID, LIVE_CALL_TO, LIVE_TOOL_SECRET")}
        {pill("whatsapp", "💬", "WhatsApp", s.whatsapp_to, "TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, WHATSAPP_TO")}
      </div>
    </details>
  );
}

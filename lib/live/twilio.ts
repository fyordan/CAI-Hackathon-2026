// WhatsApp through Twilio (sandbox by default). The phone that joined the sandbox gets the
// booking / move / cancel messages while live mode is on. Sandbox rule: it only delivers
// free-form text within 24 h of that phone last messaging the sandbox number.
export const whatsappConfigured = () => !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.WHATSAPP_TO);

export async function sendWhatsApp(body: string) {
  if (!whatsappConfigured()) return false;
  const sid = process.env.TWILIO_ACCOUNT_SID!;
  const wa = (n: string) => (n.startsWith("whatsapp:") ? n : `whatsapp:${n}`);
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: { Authorization: `Basic ${Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ From: wa(process.env.TWILIO_WHATSAPP_FROM || "+14155238886"), To: wa(process.env.WHATSAPP_TO!), Body: body }),
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) console.warn("[whatsapp] failed", res.status, (await res.text()).slice(0, 300));
  return res.ok;
}

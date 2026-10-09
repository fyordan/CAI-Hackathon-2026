// Re-voice the three pinned Marisol calls with ElevenLabs Text-to-Dialogue (v3, two voices,
// one natural take). Replaces the old Kokoro renders in public/calls/*.mp3 + *.json.
// Usage: npm run voice:calls   (needs ELEVENLABS_API_KEY; ~1.9k characters)
import { writeFileSync } from "fs";
import path from "path";
import { renderDialogue, VOICES } from "../lib/voice/elevenlabs";
import { peaks } from "../lib/calls/dialogue";

type L = [speaker: "agent" | "office", text: string, event: string | null];
const CALLS: Record<string, L[]> = {
  hero: [
    ["office", "Foot and Ankle Hato Rey, buenos días, le habla Wanda.", null],
    ["agent", "Buenos días, Wanda. Le habla CitaYa, un asistente automatizado, llamando de parte de la paciente Marisol Rivera. Quisiera una cita de podiatría por una uña encarnada.", null],
    ["office", "Ajá. ¿Es paciente nueva?", null],
    ["agent", "Sí, es paciente nueva. Ella solo puede los jueves, y necesita la cita antes del diecinueve de noviembre.", null],
    ["office", "[typing] Déjeme ver… El jueves cinco lo tengo lleno. Tengo el jueves diecinueve de noviembre, a las diez de la mañana.", "SLOT_OFFERED"],
    ["agent", "Perfecto, el jueves diecinueve a las diez. ¿Aceptan el plan Triple-S?", null],
    ["office", "Sí, Triple-S lo aceptamos. ¿Y el nombre completo de la paciente?", null],
    ["agent", "Marisol Rivera. Ella lleva la tarjeta del plan el día de la cita.", null],
    ["office", "Listo. Queda separada: jueves diecinueve, diez de la mañana, con el doctor Ramos. Que llegue quince minutos antes con su tarjeta del plan.", "BOOKED"],
    ["agent", "Excelente. Si se abre algo más temprano un jueves, ¿la pueden poner en la lista de cancelaciones?", null],
    ["office", "[warmly] Sí, claro, la apunto.", null],
    ["agent", "Muchas gracias, Wanda. Que tenga buen día.", "COMPLETED"],
  ],
  rebook: [
    ["office", "Foot and Ankle Hato Rey, buenas tardes.", null],
    ["agent", "Buenas tardes. Le habla CitaYa, de parte de Marisol Rivera. Ella tiene cita el jueves diecinueve de noviembre a las diez. ¿Se ha abierto algo antes, un jueves?", null],
    ["office", "Pues fíjese que sí. Se canceló una el jueves veintinueve de octubre, a las dos y media.", "SLOT_OFFERED"],
    ["agent", "Perfecto, la tomamos. Por favor muévala al veintinueve a las dos y media, y liberen la del diecinueve.", null],
    ["office", "Hecho. Jueves veintinueve de octubre, dos y media de la tarde.", "BOOKED"],
    ["agent", "Muchas gracias.", "COMPLETED"],
  ],
  cancel: [
    ["office", "Foot and Ankle Hato Rey, buenos días.", null],
    ["agent", "Buenos días. Le habla CitaYa, de parte de Marisol Rivera. Llamo para cancelar su cita del jueves veintinueve de octubre a las dos y media, para que se la puedan dar a otro paciente.", null],
    ["office", "Muy bien, queda cancelada. Gracias por avisar.", "CANCELLED"],
    ["agent", "Gracias a usted.", "COMPLETED"],
  ],
};

const OUT = path.join(__dirname, "..", "public", "calls");
const RING = 3.0; // seconds of (silent) ringing before pickup; the timeline shows "Sonando…"
const strip = (s: string) => s.replace(/\[[^\]]{1,30}\]\s*/g, "");

(async () => {
  for (const [name, lines] of Object.entries(CALLS)) {
    const voices = { agent: VOICES.agent(), office: VOICES.officeF() };
    const a = await renderDialogue(lines.map(([speaker, text]) => ({ speaker, text, voice: voices[speaker] })), "es");
    const cues: { t: number; speaker: string; text: string | null; event: string | null }[] = [];
    lines.forEach(([speaker, text, event], i) => {
      const seg = a.segments[i];
      cues.push({ t: +seg.start.toFixed(2), speaker, text: strip(text), event: null });
      if (event) cues.push({ t: +(event === "COMPLETED" ? a.duration : seg.end).toFixed(2), speaker: "system", text: null, event });
    });
    writeFileSync(path.join(OUT, `${name}.mp3`), a.mp3);
    writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify({ name, duration: +a.duration.toFixed(2), pre_roll: RING, synthetic: true, engine: "elevenlabs eleven_v3 text-to-dialogue", voices, cues, peaks: peaks(a.segments, a.duration, 240) }, null, 1));
    console.log(name, a.duration.toFixed(1), "s");
  }
})();

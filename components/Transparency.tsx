"use client";
import type { Lang } from "@/lib/types";

type Status = "real" | "simulated" | "synthetic" | "estimated" | "off";
const ROWS: { what: { es: string; en: string }; status: Status; how: { es: string; en: string } }[] = [
  { what: { es: "Directorio de oficinas", en: "Provider directory" }, status: "synthetic", how: { es: "182 oficinas inventadas en ubicaciones aproximadas de pueblos reales. Nombres, teléfonos 787-555, horarios, planes e idiomas son ficticios.", en: "182 invented offices at approximate real town locations. Names, 787-555 phones, hours, plans and languages are made up." } },
  { what: { es: "Planes médicos", en: "Insurance plans" }, status: "synthetic", how: { es: "Los nombres de aseguradoras son reales; qué oficina acepta qué plan es inventado.", en: "Insurer names are real; which office accepts which plan is invented." } },
  { what: { es: "Entender tu mensaje", en: "Understanding your message" }, status: "real", how: { es: "Un modelo rápido (OpenRouter, ~1 s) extrae la búsqueda, detecta la intención y escribe la respuesta. Si falla o tarda, responde un parser de reglas offline.", en: "A fast model (OpenRouter, ~1 s) extracts the search, detects intent and writes the reply. If it fails or is slow, an offline rule parser answers instead." } },
  { what: { es: "Ritmo de las fichas", en: "Chip pacing" }, status: "simulated", how: { es: "El parser responde al instante; las pausas entre fichas son artificiales para imitar un modelo que transmite.", en: "The parser answers instantly; the pauses between chips are artificial to mimic a streaming model." } },
  { what: { es: "Alertas de emergencia", en: "Emergency screening" }, status: "real", how: { es: "Reglas deterministas antes de cualquier modelo; el modelo puede añadir una alerta pero nunca quitarla. No validado clínicamente.", en: "Deterministic rules run before any model; the model can add an alert but never clear one. Not clinically validated." } },
  { what: { es: "Búsqueda y filtros", en: "Search and filters" }, status: "real", how: { es: "SQL parametrizado en Postgres 16 local (compatible con Neon) + filtros de plan, días, horario, idioma, acceso y distancia.", en: "Parameterized SQL on local Postgres 16 (Neon-compatible) + plan, day, hours, language, access and distance filters." } },
  { what: { es: "Tiempos de manejo", en: "Drive times" }, status: "estimated", how: { es: "Línea recta × 1.25 a ~60 km/h + 3 min. Sin Google Routes API en esta corrida.", en: "Straight line × 1.25 at ~60 km/h + 3 min. No Google Routes API in this run." } },
  { what: { es: "Mapa", en: "Map" }, status: "estimated", how: { es: "Leaflet con el contorno de PR (Natural Earth), sin calles. Zoom y encuadre son reales; Google Maps necesita clave.", en: "Leaflet with PR outline (Natural Earth), no streets. Zoom and fit are real; Google Maps needs a key." } },
  { what: { es: "Llamadas telefónicas", en: "Phone calls" }, status: "simulated", how: { es: "Ninguna llamada real. Cada llamada es una línea de tiempo con semilla fija; los reintentos están acelerados.", en: "No real calls. Each call is a fixed-seed timeline; retries are sped up." } },
  { what: { es: "Audio de llamadas", en: "Call audio" }, status: "synthetic", how: { es: "Diálogo escrito por IA para cada solicitud y voces de ElevenLabs. Las llamadas de Marisol usan un guion fijo. No se marca ningún teléfono.", en: "Dialogue written by AI for each request, voiced with ElevenLabs. Marisol's calls use a fixed script. No phone is ever dialed." } },
  { what: { es: "Reservar, mover, cancelar", en: "Book, move, cancel" }, status: "real", how: { es: "Lógica real en la base de datos (reservar antes de soltar, una cita activa por pedido), contra espacios inventados.", en: "Real logic in the database (book-then-release, one active booking per request), against invented slots." } },
  { what: { es: "Invitación de calendario", en: "Calendar invite" }, status: "off", how: { es: "Se genera un .ics real que abre en cualquier calendario. Google Calendar API está programado pero no conectado; no se envía email.", en: "A real .ics file that opens in any calendar. Google Calendar API is wired but not connected; no email is sent." } },
  { what: { es: "Revisión en segundo plano", en: "Background re-check" }, status: "simulated", how: { es: "“Adelantar 3 días” mueve un reloj de demo y corre el mismo código que correría un job programado.", en: "“Skip ahead 3 days” moves a demo clock and runs the same code a scheduled job would." } },
  { what: { es: "Voz (micrófono)", en: "Voice input" }, status: "real", how: { es: "Grabación del micrófono transcrita con ElevenLabs Scribe; las respuestas se pueden escuchar en voz alta (ElevenLabs).", en: "Mic audio transcribed with ElevenLabs Scribe; replies can be read aloud (ElevenLabs)." } },
  { what: { es: "Personas y cuentas", en: "Personas and accounts" }, status: "synthetic", how: { es: "Perfiles ficticios, sin login.", en: "Fictional profiles, no login." } },
];

const LABEL: Record<Status, { es: string; en: string }> = {
  real: { es: "Real", en: "Real" }, simulated: { es: "Simulado", en: "Simulated" }, synthetic: { es: "Sintético", en: "Synthetic" },
  estimated: { es: "Aproximado", en: "Approximate" }, off: { es: "No conectado", en: "Not connected" },
};

export default function Transparency({ lang, onClose }: { lang: Lang; onClose: () => void }) {
  return (
    <div className="drawer-wrap" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()} aria-label="What's real" data-testid="transparency">
        <div className="drawer-head">
          <h2>{lang === "es" ? "Qué es real en este demo" : "What's real in this demo"}</h2>
          <button className="btn ghost small" onClick={onClose}>✕</button>
        </div>
        <ul className="real-list">
          {ROWS.map((r) => (
            <li key={r.what.en}>
              <span className={`tag tag-${r.status}`}>{LABEL[r.status][lang]}</span>
              <div><strong>{r.what[lang]}</strong><p>{r.how[lang]}</p></div>
            </li>
          ))}
        </ul>
      </aside>
    </div>
  );
}

"use client";
// Plays a SIMULATED call (ElevenLabs voices: pre-rendered for the pinned demo, generated per request otherwise) in sync with the call timeline.
// "Live" means joining the call at the point its timeline has reached.
import { useEffect, useMemo, useRef, useState } from "react";
import type { Lang } from "@/lib/types";
import { t } from "./i18n";
import { StatePill } from "./StatePill";

export interface TaskView {
  id: string; provider_name: string; phone: string; purpose: string; scenario: string; state: string; attempt: number;
  started_at: string; audio: string | null; audio_at: string | null;
}
export interface EventView { id: number; call_id: string; at: string; to_state: string | null; speaker: string | null; text: string | null; payload: Record<string, unknown> | null }
interface Cue { t: number; speaker: string; text: string | null; event: string | null }
interface Meta { duration: number; cues: Cue[]; peaks: number[]; voices: Record<string, string> }

declare global { interface Window { __audioLog?: { src: string; ev: string; wall: number; pos: number }[] } }

export default function CallPlayer({ task, events, lang, onClose }: { task: TaskView; events: EventView[]; lang: Lang; onClose: () => void }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [pos, setPos] = useState(0);
  const [blocked, setBlocked] = useState(false);
  const [mode, setMode] = useState<"live" | "replay">("live");
  const capRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    if (!task.audio) return;
    fetch(task.audio.replace(".mp3", ".json")).then((r) => r.json()).then(setMeta);
  }, [task.audio]);

  useEffect(() => {
    const a = audio.current;
    if (!a || !meta || !task.audio_at) return;
    const log = (ev: string) => (window.__audioLog ??= []).push({ src: task.audio!, ev, wall: Date.now(), pos: a.currentTime });
    const offset = (Date.now() - Date.parse(task.audio_at)) / 1000;
    const live = offset < meta.duration - 0.5;
    setMode(live ? "live" : "replay");
    a.currentTime = live ? Math.max(0, offset) : 0;
    const onPlay = () => log("play"), onPause = () => log("pause"), onEnd = () => log("ended"), onWait = () => log("waiting");
    a.addEventListener("playing", onPlay); a.addEventListener("pause", onPause); a.addEventListener("ended", onEnd); a.addEventListener("waiting", onWait);
    a.play().catch(() => setBlocked(true));
    let raf = 0;
    const loop = () => { setPos(a.currentTime); raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(raf); a.pause(); a.removeEventListener("playing", onPlay); a.removeEventListener("pause", onPause); a.removeEventListener("ended", onEnd); a.removeEventListener("waiting", onWait); };
  }, [meta, task.audio, task.audio_at]);

  const lines = useMemo(() => {
    if (meta) return meta.cues.filter((c) => c.speaker !== "system" && c.t <= pos + 0.05).map((c) => ({ speaker: c.speaker, text: c.text! }));
    return events.filter((e) => e.call_id === task.id && e.speaker && e.speaker !== "system" && e.text).map((e) => ({ speaker: e.speaker!, text: e.text! }));
  }, [meta, pos, events, task.id]);

  useEffect(() => { capRef.current?.lastElementChild?.scrollIntoView({ block: "nearest", behavior: "smooth" }); }, [lines.length]);

  const progress = meta ? pos / meta.duration : 0;
  const who = (s: string) => (s === "agent" ? "CitaYa" : task.provider_name);

  return (
    <div className="player" role="dialog" aria-label={task.provider_name} data-testid="call-player">
      <div className="player-head">
        <div>
          <div className="player-title">{task.provider_name}</div>
          <div className="player-sub">{task.phone} · {task.purpose === "book" ? (lang === "es" ? "reservar" : "booking") : task.purpose === "rebook" ? (lang === "es" ? "mover más temprano" : "move earlier") : (lang === "es" ? "cancelar" : "cancel")}</div>
        </div>
        <StatePill state={task.state} lang={lang} />
        <button className="btn ghost small" onClick={onClose} aria-label={t(lang, "close")}>✕</button>
      </div>
      <div className="sim-note">{(lang === "es" ? "Llamada simulada · dos IA conversando: CitaYa y la recepcionista" : "Simulated call · two AIs talking: CitaYa and the receptionist") + (task.audio ? " · ElevenLabs" : "")}{meta ? ` · ${mode === "live" ? t(lang, "live") : t(lang, "replay")}` : ""}</div>
      {meta && (
        <div className="wave" aria-hidden onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); if (audio.current) audio.current.currentTime = ((e.clientX - r.left) / r.width) * meta.duration; }}>
          {meta.peaks.map((p, i) => <span key={i} style={{ height: `${8 + p * 92}%` }} className={i / meta.peaks.length <= progress ? "on" : ""} />)}
        </div>
      )}
      {task.audio && <audio ref={audio} src={task.audio} preload="auto" />}
      {blocked && <button className="btn primary" onClick={() => { setBlocked(false); audio.current?.play(); }}>▶ {t(lang, "listen")}</button>}
      <ol className="captions" ref={capRef} data-testid="captions">
        {lines.map((l, i) => (
          <li key={i} className={`cap ${l.speaker}`}><span className="cap-who">{who(l.speaker)}</span><span className="cap-text">{l.text}</span></li>
        ))}
      </ol>
    </div>
  );
}

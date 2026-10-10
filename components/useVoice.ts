"use client";
// Voice I/O for the chat composer.
//  - Mic: getUserMedia + MediaRecorder, auto-stops on ~1.2 s of silence after speech, uploads to
//    /api/stt (ElevenLabs Scribe). Falls back to the browser's Web Speech API if /api/stt is off.
//  - Speaker: plays assistant replies via /api/tts (ElevenLabs Flash), streaming.
import { useCallback, useEffect, useRef, useState } from "react";
import type { Lang } from "@/lib/types";

export type MicState = "idle" | "requesting" | "listening" | "transcribing";

const SILENCE_MS = 1200;   // stop this long after the user stops talking
const NO_SPEECH_MS = 7000; // give up if nothing is said
const MAX_MS = 30000;
const THRESHOLD = 0.018;   // RMS level that counts as speech

function pickMime() {
  const c = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
  return typeof MediaRecorder !== "undefined" ? c.find((m) => MediaRecorder.isTypeSupported(m)) ?? "" : "";
}

export function useVoice({ lang, onText }: { lang: Lang; onText: (text: string) => void }) {
  const [mic, setMic] = useState<MicState>("idle");
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const stopRef = useRef<(() => void) | null>(null);
  const player = useRef<HTMLAudioElement | null>(null);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;

  const msg = useCallback((es: string, en: string) => setError(lang === "en" ? en : es), [lang]);

  const stopSpeaking = useCallback(() => {
    player.current?.pause();
    setSpeaking(false);
  }, []);

  const speak = useCallback((text: string, replyLang: Lang) => {
    if (!text.trim()) return;
    stopSpeaking();
    const a = player.current ?? (player.current = new Audio());
    a.src = `/api/tts?lang=${replyLang}&text=${encodeURIComponent(text)}`;
    a.onplaying = () => setSpeaking(true);
    a.onended = a.onerror = a.onpause = () => setSpeaking(false);
    a.play().catch(() => setSpeaking(false)); // autoplay blocked: just skip audio
  }, [stopSpeaking]);

  const webSpeech = useCallback(() => {
    type SR = { lang: string; interimResults: boolean; onresult: (e: { results: ArrayLike<{ 0: { transcript: string } }> }) => void; onerror: (e: { error: string }) => void; onend: () => void; start: () => void };
    const W = window as unknown as { SpeechRecognition?: new () => SR; webkitSpeechRecognition?: new () => SR };
    const Ctor = W.SpeechRecognition ?? W.webkitSpeechRecognition;
    if (!Ctor) return msg("Este navegador no tiene dictado. Escribe el mensaje.", "This browser has no dictation. Type your message instead.");
    const r = new Ctor();
    r.lang = lang === "es" ? "es-US" : "en-US";
    r.interimResults = false;
    r.onresult = (e) => { const text = Array.from(e.results).map((x) => x[0].transcript).join(" ").trim(); if (text) onTextRef.current(text); };
    r.onerror = (e) => msg(`Dictado falló (${e.error}).`, `Dictation failed (${e.error}).`);
    r.onend = () => setMic("idle");
    setMic("listening");
    r.start();
  }, [lang, msg]);

  const start = useCallback(async () => {
    setError(null);
    stopSpeaking();
    if (!window.isSecureContext) return msg("El micrófono necesita https o localhost.", "The mic needs https or localhost.");
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") return webSpeech();
    setMic("requesting");
    // created inside the click so it isn't left "suspended" when the permission prompt eats the user gesture
    const ctx = new AudioContext();
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) {
      ctx.close().catch(() => {});
      setMic("idle");
      const name = (e as DOMException).name;
      if (name === "NotAllowedError") return msg("Permiso de micrófono denegado. Actívalo en el candado de la barra de direcciones.", "Microphone permission denied. Allow it from the lock icon in the address bar.");
      if (name === "NotFoundError") return msg("No encontré un micrófono.", "No microphone found.");
      return msg(`No pude abrir el micrófono (${name}).`, `Couldn't open the microphone (${name}).`);
    }
    const mime = pickMime();
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);

    await ctx.resume().catch(() => {});
    const src = ctx.createMediaStreamSource(stream);
    const an = ctx.createAnalyser();
    an.fftSize = 1024;
    src.connect(an);
    const buf = new Float32Array(an.fftSize);
    const t0 = performance.now();
    let heard = false, lastLoud = t0, timer = 0, stopped = false;

    const finish = () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      if (rec.state !== "inactive") rec.stop();
    };
    stopRef.current = finish;
    const loop = () => {
      an.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      const rms = Math.sqrt(sum / buf.length);
      setLevel(Math.min(1, rms * 12));
      const now = performance.now();
      if (rms > THRESHOLD) { heard = true; lastLoud = now; }
      if ((heard && now - lastLoud > SILENCE_MS) || (!heard && now - t0 > NO_SPEECH_MS) || now - t0 > MAX_MS) finish();
    };

    rec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      ctx.close().catch(() => {});
      stopRef.current = null;
      setLevel(0);
      if (!heard) { setMic("idle"); return msg("No te escuché. Toca el micrófono e intenta otra vez.", "I didn't hear anything. Tap the mic and try again."); }
      setMic("transcribing");
      try {
        const form = new FormData();
        form.append("file", new Blob(chunks, { type: rec.mimeType || mime || "audio/webm" }));
        const res = await fetch("/api/stt", { method: "POST", body: form });
        if (res.status === 501) { setMic("idle"); return webSpeech(); }
        const j = await res.json();
        if (!res.ok) throw new Error(j.error ?? res.status);
        if (!j.text) return msg("No entendí. ¿Lo repites?", "I didn't catch that. Could you say it again?");
        onTextRef.current(j.text);
      } catch (e) {
        msg(`No pude transcribir (${(e as Error).message}).`, `Transcription failed (${(e as Error).message}).`);
      } finally {
        setMic("idle");
      }
    };
    rec.start(250);
    setMic("listening");
    // a timer, not requestAnimationFrame: rAF stops in background tabs and the mic would never close
    timer = window.setInterval(loop, 50);
  }, [msg, stopSpeaking, webSpeech]);

  const toggle = useCallback(() => {
    if (mic === "listening" && stopRef.current) return stopRef.current();
    if (mic === "idle") void start();
  }, [mic, start]);

  useEffect(() => () => { stopRef.current?.(); player.current?.pause(); }, []);

  return { mic, level, error, clearError: () => setError(null), toggle, speak, speaking, stopSpeaking };
}

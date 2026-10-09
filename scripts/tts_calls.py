"""Synthesize the scripted demo calls with Kokoro TTS (offline, local model).
Everything produced here is SYNTHETIC: scripted dialogue, synthetic voices.
Output: public/calls/<name>.mp3 + <name>.json (cue sheet the UI and simulator share)."""
import json, subprocess, sys, os
import numpy as np, soundfile as sf
from kokoro_onnx import Kokoro

TTS = os.environ.get("TTS_DIR", "/home/claude/tts")
OUT = os.path.join(os.path.dirname(__file__), "..", "public", "calls")
k = Kokoro(f"{TTS}/kokoro.onnx", f"{TTS}/voices.bin")
SR = 24000
VOICE = {"office": "ef_dora", "agent": "em_alex"}

def ring():
    t = np.arange(int(SR * 1.8)) / SR
    tone = 0.12 * (np.sin(2*np.pi*440*t) + np.sin(2*np.pi*480*t))
    return np.concatenate([tone, np.zeros(int(SR * 1.2))]).astype(np.float32)

def phone_filter(x):
    # crude telephone band-limit for the office side (300-3400 Hz)
    X = np.fft.rfft(x); f = np.fft.rfftfreq(len(x), 1/SR)
    X[(f < 300) | (f > 3400)] = 0
    return np.fft.irfft(X, n=len(x)).astype(np.float32)

CALLS = {
  "hero": [
    ("office", "Foot and Ankle Hato Rey, buenos días, le habla Wanda.", None),
    ("agent", "Buenos días, Wanda. Le habla CitaYa, un asistente automatizado, llamando de parte de la paciente Marisol Rivera. Quisiera una cita de podiatría por una uña encarnada.", None),
    ("office", "Ajá. ¿Es paciente nueva?", None),
    ("agent", "Sí, es paciente nueva. Ella solo puede los jueves, y necesita la cita antes del diecinueve de noviembre.", None),
    ("office", "Déjeme ver. El jueves cinco lo tengo lleno. Tengo el jueves diecinueve de noviembre, a las diez de la mañana.", "SLOT_OFFERED"),
    ("agent", "Perfecto, el jueves diecinueve a las diez. ¿Aceptan el plan Triple-S?", None),
    ("office", "Sí, Triple-S lo aceptamos. ¿Fecha de nacimiento de la paciente?", None),
    ("agent", "Catorce de marzo de mil novecientos ochenta y cinco.", None),
    ("office", "Listo. Queda separada: jueves diecinueve, diez de la mañana, con el doctor Ramos. Que llegue quince minutos antes con su tarjeta del plan.", "BOOKED"),
    ("agent", "Excelente. Si se abre algo más temprano un jueves, ¿la pueden poner en la lista de cancelaciones?", None),
    ("office", "Sí, claro, la apunto.", None),
    ("agent", "Muchas gracias, Wanda. Que tenga buen día.", "COMPLETED"),
  ],
  "rebook": [
    ("office", "Foot and Ankle Hato Rey, buenas tardes.", None),
    ("agent", "Buenas tardes. Le habla CitaYa, de parte de Marisol Rivera. Ella tiene cita el jueves diecinueve de noviembre a las diez. ¿Se ha abierto algo antes, un jueves?", None),
    ("office", "Pues fíjese que sí. Se canceló una el jueves veintinueve de octubre, a las dos y media.", "SLOT_OFFERED"),
    ("agent", "Perfecto, la tomamos. Por favor muévala al veintinueve a las dos y media, y liberen la del diecinueve.", None),
    ("office", "Hecho. Jueves veintinueve de octubre, dos y media de la tarde.", "BOOKED"),
    ("agent", "Muchas gracias.", "COMPLETED"),
  ],
  "cancel": [
    ("office", "Foot and Ankle Hato Rey, buenos días.", None),
    ("agent", "Buenos días. Le habla CitaYa, de parte de Marisol Rivera. Llamo para cancelar su cita del jueves veintinueve de octubre a las dos y media, para que se la puedan dar a otro paciente.", None),
    ("office", "Muy bien, queda cancelada. Gracias por avisar.", "CANCELLED"),
    ("agent", "Gracias a usted.", "COMPLETED"),
  ],
}

for name, lines in CALLS.items():
    parts, cues = [ring()], []
    t = len(parts[0]) / SR
    cues.append({"t": 0.0, "speaker": "system", "text": "Llamando…", "event": "RINGING"})
    cues.append({"t": round(t - 0.2, 2), "speaker": "system", "text": "Conectado", "event": "HUMAN"})
    for speaker, text, event in lines:
        audio, sr = k.create(text, voice=VOICE[speaker], speed=1.05, lang="es")
        assert sr == SR
        audio = audio.astype(np.float32)
        if speaker == "office":
            audio = phone_filter(audio) * 1.3
        cues.append({"t": round(t, 2), "speaker": speaker, "text": text, "event": None})
        t += len(audio) / SR
        if event:  # state change lands when the line finishes
            cues.append({"t": round(t, 2), "speaker": "system", "text": None, "event": event})
        parts += [audio, np.zeros(int(SR * 0.35), np.float32)]
        t += 0.35
    wav = np.clip(np.concatenate(parts), -1, 1)
    wpath = f"/tmp/claude-0/{name}.wav"
    sf.write(wpath, wav, SR)
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", wpath, "-ar", "24000", "-b:a", "64k", f"{OUT}/{name}.mp3"], check=True)
    json.dump({"name": name, "duration": round(t, 2), "synthetic": True,
               "voices": VOICE, "cues": cues}, open(f"{OUT}/{name}.json", "w"), ensure_ascii=False, indent=1)
    print(name, round(t, 1), "s")

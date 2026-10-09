"""Precompute waveform bars for the call player (so the UI can draw the call without WebAudio)."""
import json, subprocess, numpy as np, os
OUT = os.path.join(os.path.dirname(__file__), "..", "public", "calls")
for name in ["hero", "rebook", "cancel"]:
    raw = subprocess.run(["ffmpeg", "-loglevel", "error", "-i", f"{OUT}/{name}.mp3", "-f", "f32le", "-ac", "1", "-ar", "8000", "-"], capture_output=True, check=True).stdout
    x = np.abs(np.frombuffer(raw, np.float32))
    n = 240
    bars = [float(np.sqrt(np.mean(c ** 2))) for c in np.array_split(x, n)]
    m = max(bars) or 1
    meta = json.load(open(f"{OUT}/{name}.json"))
    meta["peaks"] = [round(b / m, 3) for b in bars]
    json.dump(meta, open(f"{OUT}/{name}.json", "w"), ensure_ascii=False, indent=1)
    print(name, "ok")

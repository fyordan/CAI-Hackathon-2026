"""Rebuild a recording on the wall clock, frame by frame, then lay the call audio under it.
Each recorded frame carries a 16-bit wall-clock strip (deciseconds) drawn by the page; Playwright's
screencast timing drifts under load, so we re-time every frame from that strip instead.
Usage: python3 remux.py <recording.webm> <audio.json> <out.mp4>"""
import json, os, subprocess, sys
import numpy as np

ROOT = os.path.join(os.path.dirname(__file__), "..", "..")
webm, meta_path, out = sys.argv[1:4]
meta = json.load(open(meta_path))
t0, log = meta["t0"], meta["log"]
def video_size(path):
    import re
    try:
        out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", path], capture_output=True, text=True).stdout
        return map(int, out.strip().split(","))
    except FileNotFoundError:  # no ffprobe (e.g. the imageio-ffmpeg build): read it from ffmpeg's banner
        err = subprocess.run(["ffmpeg", "-hide_banner", "-i", path], capture_output=True, text=True).stderr
        return map(int, re.search(r"Video: .*?(\d{2,5})x(\d{2,5})", err).groups())
w, h = video_size(webm)
FPS, STEP = 25, 40.0
reader = subprocess.Popen(["ffmpeg", "-loglevel", "error", "-i", webm, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], stdout=subprocess.PIPE)
tmp = out + ".video.mp4"
writer = subprocess.Popen(["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h}", "-r", str(FPS), "-i", "-",
                           "-c:v", "libx264", "-preset", "medium", "-crf", "26", "-pix_fmt", "yuv420p", tmp], stdin=subprocess.PIPE)
base = int(t0 // 100)
size = w * h * 3
last, prev_wall, W0, n, decoded = None, None, None, 0, 0
while True:
    buf = reader.stdout.read(size)
    if len(buf) < size: break
    f = np.frombuffer(buf, np.uint8).reshape(h, w, 3)
    row = f[4, 4:128:8].mean(axis=1)
    v = int("".join("1" if x < 128 else "0" for x in row), 2)
    cand = base - base % 65536 + v
    cand = min((cand - 65536, cand, cand + 65536), key=lambda c: abs(c - base)) * 100
    ok = v != 0 and abs(cand - t0) < 900_000 and (prev_wall is None or -300 <= cand - prev_wall <= 5000)
    wall = cand if ok else (prev_wall + STEP if prev_wall is not None else None)
    if wall is None: continue  # blank frames before the page loaded
    decoded += ok
    if W0 is None: W0 = wall
    wall = max(wall, prev_wall or wall)
    if last is not None:
        while W0 + n * STEP < wall:  # hold the previous frame until this frame's wall time
            writer.stdin.write(last); n += 1
    g = f.copy(); g[:8, :128] = 255  # hide the sync strip
    last, prev_wall = g.tobytes(), wall
if last is not None: writer.stdin.write(last); n += 1
writer.stdin.close(); writer.wait()
print(f"frames out {n} ({n / FPS:.1f}s), strip decoded on {decoded} frames, W0-t0 {(W0 - t0) / 1000:.2f}s")

# every "play"/"playing" starts a stretch of continuous playback that lasts until the next logged event
# (a re-fired "playing" after a buffer hiccup just starts a new stretch at its own position)
segs = []
for i, e in enumerate(log):
    if e["ev"] != "play": continue
    nxt = next((x for x in log[i + 1:] if x["src"] == e["src"]), None)
    segs.append((e, nxt))
if not segs:
    os.replace(tmp, out)
else:
    inputs, filters = ["-i", tmp], []
    for i, (s, e) in enumerate(segs):
        inputs += ["-i", meta.get("files", {}).get(s["src"]) or os.path.join(ROOT, "public", s["src"].lstrip("/"))]
        start = max(0, s["wall"] - W0)
        dur = f":duration={(e['wall'] - s['wall']) / 1000:.2f}" if e else ""
        filters.append(f"[{i+1}:a]atrim=start={s['pos']:.2f}{dur},asetpts=PTS-STARTPTS,adelay={int(start)}|{int(start)}[a{i}]")
    mix = "".join(f"[a{i}]" for i in range(len(segs))) + f"amix=inputs={len(segs)}:normalize=0[aout]"
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", *inputs, "-filter_complex", ";".join(filters + [mix]), "-map", "0:v", "-map", "[aout]",
                    "-c:v", "copy", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", out], check=True)
    os.remove(tmp)
print("wrote", out, "audio segments:", len(segs))

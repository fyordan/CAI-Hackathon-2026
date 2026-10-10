"""Record the demo flows with Playwright, then mux the synthetic call audio back in.
Playwright videos have no audio track, so the page logs when each call clip starts/stops
(window.__audioLog) and ffmpeg lays the same mp3 under the video at those moments.
Usage: python3 scripts/record/record.py <flow> [outdir]"""
import json, os, subprocess, sys, time
from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE", "http://localhost:3000")
ROOT = os.path.join(os.path.dirname(__file__), "..", "..")
FLOW = sys.argv[1]
OUT = sys.argv[2] if len(sys.argv) > 2 else "/tmp/claude-0/videos"
os.makedirs(OUT, exist_ok=True)
PHONE = FLOW.startswith("phone")
VW, VH = (390, 844) if PHONE else (1280, 800)

CURSOR = """
window.addEventListener('DOMContentLoaded', () => {
  const c = document.createElement('div');
  c.id = '__cursor';
  c.style.cssText = 'position:fixed;z-index:99999;left:0;top:0;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;background:rgba(240,180,41,.55);border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4);pointer-events:none;transition:transform .12s;';
  document.body.appendChild(c);
  document.addEventListener('mousemove', e => { c.style.left = e.clientX + 'px'; c.style.top = e.clientY + 'px'; }, true);
  document.addEventListener('mousedown', () => c.style.transform = 'scale(.6)', true);
  document.addEventListener('mouseup', () => c.style.transform = 'scale(1)', true);
  // sync strip: 16 squares encoding wall-clock deciseconds, read back from the video to place audio exactly
  const k = document.createElement('canvas'); k.width = 128; k.height = 8;
  k.style.cssText = 'position:fixed;left:0;top:0;width:128px;height:8px;z-index:100000;pointer-events:none;image-rendering:pixelated';
  document.body.appendChild(k);
  const g = k.getContext('2d');
  const draw = () => { const v = Math.floor(Date.now() / 100) % 65536; for (let i = 0; i < 16; i++) { g.fillStyle = (v >> (15 - i)) & 1 ? '#000' : '#fff'; g.fillRect(i * 8, 0, 8, 8); } requestAnimationFrame(draw); };
  draw();
});
"""

# Voice flows: getUserMedia returns a stream that plays the next pre-rendered user line (window.__nextUtter),
# so the app's real recorder, silence detection and /api/stt all run. Spoken replies (/api/tts) and the
# user lines are logged to __audioLog like the call audio, so the remux can lay them under the video.
VOICE = """
(() => {
  const log = (src, ev, pos = 0) => (window.__audioLog ??= []).push({ src, ev, wall: Date.now(), pos });
  // replies play through a detached new Audio(), whose events never reach document; hook play() instead
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    if (!this.__logged) {
      this.__logged = true;
      for (const ev of ['playing', 'pause', 'ended']) this.addEventListener(ev, () => {
        const u = this.currentSrc && new URL(this.currentSrc);
        if (u && u.pathname === '/api/tts') log(u.pathname + u.search, ev === 'playing' ? 'play' : ev, this.currentTime);
      });
    }
    return play.call(this);
  };
  navigator.mediaDevices.getUserMedia = async () => {
    const ctx = new AudioContext(), dest = ctx.createMediaStreamDestination();
    const u = window.__nextUtter; window.__nextUtter = null;
    if (u) {
      const buf = await ctx.decodeAudioData(await (await fetch(u.data)).arrayBuffer());
      setTimeout(() => { const s = ctx.createBufferSource(); s.buffer = buf; s.connect(dest); s.onended = () => log(u.src, 'ended'); log(u.src, 'play'); s.start(); }, 700);
    }
    return dest.stream;
  };
})();
"""
FILES = {}  # __audioLog src → local file, for audio that isn't under public/

def main():
    with sync_playwright() as p:
        b = p.chromium.launch(args=["--autoplay-policy=no-user-gesture-required"])
        ctx = b.new_context(viewport={"width": VW, "height": VH}, device_scale_factor=2 if PHONE else 1,
                            is_mobile=PHONE, has_touch=False, record_video_dir=OUT, record_video_size={"width": VW, "height": VH},
                            locale="es-PR", timezone_id="America/Puerto_Rico")
        ctx.add_init_script(CURSOR)
        if "voice" in FLOW: ctx.add_init_script(VOICE)
        pg = ctx.new_page()
        t0 = time.time() * 1000
        pg.on("pageerror", lambda e: print("PAGEERROR", e))
        pg.request.post(f"{BASE}/api/demo/reset")
        flows[FLOW](pg)
        log = pg.evaluate("window.__audioLog || []")
        video = pg.video.path()
        ctx.close(); b.close()
    fetch_audio(log)
    json.dump({"t0": t0, "log": log, "webm": video, "files": FILES}, open(f"{OUT}/{FLOW}.audio.json", "w"))
    subprocess.run([sys.executable, os.path.join(os.path.dirname(__file__), "remux.py"), video, f"{OUT}/{FLOW}.audio.json", f"{OUT}/{FLOW}.mp4"], check=True)

def clock_map(video, t0):
    """Decode the sync strip → least-squares map from video seconds to wall-clock ms."""
    import numpy as np
    raw = subprocess.run(["ffmpeg", "-loglevel", "error", "-i", video, "-vf", f"fps=4,crop=128:8:0:0,format=gray", "-f", "rawvideo", "-"], capture_output=True, check=True).stdout
    frames = np.frombuffer(raw, np.uint8).reshape(-1, 8, 128)
    pts = []
    for i, f in enumerate(frames):
        bits = [1 if f[4, j * 8 + 4] < 128 else 0 for j in range(16)]
        v = int("".join(map(str, bits)), 2)
        base = int(t0 // 100)
        cand = base - base % 65536 + v
        cand = min((cand - 65536, cand, cand + 65536), key=lambda c: abs(c - base))
        if v and abs(cand - base) < 9000:  # skip blank frames before the page script runs
            pts.append((i / 4, cand * 100))
    pts = np.array(pts)
    # robust fit: drop frames whose decode disagrees with the median slope
    a, b = np.polyfit(pts[:, 0], pts[:, 1], 1)
    keep = np.abs(pts[:, 1] - (a * pts[:, 0] + b)) < 400
    a, b = np.polyfit(pts[keep, 0], pts[keep, 1], 1)
    print(f"clock map: {keep.sum()}/{len(pts)} frames, {a:.1f} ms/s, offset {(b - t0)/1000:.2f}s")
    return a, b

def mux(video, log, t0, out):
    # Playwright's screencast timestamps run slow under load; retime video to wall clock,
    # then place each audio clip at the wall-clock moment the page started playing it.
    a, b = clock_map(video, t0)
    speed = a / 1000
    vf = f"setpts=PTS*{speed:.4f},drawbox=x=0:y=0:w=128:h=8:color=white:t=fill"
    segs, open_seg = [], None
    for e in log:
        if e["ev"] == "play":
            open_seg = e
        elif open_seg and e["ev"] in ("pause", "ended"):
            segs.append((open_seg, e)); open_seg = None
    if open_seg: segs.append((open_seg, None))
    inputs, filters = ["-i", video], []
    for i, (s, e) in enumerate(segs):
        inputs += ["-i", os.path.join(ROOT, "public", s["src"].lstrip("/"))]
        start = max(0.0, (s["wall"] - b) / 1000)
        dur = f":duration={((e['wall'] - s['wall']) / 1000):.2f}" if e else ""
        filters.append(f"[{i+1}:a]atrim=start={s['pos']:.2f}{dur},asetpts=PTS-STARTPTS,adelay={int(start*1000)}|{int(start*1000)}[a{i}]")
    if segs:
        mix = "".join(f"[a{i}]" for i in range(len(segs))) + f"amix=inputs={len(segs)}:normalize=0[aout]"
        args = ["ffmpeg", "-y", "-loglevel", "error", *inputs, "-filter_complex", ";".join([f"[0:v]{vf}[v]"] + filters + [mix]), "-map", "[v]", "-map", "[aout]"]
    else:
        args = ["ffmpeg", "-y", "-loglevel", "error", "-i", video, "-vf", vf]
    args += ["-r", "25", "-c:v", "libx264", "-preset", "medium", "-crf", "26", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", out]
    subprocess.run(args, check=True)
    print("wrote", out, "audio segments:", len(segs))

def fetch_audio(log):
    """Download server-generated audio (spoken replies, generated calls); both are cached server-side, so this is free."""
    import urllib.request, hashlib
    for src in {e["src"] for e in log}:
        if src in FILES or not src.startswith("/api/"): continue
        path = os.path.join(OUT, "audio", hashlib.sha1(src.encode()).hexdigest()[:16] + ".mp3")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        urllib.request.urlretrieve(BASE + src, path)
        FILES[src] = path

def utterance(text, voice=os.environ.get("USER_VOICE", "zwDSHuqO0tEVwNUuHmR1")):
    """The demo user's line as speech (ElevenLabs), cached on disk. Default voice: Puerto Rican male."""
    import urllib.request, hashlib, base64
    path = os.path.join(OUT, "audio", "user-" + hashlib.sha1((voice + text).encode()).hexdigest()[:16] + ".mp3")
    if not os.path.exists(path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        req = urllib.request.Request(f"https://api.elevenlabs.io/v1/text-to-speech/{voice}?output_format=mp3_44100_128",
            data=json.dumps({"text": text, "model_id": "eleven_multilingual_v2", "language_code": "es",
                             "voice_settings": {"stability": 0.4, "similarity_boost": 0.8, "style": 0.2}}).encode(),
            headers={"xi-api-key": os.environ["ELEVENLABS_API_KEY"], "Content-Type": "application/json"})
        open(path, "wb").write(urllib.request.urlopen(req).read())
    src = "user:" + os.path.basename(path)
    FILES[src] = path
    return {"src": src, "data": "data:audio/mpeg;base64," + base64.b64encode(open(path, "rb").read()).decode()}

def n_ended(pg, prefix):
    return pg.evaluate(f"(window.__audioLog||[]).filter(e => e.src.startsWith('{prefix}') && e.ev === 'ended').length")

def talk(pg, text, pause=1800):
    """Say one line into the (simulated) mic, then wait for the spoken reply to finish, plus a pause."""
    u = utterance(text)
    replies = n_ended(pg, "/api/tts")
    pg.evaluate("u => { window.__nextUtter = u; }", u)
    click(pg, "[data-testid=mic]", 0)
    pg.wait_for_function(f"(window.__audioLog||[]).filter(e => e.src.startsWith('/api/tts') && e.ev === 'ended').length > {replies}", timeout=60_000)
    pg.wait_for_timeout(pause)

# ── helpers ──
def click(pg, sel, pause=500):
    loc = pg.locator(sel).first
    loc.scroll_into_view_if_needed()
    bb = loc.bounding_box()
    pg.mouse.move(bb["x"] + bb["width"] / 2, bb["y"] + bb["height"] / 2, steps=18)
    pg.wait_for_timeout(250)
    pg.mouse.down(); pg.mouse.up()
    pg.wait_for_timeout(pause)

def say(pg, text, after=6000):
    click(pg, "[data-testid=composer]", 200)
    pg.keyboard.type(text, delay=22)
    pg.wait_for_timeout(400)
    pg.keyboard.press("Enter")
    pg.wait_for_timeout(after)

def hover(pg, sel, ms=1500):
    bb = pg.locator(sel).first.bounding_box()
    pg.mouse.move(bb["x"] + bb["width"] / 2, bb["y"] + 20, steps=20)
    pg.wait_for_timeout(ms)

def wait_audio_end(pg, src, timeout=90_000):
    pg.wait_for_function(f"(window.__audioLog||[]).some(e => e.src === '{src}' && e.ev === 'ended')", timeout=timeout)

def close_player(pg):
    if pg.locator("[data-testid=call-player]").count():
        click(pg, "[data-testid=call-player] .player-head button", 800)

# ── flows ──
def desktop_marisol(pg):
    pg.goto(BASE); pg.wait_for_timeout(2000)
    click(pg, "[data-testid=persona-marisol]", 2500)
    say(pg, "Tengo una uña encarnada que me duele bastante, necesito un podiatra. Solo puedo los jueves y quiero resolverlo antes de Thanksgiving porque me voy dos semanas.", 6500)
    say(pg, "Treinta minutos, de mi casa o del trabajo.", 6000)
    for i in range(3):
        hover(pg, f"[data-testid=candidate] >> nth={i}", 1300)
    pg.mouse.move(640, 700, steps=10)
    click(pg, "[data-testid=call-all]", 1000)
    pg.wait_for_selector("[data-testid=booking]", timeout=90_000)   # hero call books near the end of its audio
    wait_audio_end(pg, "/calls/hero.mp3")
    pg.wait_for_timeout(1500)
    close_player(pg)
    click(pg, "[data-testid=tab-calls]", 3000)
    click(pg, "[data-testid=tab-appt]", 3000)
    click(pg, "[data-testid=fast-forward]", 1000)
    pg.wait_for_selector("[data-testid=toast-rebooked]", timeout=90_000)
    wait_audio_end(pg, "/calls/rebook.mp3")
    pg.wait_for_timeout(1500)
    close_player(pg)
    click(pg, "[data-testid=tab-appt]", 3500)
    click(pg, "[data-testid=cancel]", 1800)
    click(pg, "[data-testid=confirm-cancel]", 1000)
    pg.wait_for_selector("[data-testid=toast-cancelled]", timeout=60_000)
    wait_audio_end(pg, "/calls/cancel.mp3")
    pg.wait_for_timeout(1000)
    close_player(pg)
    click(pg, "[data-testid=tab-appt]", 3000)
    click(pg, "[data-testid=whats-real]", 3500)
    pg.mouse.move(1000, 500, steps=8); pg.mouse.wheel(0, 700); pg.wait_for_timeout(4000)

def phone_marisol(pg):
    pg.goto(BASE); pg.wait_for_timeout(1500)
    click(pg, "[data-testid=persona-marisol]", 2500)
    say(pg, "Tengo una uña encarnada que me duele bastante, necesito un podiatra. Solo puedo los jueves y quiero resolverlo antes de Thanksgiving porque me voy dos semanas.", 6000)
    click(pg, "[data-testid=m-map]", 3000)
    click(pg, "[data-testid=m-chat]", 800)
    say(pg, "Treinta minutos, de mi casa o del trabajo.", 5500)
    click(pg, "[data-testid=m-map]", 3000)
    click(pg, "[data-testid=m-list]", 2500)
    pg.mouse.wheel(0, 500); pg.wait_for_timeout(1500)
    click(pg, ".sticky-cta button", 1000)
    pg.wait_for_selector("[data-testid=booking]", timeout=90_000)
    wait_audio_end(pg, "/calls/hero.mp3")
    pg.wait_for_timeout(1200)
    close_player(pg)
    pg.wait_for_timeout(2000)
    click(pg, "[data-testid=m-appt]", 3000)
    click(pg, "[data-testid=fast-forward]", 1000)
    pg.wait_for_selector("[data-testid=toast-rebooked]", timeout=90_000)
    wait_audio_end(pg, "/calls/rebook.mp3")
    pg.wait_for_timeout(1200)
    close_player(pg)
    click(pg, "[data-testid=m-appt]", 3500)
    click(pg, "[data-testid=m-map]", 3000)

def desktop_caregiver_safety(pg):
    pg.goto(BASE); pg.wait_for_timeout(1500)
    click(pg, "[data-testid=persona-yadira]", 2500)
    say(pg, "Necesito un cardiólogo para el follow-up de mi papá, tiene arritmia. Por la mañana y con acceso para silla de ruedas.", 6000)
    say(pg, "Lo antes posible. No más de 25 minutos de su casa.", 5500)
    pg.locator(".excluded summary").click(); pg.wait_for_timeout(3000)
    click(pg, "[data-testid=call-all]", 1000)
    pg.wait_for_selector("[data-testid=booking]", timeout=60_000)
    pg.wait_for_timeout(2500)
    click(pg, "[data-testid=tab-calls]", 1200)
    click(pg, "[data-testid=call-card][data-outcome=BOOKED] [data-testid=listen]", 4500)
    close_player(pg)
    click(pg, "[data-testid=tab-appt]", 4000)
    # safety: a red-flag message never reaches search or calling
    pg.goto(f"{BASE}/demo/javi"); pg.wait_for_timeout(2500)
    say(pg, "Mi papá tiene dolor de pecho y el brazo izquierdo dormido ahora mismo", 5000)
    pg.wait_for_timeout(2000)
    click(pg, "[data-testid=emergency] .btn.ghost", 2500)

def desktop_english(pg):
    pg.goto(BASE); pg.wait_for_timeout(1200)
    click(pg, "[data-testid=persona-ana]", 2500)
    say(pg, "I need my annual OB-GYN exam with a doctor who speaks English, sometime in the next month.", 5500)
    say(pg, "Within 20 minutes of home.", 5000)
    pg.locator(".excluded summary").click(); pg.wait_for_timeout(2500)
    click(pg, "[data-testid=call-all]", 1000)
    pg.wait_for_selector("[data-testid=booking]", timeout=60_000)
    pg.wait_for_timeout(3000)
    click(pg, "[data-testid=tab-calls]", 3500)
    click(pg, "[data-testid=tab-appt]", 3500)

def desktop_voice(pg):
    """Unscripted, voice-only: the user describes symptoms (no specialty named) and the model picks the specialist."""
    pg.goto(BASE); pg.wait_for_timeout(1800)
    click(pg, "[data-testid=persona-javi]", 2500)
    talk(pg, "Oye, desde hace un mes me arde el estómago después de comer, sobre todo de noche, y me sube como un sabor agrio a la garganta. No sé qué médico me toca.")
    for i in range(2):
        hover(pg, f"[data-testid=candidate] >> nth={i}", 1200)
    talk(pg, "Entre semana, lo antes posible. Hasta media hora de la casa o del trabajo.")
    talk(pg, "Dale, llámalos.", 500)
    pg.wait_for_selector("[data-testid=call-player]", timeout=60_000)   # opens when the office picks up
    pg.wait_for_function("(window.__audioLog||[]).some(e => e.src.startsWith('/api/audio/') && e.ev === 'ended')", timeout=120_000)
    pg.wait_for_selector("[data-testid=booking]", timeout=60_000)
    pg.wait_for_timeout(1500)
    close_player(pg)
    click(pg, "[data-testid=tab-calls]", 3500)
    click(pg, "[data-testid=tab-appt]", 4000)

flows = {"desktop-voice": desktop_voice, "desktop-marisol": desktop_marisol, "phone-marisol": phone_marisol, "desktop-caregiver-safety": desktop_caregiver_safety, "desktop-english": desktop_english}
if __name__ == "__main__":
    main()

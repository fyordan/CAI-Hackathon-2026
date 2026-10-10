"""Submission video with WhatsApp: the app recording (left, from `WHATSAPP=1 record.py submission`) beside a
phone screen recording of the WhatsApp chat (right), cut to SEGS. The times below are for the 2026-10-10 Diego take.
Usage: APP=<submission.mp4> PHONE=<phone.mp4> WORK=<dir> python3 scripts/record/compose_whatsapp.py [out.mp4]"""
import os, subprocess, sys
FF = os.environ.get("FFMPEG", "ffmpeg")
APP, PHONE, W = os.environ["APP"], os.environ["PHONE"], os.environ["WORK"]
os.makedirs(f"{W}/seg", exist_ok=True)
OFF = 1.7            # phone_t = app_t + OFF (phone recording started 1.7 s before the app video)
PH_END = 181.0       # end of the phone recording
HIDE = [(0, 12.6, 13.0), (88.4, 95.6, 88.0)]  # (from, to, still at): Control Center at the start, the phone rotating
SEGS = [(2.3, 14.0), (14.0, 26.2), (30.0, 36.9), (40.4, 44.0), (47.4, 54.0), (59.2, 60.6), (63.9, 68.0),
        (73.5, 107.5), (107.5, 110.8), (117.5, 121.0), (128.5, 136.0), (143.5, 152.3), (153.0, 162.6), (167.0, 170.0)]
PW, PH = 332, 720
FONT = "/System/Library/Fonts/SFNS.ttf"
run = lambda *a: subprocess.run([FF, "-y", "-loglevel", "error", *a], check=True)

# 1. phone track normalized to 25 fps and panel size, with HIDE spans covered by a still frame taken just before
#    (overlaying keeps the timeline intact)
clean = f"{W}/phone_clean.mp4"
if not os.path.exists(clean):
    stills, chain, last = [], [], "[base]"
    for k, (a, b, still_at) in enumerate(HIDE):
        png = f"{W}/still{k}.png"
        run("-ss", f"{still_at}", "-i", PHONE, "-frames:v", "1", "-vf", f"scale={PW}:{PH}", png)
        stills += ["-i", png]
        chain.append(f"{last}[{k + 1}:v]overlay=0:0:enable='between(t,{a},{b})'[o{k}]")
        last = f"[o{k}]"
    run("-i", PHONE, *stills, "-filter_complex", f"[0:v]fps=25,scale={PW}:{PH}[base];" + ";".join(chain),
        "-map", last, "-an", "-c:v", "libx264", "-crf", "16", "-preset", "fast", clean)

label = f"drawtext=fontfile={FONT}:text='WhatsApp on a real phone':fontcolor=0xE5E7EB:fontsize=20:x=1280+(420-tw)/2:y=20"
parts = []
for i, (s, e) in enumerate(SEGS):
    d = e - s
    ps = s + OFF
    out = f"{W}/seg/{i:02d}.mp4"
    if ps + d <= PH_END:
        phone = ["-ss", f"{ps:.2f}", "-t", f"{d:.2f}", "-i", clean]
        pv = "[1:v]setpts=PTS-STARTPTS[p]"
        note = ""
    else:  # recording ended: hold the last good frame, dimmed, and say so
        phone = ["-ss", f"{PH_END - 0.1:.2f}", "-t", "0.04", "-i", clean]
        pv = f"[1:v]tpad=stop_mode=clone:stop_duration={d + 1},trim=0:{d},setpts=PTS-STARTPTS,eq=brightness=-0.25[p]"
        note = f",drawtext=fontfile={FONT}:text='(phone recording ended here)':fontcolor=0x9CA3AF:fontsize=16:x=1280+(420-tw)/2:y=772"
    run("-ss", f"{s:.2f}", "-t", f"{d:.2f}", "-i", APP, *phone, "-filter_complex",
        f"{pv};[0:v]pad=1700:800:0:0:color=0x111827[a];[a][p]overlay=1280+44:56,{label}{note}[v]",
        "-map", "[v]", "-map", "0:a", "-r", "25", "-c:v", "libx264", "-crf", "20", "-preset", "medium", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "128k", "-ar", "44100", out)
    parts.append(out)

with open(f"{W}/seg/list.txt", "w") as f:
    f.writelines(f"file '{p}'\n" for p in parts)
final = sys.argv[1] if len(sys.argv) > 1 else f"{W}/citaya-submission-whatsapp.mp4"
run("-f", "concat", "-safe", "0", "-i", f"{W}/seg/list.txt", "-c:v", "libx264", "-crf", "22", "-preset", "medium", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", final)
print("total", round(sum(e - s for s, e in SEGS), 1), "s →", final)

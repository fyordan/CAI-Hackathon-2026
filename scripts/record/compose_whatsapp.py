"""Submission video with WhatsApp: the app recording (left, from `WHATSAPP=1 record.py submission`) beside a
phone screen recording of the WhatsApp chat (right), cut to SEGS. The times below are for the 2026-10-10 take.
Usage: APP=<submission.mp4> PHONE=<phone.mp4> WORK=<dir> python3 scripts/record/compose_whatsapp.py [out.mp4]"""
import os, subprocess, sys
FF = os.environ.get("FFMPEG", "ffmpeg")
APP, PHONE, W = os.environ["APP"], os.environ["PHONE"], os.environ["WORK"]
os.makedirs(f"{W}/seg", exist_ok=True)
OFF = 6.9            # phone_t = app_t + OFF
PH_END = 127.0       # last useful phone frame (calendar); later the phone shows other apps
BANNER = (50.3, 57.7)  # another chat's notification: replaced with a clean frame
SEGS = [(2.5, 13.6), (13.6, 22.8), (26.6, 32.5), (35.6, 38.4), (41.8, 50.1), (55.1, 56.9), (59.9, 64.0),
        (70.0, 110.3), (110.3, 120.1), (120.1, 123.5), (131.0, 138.4), (149.5, 158.6), (159.2, 164.0)]
PW, PH = 332, 720
FONT = "/System/Library/Fonts/SFNS.ttf"
run = lambda *a: subprocess.run([FF, "-y", "-loglevel", "error", *a], check=True)

# 1. phone track normalized to 25 fps, panel size, banner removed
clean = f"{W}/phone_clean.mp4"
if not os.path.exists(clean):
    a, b = BANNER
    run("-i", PHONE, "-filter_complex",
        f"[0:v]fps=25,scale={PW}:{PH},split=3[p1][p2][p3];"
        f"[p1]trim=0:{a},setpts=PTS-STARTPTS[x];"
        f"[p2]trim={a-0.4}:{a-0.36},setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration={b-a}[y];"
        f"[p3]trim={b},setpts=PTS-STARTPTS[z];[x][y][z]concat=n=3:v=1[v]",
        "-map", "[v]", "-an", "-c:v", "libx264", "-crf", "16", "-preset", "fast", clean)

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

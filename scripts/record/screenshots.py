"""Devpost gallery screenshots (3:2, 2x) of the English Marisol flow, typed instead of spoken.
Usage: BASE=https://cai-hackathon-2026.vercel.app python3 scripts/record/screenshots.py <outdir>"""
import os, sys
from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE", "http://localhost:3000")
OUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/claude-0/shots"
os.makedirs(OUT, exist_ok=True)

def shot(pg, name):
    pg.mouse.move(1490, 990)  # park the pointer so no hover state shows
    pg.wait_for_timeout(600)
    pg.screenshot(path=f"{OUT}/{name}.png")
    print("shot", name)

def say(pg, text):
    n = pg.locator("[data-testid=messages] > *").count()
    pg.locator("[data-testid=composer]").fill(text)
    pg.keyboard.press("Enter")
    pg.wait_for_function(f"document.querySelector('[data-testid=messages]').children.length >= {n + 2}", timeout=60_000)
    pg.wait_for_timeout(2500)

def close_player(pg):
    if pg.locator("[data-testid=call-player]").count():
        pg.locator("[data-testid=call-player] .player-head button").first.click()
        pg.wait_for_timeout(600)

with sync_playwright() as p:
    b = p.chromium.launch(args=["--autoplay-policy=no-user-gesture-required"])
    ctx = b.new_context(viewport={"width": 1500, "height": 1000}, device_scale_factor=2, locale="en-US", timezone_id="America/Puerto_Rico")
    pg = ctx.new_page()
    pg.request.post(f"{BASE}/api/demo/reset")
    pg.goto(BASE); pg.wait_for_timeout(2500)
    shot(pg, "01-home")
    pg.click("[data-testid=persona-marisol]"); pg.wait_for_timeout(2500)
    say(pg, "My son Diego's eczema keeps spreading and the pharmacy creams stopped working. He needs a pediatric dermatologist. I drive a delivery truck all day, so Friday is the only day I can take him.")
    shot(pg, "02-understands-the-need")
    say(pg, "As soon as possible, and no more than twenty-five minutes from home.")
    shot(pg, "03-matching-offices")
    pg.locator("[data-testid=call-all] >> visible=true").first.click()
    pg.wait_for_timeout(7000)
    close_player(pg)
    pg.click("[data-testid=tab-calls]"); pg.wait_for_timeout(1500)
    shot(pg, "04-calling-in-parallel")
    pg.wait_for_selector("[data-testid=booking]", timeout=150_000)
    if not pg.locator("[data-testid=call-player]").count():
        pg.locator("[data-testid=listen] >> visible=true").first.click(); pg.wait_for_timeout(1500)
    pg.wait_for_timeout(4000)
    shot(pg, "05-booking-call-transcript")
    close_player(pg)
    pg.click("[data-testid=tab-appt]"); pg.wait_for_timeout(1500)
    shot(pg, "06-appointment-booked")
    pg.click("[data-testid=fast-forward]")
    pg.wait_for_selector("[data-testid=toast-rebooked]", timeout=150_000)
    pg.wait_for_timeout(1500)
    if not pg.locator("[data-testid=call-player]").count():
        pg.click("[data-testid=tab-calls]"); pg.wait_for_timeout(800)
        pg.locator("[data-testid=listen] >> visible=true").first.click(); pg.wait_for_timeout(1500)
    shot(pg, "07-moved-earlier-call")
    close_player(pg)
    pg.wait_for_timeout(6000)  # let the toast clear
    pg.click("[data-testid=tab-appt]"); pg.wait_for_timeout(1500)
    shot(pg, "08-moved-to-earlier-slot")
    pg.click("[data-testid=live-settings] summary"); pg.wait_for_timeout(800)
    shot(pg, "09-live-demo-settings")
    ctx.close(); b.close()

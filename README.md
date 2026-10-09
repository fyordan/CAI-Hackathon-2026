# CitaYa PR — hackathon demo

Describe what you need (Spanish, English or Spanglish). CitaYa builds a structured search live,
shows matching Puerto Rico offices on a map, "calls" them in parallel, books one, sends a
calendar invite, keeps watching for an earlier opening, and can call to cancel so you're not a no-show.

## What is real vs. mocked in this build

| Piece | Status | Detail |
|---|---|---|
| Provider directory (115 offices) | **Synthetic** | Invented names, 787-555 phones, hours, plans, languages. Coordinates are approximate real town locations. |
| Insurance plans | **Synthetic acceptance** | Insurer names are real PR carriers; which office takes which plan is made up. |
| Understanding messages | **Real, rule-based** | `lib/brain/rules.ts`: keyword triage + constraint extraction (ES/EN/Spanglish). No LLM ran. `lib/brain/llm.ts` (OpenRouter, strict JSON schema) is wired but untested: no key, and openrouter.ai was unreachable from the build machine. |
| Chip streaming pace | **Artificial** | Rules answer instantly; `/api/requests/[id]/chat` adds ~380 ms between chips (`DEMO_PACE_MS`). |
| Emergency screening | **Real, deterministic** | Runs before any model; disables search/calling. Heuristic, not clinically validated. |
| Search + filters + ranking | **Real** | Parameterized SQL on Postgres 16 (Neon-compatible), then plan/day/hours/language/access/drive filters. |
| Drive times | **Estimated** | Straight-line × 1.25 at 60 km/h + 3 min (`lib/geo.ts`). Swap for Google Routes `computeRouteMatrix`. |
| Map | **Offline basemap** | Leaflet + Natural Earth PR outline, no streets. Pan/zoom/fit-to-pins are real. Google Maps JS not wired. |
| Phone calls | **Simulated** | Deterministic timelines (`lib/calls/scenarios.ts`), validated against a state machine. No call is ever placed. Retries are sped up. |
| Call audio | **Synthetic** | 3 scripted Spanish calls for Marisol voiced with Kokoro TTS (`scripts/tts_calls.py`). Other personas: transcript only. |
| Book / move earlier / cancel | **Real logic, fake slots** | Book-then-release, one active booking per request (unique index), rebook only if strictly earlier and still valid. |
| Calendar invite | **Real .ics, Google not connected** | Standards-compliant .ics (REQUEST/CANCEL, SEQUENCE). Google Calendar adapter in `lib/calendar.ts` is untested; no email is sent. |
| Background re-check | **Simulated clock** | "Skip ahead 3 days" advances a virtual clock and runs the same `rebookScan()` a QStash job would call. |
| Voice input | **Real where supported** | Browser Web Speech API. Recordings typed the text. |
| Auth / personas | **Synthetic** | Four fictional personas, no login. |

## Demo recordings

`docs/demos/` has the four Playwright recordings (desktop full flow with call audio, phone, caregiver + emergency screen, English).

## Run locally

```bash
npm install
# Postgres 16 (or a Neon URL) in DATABASE_URL
cp .env.example .env.local   # then set DATABASE_URL
npm run db:setup        # schema + synthetic seed
npm run build && npm start   # http://localhost:3000
npm test                # 77 unit tests (vitest)
```

Optional: `OPENROUTER_API_KEY` (+ `REASONER_MODEL`) to try the LLM path; `GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN` for real invites.

Regenerate call audio: `pip install kokoro-onnx soundfile`, download `kokoro-v1.0.int8.onnx` + `voices-v1.0.bin`
from the kokoro-onnx GitHub release into `$TTS_DIR`, then `npm run tts && python3 scripts/peaks.py`.

Record demos: `python3 scripts/record/record.py desktop-marisol|phone-marisol|desktop-caregiver-safety|desktop-english`
(Playwright video + ffmpeg muxes the call audio at the moments the page logged playback).

## Layout

- `lib/brain/` — red flags, triage, extraction, ask-vs-search turn logic, optional LLM
- `lib/search.ts` — SQL compile + rank; `lib/geo.ts` — drive estimate
- `lib/calls/` — state machine + scenario timelines; `lib/engine.ts` — booking side effects, rebook scan, cancel, SSE snapshot
- `lib/calendar.ts` — .ics + Google adapter; `lib/demo.ts` — reset + virtual clock; `lib/seed-data.ts` — synthetic directory
- `app/api/**` — routes (chat SSE, state SSE, calls, cancel, ics, demo reset/fast-forward)
- `components/` — workspace UI, map, call player, "What's real" drawer

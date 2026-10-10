# CitaYa PR — hackathon demo

Describe what you need (Spanish, English or Spanglish). CitaYa builds a structured search live,
shows matching Puerto Rico offices on a map, "calls" them in parallel, books one, sends a
calendar invite, keeps watching for an earlier opening, and can call to cancel so you're not a no-show.

## What is real vs. mocked in this build

| Piece | Status | Detail |
|---|---|---|
| Provider directory (182 offices) | **Synthetic** | Invented names, 787-555 phones, hours, plans, languages. Coordinates are approximate real town locations. |
| Insurance plans | **Synthetic acceptance** | Insurer names are real PR carriers; which office takes which plan is made up. |
| Understanding messages | **Real, LLM + fallback** | `lib/brain/llm.ts`: one strict-JSON call to `FAST_MODEL` (OpenRouter, ~1-1.5 s) extracts the query, intent ("yes, call them") and writes the reply. Falls back to the offline rule parser `lib/brain/rules.ts` on error/timeout. |
| Chip streaming pace | **Artificial (rules only)** | When the rule brain answers, `/api/requests/[id]/chat` adds ~380 ms between chips (`DEMO_PACE_MS`). LLM turns stream immediately. |
| Emergency screening | **Real, deterministic + LLM** | Regex screen runs first and can't be overridden; the LLM can add an emergency the regex missed. Heuristic, not clinically validated. |
| Search + filters + ranking | **Real** | Parameterized SQL on Postgres 16 (Neon-compatible), then plan/day/hours/language/access/drive filters. |
| Drive times | **Estimated** | Straight-line × 1.25 at 60 km/h + 3 min (`lib/geo.ts`). Swap for Google Routes `computeRouteMatrix`. |
| Map | **Offline basemap** | Leaflet + Natural Earth PR outline, no streets. Pan/zoom/fit-to-pins are real. Google Maps JS not wired. |
| Phone calls | **Simulated** | Outcomes are deterministic (`lib/calls/scenarios.ts`) and validated against a state machine; the conversation is written per request by `REASONER_MODEL` (`lib/calls/dialogue.ts`), template fallback. No call is ever placed. |
| Call audio | **Synthetic (ElevenLabs)** | Booking/rebook/cancel calls are voiced with ElevenLabs Text-to-Dialogue (`CALL_AUDIO=featured`); Marisol's 3 pinned calls are pre-rendered (`npm run voice:calls`). |
| Book / move earlier / cancel | **Real logic, fake slots** | Book-then-release, one active booking per request (unique index), rebook only if strictly earlier and still valid. |
| Calendar invite | **Real .ics, Google not connected** | Standards-compliant .ics (REQUEST/CANCEL, SEQUENCE). Google Calendar adapter in `lib/calendar.ts` is untested; no email is sent. |
| Background re-check | **Simulated clock** | "Skip ahead 3 days" advances a virtual clock and runs the same `rebookScan()` a QStash job would call. |
| Voice input | **Real** | MediaRecorder with silence detection → `/api/stt` (ElevenLabs Scribe, ~1 s). Replies read aloud via `/api/tts` (ElevenLabs Flash, cached in Postgres). Web Speech API only as fallback. |
| Auth / personas | **Synthetic** | Four fictional personas, editable (plus new ones) at `/profile/[id]`, no login. |

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

`OPENROUTER_API_KEY` + `ELEVENLABS_API_KEY` enable the LLM brain, generated calls and voice (see `.env.example` for `FAST_MODEL` / `REASONER_MODEL` and voice IDs). Without them the app falls back to rules, templates and browser dictation. `GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN` for real invites.

Local Postgres via Docker: `docker run -d --name citaya-pg -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=citaya -p 5433:5432 postgres:16`

Regenerate the pinned call audio with ElevenLabs: `npm run voice:calls` (~1.9k characters). The old Kokoro pipeline (`npm run tts`) is kept for offline use.

Record demos: `python3 scripts/record/record.py desktop-marisol|phone-marisol|desktop-caregiver-safety|desktop-english`
(Playwright video + ffmpeg muxes the call audio at the moments the page logged playback).

## Layout

- `lib/brain/` — red flags, triage, extraction, ask-vs-search turn logic, optional LLM
- `lib/search.ts` — SQL compile + rank; `lib/geo.ts` — drive estimate
- `lib/calls/` — state machine + scenario timelines; `lib/engine.ts` — booking side effects, rebook scan, cancel, SSE snapshot
- `lib/calendar.ts` — .ics + Google adapter; `lib/demo.ts` — reset + virtual clock; `lib/seed-data.ts` — synthetic directory
- `app/api/**` — routes (chat SSE, state SSE, calls, cancel, ics, demo reset/fast-forward)
- `components/` — workspace UI, map, call player, "What's real" drawer

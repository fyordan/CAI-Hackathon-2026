-- Neon-compatible schema. Distance is computed in app code / plain SQL math here;
-- on Neon you can add PostGIS (geography + ST_DWithin) for the prefilter.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS providers (
  id text PRIMARY KEY, name text NOT NULL, specialty text NOT NULL, address text, municipio text,
  lat double precision NOT NULL, lng double precision NOT NULL, phone text,
  languages text[] NOT NULL DEFAULT '{es}', wheelchair boolean NOT NULL DEFAULT true,
  services text[] NOT NULL DEFAULT '{}', insurers text[] NOT NULL DEFAULT '{}',
  hours jsonb NOT NULL, answer_rate numeric NOT NULL DEFAULT 0.6, is_mock boolean NOT NULL DEFAULT true);
CREATE INDEX IF NOT EXISTS providers_specialty ON providers(specialty);

CREATE TABLE IF NOT EXISTS provider_slots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), provider_id text REFERENCES providers(id),
  starts_at timestamptz NOT NULL, minutes int NOT NULL DEFAULT 30,
  status text NOT NULL,            -- open | booked | ours
  release_at timestamptz,          -- virtual time when someone else's booking gets cancelled
  UNIQUE (provider_id, starts_at));

-- virtual clock: virtual_now = real now + offset_ms (fast-forward bumps the offset)
CREATE TABLE IF NOT EXISTS demo_state (id int PRIMARY KEY DEFAULT 1, offset_ms bigint NOT NULL DEFAULT 0);

CREATE TABLE IF NOT EXISTS care_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), persona_id text NOT NULL,
  query jsonb NOT NULL, expecting text, status text NOT NULL DEFAULT 'drafting',
  messages jsonb NOT NULL DEFAULT '[]', shortlist jsonb NOT NULL DEFAULT '[]',
  seed int NOT NULL DEFAULT 42, created_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE IF NOT EXISTS appointments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), request_id uuid REFERENCES care_requests(id) ON DELETE CASCADE,
  provider_id text REFERENCES providers(id), slot_id uuid, starts_at timestamptz NOT NULL,
  status text NOT NULL, calendar_seq int NOT NULL DEFAULT 0, previous_starts_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS one_active_per_request ON appointments(request_id) WHERE status = 'booked';

CREATE TABLE IF NOT EXISTS call_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), request_id uuid REFERENCES care_requests(id) ON DELETE CASCADE,
  provider_id text REFERENCES providers(id), purpose text NOT NULL, scenario text NOT NULL,
  state text NOT NULL DEFAULT 'QUEUED', attempt int NOT NULL DEFAULT 0,
  started_at timestamptz NOT NULL DEFAULT now(), audio text, appointment_id uuid);

CREATE TABLE IF NOT EXISTS call_events (
  id bigserial PRIMARY KEY, call_id uuid REFERENCES call_tasks(id) ON DELETE CASCADE,
  at timestamptz NOT NULL, to_state text, speaker text, text text, payload jsonb,
  applied boolean NOT NULL DEFAULT false);
CREATE INDEX IF NOT EXISTS call_events_due ON call_events(at) WHERE applied = false;

-- Local calendar outbox. The Google Calendar adapter (lib/calendar.ts) is only used when
-- GOOGLE_* env vars are set; otherwise invites are written here and offered as .ics.
CREATE TABLE IF NOT EXISTS calendar_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), appointment_id uuid REFERENCES appointments(id) ON DELETE CASCADE,
  uid text NOT NULL, attendee text NOT NULL, title text NOT NULL, location text,
  starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL, status text NOT NULL,
  sequence int NOT NULL DEFAULT 0, delivery text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE IF NOT EXISTS watchers (
  appointment_id uuid PRIMARY KEY REFERENCES appointments(id) ON DELETE CASCADE,
  auto_rebook boolean NOT NULL DEFAULT true, min_notice_hours int NOT NULL DEFAULT 24, active boolean NOT NULL DEFAULT true);

CREATE TABLE IF NOT EXISTS notifications (
  id bigserial PRIMARY KEY, request_id uuid REFERENCES care_requests(id) ON DELETE CASCADE,
  kind text NOT NULL, text text NOT NULL, payload jsonb, created_at timestamptz NOT NULL DEFAULT now());

// Demo control: virtual clock + reset. The virtual clock lets "fast-forward 3 days" trigger
// the background rebooking scan on stage; production would use real time + a QStash job.
import { readFileSync } from "fs";
import path from "path";
import { one, pool, q } from "./db";
import { buildProviders, HERO_SLOTS } from "./seed-data";

export const DEMO_START = "2026-10-09T10:00:00-04:00"; // Fri Oct 9, 2026, 10:00 AST

export async function virtualNow(): Promise<Date> {
  const r = await one<{ offset_ms: string }>("SELECT offset_ms FROM demo_state WHERE id = 1");
  return new Date(Date.now() + Number(r?.offset_ms ?? 0));
}

export async function advanceClock(hours: number) {
  await q("UPDATE demo_state SET offset_ms = offset_ms + $1 WHERE id = 1", [Math.round(hours * 3600_000)]);
  return virtualNow();
}

export async function ensureSchema() {
  const sql = readFileSync(path.join(process.cwd(), "sql", "schema.sql"), "utf8");
  await pool.query(sql);
}

export async function resetDemo() {
  await ensureSchema();
  await q("TRUNCATE notifications, watchers, calendar_events, call_events, call_tasks, appointments, care_requests, provider_slots, providers RESTART IDENTITY CASCADE");
  const providers = buildProviders();
  for (const p of providers) {
    await q(
      `INSERT INTO providers (id,name,specialty,address,municipio,lat,lng,phone,languages,wheelchair,services,insurers,hours,answer_rate)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [p.id, p.name, p.specialty, p.address, p.municipio, p.lat, p.lng, p.phone, p.languages, p.wheelchair, p.services, p.insurers, JSON.stringify(p.hours), p.answer_rate],
    );
  }
  for (const s of HERO_SLOTS) {
    await q("INSERT INTO provider_slots (provider_id, starts_at, status, release_at) VALUES ($1,$2,$3,$4)", [s.provider_id, s.starts_at, s.status, s.release_at]);
  }
  // live demo switches go back to off; turn them on again right before presenting
  await q("UPDATE live_settings SET calls=false, whatsapp=false WHERE id=1");
  const offset = new Date(DEMO_START).getTime() - Date.now();
  await q("INSERT INTO demo_state (id, offset_ms) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET offset_ms = EXCLUDED.offset_ms", [offset]);
  return { providers: providers.length, slots: HERO_SLOTS.length };
}

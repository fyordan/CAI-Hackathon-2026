// Plain Postgres via `pg`. Locally: Postgres 16 on :5433. In production: a Neon connection
// string in DATABASE_URL works with the same driver (use the pooled endpoint on Vercel).
import { Pool, type QueryResultRow } from "pg";

const g = globalThis as unknown as { __pool?: Pool };
export const pool =
  g.__pool ??
  new Pool({
    connectionString: process.env.DATABASE_URL ?? "postgres://postgres@127.0.0.1:5433/citaya",
    max: 5,
    ssl: process.env.DATABASE_URL?.includes("neon.tech") ? { rejectUnauthorized: true } : undefined,
  });
g.__pool = pool;

export async function q<T extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []) {
  const r = await pool.query<T>(text, values);
  return r.rows;
}
export async function one<T extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []) {
  return (await q<T>(text, values))[0] ?? null;
}

// postgres — integration-test helpers for Postgres-backed exchanges.
//
// Tests gated by `KYNETA_PG_URL`. Use `pgEnabled()` to skip-on-missing
// at the describe level, and `openPgPool()` to construct a Pool.

import { Pool } from "pg"

export const PG_URL: string | undefined = process.env["KYNETA_PG_URL"]

export function pgEnabled(): boolean {
  return PG_URL !== undefined && PG_URL.length > 0
}

/**
 * Open a fresh Pool against `KYNETA_PG_URL`. Caller is responsible
 * for `pool.end()` at teardown.
 */
export function openPgPool(): Pool {
  if (!pgEnabled()) throw new Error("KYNETA_PG_URL not set")
  return new Pool({ connectionString: PG_URL })
}

/** Canonical schema DDL — idempotent. */
export const POSTGRES_SCHEMA_DDL = `
  CREATE TABLE IF NOT EXISTS kyneta_meta (
    doc_id TEXT  PRIMARY KEY,
    data   JSONB NOT NULL
  );
  CREATE TABLE IF NOT EXISTS kyneta_records (
    doc_id  TEXT    NOT NULL,
    seq     INTEGER NOT NULL,
    kind    TEXT    NOT NULL,
    payload TEXT,
    blob    BYTEA,
    PRIMARY KEY (doc_id, seq)
  );
`

/** Wipe the canonical tables. Useful for per-test isolation. */
export async function truncateAll(pool: Pool): Promise<void> {
  await pool.query(`TRUNCATE kyneta_records, kyneta_meta`)
}

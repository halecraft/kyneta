// postgres — integration-test helpers for Postgres-backed exchanges.
//
// Tests gated by `KYNETA_PG_URL`. Use `pgEnabled()` to skip-on-missing
// at the describe level, and `openPgPool(name)` for a Pool on a database
// of that name's own.

import { pgTestDatabase, pgTestServer } from "@kyneta/postgres-store/testing"
import { Pool } from "pg"

export function pgEnabled(): boolean {
  return pgTestServer() !== null
}

/**
 * Open a Pool on database `kyneta_it_<name>` of the `KYNETA_PG_URL` server,
 * creating it if needed. Each storage tier and suite gets its own database:
 * suites sharing one truncate each other's tables when run in parallel.
 * Caller is responsible for `pool.end()` at teardown.
 */
export async function openPgPool(name: string): Promise<Pool> {
  return new Pool({
    connectionString: await pgTestDatabase(`kyneta_it_${name}`),
  })
}

/** Wipe the canonical tables. Useful for per-test isolation. */
export async function truncateAll(pool: Pool): Promise<void> {
  await pool.query(
    `TRUNCATE kyneta_records, kyneta_doc_meta, kyneta_store_meta`,
  )
}

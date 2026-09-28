// testing — Postgres helpers for test suites (`@kyneta/postgres-store/testing`).
//
// `KYNETA_PG_URL` names one server. Suites that share a database truncate
// each other's tables mid-test when they run in parallel, as `pnpm verify`
// runs packages. Each suite, and each storage tier within one, takes a
// database of its own instead.

import { Pool } from "pg"

/** Postgres's error code for a database that already exists. */
const DUPLICATE_DATABASE = "42P04"

/**
 * The server `KYNETA_PG_URL` names, or `null` when the variable is unset and
 * Postgres suites should skip.
 */
export function pgTestServer(): string | null {
  const url = process.env["KYNETA_PG_URL"]
  return url === undefined || url.length === 0 ? null : url
}

/**
 * The URL of database `name` on the `KYNETA_PG_URL` server, creating the
 * database if it does not exist. `name` must be a plain identifier.
 */
export async function pgTestDatabase(name: string): Promise<string> {
  const url = pgTestServer()
  if (url === null) throw new Error("pgTestDatabase: KYNETA_PG_URL is not set")
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
    throw new Error(`pgTestDatabase: "${name}" is not a plain identifier`)
  }
  const admin = new Pool({ connectionString: url, max: 1 })
  try {
    await admin.query(`CREATE DATABASE ${name}`)
  } catch (error) {
    const code = (error as { code?: unknown }).code
    if (code !== DUPLICATE_DATABASE) throw error
  } finally {
    await admin.end()
  }
  const target = new URL(url)
  target.pathname = `/${name}`
  return target.toString()
}

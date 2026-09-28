// schema — `schema.sql` is `postgresSchema()` for the default table names.
//
// Runs without KYNETA_PG_URL: it compares text, so the shipped file cannot
// drift from the DDL the tests create their tables from.

import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { postgresSchema } from "../index.js"

/** The statements of some SQL, without comments or layout. */
function statements(sql: string): string {
  return sql
    .split("\n")
    .map(line => line.replace(/--.*$/, "").trim())
    .filter(line => line.length > 0)
    .join(" ")
    .replace(/\s+/g, " ")
}

describe("postgresSchema", () => {
  it("is what schema.sql ships, for the default table names", () => {
    const shipped = readFileSync(
      new URL("../../schema.sql", import.meta.url),
      "utf8",
    )
    expect(statements(shipped)).toBe(statements(postgresSchema()))
  })

  it("names the given tables, and byte-orders every doc_id", () => {
    const sql = postgresSchema({ docMeta: "m", records: "r", storeMeta: "s" })
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS m (")
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS r (")
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS s (")
    expect(sql.match(/doc_id\s+TEXT COLLATE "C"/g)).toHaveLength(2)
  })
})

// sqlite-store — conformance + SQLite-specific tests.

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  collectAll,
  describeStore,
  makeEntryRecord,
  makeMetaRecord,
  plainMeta,
} from "@kyneta/exchange/testing"
import Database from "better-sqlite3"
import { afterAll, describe, expect, it } from "vitest"
import { fromBetterSqlite3, type SqliteAdapter, SqliteStore } from "../index.js"

/**
 * Why `arm(n)` instead of a constructor-time `failOnNth`: schema DDL
 * runs `exec` during `SqliteStore` construction. We need the counter
 * latent until after the priming append succeeds, so the conformance
 * test can target a specific subsequent write call.
 */
function makeFaultyAdapter(base: SqliteAdapter): {
  adapter: SqliteAdapter
  arm: (n: number) => void
} {
  let armed: number | null = null
  let count = 0
  const adapter: SqliteAdapter = {
    exec(sql, ...params) {
      if (armed !== null) {
        count += 1
        if (count === armed) {
          throw new Error(`fault-injected: exec call #${count}`)
        }
      }
      base.exec(sql, ...params)
    },
    iterate: base.iterate.bind(base),
    transaction: base.transaction.bind(base),
    close: base.close.bind(base),
  }
  return {
    adapter,
    arm: n => {
      armed = n
      count = 0
    },
  }
}

// ---------------------------------------------------------------------------
// Temp file management
// ---------------------------------------------------------------------------

const tmpDirs: string[] = []

function makeTmpFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kyneta-sqlite-test-"))
  const file = path.join(dir, "test.db")
  tmpDirs.push(dir)
  return file
}

afterAll(() => {
  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // best-effort cleanup
    }
  }
})

// ---------------------------------------------------------------------------
// Conformance suite — validates the full Store contract (17 tests)
// ---------------------------------------------------------------------------

describeStore(
  "SqliteStore",
  () => {
    const db = new Database(":memory:")
    return new SqliteStore(fromBetterSqlite3(db))
  },
  {
    cleanup: async backend => {
      await backend.close()
    },
    // The harness counts only after `arm(n)`, so schema DDL during
    // `SqliteStore` construction (a sequence of `exec` calls) doesn't
    // trip the counter. A meta-record append issues 2 execs (meta
    // upsert + record insert) inside one transaction; arming n=2 fires
    // mid-transaction so rollback is observable.
    faultFactory: async () => {
      const file = makeTmpFile()
      const db = new Database(file)
      const base = fromBetterSqlite3(db)
      const { adapter, arm } = makeFaultyAdapter(base)
      const store = new SqliteStore(adapter)
      return {
        store,
        injectFault: arm,
        // freshStore opens a separate connection on the same file. The
        // primary `db` connection is used by `store`; the fresh one is
        // independent so its lifecycle is the caller's.
        freshStore: async () => {
          const freshDb = new Database(file)
          return new SqliteStore(fromBetterSqlite3(freshDb))
        },
        cleanup: async () => {
          await store.close()
        },
      }
    },
    isolationFactory: async () => {
      const db = new Database(":memory:")
      const adapter = fromBetterSqlite3(db)
      return {
        storeA: new SqliteStore(adapter, {
          tables: { meta: "a_meta", records: "a_records" },
        }),
        storeB: new SqliteStore(adapter, {
          tables: { meta: "b_meta", records: "b_records" },
        }),
        // Both stores share `adapter`; closing it once tears down both.
        cleanup: async () => {
          adapter.close()
        },
      }
    },
  },
)

// ---------------------------------------------------------------------------
// SQLite-specific tests
// ---------------------------------------------------------------------------

describe("SqliteStore — persistence across close + reopen", () => {
  it("data, metadata, and seq numbers survive close and reopen", async () => {
    const file = makeTmpFile()

    const db1 = new Database(file)
    const store1 = new SqliteStore(fromBetterSqlite3(db1))
    await store1.append("doc-1", makeMetaRecord())
    await store1.append("doc-1", makeEntryRecord("entirety", "v1"))
    await store1.append("doc-1", makeEntryRecord("since", "v2"))
    await store1.close()

    // Reopen, verify persisted data, then append and verify seq continuity
    const db2 = new Database(file)
    const store2 = new SqliteStore(fromBetterSqlite3(db2))
    expect(await store2.currentMeta("doc-1")).toEqual(plainMeta)

    await store2.append("doc-1", makeEntryRecord("since", "v3"))

    const records = await collectAll(store2.loadAll("doc-1"))
    expect(records).toHaveLength(4)
    const versions = records
      .filter(r => r.kind === "entry")
      .map(r => (r as { kind: "entry"; version: string }).version)
    expect(versions).toEqual(["v1", "v2", "v3"])
    await store2.close()
  })
})

describe("SqliteStore — adapter factory", () => {
  it("fromBetterSqlite3 exec, iterate, and transaction round-trip", () => {
    const db = new Database(":memory:")
    const adapter = fromBetterSqlite3(db)

    adapter.exec("CREATE TABLE test (id INTEGER PRIMARY KEY, value TEXT)")
    adapter.exec("INSERT INTO test (id, value) VALUES (?, ?)", 1, "hello")
    adapter.exec("INSERT INTO test (id, value) VALUES (?, ?)", 2, "world")

    const rows = Array.from(
      adapter.iterate<{ id: number; value: string }>(
        "SELECT * FROM test ORDER BY id",
      ),
    )
    expect(rows).toEqual([
      { id: 1, value: "hello" },
      { id: 2, value: "world" },
    ])

    adapter.close()
  })

  it("iterate releases the statement on early termination", () => {
    // Without proper iterator-return semantics, better-sqlite3 throws
    // "This statement is busy" on the second iterate call below.
    const db = new Database(":memory:")
    const adapter = fromBetterSqlite3(db)

    adapter.exec("CREATE TABLE test (id INTEGER PRIMARY KEY)")
    adapter.exec("INSERT INTO test VALUES (1), (2), (3)")

    const [first] = adapter.iterate<{ id: number }>(
      "SELECT id FROM test ORDER BY id",
    )
    expect(first?.id).toBe(1)

    const all = Array.from(
      adapter.iterate<{ id: number }>("SELECT id FROM test ORDER BY id"),
    )
    expect(all).toHaveLength(3)

    adapter.close()
  })

  it("fromBetterSqlite3 transaction rolls back on throw", () => {
    const db = new Database(":memory:")
    const adapter = fromBetterSqlite3(db)

    adapter.exec("CREATE TABLE test (id INTEGER PRIMARY KEY, value TEXT)")
    adapter.exec("INSERT INTO test (id, value) VALUES (?, ?)", 1, "original")

    expect(() =>
      adapter.transaction(() => {
        adapter.exec("UPDATE test SET value = ? WHERE id = ?", "modified", 1)
        throw new Error("rollback")
      }),
    ).toThrow("rollback")

    const [row] = adapter.iterate<{ value: string }>(
      "SELECT value FROM test WHERE id = ?",
      1,
    )
    expect(row?.value).toBe("original")

    adapter.close()
  })
})

describe("SqliteStore — tables isolation", () => {
  it("two stores with different table names coexist in the same database", async () => {
    const db = new Database(":memory:")
    const adapter = fromBetterSqlite3(db)

    const store1 = new SqliteStore(adapter, {
      tables: { meta: "app1_meta", records: "app1_records" },
    })
    const store2 = new SqliteStore(adapter, {
      tables: { meta: "app2_meta", records: "app2_records" },
    })

    await store1.append("doc-1", makeMetaRecord())
    await store1.append("doc-1", makeEntryRecord("entirety", "v1-app1"))

    await store2.append("doc-1", makeMetaRecord())
    await store2.append("doc-1", makeEntryRecord("entirety", "v1-app2"))

    const records1 = await collectAll(store1.loadAll("doc-1"))
    const records2 = await collectAll(store2.loadAll("doc-1"))

    expect(records1).toHaveLength(2)
    expect(records2).toHaveLength(2)

    const entry1 = records1.find(r => r.kind === "entry")
    const entry2 = records2.find(r => r.kind === "entry")

    if (entry1?.kind === "entry") expect(entry1.version).toBe("v1-app1")
    if (entry2?.kind === "entry") expect(entry2.version).toBe("v1-app2")

    adapter.close()
  })
})

describe("SqliteStore — listDocIds with LIKE-special characters", () => {
  it("prefix containing % and _ matches literally, not as wildcards", async () => {
    const db = new Database(":memory:")
    const store = new SqliteStore(fromBetterSqlite3(db))

    // Create docs with tricky names
    await store.append("100%_done", makeMetaRecord())
    await store.append("100_other", makeMetaRecord())
    await store.append("100xyz", makeMetaRecord())
    await store.append("other", makeMetaRecord())

    // "100%" should match only "100%_done", not "100_other" or "100xyz"
    const matched = await collectAll(store.listDocIds("100%"))
    expect(matched).toEqual(["100%_done"])

    // "100_" should match only "100_other", not "100%_done" or "100xyz"
    const matched2 = await collectAll(store.listDocIds("100_"))
    expect(matched2).toEqual(["100_other"])

    await store.close()
  })
})

// sqlite-store — conformance + SQLite-specific tests.

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { StoreFormatVersionError } from "@kyneta/exchange"
import {
  collectAll,
  describeStore,
  makeArmedFault,
  makeEntryRecord,
  makeMetaRecord,
  plainMeta,
} from "@kyneta/exchange/testing"
import Database from "better-sqlite3"
import { afterAll, describe, expect, it } from "vitest"
import { fromBetterSqlite3, SqliteStore } from "../index.js"

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
// Conformance suite — validates the full Store contract
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
      const { proxy, arm } = makeArmedFault(base, { exec: 1 })
      const store = new SqliteStore(proxy)
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
          tables: {
            docMeta: "a_meta",
            records: "a_records",
            storeMeta: "a_store_meta",
          },
        }),
        storeB: new SqliteStore(adapter, {
          tables: {
            docMeta: "b_meta",
            records: "b_records",
            storeMeta: "b_store_meta",
          },
        }),
        // Both stores share `adapter`; closing it once tears down both.
        cleanup: async () => {
          adapter.close()
        },
      }
    },
    // Two connections to one file: `:memory:` databases are private to
    // their connection, so a second instance could not share one.
    secondInstance: {
      refused: false,
      open: async () => {
        const file = makeTmpFile()
        const first = new SqliteStore(fromBetterSqlite3(new Database(file)))
        const opened: SqliteStore[] = [first]
        return {
          first,
          openSecond: async () => {
            const second = new SqliteStore(
              fromBetterSqlite3(new Database(file)),
            )
            opened.push(second)
            return second
          },
          cleanup: async () => {
            for (const store of opened) await store.close()
          },
        }
      },
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
      tables: {
        docMeta: "app1_meta",
        records: "app1_records",
        storeMeta: "app1_store_meta",
      },
    })
    const store2 = new SqliteStore(adapter, {
      tables: {
        docMeta: "app2_meta",
        records: "app2_records",
        storeMeta: "app2_store_meta",
      },
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

// Capture the error thrown by a (synchronous) store open, for asserting its
// typed `reason` discriminant — the class alone can't distinguish refusals.
function captureError(open: () => unknown): unknown {
  try {
    open()
    return undefined
  } catch (e) {
    return e
  }
}

describe("SqliteStore — store-format gate", () => {
  it("refuses a store whose stamped major is incompatible", () => {
    const db = new Database(":memory:")
    // First open stamps {major:1,minor:0}. Keep the connection open — an
    // in-memory db's data lives only while the connection is open.
    new SqliteStore(fromBetterSqlite3(db))
    // Tamper the marker to a future major.
    db.prepare(
      "UPDATE kyneta_store_meta SET value = ? WHERE key = 'format'",
    ).run(JSON.stringify({ major: 99, minor: 0 }))

    const err = captureError(() => new SqliteStore(fromBetterSqlite3(db)))
    expect(err).toBeInstanceOf(StoreFormatVersionError)
    expect((err as StoreFormatVersionError).reason).toBe("incompatible-major")
    db.close()
  })

  it("refuses an unversioned store that already holds documents", () => {
    const db = new Database(":memory:")
    // Hand-create the doc-meta + records tables (no store_meta marker) and
    // insert a document row — simulating a foreign / pre-marker store.
    db.exec(`
      CREATE TABLE kyneta_doc_meta (doc_id TEXT PRIMARY KEY, data TEXT NOT NULL) WITHOUT ROWID;
      CREATE TABLE kyneta_records (
        doc_id TEXT NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL,
        payload TEXT, blob BLOB, PRIMARY KEY (doc_id, seq)
      ) WITHOUT ROWID;
      INSERT INTO kyneta_doc_meta (doc_id, data) VALUES ('doc-1', '{}');
    `)

    const err = captureError(() => new SqliteStore(fromBetterSqlite3(db)))
    expect(err).toBeInstanceOf(StoreFormatVersionError)
    expect((err as StoreFormatVersionError).reason).toBe(
      "unversioned-existing-data",
    )
    db.close()
  })
})

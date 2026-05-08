// persistence-and-restart — SQLite-backed Exchange integration over real
// WebSocket transport. Proves:
//
// Test A: Two SQLite-backed exchanges sync a Yjs doc over a real WebSocket
//   transport, and the on-disk SQLite state matches what the API observes.
//   Yjs is chosen for its binary payloads, exercising the BLOB column path
//   through SqliteStore that the JSON-substrate unit suite doesn't cover.
//
// Test B: After shutdown, fresh exchanges with no transport rehydrate
//   from SQLite alone (Phase 1). After a second restart with fresh
//   WebSocket transports, sync resumes correctly on top of pre-hydrated
//   state (Phase 2).
//
// Splitting Test B into two phases is deliberate: with a transport
// attached at construction, sync messages can flow before the hydration
// assertion, making "no sync occurred" racy. Phase 1 has no transport at
// all — the assertion is deterministic. Phase 2 then proves resume.

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Exchange } from "@kyneta/exchange"
import { change, Schema } from "@kyneta/schema"
import { fromBetterSqlite3, SqliteStore } from "@kyneta/sqlite-store"
import { yjs } from "@kyneta/yjs-schema"
import Database from "better-sqlite3"
import { afterEach, describe, expect, it } from "vitest"
import { createTestLifecycle } from "../helpers/cleanup.js"
import { drain } from "../helpers/drain.js"
import { createConnectedPair } from "../helpers/exchange-pair.js"

const lifecycle = createTestLifecycle()

afterEach(() => lifecycle.cleanup())

const YjsDoc = yjs.bind(
  Schema.struct({
    title: Schema.text(),
    count: Schema.number(),
  }),
)

interface SqlitePathPair {
  serverPath: string
  clientPath: string
}

/** Allocate two tmpdirs (one SQLite path each) and register for cleanup. */
function makeSqlitePaths(): SqlitePathPair {
  const serverDir = lifecycle.registerTmpdir(
    fs.mkdtempSync(path.join(os.tmpdir(), "kyneta-int-server-")),
  )
  const clientDir = lifecycle.registerTmpdir(
    fs.mkdtempSync(path.join(os.tmpdir(), "kyneta-int-client-")),
  )
  return {
    serverPath: path.join(serverDir, "exchange.db"),
    clientPath: path.join(clientDir, "exchange.db"),
  }
}

/** Construct a SqliteStore over a fresh better-sqlite3 connection. */
function openStore(filePath: string): SqliteStore {
  const db = new Database(filePath)
  return new SqliteStore(fromBetterSqlite3(db))
}

interface EntryPayloadJson {
  readonly kind: "entirety" | "since"
  readonly encoding: "json" | "binary"
  readonly version: string
  readonly data?: string
}

/**
 * Inspect a SQLite file via a separate read-only handle. Returns the meta
 * row count for `doc-1`, the raw entry rows, and the count of entry rows
 * whose `blob` column is non-null.
 */
function inspectDb(
  filePath: string,
  docId: string,
): {
  metaRowCount: number
  metaSchemaHash: string | null
  metaKindRowCount: number
  entryKindRowCount: number
  lastEntryBlobNonNull: boolean
  lastEntryPayloadJson: EntryPayloadJson | null
} {
  const db = new Database(filePath, { readonly: true })
  try {
    const metaRow = db
      .prepare(`SELECT data FROM meta WHERE doc_id = ?`)
      .get(docId) as { data: string } | undefined
    const metaSchemaHash =
      metaRow !== undefined
        ? ((
            JSON.parse(metaRow.data) as {
              schemaHash?: string
            }
          ).schemaHash ?? null)
        : null

    const kindCounts = db
      .prepare(
        `SELECT kind, COUNT(*) AS n FROM records WHERE doc_id = ? GROUP BY kind`,
      )
      .all(docId) as { kind: string; n: number }[]
    let metaKindRowCount = 0
    let entryKindRowCount = 0
    for (const row of kindCounts) {
      if (row.kind === "meta") metaKindRowCount = row.n
      if (row.kind === "entry") entryKindRowCount = row.n
    }

    const lastEntry = db
      .prepare(
        `SELECT payload, blob FROM records WHERE doc_id = ? AND kind = 'entry' ORDER BY seq DESC LIMIT 1`,
      )
      .get(docId) as { payload: string; blob: Uint8Array | null } | undefined

    return {
      metaRowCount: metaRow === undefined ? 0 : 1,
      metaSchemaHash,
      metaKindRowCount,
      entryKindRowCount,
      lastEntryBlobNonNull: lastEntry !== undefined && lastEntry.blob !== null,
      lastEntryPayloadJson:
        lastEntry !== undefined
          ? (JSON.parse(lastEntry.payload) as EntryPayloadJson)
          : null,
    }
  } finally {
    db.close()
  }
}

describe("SQLite-backed exchanges: persistence + restart over WebSocket", () => {
  it("two SQLite-backed exchanges converge and persist on both sides", async () => {
    const { serverPath, clientPath } = makeSqlitePaths()

    const serverStore = openStore(serverPath)
    const clientStore = openStore(clientPath)

    const { serverExchange, clientExchange } = await createConnectedPair(
      lifecycle,
      {
        serverStores: [serverStore],
        clientStores: [clientStore],
        schemas: [YjsDoc],
      },
    )

    const docServer = serverExchange.get("doc-1", YjsDoc)
    const docClient = clientExchange.get("doc-1", YjsDoc)

    change(docServer, (d: any) => {
      d.title.insert(0, "from server")
      d.count.set(7)
    })

    await drain()
    expect(docClient.title()).toBe("from server")
    expect(docClient.count()).toBe(7)

    change(docClient, (d: any) => {
      d.count.set(42)
    })

    await drain()
    expect(docServer.title()).toBe("from server")
    expect(docServer.count()).toBe(42)

    // Make sure all writes have landed on disk before opening read-only
    // handles to inspect.
    await serverExchange.flush()
    await clientExchange.flush()

    for (const filePath of [serverPath, clientPath]) {
      const inspection = inspectDb(filePath, "doc-1")

      expect(inspection.metaRowCount).toBe(1)
      expect(inspection.metaSchemaHash).toBe(YjsDoc.schemaHash)

      expect(inspection.metaKindRowCount).toBeGreaterThanOrEqual(1)
      expect(inspection.entryKindRowCount).toBeGreaterThanOrEqual(1)

      // Yjs payloads are binary — the most-recent entry must have a
      // non-null `blob` column, and its payload-json must declare
      // `encoding: "binary"` with no `data` field (binary lives in
      // the blob column, not the payload column).
      expect(inspection.lastEntryBlobNonNull).toBe(true)
      expect(inspection.lastEntryPayloadJson).not.toBeNull()
      expect(inspection.lastEntryPayloadJson?.encoding).toBe("binary")
      expect(inspection.lastEntryPayloadJson?.data).toBeUndefined()
    }
  })

  it("state survives shutdown and exchanges resume syncing", async () => {
    const { serverPath, clientPath } = makeSqlitePaths()

    // -----------------------------------------------------------------
    // Phase 0 — initial converge + shutdown.
    // -----------------------------------------------------------------
    {
      const serverStore = openStore(serverPath)
      const clientStore = openStore(clientPath)

      const { serverExchange, clientExchange } = await createConnectedPair(
        lifecycle,
        {
          serverStores: [serverStore],
          clientStores: [clientStore],
          schemas: [YjsDoc],
        },
      )

      const docServer = serverExchange.get("doc-1", YjsDoc)
      clientExchange.get("doc-1", YjsDoc)

      change(docServer, (d: any) => {
        d.title.insert(0, "persisted")
        d.count.set(11)
      })

      await drain()
      await serverExchange.flush()
      await clientExchange.flush()

      // Cleanup of these specific exchanges/server, keeping tmpdirs.
      await lifecycle.cleanupTransient()
    }

    // -----------------------------------------------------------------
    // Phase 1 — hydrate from SQLite alone, NO transport. Deterministic
    // because no sync messages can flow.
    // -----------------------------------------------------------------
    {
      const serverStore = openStore(serverPath)
      const clientStore = openStore(clientPath)

      const serverExchange = lifecycle.registerExchange(
        new Exchange({
          id: "server",
          stores: [serverStore],
          schemas: [YjsDoc],
        }),
      )
      const clientExchange = lifecycle.registerExchange(
        new Exchange({
          id: "client",
          stores: [clientStore],
          schemas: [YjsDoc],
        }),
      )

      const docServer = serverExchange.get("doc-1", YjsDoc)
      const docClient = clientExchange.get("doc-1", YjsDoc)
      await serverExchange.flush()
      await clientExchange.flush()

      expect(docServer.title()).toBe("persisted")
      expect(docServer.count()).toBe(11)
      expect(docClient.title()).toBe("persisted")
      expect(docClient.count()).toBe(11)

      await lifecycle.cleanupTransient()
    }

    // -----------------------------------------------------------------
    // Phase 2 — fresh WebSocket transports. Hydrate locally first, then
    // mutate one side and verify propagation. Proves sync resumes on
    // top of pre-hydrated state.
    // -----------------------------------------------------------------
    {
      const serverStore = openStore(serverPath)
      const clientStore = openStore(clientPath)

      const { serverExchange, clientExchange } = await createConnectedPair(
        lifecycle,
        {
          serverStores: [serverStore],
          clientStores: [clientStore],
          schemas: [YjsDoc],
        },
      )

      const docServer = serverExchange.get("doc-1", YjsDoc)
      const docClient = clientExchange.get("doc-1", YjsDoc)
      await drain()

      expect(docServer.count()).toBe(11)
      expect(docClient.count()).toBe(11)

      change(docClient, (d: any) => {
        d.count.set(99)
      })

      await drain()
      expect(docServer.count()).toBe(99)
    }
  })
})

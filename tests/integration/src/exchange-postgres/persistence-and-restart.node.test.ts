// Postgres-backed Exchange integration over real WebSocket transport.
//
// Mirrors exchange-sqlite/persistence-and-restart for the Postgres
// backend:
//
// Test A: Two Postgres-backed exchanges sync a Yjs doc, with raw SQL
//   row inspection (BYTEA blob path).
//
// Test B: After shutdown, fresh exchanges with no transport rehydrate
//   from the database alone (Phase 1). After a second restart with
//   fresh WebSocket transports, sync resumes correctly (Phase 2).
//
// Gated by `KYNETA_PG_URL`. To run:
//   KYNETA_PG_URL=postgres://localhost:5432/kyneta_test pnpm verify

import { Exchange } from "@kyneta/exchange"
import { createPostgresStore } from "@kyneta/postgres-store"
import { change, Schema } from "@kyneta/schema"
import type { EntryPayloadJson } from "@kyneta/sql-store-core"
import { yjs } from "@kyneta/yjs-schema"
import type { Pool } from "pg"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { createTestLifecycle } from "../helpers/cleanup.js"
import { drain } from "../helpers/drain.js"
import { createConnectedPair } from "../helpers/exchange-pair.js"
import {
  openPgPool,
  POSTGRES_SCHEMA_DDL,
  pgEnabled,
  truncateAll,
} from "../helpers/postgres.js"

const lifecycle = createTestLifecycle()
afterEach(() => lifecycle.cleanup())

const YjsDoc = yjs.bind(
  Schema.struct({
    title: Schema.text(),
    count: Schema.number(),
  }),
)

const describeIfEnabled = pgEnabled() ? describe : describe.skip

describeIfEnabled(
  "Postgres-backed exchanges: persistence + restart over WebSocket",
  () => {
    let serverPool: Pool
    let clientPool: Pool

    beforeAll(async () => {
      // The "two exchanges" pattern uses two pools to model two
      // independent server/client storage tiers. They both run the
      // canonical schema; per-test truncation isolates state.
      serverPool = openPgPool()
      clientPool = openPgPool()
      await serverPool.query(POSTGRES_SCHEMA_DDL)
      await clientPool.query(POSTGRES_SCHEMA_DDL)
    })

    afterAll(async () => {
      await serverPool.end()
      await clientPool.end()
    })

    afterEach(async () => {
      await truncateAll(serverPool)
      await truncateAll(clientPool)
    })

    it("two Postgres-backed exchanges converge and persist on both sides", async () => {
      const serverStore = await createPostgresStore(serverPool)
      const clientStore = await createPostgresStore(clientPool)

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

      await serverExchange.flush()
      await clientExchange.flush()

      // Inspect raw rows on both sides.
      for (const pool of [serverPool, clientPool]) {
        const metaResult = await pool.query<{
          data: { schemaHash: string }
        }>(`SELECT data FROM kyneta_meta WHERE doc_id = $1`, ["doc-1"])
        expect(metaResult.rows).toHaveLength(1)
        expect(metaResult.rows[0]?.data.schemaHash).toBe(YjsDoc.schemaHash)

        const kindResult = await pool.query<{ kind: string; n: string }>(
          `SELECT kind, COUNT(*) AS n FROM kyneta_records WHERE doc_id = $1 GROUP BY kind`,
          ["doc-1"],
        )
        const counts = new Map(kindResult.rows.map(r => [r.kind, Number(r.n)]))
        expect(counts.get("meta") ?? 0).toBeGreaterThanOrEqual(1)
        expect(counts.get("entry") ?? 0).toBeGreaterThanOrEqual(1)

        // Yjs payloads are binary — the most-recent entry has a non-null
        // BYTEA blob, and its payload JSON declares encoding="binary"
        // with no data field.
        const lastResult = await pool.query<{
          payload: string
          blob: Uint8Array | null
        }>(
          `SELECT payload, blob FROM kyneta_records
           WHERE doc_id = $1 AND kind = 'entry'
           ORDER BY seq DESC LIMIT 1`,
          ["doc-1"],
        )
        const last = lastResult.rows[0]
        expect(last).toBeDefined()
        if (last === undefined) return
        expect(last.blob).not.toBeNull()
        const json = JSON.parse(last.payload) as EntryPayloadJson
        expect(json.encoding).toBe("binary")
        expect(json.data).toBeUndefined()
      }
    })

    it("state survives shutdown and exchanges resume syncing", async () => {
      // Phase 0: converge + shutdown.
      {
        const serverStore = await createPostgresStore(serverPool)
        const clientStore = await createPostgresStore(clientPool)

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
        await lifecycle.cleanupTransient()
      }

      // Phase 1: hydrate from Postgres alone (no transport).
      {
        const serverStore = await createPostgresStore(serverPool)
        const clientStore = await createPostgresStore(clientPool)

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

      // Phase 2: fresh WebSocket transports — sync resumes on top of state.
      {
        const serverStore = await createPostgresStore(serverPool)
        const clientStore = await createPostgresStore(clientPool)

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

    it("round-trip portability: rows written via sqlite-store hydrate via postgres-store", async () => {
      // This test asserts the success-criterion #7 contract: a record
      // stream written through one SQL-family backend can be loaded
      // through another and yields structurally equal `StoreRecord`s.
      // We do a manual transcribe (sqlite tmpfile → pg) to keep the
      // test self-contained.
      const Database = (await import("better-sqlite3")).default
      const { fromBetterSqlite3, SqliteStore } = await import(
        "@kyneta/sqlite-store"
      )

      const db = new Database(":memory:")
      const sqliteStore = new SqliteStore(fromBetterSqlite3(db))

      // Write a meta + a couple of entries through sqlite.
      const exchange = lifecycle.registerExchange(
        new Exchange({
          id: "sqlite-source",
          stores: [sqliteStore],
          schemas: [YjsDoc],
        }),
      )
      const doc = exchange.get("doc-roundtrip", YjsDoc)
      change(doc, (d: any) => {
        d.title.insert(0, "portable")
        d.count.set(5)
      })
      await exchange.flush()

      // Transcribe rows: kyneta_meta + kyneta_records → Postgres.
      await truncateAll(serverPool)
      const metaRows = db
        .prepare(`SELECT doc_id, data FROM kyneta_meta`)
        .all() as Array<{ doc_id: string; data: string }>
      for (const row of metaRows) {
        await serverPool.query(
          `INSERT INTO kyneta_meta (doc_id, data) VALUES ($1, $2::jsonb)`,
          [row.doc_id, row.data],
        )
      }
      const recRows = db
        .prepare(
          `SELECT doc_id, seq, kind, payload, blob FROM kyneta_records ORDER BY seq`,
        )
        .all() as Array<{
        doc_id: string
        seq: number
        kind: string
        payload: string | null
        blob: Buffer | null
      }>
      for (const r of recRows) {
        await serverPool.query(
          `INSERT INTO kyneta_records (doc_id, seq, kind, payload, blob)
             VALUES ($1, $2, $3, $4, $5)`,
          [r.doc_id, r.seq, r.kind, r.payload, r.blob],
        )
      }
      db.close()

      // Hydrate from Postgres — the doc should round-trip identically.
      const pgStore = await createPostgresStore(serverPool)
      const pgExchange = lifecycle.registerExchange(
        new Exchange({
          id: "pg-sink",
          stores: [pgStore],
          schemas: [YjsDoc],
        }),
      )
      const docPg = pgExchange.get("doc-roundtrip", YjsDoc)
      await pgExchange.flush()

      expect(docPg.title()).toBe("portable")
      expect(docPg.count()).toBe(5)
    })
  },
)

// postgres-store — conformance + Postgres-specific tests.
//
// Gated by the `KYNETA_PG_URL` env var. When unset, the entire suite
// is skipped (the package still builds and typechecks). Set
// `KYNETA_PG_URL=postgres://localhost:5432/kyneta_test` (or similar)
// to run.

import { describeStore, makeMetaRecord } from "@kyneta/exchange/testing"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createPostgresStore, PostgresStore } from "../index.js"

const PG_URL = process.env.KYNETA_PG_URL
const ENABLED = PG_URL !== undefined && PG_URL.length > 0

const pool: Pool | null = ENABLED
  ? new Pool({ connectionString: PG_URL })
  : null

// Per-test schema namespace via per-test table names. Truncate between
// tests via DELETE on the canonical tables for the conformance run.
const SCHEMA_TABLES = {
  meta: "kyneta_meta",
  records: "kyneta_records",
} as const

const SCHEMA_DDL = `
  CREATE TABLE IF NOT EXISTS ${SCHEMA_TABLES.meta} (
    doc_id TEXT  PRIMARY KEY,
    data   JSONB NOT NULL
  );
  CREATE TABLE IF NOT EXISTS ${SCHEMA_TABLES.records} (
    doc_id  TEXT    NOT NULL,
    seq     INTEGER NOT NULL,
    kind    TEXT    NOT NULL,
    payload TEXT,
    blob    BYTEA,
    PRIMARY KEY (doc_id, seq)
  );
`

if (ENABLED && pool !== null) {
  beforeAll(async () => {
    await pool.query(SCHEMA_DDL)
  })

  afterAll(async () => {
    await pool.end()
  })
}

const describeIfEnabled = ENABLED ? describe : describe.skip

describeIfEnabled("PostgresStore", () => {
  if (!ENABLED || pool === null) return

  // -------------------------------------------------------------------------
  // Conformance suite — uses canonical tables + per-test truncation
  // -------------------------------------------------------------------------

  describeStore(
    "PostgresStore",
    async () => {
      // Truncate before each test for a clean slate.
      await pool.query(
        `TRUNCATE ${SCHEMA_TABLES.records}, ${SCHEMA_TABLES.meta}`,
      )
      return new PostgresStore(pool)
    },
    {
      cleanup: async () => {
        await pool.query(
          `TRUNCATE ${SCHEMA_TABLES.records}, ${SCHEMA_TABLES.meta}`,
        )
      },
      faultFactory: async () => {
        await pool.query(
          `TRUNCATE ${SCHEMA_TABLES.records}, ${SCHEMA_TABLES.meta}`,
        )
        // Wrap a single connection (not the pool) so we can intercept
        // its `query` method to inject failures. The faulty store uses
        // a Client-shaped wrapper; the fresh store uses a fresh client
        // checked out from the pool.
        const client = await pool.connect()
        // Forward all queries except after arming, when the Nth post-arm
        // call throws. Schema DDL ran in beforeAll, so we don't need to
        // protect those calls.
        let armed: number | null = null
        let count = 0
        const realQuery = client.query.bind(client) as (
          ...args: unknown[]
        ) => Promise<unknown>
        const wrappedClient = {
          query: ((...args: unknown[]) => {
            if (armed !== null) {
              count += 1
              if (count === armed) {
                return Promise.reject(
                  new Error(`fault-injected: query call #${count}`),
                )
              }
            }
            return realQuery(...args)
          }) as typeof client.query,
          // Pretend to be a Client (no .connect method).
        } as unknown as ConstructorParameters<typeof PostgresStore>[0]

        const store = new PostgresStore(wrappedClient)

        return {
          store,
          injectFault: n => {
            armed = n
            count = 0
          },
          freshStore: async () => new PostgresStore(pool),
          cleanup: async () => {
            client.release()
          },
        }
      },
      isolationFactory: async () => {
        // Two distinct table-name pairs sharing the same Pool.
        const tablesA = { meta: "iso_a_meta", records: "iso_a_records" }
        const tablesB = { meta: "iso_b_meta", records: "iso_b_records" }
        await pool.query(`
          CREATE TABLE IF NOT EXISTS ${tablesA.meta} (
            doc_id TEXT PRIMARY KEY, data JSONB NOT NULL
          );
          CREATE TABLE IF NOT EXISTS ${tablesA.records} (
            doc_id TEXT, seq INTEGER, kind TEXT, payload TEXT, blob BYTEA,
            PRIMARY KEY (doc_id, seq)
          );
          CREATE TABLE IF NOT EXISTS ${tablesB.meta} (
            doc_id TEXT PRIMARY KEY, data JSONB NOT NULL
          );
          CREATE TABLE IF NOT EXISTS ${tablesB.records} (
            doc_id TEXT, seq INTEGER, kind TEXT, payload TEXT, blob BYTEA,
            PRIMARY KEY (doc_id, seq)
          );
          TRUNCATE ${tablesA.records}, ${tablesA.meta},
                   ${tablesB.records}, ${tablesB.meta};
        `)
        return {
          storeA: new PostgresStore(pool, { tables: tablesA }),
          storeB: new PostgresStore(pool, { tables: tablesB }),
          cleanup: async () => {
            await pool.query(`
              DROP TABLE IF EXISTS ${tablesA.records};
              DROP TABLE IF EXISTS ${tablesA.meta};
              DROP TABLE IF EXISTS ${tablesB.records};
              DROP TABLE IF EXISTS ${tablesB.meta};
            `)
          },
        }
      },
    },
  )

  // -------------------------------------------------------------------------
  // Postgres-specific: createPostgresStore validation
  // -------------------------------------------------------------------------

  describe("createPostgresStore — schema validation", () => {
    it("rejects when meta table is missing", async () => {
      await expect(
        createPostgresStore(pool, {
          tables: { meta: "nonexistent_meta", records: "kyneta_records" },
        }),
      ).rejects.toThrow(/nonexistent_meta/)
    })

    it("rejects when records table is missing", async () => {
      await expect(
        createPostgresStore(pool, {
          tables: { meta: "kyneta_meta", records: "nonexistent_records" },
        }),
      ).rejects.toThrow(/nonexistent_records/)
    })

    it("returns a ready Store when schema is valid", async () => {
      const store = await createPostgresStore(pool)
      expect(store).toBeDefined()
      await store.close()
    })

    it("rejects when a column has the wrong type", async () => {
      const tables = {
        meta: "wrongtype_meta",
        records: "wrongtype_records",
      }
      await pool.query(`
        DROP TABLE IF EXISTS ${tables.records};
        DROP TABLE IF EXISTS ${tables.meta};
        CREATE TABLE ${tables.meta} (
          doc_id TEXT PRIMARY KEY, data TEXT NOT NULL
        );
        CREATE TABLE ${tables.records} (
          doc_id TEXT, seq INTEGER, kind TEXT, payload TEXT, blob BYTEA,
          PRIMARY KEY (doc_id, seq)
        );
      `)
      try {
        await expect(createPostgresStore(pool, { tables })).rejects.toThrow(
          /data.*type "text"/,
        )
      } finally {
        await pool.query(`
          DROP TABLE IF EXISTS ${tables.records};
          DROP TABLE IF EXISTS ${tables.meta};
        `)
      }
    })
  })

  // -------------------------------------------------------------------------
  // Postgres-specific: range-scan correctness
  // -------------------------------------------------------------------------

  describe("listDocIds — range scan vs LIKE-pattern hazards", () => {
    it("prefix containing % and _ matches literally, not as wildcards", async () => {
      await pool.query(
        `TRUNCATE ${SCHEMA_TABLES.records}, ${SCHEMA_TABLES.meta}`,
      )
      const store = new PostgresStore(pool)

      await store.append("100%_done", makeMetaRecord())
      await store.append("100_other", makeMetaRecord())
      await store.append("100xyz", makeMetaRecord())
      await store.append("other", makeMetaRecord())

      // "100%" must match only "100%_done" — NOT "100_other" / "100xyz"
      const matched: string[] = []
      for await (const id of store.listDocIds("100%")) matched.push(id)
      expect(matched).toEqual(["100%_done"])

      // "100_" must match only "100_other"
      const matched2: string[] = []
      for await (const id of store.listDocIds("100_")) matched2.push(id)
      expect(matched2).toEqual(["100_other"])
    })
  })
})

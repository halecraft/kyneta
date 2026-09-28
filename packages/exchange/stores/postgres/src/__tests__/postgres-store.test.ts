// postgres-store — conformance + Postgres-specific tests.
//
// Gated by the `KYNETA_PG_URL` env var. When unset, the entire suite
// is skipped (the package still builds and typechecks). To run it against
// a disposable Postgres in Docker, from the repository root:
//   eval "$(scripts/postgres.sh up)" && pnpm verify

import type { Store } from "@kyneta/exchange"
import { describeStore, makeArmedFault } from "@kyneta/exchange/testing"
import { DEFAULT_TABLES } from "@kyneta/sql-store-core"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  createPostgresStore,
  fromClient,
  fromPool,
  PostgresStore,
  postgresSchema,
} from "../index.js"
import { pgTestDatabase, pgTestServer } from "../testing.js"

const ENABLED = pgTestServer() !== null

// A database of this suite's own, so a parallel suite on the same server
// cannot truncate its tables mid-test.
const pool: Pool | null = ENABLED
  ? new Pool({
      connectionString: await pgTestDatabase("kyneta_postgres_store"),
    })
  : null

if (ENABLED && pool !== null) {
  beforeAll(async () => {
    await pool.query(postgresSchema())
  })

  afterAll(async () => {
    await pool.end()
  })
}

const describeIfEnabled = ENABLED ? describe : describe.skip

/** The seat section's tables, apart from the canonical ones. */
const SEAT_TABLES = {
  docMeta: "seat_doc_meta",
  records: "seat_records",
  storeMeta: "seat_store_meta",
}

/**
 * End the connection holding `store`'s seat lock, from another connection,
 * as a crash would, and wait until its locks are gone. The store's writes
 * still reach the database through its pool.
 */
async function terminateSeat(storeMeta: string, store: Store): Promise<void> {
  if (pool === null) throw new Error("terminateSeat: no pool")
  await pool.query(
    `SELECT pg_terminate_backend(pid, 5000) FROM pg_locks
     WHERE locktype = 'advisory' AND objsubid = 2
       AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
       AND classid = hashtext($1)::oid AND objid = hashtext($2)::oid`,
    [storeMeta, store.seat.peerId],
  )
}

describeIfEnabled("PostgresStore", () => {
  if (!ENABLED || pool === null) return

  // -------------------------------------------------------------------------
  // Conformance suite — uses canonical tables + per-test truncation
  // -------------------------------------------------------------------------

  // The seat pool lives in the store-metadata table, so it is truncated too:
  // a pool left by one test would hand its seats to the next.
  const truncateAll = () =>
    pool.query(
      `TRUNCATE ${DEFAULT_TABLES.records}, ${DEFAULT_TABLES.docMeta}, ${DEFAULT_TABLES.storeMeta}`,
    )

  describeStore(
    "PostgresStore",
    async () => {
      await truncateAll()
      return PostgresStore.open(fromPool(pool))
    },
    {
      cleanup: async () => {
        await truncateAll()
      },
      seats: {
        kind: "pooled",
        storage: async () => {
          await pool.query(postgresSchema(SEAT_TABLES))
          await pool.query(
            `TRUNCATE ${SEAT_TABLES.records}, ${SEAT_TABLES.docMeta}, ${SEAT_TABLES.storeMeta}`,
          )
          return {
            open: () =>
              PostgresStore.open(fromPool(pool), { tables: SEAT_TABLES }),
            cleanup: async () => {},
          }
        },
        abandon: store => terminateSeat(SEAT_TABLES.storeMeta, store),
      },
      faultFactory: async () => {
        await truncateAll()
        // Check out a single connection and wrap its `query` with the shared
        // op-weighted fault primitive. `fromClient` runs transactions inline
        // on that one connection, so every query (BEGIN/COMMIT/fence/inserts/
        // reads) is counted, and the sweep fails each in turn.
        const client = await pool.connect()
        const { proxy, arm, fired } = makeArmedFault(client, { query: 1 })
        const store = await PostgresStore.open(fromClient(proxy))
        return {
          store,
          injectFault: arm,
          fired,
          freshStore: () => PostgresStore.open(fromPool(pool)),
          cleanup: async () => {
            await store.close()
            client.release()
          },
        }
      },
      isolationFactory: async () => {
        // Two distinct table-name sets sharing the same Pool, from the
        // canonical DDL.
        const tablesA = {
          docMeta: "iso_a_meta",
          records: "iso_a_records",
          storeMeta: "iso_a_store_meta",
        }
        const tablesB = {
          docMeta: "iso_b_meta",
          records: "iso_b_records",
          storeMeta: "iso_b_store_meta",
        }
        await pool.query(postgresSchema(tablesA))
        await pool.query(postgresSchema(tablesB))
        await pool.query(`
          TRUNCATE ${tablesA.records}, ${tablesA.docMeta}, ${tablesA.storeMeta},
                   ${tablesB.records}, ${tablesB.docMeta}, ${tablesB.storeMeta};
        `)
        const storeA = await PostgresStore.open(fromPool(pool), {
          tables: tablesA,
        })
        const storeB = await PostgresStore.open(fromPool(pool), {
          tables: tablesB,
        })
        return {
          storeA,
          storeB,
          cleanup: async () => {
            await storeA.close()
            await storeB.close()
            await pool.query(`
              DROP TABLE IF EXISTS ${tablesA.records};
              DROP TABLE IF EXISTS ${tablesA.docMeta};
              DROP TABLE IF EXISTS ${tablesA.storeMeta};
              DROP TABLE IF EXISTS ${tablesB.records};
              DROP TABLE IF EXISTS ${tablesB.docMeta};
              DROP TABLE IF EXISTS ${tablesB.storeMeta};
            `)
          },
        }
      },
    },
  )

  // -------------------------------------------------------------------------
  // Postgres-specific: seat allocation
  // -------------------------------------------------------------------------

  describe("PostgresStore — seat allocation", () => {
    const tables = {
      docMeta: "alloc_doc_meta",
      records: "alloc_records",
      storeMeta: "alloc_store_meta",
    }

    beforeAll(async () => {
      await pool.query(postgresSchema(tables))
    })

    it("concurrent opens take distinct seats, and none waits on another's seat", async () => {
      await pool.query(`TRUNCATE ${tables.storeMeta}`)
      const stores = await Promise.all(
        Array.from({ length: 5 }, () =>
          PostgresStore.open(fromPool(pool), { tables }),
        ),
      )
      try {
        const ids = new Set(stores.map(store => store.seat.peerId))
        expect(ids.size).toBe(5)
      } finally {
        for (const store of stores) await store.close()
      }
    })

    it("a seat whose connection was terminated is taken by the next open", async () => {
      await pool.query(`TRUNCATE ${tables.storeMeta}`)
      const crashed = await PostgresStore.open(fromPool(pool), { tables })
      const other = await PostgresStore.open(fromPool(pool), { tables })
      try {
        await terminateSeat(tables.storeMeta, crashed)
        const next = await PostgresStore.open(fromPool(pool), { tables })
        expect(next.seat.peerId).toBe(crashed.seat.peerId)
        expect(next.seat.fence).toBe(crashed.seat.fence + 1)
        await next.close()
      } finally {
        await crashed.close()
        await other.close()
      }
    })

    it("a seat lock is released by close, and the seat reused", async () => {
      await pool.query(`TRUNCATE ${tables.storeMeta}`)
      const first = await PostgresStore.open(fromPool(pool), { tables })
      await first.close()
      const second = await PostgresStore.open(fromPool(pool), { tables })
      expect(second.seat.peerId).toBe(first.seat.peerId)
      await second.close()
    })
  })

  // -------------------------------------------------------------------------
  // Postgres-specific: createPostgresStore validation
  // -------------------------------------------------------------------------

  describe("createPostgresStore — schema validation", () => {
    it("rejects when doc-meta table is missing", async () => {
      await expect(
        createPostgresStore(fromPool(pool), {
          tables: { docMeta: "nonexistent_meta", records: "kyneta_records" },
        }),
      ).rejects.toThrow(/nonexistent_meta/)
    })

    it("rejects when records table is missing", async () => {
      await expect(
        createPostgresStore(fromPool(pool), {
          tables: {
            docMeta: "kyneta_doc_meta",
            records: "nonexistent_records",
          },
        }),
      ).rejects.toThrow(/nonexistent_records/)
    })

    it("returns a ready Store when schema is valid", async () => {
      const store = await createPostgresStore(fromPool(pool))
      expect(store).toBeDefined()
      await store.close()
    })

    it("rejects when a column has the wrong type", async () => {
      const tables = {
        docMeta: "wrongtype_meta",
        records: "wrongtype_records",
      }
      await pool.query(`
        DROP TABLE IF EXISTS ${tables.records};
        DROP TABLE IF EXISTS ${tables.docMeta};
        CREATE TABLE ${tables.docMeta} (
          doc_id TEXT COLLATE "C" PRIMARY KEY, data TEXT NOT NULL
        );
        CREATE TABLE ${tables.records} (
          doc_id TEXT COLLATE "C", seq INTEGER, kind TEXT, payload TEXT,
          blob BYTEA, PRIMARY KEY (doc_id, seq)
        );
      `)
      try {
        await expect(
          createPostgresStore(fromPool(pool), { tables }),
        ).rejects.toThrow(/data.*type "text"/)
      } finally {
        await pool.query(`
          DROP TABLE IF EXISTS ${tables.records};
          DROP TABLE IF EXISTS ${tables.docMeta};
        `)
      }
    })
  })

  describe("createPostgresStore — doc_id collation", () => {
    it('refuses a doc_id column without COLLATE "C", naming the migration', async () => {
      // Created as schema.sql was before `doc_id` had to be byte-ordered:
      // under the database's locale collation the prefix scan returns nothing.
      const tables = {
        docMeta: "locale_meta",
        records: "locale_records",
        storeMeta: "locale_store_meta",
      }
      await pool.query(`
        DROP TABLE IF EXISTS ${tables.records};
        DROP TABLE IF EXISTS ${tables.docMeta};
        DROP TABLE IF EXISTS ${tables.storeMeta};
        ${postgresSchema(tables).replaceAll(' COLLATE "C"', "")}
      `)
      try {
        await expect(
          createPostgresStore(fromPool(pool), { tables }),
        ).rejects.toThrow(
          /locale_meta.*doc_id.*collation.*ALTER TABLE locale_meta ALTER COLUMN doc_id TYPE TEXT COLLATE "C"/,
        )
      } finally {
        await pool.query(`
          DROP TABLE IF EXISTS ${tables.records};
          DROP TABLE IF EXISTS ${tables.docMeta};
          DROP TABLE IF EXISTS ${tables.storeMeta};
        `)
      }
    })
  })

  // -------------------------------------------------------------------------
  // Postgres-specific: store-format gate
  // -------------------------------------------------------------------------

  describe("createPostgresStore — store-format gate", () => {
    const tables = {
      docMeta: "fmt_doc_meta",
      records: "fmt_records",
      storeMeta: "fmt_store_meta",
    }
    const ddl = postgresSchema(tables)
    const drop = `
      DROP TABLE IF EXISTS ${tables.records};
      DROP TABLE IF EXISTS ${tables.docMeta};
      DROP TABLE IF EXISTS ${tables.storeMeta};
    `

    it("stamps a fresh store and refuses an incompatible major", async () => {
      await pool.query(drop)
      await pool.query(ddl)
      try {
        // The first open stamps the current format.
        const store = await createPostgresStore(fromPool(pool), { tables })
        await store.close()
        const stamped = await pool.query<{ value: { major: number } }>(
          `SELECT value FROM ${tables.storeMeta} WHERE key = 'format'`,
        )
        expect(stamped.rows[0]?.value.major).toBe(1)

        // Tamper to a future major → reopen refuses.
        await pool.query(
          `UPDATE ${tables.storeMeta} SET value = $1::jsonb WHERE key = 'format'`,
          [JSON.stringify({ major: 99, minor: 0 })],
        )
        await expect(
          createPostgresStore(fromPool(pool), { tables }),
        ).rejects.toMatchObject({
          name: "StoreFormatVersionError",
          reason: "incompatible-major",
        })
      } finally {
        await pool.query(drop)
      }
    })
  })
})

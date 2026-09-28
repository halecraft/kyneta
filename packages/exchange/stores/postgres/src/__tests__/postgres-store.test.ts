// postgres-store — conformance + Postgres-specific tests.
//
// Gated by the `KYNETA_PG_URL` env var. When unset, the entire suite
// is skipped (the package still builds and typechecks). To run it against
// a disposable Postgres in Docker, from the repository root:
//   eval "$(scripts/postgres.sh up)" && pnpm verify

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
        `TRUNCATE ${DEFAULT_TABLES.records}, ${DEFAULT_TABLES.docMeta}`,
      )
      return new PostgresStore(fromPool(pool))
    },
    {
      cleanup: async () => {
        await pool.query(
          `TRUNCATE ${DEFAULT_TABLES.records}, ${DEFAULT_TABLES.docMeta}`,
        )
      },
      faultFactory: async () => {
        await pool.query(
          `TRUNCATE ${DEFAULT_TABLES.records}, ${DEFAULT_TABLES.docMeta}`,
        )
        // Check out a single connection and wrap its `query` with the shared
        // op-weighted fault primitive. `fromClient` runs transactions inline
        // on that one connection, so every query (BEGIN/COMMIT/inserts/reads)
        // is counted — injectFault(2) fires mid-transaction → rollback.
        const client = await pool.connect()
        const { proxy, arm } = makeArmedFault(client, { query: 1 })
        const store = new PostgresStore(fromClient(proxy))

        return {
          store,
          injectFault: arm,
          freshStore: async () => new PostgresStore(fromPool(pool)),
          cleanup: async () => {
            client.release()
          },
        }
      },
      // Two stores over one schema, as two processes have. Each transaction
      // checks out its own connection from the pool.
      secondInstance: {
        refused: false,
        open: async () => {
          await pool.query(
            `TRUNCATE ${DEFAULT_TABLES.records}, ${DEFAULT_TABLES.docMeta}`,
          )
          return {
            first: new PostgresStore(fromPool(pool)),
            openSecond: async () => new PostgresStore(fromPool(pool)),
            cleanup: async () => {
              await pool.query(
                `TRUNCATE ${DEFAULT_TABLES.records}, ${DEFAULT_TABLES.docMeta}`,
              )
            },
          }
        },
      },
      isolationFactory: async () => {
        // Two distinct table-name sets sharing the same Pool, from the
        // canonical DDL. These use the bare `PostgresStore` constructor (no
        // store-format gate), so each set's store-metadata table goes unused.
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
          TRUNCATE ${tablesA.records}, ${tablesA.docMeta},
                   ${tablesB.records}, ${tablesB.docMeta};
        `)
        return {
          storeA: new PostgresStore(fromPool(pool), { tables: tablesA }),
          storeB: new PostgresStore(fromPool(pool), { tables: tablesB }),
          cleanup: async () => {
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
        // First open stamps {major:1,minor:0}.
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

// Postgres Store backend.
//
// Why JSONB on meta, not TEXT: operators occasionally need to filter
// metas by `syncProtocol` or `replicaType` during incident
// investigations, and JSONB makes `data->>'syncProtocol'` trivial.
// Cost: JSONB normalizes whitespace and key order at insert time, so
// `meta.data` bytes don't match SQLite's TEXT-stored meta — but
// round-trip through `loadAll` still yields a structurally equal
// `StoreRecord`, which is what cross-backend portability actually
// requires.

import {
  type DocId,
  SeqNoTracker,
  type Store,
  type StoreMeta,
  type StoreRecord,
} from "@kyneta/exchange"
import {
  fromRow,
  planAppend,
  planReplace,
  type RowShape,
  resolveTables,
  type TableNames,
} from "@kyneta/sql-store-core"
import type { Client, Pool, PoolClient } from "pg"

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface PostgresStoreOptions {
  /**
   * Override the default table names (`kyneta_meta` and `kyneta_records`).
   *
   * Use when running multiple isolated Exchange instances against the
   * same database — each instance owns one `tables` pair.
   */
  tables?: Partial<TableNames>
}

type PgConnection = Client | Pool

/**
 * Narrow structural type for the methods we actually call. Keeps the
 * package independent of `pg`'s top-level type changes across versions.
 */
interface PgQuerier {
  query<R = unknown>(text: string, values?: unknown[]): Promise<{ rows: R[] }>
}

// ---------------------------------------------------------------------------
// PostgresStore
// ---------------------------------------------------------------------------

/**
 * Caller owns the connection lifecycle — `close()` is a no-op,
 * `pool.end()` is the caller's responsibility. Prefer
 * `createPostgresStore` over the bare constructor: it validates the
 * schema at construction time so misconfiguration fails loudly with a
 * curated error rather than per-method `column does not exist` later.
 */
export class PostgresStore implements Store {
  readonly #client: PgConnection
  readonly #seqNos = new SeqNoTracker()
  readonly #tables: TableNames

  constructor(client: PgConnection, options: PostgresStoreOptions = {}) {
    this.#client = client
    this.#tables = resolveTables(options)
  }

  /**
   * For `Pool`: check out a `PoolClient` so BEGIN..COMMIT all run on
   * the same physical connection (Postgres transactions are
   * connection-scoped; checking back out for COMMIT would target a
   * different connection). For `Client`: run inline.
   *
   * Re-throws on rollback so callers can put post-commit work
   * lexically after the awaited call — a rejection skips the next
   * statement, mirroring sync `transaction()` + throw.
   */
  async #withTransaction<R>(
    fn: (querier: PgQuerier) => Promise<R>,
  ): Promise<R> {
    const isPool = typeof (this.#client as Pool).connect === "function"
    if (isPool) {
      const poolClient: PoolClient = await (this.#client as Pool).connect()
      try {
        await poolClient.query("BEGIN")
        try {
          const result = await fn(poolClient as unknown as PgQuerier)
          await poolClient.query("COMMIT")
          return result
        } catch (e) {
          await poolClient.query("ROLLBACK")
          throw e
        }
      } finally {
        poolClient.release()
      }
    }
    const client = this.#client as Client
    await client.query("BEGIN")
    try {
      const result = await fn(client as unknown as PgQuerier)
      await client.query("COMMIT")
      return result
    } catch (e) {
      await client.query("ROLLBACK")
      throw e
    }
  }

  // Non-transactional reads (currentMeta, loadAll, listDocIds, the
  // cold-start MAX(seq)) don't need a held connection — issuing them
  // against the pool/client directly avoids unnecessary checkouts.
  get #q(): PgQuerier {
    return this.#client as unknown as PgQuerier
  }

  // -------------------------------------------------------------------------
  // Store interface
  // -------------------------------------------------------------------------

  async append(docId: DocId, record: StoreRecord): Promise<void> {
    const existingMeta = await this.currentMeta(docId)
    const seq = await this.#seqNos.next(docId, async () => {
      const result = await this.#q.query<{ max_seq: number | null }>(
        `SELECT MAX(seq)::int AS max_seq FROM ${this.#tables.records} WHERE doc_id = $1`,
        [docId],
      )
      return result.rows[0]?.max_seq ?? null
    })

    const plan = planAppend(docId, record, existingMeta, seq)

    await this.#withTransaction(async q => {
      if (plan.upsertMeta !== null) {
        await q.query(
          `INSERT INTO ${this.#tables.meta} (doc_id, data)
           VALUES ($1, $2::jsonb)
           ON CONFLICT (doc_id) DO UPDATE SET data = EXCLUDED.data`,
          [docId, plan.upsertMeta.data],
        )
      }
      const { row } = plan.insertRecord
      await q.query(
        `INSERT INTO ${this.#tables.records}
         (doc_id, seq, kind, payload, blob)
         VALUES ($1, $2, $3, $4, $5)`,
        [docId, plan.insertRecord.seq, row.kind, row.payload, row.blob],
      )
    })
  }

  async *loadAll(docId: DocId): AsyncIterable<StoreRecord> {
    const result = await this.#q.query<RowShape>(
      `SELECT kind, payload, blob FROM ${this.#tables.records}
       WHERE doc_id = $1 ORDER BY seq`,
      [docId],
    )
    for (const row of result.rows) {
      yield fromRow(row)
    }
  }

  async replace(docId: DocId, records: StoreRecord[]): Promise<void> {
    const existingMeta = await this.currentMeta(docId)
    const plan = planReplace(records, existingMeta)

    await this.#withTransaction(async q => {
      await q.query(`DELETE FROM ${this.#tables.records} WHERE doc_id = $1`, [
        docId,
      ])

      for (const { seq, row } of plan.records) {
        await q.query(
          `INSERT INTO ${this.#tables.records}
           (doc_id, seq, kind, payload, blob)
           VALUES ($1, $2, $3, $4, $5)`,
          [docId, seq, row.kind, row.payload, row.blob],
        )
      }

      await q.query(
        `INSERT INTO ${this.#tables.meta} (doc_id, data)
         VALUES ($1, $2::jsonb)
         ON CONFLICT (doc_id) DO UPDATE SET data = EXCLUDED.data`,
        [docId, plan.upsertMeta.data],
      )
    })

    // Must run after commit. If `#withTransaction` rejects, the throw
    // propagates past this line; the cache stays unmutated. Inside the
    // callback would corrupt it on rollback — the next append would
    // collide with restored rows on (doc_id, seq).
    this.#seqNos.reset(docId, records.length - 1)
  }

  async delete(docId: DocId): Promise<void> {
    await this.#withTransaction(async q => {
      await q.query(`DELETE FROM ${this.#tables.records} WHERE doc_id = $1`, [
        docId,
      ])
      await q.query(`DELETE FROM ${this.#tables.meta} WHERE doc_id = $1`, [
        docId,
      ])
    })
    this.#seqNos.remove(docId)
  }

  async currentMeta(docId: DocId): Promise<StoreMeta | null> {
    const result = await this.#q.query<{ data: StoreMeta }>(
      `SELECT data FROM ${this.#tables.meta} WHERE doc_id = $1`,
      [docId],
    )
    return result.rows[0]?.data ?? null
  }

  async *listDocIds(prefix?: string): AsyncIterable<DocId> {
    if (prefix === undefined) {
      const result = await this.#q.query<{ doc_id: string }>(
        `SELECT doc_id FROM ${this.#tables.meta}`,
      )
      for (const row of result.rows) yield row.doc_id
      return
    }

    // Range scan instead of LIKE — `%` and `_` in doc IDs are literal,
    // not wildcards.
    const upper = prefixUpperBound(prefix)
    const result =
      upper === null
        ? await this.#q.query<{ doc_id: string }>(
            `SELECT doc_id FROM ${this.#tables.meta} WHERE doc_id >= $1`,
            [prefix],
          )
        : await this.#q.query<{ doc_id: string }>(
            `SELECT doc_id FROM ${this.#tables.meta}
             WHERE doc_id >= $1 AND doc_id < $2`,
            [prefix, upper],
          )
    for (const row of result.rows) yield row.doc_id
  }

  async close(): Promise<void> {
    // Caller calls `pool.end()` / `client.end()`.
  }
}

// ---------------------------------------------------------------------------
// Range-scan helper
// ---------------------------------------------------------------------------

/**
 * Returns null when no successor exists (e.g. all code units at U+10FFFF),
 * letting the caller fall back to an unbounded `>= prefix` scan.
 */
function prefixUpperBound(prefix: string): string | null {
  if (prefix.length === 0) return null
  const codes = Array.from(prefix)
  for (let i = codes.length - 1; i >= 0; i--) {
    const ch = codes[i] as string
    const code = ch.codePointAt(0) as number
    if (code < 0x10ffff) {
      const next = String.fromCodePoint(code + 1)
      return codes.slice(0, i).join("") + next
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Factory: createPostgresStore (recommended entry point)
// ---------------------------------------------------------------------------

/**
 * Validation runs once at factory time, not on every method call. A
 * schema change applied while the Exchange is running won't be
 * detected — restart after migrations. Polling or a `revalidate()`
 * API would be over-engineering for a failure mode that fails loudly
 * on the next write anyway.
 */
export async function createPostgresStore(
  client: PgConnection,
  options: PostgresStoreOptions = {},
): Promise<Store> {
  const tables = resolveTables(options)
  await validateSchema(client as unknown as PgQuerier, tables)
  return new PostgresStore(client, options)
}

interface ColumnInfo {
  column_name: string
  data_type: string
  is_nullable: string
}

const EXPECTED_COLUMNS = {
  meta: [
    { name: "doc_id", types: ["text"] },
    { name: "data", types: ["jsonb"] },
  ],
  records: [
    { name: "doc_id", types: ["text"] },
    { name: "seq", types: ["integer"] },
    { name: "kind", types: ["text"] },
    { name: "payload", types: ["text"] },
    { name: "blob", types: ["bytea"] },
  ],
} as const

async function validateSchema(q: PgQuerier, tables: TableNames): Promise<void> {
  for (const [role, expected] of [
    ["meta", EXPECTED_COLUMNS.meta] as const,
    ["records", EXPECTED_COLUMNS.records] as const,
  ]) {
    const tableName = tables[role]
    const result = await q.query<ColumnInfo>(
      `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
       WHERE table_name = $1`,
      [tableName],
    )
    if (result.rows.length === 0) {
      throw new Error(
        `@kyneta/postgres-store: table "${tableName}" not found. ` +
          `Run schema.sql or include the canonical DDL in your migrations.`,
      )
    }
    const columnsByName = new Map(result.rows.map(r => [r.column_name, r]))
    for (const col of expected) {
      const found = columnsByName.get(col.name)
      if (found === undefined) {
        throw new Error(
          `@kyneta/postgres-store: table "${tableName}" missing column ` +
            `"${col.name}". See schema.sql for the canonical definition.`,
        )
      }
      if (!(col.types as readonly string[]).includes(found.data_type)) {
        throw new Error(
          `@kyneta/postgres-store: table "${tableName}" column ` +
            `"${col.name}" has type "${found.data_type}", ` +
            `expected one of [${col.types.join(", ")}].`,
        )
      }
    }
  }
}

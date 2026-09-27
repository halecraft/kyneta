// Postgres Store backend.
//
// Why JSONB on meta, not TEXT: operators occasionally need to filter
// metas by `syncMode` or `replicaType` during incident
// investigations, and JSONB makes `data->>'syncMode'` trivial.
// Cost: JSONB normalizes whitespace and key order at insert time, so
// `meta.data` bytes don't match SQLite's TEXT-stored meta — but
// round-trip through `loadAll` still yields a structurally equal
// `StoreRecord`, which is what cross-backend portability actually
// requires.

import {
  type DocId,
  decideStoreFormat,
  parseStoreFormat,
  STORE_META_FORMAT_KEY,
  type Store,
  StoreFormatVersionError,
  type StoreMark,
  type StoreMeta,
  type StoreRecord,
} from "@kyneta/exchange"
import {
  fromRow,
  planAppend,
  planCompact,
  type RowShape,
  resolveTables,
  STORE_FORMAT_VERSION,
  type TableNames,
} from "@kyneta/sql-store-core"
import type { Client, Pool, PoolClient } from "pg"

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface PostgresStoreOptions {
  /**
   * Override the default table names (`kyneta_doc_meta`, `kyneta_records`,
   * `kyneta_store_meta`).
   *
   * Use when running multiple isolated Exchange instances against the
   * same database — each instance owns one `tables` set.
   */
  tables?: Partial<TableNames>
}

/**
 * Narrow structural type for the methods we actually call. Keeps the
 * package independent of `pg`'s top-level type changes across versions.
 */
export interface PgQuerier {
  query<R = unknown>(text: string, values?: unknown[]): Promise<{ rows: R[] }>
}

/**
 * The minimal Postgres capability `PostgresStore` needs, decoupled from any
 * specific pg surface — mirrors `SqliteAdapter`. `fromPool` / `fromClient`
 * supply it, so `PostgresStore` never discriminates connection types and `pg`
 * stays a type-only import (no `instanceof`, no runtime class coupling).
 */
export interface PgAdapter extends PgQuerier {
  /**
   * Run `fn` with a querier whose statements share one connection under
   * BEGIN/COMMIT; ROLLBACK and rethrow on failure.
   */
  transaction<R>(fn: (q: PgQuerier) => Promise<R>): Promise<R>
}

/**
 * Adapter over a `Pool`: each transaction checks out a `PoolClient` so
 * BEGIN..COMMIT share one physical connection (Postgres transactions are
 * connection-scoped — checking back out for COMMIT would target a different
 * connection), then releases it. Non-transactional queries go to the pool
 * directly (the pool checks out/in per query — fine for single reads).
 */
export function fromPool(pool: Pool): PgAdapter {
  const direct = pool as unknown as PgQuerier
  return {
    query<R = unknown>(
      text: string,
      values?: unknown[],
    ): Promise<{ rows: R[] }> {
      return direct.query<R>(text, values)
    },
    async transaction<R>(fn: (q: PgQuerier) => Promise<R>): Promise<R> {
      const poolClient: PoolClient = await pool.connect()
      const q = poolClient as unknown as PgQuerier
      try {
        await q.query("BEGIN")
        try {
          const result = await fn(q)
          await q.query("COMMIT")
          return result
        } catch (e) {
          await q.query("ROLLBACK")
          throw e
        }
      } finally {
        poolClient.release()
      }
    },
  }
}

/**
 * Adapter over a single `Client` (or an already-checked-out `PoolClient`):
 * transactions run inline on the one connection. Re-throws on rollback so a
 * caller can place post-commit work lexically after the awaited call.
 */
export function fromClient(client: Client | PoolClient): PgAdapter {
  const q = client as unknown as PgQuerier
  return {
    query<R = unknown>(
      text: string,
      values?: unknown[],
    ): Promise<{ rows: R[] }> {
      return q.query<R>(text, values)
    },
    async transaction<R>(fn: (q: PgQuerier) => Promise<R>): Promise<R> {
      await q.query("BEGIN")
      try {
        const result = await fn(q)
        await q.query("COMMIT")
        return result
      } catch (e) {
        await q.query("ROLLBACK")
        throw e
      }
    },
  }
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
  readonly #adapter: PgAdapter
  readonly #tables: TableNames

  constructor(adapter: PgAdapter, options: PostgresStoreOptions = {}) {
    this.#adapter = adapter
    this.#tables = resolveTables(options)
  }

  // -------------------------------------------------------------------------
  // Store interface
  // -------------------------------------------------------------------------

  async append(docId: DocId, record: StoreRecord): Promise<void> {
    await this.#adapter.transaction(async q => {
      await this.#lockDoc(q, docId)
      const plan = planAppend(
        docId,
        record,
        await this.#readMeta(q, docId),
        await this.#nextSeq(q, docId),
      )
      if (plan.upsertMeta !== null) {
        await q.query(
          `INSERT INTO ${this.#tables.docMeta} (doc_id, data)
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
    const result = await this.#adapter.query<RowShape>(
      `SELECT kind, payload, blob FROM ${this.#tables.records}
       WHERE doc_id = $1 ORDER BY seq`,
      [docId],
    )
    for (const row of result.rows) {
      yield fromRow(row)
    }
  }

  async mark(docId: DocId): Promise<StoreMark | null> {
    return this.#lastSeq(this.#adapter, docId)
  }

  async compact(
    docId: DocId,
    records: StoreRecord[],
    through: StoreMark | null,
  ): Promise<void> {
    await this.#adapter.transaction(async q => {
      await this.#lockDoc(q, docId)
      const plan = planCompact(
        records,
        await this.#readMeta(q, docId),
        await this.#nextSeq(q, docId),
      )
      if (through !== null) {
        await q.query(
          `DELETE FROM ${this.#tables.records} WHERE doc_id = $1 AND seq <= $2`,
          [docId, through],
        )
      }

      for (const { seq, row } of plan.records) {
        await q.query(
          `INSERT INTO ${this.#tables.records}
           (doc_id, seq, kind, payload, blob)
           VALUES ($1, $2, $3, $4, $5)`,
          [docId, seq, row.kind, row.payload, row.blob],
        )
      }

      await q.query(
        `INSERT INTO ${this.#tables.docMeta} (doc_id, data)
         VALUES ($1, $2::jsonb)
         ON CONFLICT (doc_id) DO UPDATE SET data = EXCLUDED.data`,
        [docId, plan.upsertMeta.data],
      )
    })
  }

  /**
   * Hold the document's write lock until the transaction ends. Several
   * stores may open one schema: each reads the document's last sequence
   * number and writes after it, so two writers of one document take turns.
   * Released at commit or rollback. `hashtext` collisions only make two
   * documents take turns too.
   */
  async #lockDoc(q: PgQuerier, docId: DocId): Promise<void> {
    await q.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
      `${this.#tables.records}:${docId}`,
    ])
  }

  async #lastSeq(q: PgQuerier, docId: DocId): Promise<number | null> {
    const result = await q.query<{ max_seq: number | null }>(
      `SELECT MAX(seq)::int AS max_seq FROM ${this.#tables.records} WHERE doc_id = $1`,
      [docId],
    )
    return result.rows[0]?.max_seq ?? null
  }

  /** The next sequence number. Read inside the write transaction. */
  async #nextSeq(q: PgQuerier, docId: DocId): Promise<number> {
    return ((await this.#lastSeq(q, docId)) ?? -1) + 1
  }

  async #readMeta(q: PgQuerier, docId: DocId): Promise<StoreMeta | null> {
    const result = await q.query<{ data: StoreMeta }>(
      `SELECT data FROM ${this.#tables.docMeta} WHERE doc_id = $1`,
      [docId],
    )
    return result.rows[0]?.data ?? null
  }

  async delete(docId: DocId): Promise<void> {
    await this.#adapter.transaction(async q => {
      await q.query(`DELETE FROM ${this.#tables.records} WHERE doc_id = $1`, [
        docId,
      ])
      await q.query(`DELETE FROM ${this.#tables.docMeta} WHERE doc_id = $1`, [
        docId,
      ])
    })
  }

  async currentMeta(docId: DocId): Promise<StoreMeta | null> {
    return this.#readMeta(this.#adapter, docId)
  }

  async *listDocIds(prefix?: string): AsyncIterable<DocId> {
    if (prefix === undefined) {
      const result = await this.#adapter.query<{ doc_id: string }>(
        `SELECT doc_id FROM ${this.#tables.docMeta}`,
      )
      for (const row of result.rows) yield row.doc_id
      return
    }

    // Range scan instead of LIKE — `%` and `_` in doc IDs are literal,
    // not wildcards.
    const upper = prefixUpperBound(prefix)
    const result =
      upper === null
        ? await this.#adapter.query<{ doc_id: string }>(
            `SELECT doc_id FROM ${this.#tables.docMeta} WHERE doc_id >= $1`,
            [prefix],
          )
        : await this.#adapter.query<{ doc_id: string }>(
            `SELECT doc_id FROM ${this.#tables.docMeta}
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
  adapter: PgAdapter,
  options: PostgresStoreOptions = {},
): Promise<Store> {
  const tables = resolveTables(options)
  await validateSchema(adapter, tables)
  await assertFormat(adapter, tables)
  return new PostgresStore(adapter, options)
}

/**
 * Bootstrap reader: stamp/accept/refuse the store-format marker on open.
 * Writes at most one idempotent row (`ON CONFLICT DO NOTHING`) — not DDL,
 * so the "no auto-DDL" invariant holds; the operator still owns the table.
 */
async function assertFormat(q: PgQuerier, tables: TableNames): Promise<void> {
  const markerResult = await q.query<{ value: unknown }>(
    `SELECT value FROM ${tables.storeMeta} WHERE key = $1`,
    [STORE_META_FORMAT_KEY],
  )
  const raw = markerResult.rows[0]?.value
  const parsed = raw === undefined ? null : parseStoreFormat(raw)
  if (parsed === "malformed") {
    throw new StoreFormatVersionError({
      reason: "malformed-version",
      backend: "postgres",
      stored: null,
      current: STORE_FORMAT_VERSION,
    })
  }

  const dataResult = await q.query(`SELECT 1 FROM ${tables.docMeta} LIMIT 1`)

  const decision = decideStoreFormat({
    current: STORE_FORMAT_VERSION,
    stored: parsed,
    storeHasData: dataResult.rows.length > 0,
  })

  if (decision.action === "refuse") {
    throw new StoreFormatVersionError({
      reason: decision.reason,
      backend: "postgres",
      stored: parsed,
      current: STORE_FORMAT_VERSION,
    })
  }
  if (decision.action === "stamp") {
    await q.query(
      `INSERT INTO ${tables.storeMeta} (key, value)
       VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO NOTHING`,
      [STORE_META_FORMAT_KEY, JSON.stringify(decision.value)],
    )
  }
}

interface ColumnInfo {
  column_name: string
  data_type: string
  is_nullable: string
}

const EXPECTED_COLUMNS = {
  docMeta: [
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
  storeMeta: [
    { name: "key", types: ["text"] },
    { name: "value", types: ["jsonb"] },
  ],
} as const

async function validateSchema(q: PgQuerier, tables: TableNames): Promise<void> {
  for (const [role, expected] of [
    ["docMeta", EXPECTED_COLUMNS.docMeta] as const,
    ["records", EXPECTED_COLUMNS.records] as const,
    ["storeMeta", EXPECTED_COLUMNS.storeMeta] as const,
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

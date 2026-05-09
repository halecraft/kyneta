// SQLite Store backend.
//
// Why a thin adapter rather than a direct better-sqlite3 dependency: the
// adapter shape is deliberately synchronous because every supported
// SQLite binding is sync (better-sqlite3, bun:sqlite, Cloudflare DO's
// ctx.storage.sql). Forcing async here would dilute that ergonomics for
// no benefit, since postgres-store and prisma-store get their own
// async-native packages.

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

// ---------------------------------------------------------------------------
// SqliteAdapter — minimal synchronous database interface
// ---------------------------------------------------------------------------

/**
 * `iterate` returns `Iterable<T>` rather than `T[]` so `loadAll` can
 * stream million-record stores without materializing them all in
 * memory. Cloudflare DO's `ctx.storage.sql.exec` returns a cursor for
 * the same reason; this shape is chosen to pass through.
 */
export interface SqliteAdapter {
  exec(sql: string, ...params: unknown[]): void
  iterate<T = Record<string, unknown>>(
    sql: string,
    ...params: unknown[]
  ): Iterable<T>
  transaction<R>(fn: () => R): R
  close(): void
}

// ---------------------------------------------------------------------------
// Adapter factories
// ---------------------------------------------------------------------------

/**
 * Wrap a `better-sqlite3` Database as a `SqliteAdapter`.
 *
 * @example
 * ```typescript
 * import Database from "better-sqlite3"
 * import { SqliteStore, fromBetterSqlite3 } from "@kyneta/sqlite-store"
 *
 * const db = new Database("exchange.db")
 * const store = new SqliteStore(fromBetterSqlite3(db))
 * ```
 */
export function fromBetterSqlite3(db: BetterSqlite3Database): SqliteAdapter {
  return {
    exec(sql: string, ...params: unknown[]): void {
      db.prepare(sql).run(...params)
    },
    iterate<T = Record<string, unknown>>(
      sql: string,
      ...params: unknown[]
    ): Iterable<T> {
      return db.prepare(sql).iterate(...params) as IterableIterator<T>
    },
    transaction<R>(fn: () => R): R {
      return db.transaction(fn)()
    },
    close(): void {
      db.close()
    },
  }
}

/**
 * Wrap a `bun:sqlite` Database as a `SqliteAdapter`.
 *
 * @example
 * ```typescript
 * import { Database } from "bun:sqlite"
 * import { SqliteStore, fromBunSqlite } from "@kyneta/sqlite-store"
 *
 * const db = new Database("exchange.db")
 * const store = new SqliteStore(fromBunSqlite(db))
 * ```
 */
export function fromBunSqlite(db: BunSqliteDatabase): SqliteAdapter {
  return {
    exec(sql: string, ...params: unknown[]): void {
      db.run(sql, ...params)
    },
    iterate<T = Record<string, unknown>>(
      sql: string,
      ...params: unknown[]
    ): Iterable<T> {
      return db.query(sql).iterate(...params) as IterableIterator<T>
    },
    transaction<R>(fn: () => R): R {
      return db.transaction(fn)()
    },
    close(): void {
      db.close()
    },
  }
}

// Minimal structural types for the two primary SQLite bindings.
// These avoid a hard dependency on `better-sqlite3` or `bun:sqlite` types
// at runtime — the caller provides the concrete database instance.

/** Structural type for a `better-sqlite3` Database instance. */
interface BetterSqlite3Database {
  prepare(sql: string): {
    run(...params: unknown[]): unknown
    iterate(...params: unknown[]): IterableIterator<unknown>
  }
  transaction<R>(fn: () => R): () => R
  close(): void
}

/** Structural type for a `bun:sqlite` Database instance. */
interface BunSqliteDatabase {
  run(sql: string, ...params: unknown[]): void
  query(sql: string): {
    iterate(...params: unknown[]): IterableIterator<unknown>
  }
  transaction<R>(fn: () => R): () => R
  close(): void
}

// ---------------------------------------------------------------------------
// SqliteStore options
// ---------------------------------------------------------------------------

export interface SqliteStoreOptions {
  /**
   * Override the default table names (`kyneta_meta` and `kyneta_records`).
   *
   * Use when co-locating Exchange tables alongside application tables in
   * the same SQLite database, or when running multiple isolated Exchange
   * instances in one database. Either or both names may be overridden.
   */
  tables?: Partial<TableNames>
}

// ---------------------------------------------------------------------------
// SqliteStore
// ---------------------------------------------------------------------------

export class SqliteStore implements Store {
  readonly #adapter: SqliteAdapter
  readonly #seqNos = new SeqNoTracker()
  readonly #tables: TableNames

  constructor(adapter: SqliteAdapter, options: SqliteStoreOptions = {}) {
    this.#adapter = adapter
    this.#tables = resolveTables(options)
    this.#ensureSchema()
  }

  #ensureSchema(): void {
    this.#adapter.exec(`
      CREATE TABLE IF NOT EXISTS ${this.#tables.meta} (
        doc_id  TEXT PRIMARY KEY,
        data    TEXT NOT NULL
      ) WITHOUT ROWID
    `)
    this.#adapter.exec(`
      CREATE TABLE IF NOT EXISTS ${this.#tables.records} (
        doc_id  TEXT    NOT NULL,
        seq     INTEGER NOT NULL,
        kind    TEXT    NOT NULL,
        payload TEXT,
        blob    BLOB,
        PRIMARY KEY (doc_id, seq)
      ) WITHOUT ROWID
    `)
  }

  // -------------------------------------------------------------------------
  // Store interface
  // -------------------------------------------------------------------------

  async append(docId: DocId, record: StoreRecord): Promise<void> {
    const existingMeta = await this.currentMeta(docId)
    const seq = await this.#seqNos.next(docId, async () => {
      const [row] = this.#adapter.iterate<{ max_seq: number | null }>(
        `SELECT MAX(seq) AS max_seq FROM ${this.#tables.records} WHERE doc_id = ?`,
        docId,
      )
      return row?.max_seq ?? null
    })

    const plan = planAppend(docId, record, existingMeta, seq)

    // Both writes must commit together or neither — a crash between
    // them used to leave meta updated with no corresponding row.
    this.#adapter.transaction(() => {
      if (plan.upsertMeta !== null) {
        this.#adapter.exec(
          `INSERT OR REPLACE INTO ${this.#tables.meta} (doc_id, data) VALUES (?, ?)`,
          docId,
          plan.upsertMeta.data,
        )
      }
      const { row } = plan.insertRecord
      this.#adapter.exec(
        `INSERT INTO ${this.#tables.records} (doc_id, seq, kind, payload, blob) VALUES (?, ?, ?, ?, ?)`,
        docId,
        plan.insertRecord.seq,
        row.kind,
        row.payload,
        row.blob,
      )
    })
  }

  async *loadAll(docId: DocId): AsyncIterable<StoreRecord> {
    for (const row of this.#adapter.iterate<RowShape>(
      `SELECT kind, payload, blob FROM ${this.#tables.records} WHERE doc_id = ? ORDER BY seq`,
      docId,
    )) {
      yield fromRow(row)
    }
  }

  async replace(docId: DocId, records: StoreRecord[]): Promise<void> {
    const existingMeta = await this.currentMeta(docId)
    const plan = planReplace(records, existingMeta)

    this.#adapter.transaction(() => {
      this.#adapter.exec(
        `DELETE FROM ${this.#tables.records} WHERE doc_id = ?`,
        docId,
      )

      for (const { seq, row } of plan.records) {
        this.#adapter.exec(
          `INSERT INTO ${this.#tables.records} (doc_id, seq, kind, payload, blob) VALUES (?, ?, ?, ?, ?)`,
          docId,
          seq,
          row.kind,
          row.payload,
          row.blob,
        )
      }

      this.#adapter.exec(
        `INSERT OR REPLACE INTO ${this.#tables.meta} (doc_id, data) VALUES (?, ?)`,
        docId,
        plan.upsertMeta.data,
      )
    })

    // Must run after the transaction commits. If `transaction()` throws,
    // control jumps past this line; the cache stays unmutated. Moving
    // this inside the callback or before the call would corrupt the
    // cache on rollback — the next append would compute a seq that
    // collides with restored rows on the (doc_id, seq) primary key.
    this.#seqNos.reset(docId, records.length - 1)
  }

  async delete(docId: DocId): Promise<void> {
    this.#adapter.transaction(() => {
      this.#adapter.exec(
        `DELETE FROM ${this.#tables.records} WHERE doc_id = ?`,
        docId,
      )
      this.#adapter.exec(
        `DELETE FROM ${this.#tables.meta} WHERE doc_id = ?`,
        docId,
      )
    })
    this.#seqNos.remove(docId)
  }

  async currentMeta(docId: DocId): Promise<StoreMeta | null> {
    const [row] = this.#adapter.iterate<{ data: string }>(
      `SELECT data FROM ${this.#tables.meta} WHERE doc_id = ?`,
      docId,
    )
    if (row === undefined) return null
    return JSON.parse(row.data) as StoreMeta
  }

  async *listDocIds(prefix?: string): AsyncIterable<DocId> {
    const rows =
      prefix !== undefined
        ? this.#adapter.iterate<{ doc_id: string }>(
            `SELECT doc_id FROM ${this.#tables.meta} WHERE doc_id LIKE ? ESCAPE '\\'`,
            `${escapeLike(prefix)}%`,
          )
        : this.#adapter.iterate<{ doc_id: string }>(
            `SELECT doc_id FROM ${this.#tables.meta}`,
          )
    for (const row of rows) {
      yield row.doc_id
    }
  }

  async close(): Promise<void> {
    this.#adapter.close()
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * SQLite's LIKE treats `%` and `_` as wildcards. Escape them (and the
 * escape char itself) so doc IDs containing those characters are
 * matched literally. The query declares `ESCAPE '\'`.
 */
function escapeLike(value: string): string {
  return value.replace(/[%_\\]/g, ch => `\\${ch}`)
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

export function createSqliteStore(
  adapter: SqliteAdapter,
  options?: SqliteStoreOptions,
): Store {
  return new SqliteStore(adapter, options)
}

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
  decideStoreFormat,
  parseStoreFormat,
  prefixSuccessor,
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
  /**
   * Run `fn` in a transaction that takes the database's write lock when it
   * begins (`BEGIN IMMEDIATE`), not at its first write. Several stores may
   * open one database file; each reads a document's last sequence number
   * inside the transaction and writes after it, which is sound only if no
   * other writer can come between the read and the write.
   */
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
      return db.transaction(fn).immediate()
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
      return db.transaction(fn).immediate()
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
  transaction<R>(fn: () => R): { immediate(): R }
  close(): void
}

/** Structural type for a `bun:sqlite` Database instance. */
interface BunSqliteDatabase {
  run(sql: string, ...params: unknown[]): void
  query(sql: string): {
    iterate(...params: unknown[]): IterableIterator<unknown>
  }
  transaction<R>(fn: () => R): { immediate(): R }
  close(): void
}

// ---------------------------------------------------------------------------
// SqliteStore options
// ---------------------------------------------------------------------------

export interface SqliteStoreOptions {
  /**
   * Override the default table names (`kyneta_doc_meta`, `kyneta_records`,
   * `kyneta_store_meta`).
   *
   * Use when co-locating Exchange tables alongside application tables in
   * the same SQLite database, or when running multiple isolated Exchange
   * instances in one database. Any subset of names may be overridden.
   */
  tables?: Partial<TableNames>
}

// ---------------------------------------------------------------------------
// SqliteStore
// ---------------------------------------------------------------------------

export class SqliteStore implements Store {
  readonly #adapter: SqliteAdapter
  readonly #tables: TableNames

  constructor(adapter: SqliteAdapter, options: SqliteStoreOptions = {}) {
    this.#adapter = adapter
    this.#tables = resolveTables(options)
    // Wait for another connection's write lock rather than fail at once,
    // whatever the driver's default. The pragma answers with a row, so it is
    // read rather than run.
    Array.from(adapter.iterate("PRAGMA busy_timeout = 5000"))
    this.#ensureSchema()
    this.#assertFormat()
  }

  #ensureSchema(): void {
    this.#adapter.exec(`
      CREATE TABLE IF NOT EXISTS ${this.#tables.docMeta} (
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
    this.#adapter.exec(`
      CREATE TABLE IF NOT EXISTS ${this.#tables.storeMeta} (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) WITHOUT ROWID
    `)
  }

  // Bootstrap reader: consult the store-format marker before trusting any
  // bytes. Stamps a brand-new store, accepts a compatible one, or throws.
  #assertFormat(): void {
    const [row] = this.#adapter.iterate<{ value: string }>(
      `SELECT value FROM ${this.#tables.storeMeta} WHERE key = ?`,
      STORE_META_FORMAT_KEY,
    )
    const parsed = row === undefined ? null : parseStoreFormat(row.value)
    if (parsed === "malformed") {
      throw new StoreFormatVersionError({
        reason: "malformed-version",
        backend: "sqlite",
        stored: null,
        current: STORE_FORMAT_VERSION,
      })
    }

    const [hasData] = this.#adapter.iterate<{ one: number }>(
      `SELECT 1 AS one FROM ${this.#tables.docMeta} LIMIT 1`,
    )

    const decision = decideStoreFormat({
      current: STORE_FORMAT_VERSION,
      stored: parsed,
      storeHasData: hasData !== undefined,
    })

    if (decision.action === "refuse") {
      throw new StoreFormatVersionError({
        reason: decision.reason,
        backend: "sqlite",
        stored: parsed,
        current: STORE_FORMAT_VERSION,
      })
    }
    if (decision.action === "stamp") {
      this.#adapter.exec(
        `INSERT INTO ${this.#tables.storeMeta} (key, value) VALUES (?, ?)`,
        STORE_META_FORMAT_KEY,
        JSON.stringify(decision.value),
      )
    }
  }

  // -------------------------------------------------------------------------
  // Store interface
  // -------------------------------------------------------------------------

  async append(docId: DocId, record: StoreRecord): Promise<void> {
    // The meta, the next sequence number and both writes in one transaction:
    // they commit together or not at all, and no other store over this file
    // can take the same sequence number in between.
    this.#adapter.transaction(() => {
      const plan = planAppend(
        docId,
        record,
        this.#readMeta(docId),
        this.#nextSeq(docId),
      )
      if (plan.upsertMeta !== null) {
        this.#adapter.exec(
          `INSERT OR REPLACE INTO ${this.#tables.docMeta} (doc_id, data) VALUES (?, ?)`,
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

  async mark(docId: DocId): Promise<StoreMark | null> {
    return this.#lastSeq(docId)
  }

  async compact(
    docId: DocId,
    records: StoreRecord[],
    through: StoreMark | null,
  ): Promise<void> {
    this.#adapter.transaction(() => {
      const plan = planCompact(
        records,
        this.#readMeta(docId),
        this.#nextSeq(docId),
      )
      if (through !== null) {
        this.#adapter.exec(
          `DELETE FROM ${this.#tables.records} WHERE doc_id = ? AND seq <= ?`,
          docId,
          through,
        )
      }

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
        `INSERT OR REPLACE INTO ${this.#tables.docMeta} (doc_id, data) VALUES (?, ?)`,
        docId,
        plan.upsertMeta.data,
      )
    })
  }

  /** The document's last sequence number, read from the table. */
  #lastSeq(docId: DocId): number | null {
    const [row] = this.#adapter.iterate<{ max_seq: number | null }>(
      `SELECT MAX(seq) AS max_seq FROM ${this.#tables.records} WHERE doc_id = ?`,
      docId,
    )
    return row?.max_seq ?? null
  }

  /** The next sequence number. Read inside the write transaction. */
  #nextSeq(docId: DocId): number {
    return (this.#lastSeq(docId) ?? -1) + 1
  }

  async delete(docId: DocId): Promise<void> {
    this.#adapter.transaction(() => {
      this.#adapter.exec(
        `DELETE FROM ${this.#tables.records} WHERE doc_id = ?`,
        docId,
      )
      this.#adapter.exec(
        `DELETE FROM ${this.#tables.docMeta} WHERE doc_id = ?`,
        docId,
      )
    })
  }

  async currentMeta(docId: DocId): Promise<StoreMeta | null> {
    return this.#readMeta(docId)
  }

  #readMeta(docId: DocId): StoreMeta | null {
    const [row] = this.#adapter.iterate<{ data: string }>(
      `SELECT data FROM ${this.#tables.docMeta} WHERE doc_id = ?`,
      docId,
    )
    if (row === undefined) return null
    return JSON.parse(row.data) as StoreMeta
  }

  async *listDocIds(prefix?: string): AsyncIterable<DocId> {
    // A range scan, not LIKE: SQLite's LIKE ignores ASCII case and cannot
    // use the primary-key index. The default BINARY collation compares UTF-8
    // bytes, which is code-point order, the order the range assumes.
    const upper =
      prefix === undefined ? null : prefixSuccessor(prefix, "code-point")
    const rows =
      prefix === undefined
        ? this.#adapter.iterate<{ doc_id: string }>(
            `SELECT doc_id FROM ${this.#tables.docMeta}`,
          )
        : upper === null
          ? this.#adapter.iterate<{ doc_id: string }>(
              `SELECT doc_id FROM ${this.#tables.docMeta} WHERE doc_id >= ?`,
              prefix,
            )
          : this.#adapter.iterate<{ doc_id: string }>(
              `SELECT doc_id FROM ${this.#tables.docMeta} WHERE doc_id >= ? AND doc_id < ?`,
              prefix,
              upper,
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

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

export function createSqliteStore(
  adapter: SqliteAdapter,
  options?: SqliteStoreOptions,
): Store {
  return new SqliteStore(adapter, options)
}

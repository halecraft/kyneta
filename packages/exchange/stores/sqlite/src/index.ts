// SQLite Store backend.
//
// Why a thin adapter rather than a direct better-sqlite3 dependency: the
// adapter shape is deliberately synchronous because every supported
// SQLite binding is sync (better-sqlite3, bun:sqlite, Cloudflare DO's
// ctx.storage.sql). Forcing async here would dilute that ergonomics for
// no benefit, since postgres-store and prisma-store get their own
// async-native packages.
//
// A SQLite database has one owner: the adapter. Its seat is `owned`, the one
// seat the database's pool holds, reused on every open. The owner's writes go
// through the connection that holds the ownership, so no write can outlive it
// and none is fenced.

import {
  type DocId,
  freshPeerIds,
  type OwnedSeat,
  planStoreOpen,
  prefixSuccessor,
  STORE_META_FORMAT_KEY,
  STORE_META_SEATS_KEY,
  type Store,
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
 * A SQLite database, owned.
 *
 * **One adapter is the one owner of its database** until it closes: no other
 * connection, in this process or another, may write to it meanwhile. The
 * store reuses one seat on every open, which is sound only because nothing
 * else writes under it. How ownership is held belongs to the host:
 *
 * - over a file, the adapter takes it when it wraps the connection, with
 *   `PRAGMA locking_mode = EXCLUSIVE` and a `BEGIN EXCLUSIVE; COMMIT` that
 *   takes the lock at once, as `fromBetterSqlite3` and `fromBunSqlite` do. A
 *   second adapter over the file is then refused;
 * - a Cloudflare Durable Object is the sole owner of its storage by platform
 *   guarantee, so its adapter does nothing.
 *
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
  /** Run `fn` in a transaction: commit if it returns, roll back if it throws. */
  transaction<R>(fn: () => R): R
  close(): void
}

/** Options for the built-in file adapters. */
export interface SqliteFileOptions {
  /**
   * How long, in milliseconds, taking ownership waits for another owner of
   * the file to close before it is refused. Default 5000.
   */
  readonly busyTimeout?: number
}

/**
 * Take ownership of the database file behind `db`: hold its lock for as long
 * as the connection is open. Throws, naming the reason, when another
 * connection owns it.
 */
function own(
  db: { exec(sql: string): unknown },
  options: SqliteFileOptions,
): void {
  db.exec(`PRAGMA busy_timeout = ${options.busyTimeout ?? 5000}`)
  db.exec("PRAGMA locking_mode = EXCLUSIVE")
  try {
    db.exec("BEGIN EXCLUSIVE; COMMIT")
  } catch (error) {
    if ((error as { code?: unknown }).code !== "SQLITE_BUSY") throw error
    throw new Error(
      "@kyneta/sqlite-store: another connection owns this database file. " +
        "A SQLite database has one owner at a time; close the other first.",
      { cause: error },
    )
  }
}

// ---------------------------------------------------------------------------
// Adapter factories
// ---------------------------------------------------------------------------

/**
 * Wrap a `better-sqlite3` Database as a `SqliteAdapter`, taking ownership of
 * its file (see `SqliteAdapter`).
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
export function fromBetterSqlite3(
  db: BetterSqlite3Database,
  options: SqliteFileOptions = {},
): SqliteAdapter {
  own(db, options)
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
 * Wrap a `bun:sqlite` Database as a `SqliteAdapter`, taking ownership of its
 * file (see `SqliteAdapter`).
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
export function fromBunSqlite(
  db: BunSqliteDatabase,
  options: SqliteFileOptions = {},
): SqliteAdapter {
  own(db, options)
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
  exec(sql: string): unknown
  prepare(sql: string): {
    run(...params: unknown[]): unknown
    iterate(...params: unknown[]): IterableIterator<unknown>
  }
  transaction<R>(fn: () => R): () => R
  close(): void
}

/** Structural type for a `bun:sqlite` Database instance. */
interface BunSqliteDatabase {
  exec(sql: string): unknown
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
  readonly seat: OwnedSeat
  readonly #adapter: SqliteAdapter
  readonly #tables: TableNames
  #closed = false

  constructor(adapter: SqliteAdapter, options: SqliteStoreOptions = {}) {
    this.#adapter = adapter
    this.#tables = resolveTables(options)
    this.#ensureSchema()
    this.seat = this.#openSeat()
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

  /**
   * Read the store-wide metadata, plan the open, and write what it says.
   * Throws `StoreFormatVersionError` for a store this build cannot read.
   */
  #openSeat(): OwnedSeat {
    const stored = new Map<string, string>()
    for (const row of this.#adapter.iterate<{ key: string; value: string }>(
      `SELECT key, value FROM ${this.#tables.storeMeta} WHERE key IN (?, ?)`,
      STORE_META_FORMAT_KEY,
      STORE_META_SEATS_KEY,
    )) {
      stored.set(row.key, row.value)
    }
    const [hasData] = this.#adapter.iterate<{ one: number }>(
      `SELECT 1 AS one FROM ${this.#tables.docMeta} LIMIT 1`,
    )
    const plan = planStoreOpen({
      backend: "sqlite",
      current: STORE_FORMAT_VERSION,
      storedFormat: stored.get(STORE_META_FORMAT_KEY),
      storeHasData: hasData !== undefined,
      storedPool: stored.get(STORE_META_SEATS_KEY),
      seating: { kind: "owned" },
      fresh: freshPeerIds(),
    })
    if (plan.action === "refuse") throw plan.error
    const writes: [string, unknown][] = []
    if (plan.writeFormat !== undefined) {
      writes.push([STORE_META_FORMAT_KEY, plan.writeFormat])
    }
    if (plan.writePool !== undefined) {
      writes.push([STORE_META_SEATS_KEY, plan.writePool])
    }
    if (writes.length > 0) {
      this.#adapter.transaction(() => {
        for (const [key, value] of writes) {
          this.#adapter.exec(
            `INSERT OR REPLACE INTO ${this.#tables.storeMeta} (key, value) VALUES (?, ?)`,
            key,
            JSON.stringify(value),
          )
        }
      })
    }
    return plan.seat
  }

  /** The adapter, while the store is open. */
  get #db(): SqliteAdapter {
    if (this.#closed) throw new Error("SqliteStore: the store is closed")
    return this.#adapter
  }

  // -------------------------------------------------------------------------
  // Store interface
  // -------------------------------------------------------------------------

  async append(docId: DocId, record: StoreRecord): Promise<void> {
    // The meta, the next sequence number and both writes in one transaction:
    // they commit together or not at all.
    this.#db.transaction(() => {
      const plan = planAppend(
        docId,
        record,
        this.#readMeta(docId),
        this.#nextSeq(docId),
      )
      if (plan.upsertMeta !== null) {
        this.#db.exec(
          `INSERT OR REPLACE INTO ${this.#tables.docMeta} (doc_id, data) VALUES (?, ?)`,
          docId,
          plan.upsertMeta.data,
        )
      }
      const { row } = plan.insertRecord
      this.#db.exec(
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
    for (const row of this.#db.iterate<RowShape>(
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
    this.#db.transaction(() => {
      const plan = planCompact(
        records,
        this.#readMeta(docId),
        this.#nextSeq(docId),
      )
      if (through !== null) {
        this.#db.exec(
          `DELETE FROM ${this.#tables.records} WHERE doc_id = ? AND seq <= ?`,
          docId,
          through,
        )
      }

      for (const { seq, row } of plan.records) {
        this.#db.exec(
          `INSERT INTO ${this.#tables.records} (doc_id, seq, kind, payload, blob) VALUES (?, ?, ?, ?, ?)`,
          docId,
          seq,
          row.kind,
          row.payload,
          row.blob,
        )
      }

      this.#db.exec(
        `INSERT OR REPLACE INTO ${this.#tables.docMeta} (doc_id, data) VALUES (?, ?)`,
        docId,
        plan.upsertMeta.data,
      )
    })
  }

  /** The document's last sequence number, read from the table. */
  #lastSeq(docId: DocId): number | null {
    const [row] = this.#db.iterate<{ max_seq: number | null }>(
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
    this.#db.transaction(() => {
      this.#db.exec(
        `DELETE FROM ${this.#tables.records} WHERE doc_id = ?`,
        docId,
      )
      this.#db.exec(
        `DELETE FROM ${this.#tables.docMeta} WHERE doc_id = ?`,
        docId,
      )
    })
  }

  async currentMeta(docId: DocId): Promise<StoreMeta | null> {
    return this.#readMeta(docId)
  }

  #readMeta(docId: DocId): StoreMeta | null {
    const [row] = this.#db.iterate<{ data: string }>(
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
        ? this.#db.iterate<{ doc_id: string }>(
            `SELECT doc_id FROM ${this.#tables.docMeta}`,
          )
        : upper === null
          ? this.#db.iterate<{ doc_id: string }>(
              `SELECT doc_id FROM ${this.#tables.docMeta} WHERE doc_id >= ?`,
              prefix,
            )
          : this.#db.iterate<{ doc_id: string }>(
              `SELECT doc_id FROM ${this.#tables.docMeta} WHERE doc_id >= ? AND doc_id < ?`,
              prefix,
              upper,
            )
    for (const row of rows) {
      yield row.doc_id
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
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

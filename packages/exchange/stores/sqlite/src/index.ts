// sqlite-store — SQLite storage backend for @kyneta/exchange.
//
// Implements the Store interface using a thin database adapter abstraction.
// The caller provides an adapter conforming to `SqliteAdapter`; this module
// has zero opinion about which SQLite binding is used.
//
// Schema (two tables, created on first use):
//   {prefix}meta    — materialized metadata index (doc_id TEXT PK → JSON)
//   {prefix}records — per-document append-only record stream
//                     (doc_id TEXT, seq INTEGER, kind TEXT, payload TEXT, blob BLOB)
//
// Binary Uint8Array payloads are stored in the `blob` column; string/JSON
// payloads go in `payload`. The `kind` discriminant ('meta' | 'entry') is
// stored explicitly for clarity and queryability.

import {
  type DocId,
  resolveMetaFromBatch,
  SeqNoTracker,
  type Store,
  type StoreMeta,
  type StoreRecord,
  validateAppend,
} from "@kyneta/exchange"
import type { SubstratePayload } from "@kyneta/schema"

// ---------------------------------------------------------------------------
// SqliteAdapter — minimal synchronous database interface
// ---------------------------------------------------------------------------

/**
 * Minimal synchronous SQLite database interface.
 *
 * `iterate` returns `Iterable<T>` rather than `T[]` so `loadAll` can
 * stream large result sets without materializing them — same reason
 * Cloudflare DO's `ctx.storage.sql.exec` returns a cursor.
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
// Row serialization — pure functional core
// ---------------------------------------------------------------------------

interface RowShape {
  readonly kind: string
  readonly payload: string
  readonly blob: Uint8Array | null
}

/** Binary data lives in the `blob` column, not here. */
interface EntryPayloadJson {
  readonly kind: "entirety" | "since"
  readonly encoding: "json" | "binary"
  readonly version: string
  readonly data?: string
}

function toRow(record: StoreRecord): RowShape {
  if (record.kind === "meta") {
    return {
      kind: "meta",
      payload: JSON.stringify(record.meta),
      blob: null,
    }
  }

  const { payload, version } = record

  if (payload.data instanceof Uint8Array) {
    const json: EntryPayloadJson = {
      kind: payload.kind,
      encoding: payload.encoding,
      version,
    }
    return {
      kind: "entry",
      payload: JSON.stringify(json),
      blob: payload.data as Uint8Array,
    }
  }

  const json: EntryPayloadJson = {
    kind: payload.kind,
    encoding: payload.encoding,
    version,
    data: payload.data as string,
  }
  return {
    kind: "entry",
    payload: JSON.stringify(json),
    blob: null,
  }
}

/**
 * Normalize a blob value to a plain `Uint8Array`.
 *
 * `better-sqlite3` returns `Buffer` for BLOB columns. `Buffer` extends
 * `Uint8Array`, so `instanceof Uint8Array` passes — but vitest's `toEqual`
 * treats them as structurally distinct types. This normalization ensures
 * the Store contract returns plain `Uint8Array` values regardless of the
 * underlying SQLite binding.
 */
function normalizeBlob(blob: Uint8Array): Uint8Array {
  if (blob.constructor === Uint8Array) return blob
  return new Uint8Array(blob.buffer, blob.byteOffset, blob.byteLength)
}

function fromRow(row: RowShape): StoreRecord {
  if (row.kind === "meta") {
    return { kind: "meta", meta: JSON.parse(row.payload) as StoreMeta }
  }

  const json = JSON.parse(row.payload) as EntryPayloadJson

  let data: string | Uint8Array
  if (row.blob !== null) {
    data = normalizeBlob(row.blob)
  } else {
    data = json.data as string
  }

  const payload: SubstratePayload = {
    kind: json.kind,
    encoding: json.encoding,
    data,
  }

  return { kind: "entry", payload, version: json.version }
}

// ---------------------------------------------------------------------------
// SqliteStore options
// ---------------------------------------------------------------------------

export interface SqliteStoreOptions {
  /**
   * Optional table name prefix. Default `""`.
   *
   * Use when co-locating Exchange tables alongside application tables
   * in the same SQLite database (e.g. `{ tablePrefix: "kyneta_" }`
   * produces tables `kyneta_meta` and `kyneta_records`).
   */
  tablePrefix?: string
}

// ---------------------------------------------------------------------------
// SqliteStore
// ---------------------------------------------------------------------------

export class SqliteStore implements Store {
  readonly #adapter: SqliteAdapter
  readonly #seqNos = new SeqNoTracker()
  readonly #metaTable: string
  readonly #recordsTable: string

  constructor(adapter: SqliteAdapter, options: SqliteStoreOptions = {}) {
    this.#adapter = adapter
    const prefix = options.tablePrefix ?? ""
    this.#metaTable = `${prefix}meta`
    this.#recordsTable = `${prefix}records`
    this.#ensureSchema()
  }

  #ensureSchema(): void {
    this.#adapter.exec(`
      CREATE TABLE IF NOT EXISTS ${this.#metaTable} (
        doc_id  TEXT PRIMARY KEY,
        data    TEXT NOT NULL
      ) WITHOUT ROWID
    `)
    this.#adapter.exec(`
      CREATE TABLE IF NOT EXISTS ${this.#recordsTable} (
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
    const resolved = validateAppend(docId, record, existingMeta)

    if (resolved !== null) {
      this.#adapter.exec(
        `INSERT OR REPLACE INTO ${this.#metaTable} (doc_id, data) VALUES (?, ?)`,
        docId,
        JSON.stringify(resolved),
      )
    }

    const seq = await this.#seqNos.next(docId, async () => {
      const [row] = this.#adapter.iterate<{ max_seq: number | null }>(
        `SELECT MAX(seq) AS max_seq FROM ${this.#recordsTable} WHERE doc_id = ?`,
        docId,
      )
      return row?.max_seq ?? null
    })

    const { kind, payload, blob } = toRow(record)
    this.#adapter.exec(
      `INSERT INTO ${this.#recordsTable} (doc_id, seq, kind, payload, blob) VALUES (?, ?, ?, ?, ?)`,
      docId,
      seq,
      kind,
      payload,
      blob,
    )
  }

  async *loadAll(docId: DocId): AsyncIterable<StoreRecord> {
    for (const row of this.#adapter.iterate<RowShape>(
      `SELECT kind, payload, blob FROM ${this.#recordsTable} WHERE doc_id = ? ORDER BY seq`,
      docId,
    )) {
      yield fromRow(row)
    }
  }

  async replace(docId: DocId, records: StoreRecord[]): Promise<void> {
    const existingMeta = await this.currentMeta(docId)
    const resolved = resolveMetaFromBatch(records, existingMeta)

    this.#adapter.transaction(() => {
      this.#adapter.exec(
        `DELETE FROM ${this.#recordsTable} WHERE doc_id = ?`,
        docId,
      )

      for (let i = 0; i < records.length; i++) {
        const record = records[i]
        if (record === undefined) continue
        const { kind, payload, blob } = toRow(record)
        this.#adapter.exec(
          `INSERT INTO ${this.#recordsTable} (doc_id, seq, kind, payload, blob) VALUES (?, ?, ?, ?, ?)`,
          docId,
          i,
          kind,
          payload,
          blob,
        )
      }

      this.#adapter.exec(
        `INSERT OR REPLACE INTO ${this.#metaTable} (doc_id, data) VALUES (?, ?)`,
        docId,
        JSON.stringify(resolved),
      )
    })

    this.#seqNos.reset(docId, records.length - 1)
  }

  async delete(docId: DocId): Promise<void> {
    this.#adapter.transaction(() => {
      this.#adapter.exec(
        `DELETE FROM ${this.#recordsTable} WHERE doc_id = ?`,
        docId,
      )
      this.#adapter.exec(
        `DELETE FROM ${this.#metaTable} WHERE doc_id = ?`,
        docId,
      )
    })
    this.#seqNos.remove(docId)
  }

  async currentMeta(docId: DocId): Promise<StoreMeta | null> {
    const [row] = this.#adapter.iterate<{ data: string }>(
      `SELECT data FROM ${this.#metaTable} WHERE doc_id = ?`,
      docId,
    )
    if (row === undefined) return null
    return JSON.parse(row.data) as StoreMeta
  }

  async *listDocIds(prefix?: string): AsyncIterable<DocId> {
    const rows =
      prefix !== undefined
        ? this.#adapter.iterate<{ doc_id: string }>(
            `SELECT doc_id FROM ${this.#metaTable} WHERE doc_id LIKE ? ESCAPE '\\'`,
            `${escapeLike(prefix)}%`,
          )
        : this.#adapter.iterate<{ doc_id: string }>(
            `SELECT doc_id FROM ${this.#metaTable}`,
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
 * Escape special LIKE pattern characters (`%`, `_`, `\`) in a prefix string.
 *
 * SQLite's LIKE operator treats `%` and `_` as wildcards. If a docId
 * contains these characters, the prefix filter must escape them. We use
 * `\` as the escape character (declared via `ESCAPE '\'` in the query).
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

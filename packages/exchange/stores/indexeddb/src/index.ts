// indexeddb-store — IndexedDB storage backend for @kyneta/exchange.
//
// Implements the Store interface using the browser's native IndexedDB API.
//
// Database schema (version 2):
//   Object store "doc_meta":   (per-document metadata)
//     keyPath: "docId"
//     value: { docId: string, meta: StoreMeta }
//
//   Object store "records":
//     keyPath: "id" (autoIncrement)
//     indexes: { "byDoc": keyPath "docId", unique: false }
//     value: { docId: string, record: StoreRecord }
//
//   Object store "store_meta": (store-global metadata, e.g. format version)
//     keyPath: "key"
//     value: { key: string, value: unknown }
//
// Structured clone handles StoreRecord natively — no binary envelope needed.
// Auto-increment keys preserve insertion order without manual seqNo management,
// and are the store's marks: the database assigns them, so appends from
// several connections (tabs) over one database never collide.

import {
  type DocId,
  decideStoreFormat,
  parseStoreFormat,
  prefixSuccessor,
  resolveMetaFromBatch,
  STORE_META_FORMAT_KEY,
  type Store,
  type StoreFormatVersion,
  StoreFormatVersionError,
  type StoreMark,
  type StoreMeta,
  type StoreRecord,
} from "@kyneta/exchange"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DOC_META_STORE = "doc_meta"
const RECORDS_STORE = "records"
const BY_DOC_INDEX = "byDoc"
// Store-global metadata object store, distinct from the per-doc `doc_meta`
// map. Holds the on-disk format version (under STORE_META_FORMAT_KEY), read
// by a bootstrap reader on open — never through the Store interface.
// Context: jj:uvssotsy.
const STORE_META_STORE = "store_meta"
// Bumped 1 → 2 to introduce the `doc_meta` (renamed) and `store_meta` object
// stores via onupgradeneeded.
const DB_VERSION = 2

// IndexedDB owns its own on-disk format version (its row layout), gated on
// open via `decideStoreFormat`. Independent of IDB's structural DB_VERSION,
// which versions object-store layout, not the data format.
const STORE_FORMAT_VERSION: StoreFormatVersion = { major: 1, minor: 0 }

// ---------------------------------------------------------------------------
// IDB promise wrappers
// ---------------------------------------------------------------------------

function req<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

// oncomplete (not onsuccess of the last request) is the signal that
// the transaction actually committed to disk.
function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    // tx.error is null when abort is called explicitly (e.g. validation failure)
    tx.onabort = () => reject(tx.error ?? new Error("Transaction aborted"))
    tx.onerror = () => reject(tx.error ?? new Error("Transaction error"))
  })
}

function openDatabase(dbName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, DB_VERSION)

    request.onupgradeneeded = () => {
      const db = request.result

      // Guard against re-entry: onupgradeneeded fires on version bump,
      // and the stores may already exist from a prior version.
      if (!db.objectStoreNames.contains(DOC_META_STORE)) {
        db.createObjectStore(DOC_META_STORE, { keyPath: "docId" })
      }

      if (!db.objectStoreNames.contains(RECORDS_STORE)) {
        const recordsStore = db.createObjectStore(RECORDS_STORE, {
          keyPath: "id",
          autoIncrement: true,
        })
        recordsStore.createIndex(BY_DOC_INDEX, "docId", { unique: false })
      }

      if (!db.objectStoreNames.contains(STORE_META_STORE)) {
        db.createObjectStore(STORE_META_STORE, { keyPath: "key" })
      }
    }

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

interface MetaRow {
  readonly docId: string
  readonly meta: StoreMeta
}

interface RecordRow {
  readonly id?: number // auto-increment primary key
  readonly docId: string
  readonly record: StoreRecord
}

// ---------------------------------------------------------------------------
// IndexedDBStore
// ---------------------------------------------------------------------------

export class IndexedDBStore implements Store {
  readonly #db: IDBDatabase

  private constructor(db: IDBDatabase) {
    this.#db = db
  }

  /**
   * Open an IndexedDB-backed store.
   *
   * The database is created on first call; subsequent calls with the
   * same `dbName` reopen the existing database.
   */
  static async open(dbName: string): Promise<IndexedDBStore> {
    const db = await openDatabase(dbName)
    const store = new IndexedDBStore(db)
    try {
      await store.#assertFormat()
    } catch (error) {
      // A refused store must not leak its connection — an open handle would
      // block `deleteDatabase` and future opens.
      db.close()
      throw error
    }
    return store
  }

  // Bootstrap reader: consult the store-format marker before trusting any
  // bytes. Stamps a brand-new store, accepts a compatible one, or throws.
  async #assertFormat(): Promise<void> {
    const readTx = this.#db.transaction(
      [STORE_META_STORE, DOC_META_STORE],
      "readonly",
    )
    const markerRow = (await req(
      readTx.objectStore(STORE_META_STORE).get(STORE_META_FORMAT_KEY),
    )) as { key: string; value: unknown } | undefined
    const docCount = await req(readTx.objectStore(DOC_META_STORE).count())

    const parsed =
      markerRow === undefined ? null : parseStoreFormat(markerRow.value)
    if (parsed === "malformed") {
      throw new StoreFormatVersionError({
        reason: "malformed-version",
        backend: "indexeddb",
        stored: null,
        current: STORE_FORMAT_VERSION,
      })
    }

    const decision = decideStoreFormat({
      current: STORE_FORMAT_VERSION,
      stored: parsed,
      storeHasData: docCount > 0,
    })

    if (decision.action === "refuse") {
      throw new StoreFormatVersionError({
        reason: decision.reason,
        backend: "indexeddb",
        stored: parsed,
        current: STORE_FORMAT_VERSION,
      })
    }
    if (decision.action === "stamp") {
      const writeTx = this.#db.transaction(STORE_META_STORE, "readwrite")
      writeTx
        .objectStore(STORE_META_STORE)
        .put({ key: STORE_META_FORMAT_KEY, value: decision.value })
      await txDone(writeTx)
    }
  }

  // -----------------------------------------------------------------------
  // Store interface
  // -----------------------------------------------------------------------

  async append(docId: DocId, record: StoreRecord): Promise<void> {
    const tx = this.#db.transaction(
      [DOC_META_STORE, RECORDS_STORE],
      "readwrite",
    )
    const metaStore = tx.objectStore(DOC_META_STORE)
    const recordsStore = tx.objectStore(RECORDS_STORE)

    const existing = (await req(metaStore.get(docId))) as MetaRow | undefined
    const existingMeta: StoreMeta | null = existing ? existing.meta : null

    if (record.kind === "entry") {
      if (existingMeta === null) {
        tx.abort()
        throw new Error(
          `Store: first record for doc '${docId}' must be meta, got entry`,
        )
      }
    } else {
      const resolved = resolveMetaFromBatch([record], existingMeta)
      metaStore.put({ docId, meta: resolved } satisfies MetaRow)
    }

    recordsStore.add({ docId, record } satisfies RecordRow)

    await txDone(tx)
  }

  async *loadAll(docId: DocId): AsyncIterable<StoreRecord> {
    const tx = this.#db.transaction(RECORDS_STORE, "readonly")
    const index = tx.objectStore(RECORDS_STORE).index(BY_DOC_INDEX)
    const rows = (await req(index.getAll(docId))) as RecordRow[]
    for (const row of rows) {
      yield row.record
    }
  }

  async mark(docId: DocId): Promise<StoreMark | null> {
    const tx = this.#db.transaction(RECORDS_STORE, "readonly")
    const index = tx.objectStore(RECORDS_STORE).index(BY_DOC_INDEX)
    const last = await req(index.openKeyCursor(IDBKeyRange.only(docId), "prev"))
    return last ? (last.primaryKey as number) : null
  }

  async compact(
    docId: DocId,
    records: StoreRecord[],
    through: StoreMark | null,
  ): Promise<void> {
    const tx = this.#db.transaction(
      [DOC_META_STORE, RECORDS_STORE],
      "readwrite",
    )
    const metaStore = tx.objectStore(DOC_META_STORE)
    const recordsStore = tx.objectStore(RECORDS_STORE)

    // Read + validate + delete + write in one transaction — no TOCTOU race.
    const existing = (await req(metaStore.get(docId))) as MetaRow | undefined
    const existingMeta: StoreMeta | null = existing ? existing.meta : null
    const resolved = resolveMetaFromBatch(records, existingMeta)

    if (through !== null) {
      const index = recordsStore.index(BY_DOC_INDEX)
      const keys = (await req(index.getAllKeys(docId))) as number[]
      for (const key of keys) {
        if (key <= through) recordsStore.delete(key)
      }
    }
    for (const record of records) {
      recordsStore.add({ docId, record } satisfies RecordRow)
    }
    metaStore.put({ docId, meta: resolved } satisfies MetaRow)

    await txDone(tx)
  }

  async delete(docId: DocId): Promise<void> {
    const tx = this.#db.transaction(
      [DOC_META_STORE, RECORDS_STORE],
      "readwrite",
    )
    const metaStore = tx.objectStore(DOC_META_STORE)
    const recordsStore = tx.objectStore(RECORDS_STORE)

    metaStore.delete(docId)

    const index = recordsStore.index(BY_DOC_INDEX)
    const keys = await req(index.getAllKeys(docId))
    for (const key of keys) {
      recordsStore.delete(key)
    }

    await txDone(tx)
  }

  async currentMeta(docId: DocId): Promise<StoreMeta | null> {
    const tx = this.#db.transaction(DOC_META_STORE, "readonly")
    const row = (await req(tx.objectStore(DOC_META_STORE).get(docId))) as
      | MetaRow
      | undefined
    return row ? row.meta : null
  }

  async *listDocIds(prefix?: string): AsyncIterable<DocId> {
    const tx = this.#db.transaction(DOC_META_STORE, "readonly")
    const store = tx.objectStore(DOC_META_STORE)
    const range = prefix === undefined ? undefined : prefixRange(prefix)
    const keys = (await req(store.getAllKeys(range))) as string[]
    for (const key of keys) {
      yield key
    }
  }

  async close(): Promise<void> {
    this.#db.close()
  }
}

// ---------------------------------------------------------------------------
// Factory functions
// ---------------------------------------------------------------------------

/**
 * Create an IndexedDB storage backend for browser-side persistence.
 *
 * Returns a `Store` — pass directly to `Exchange({ store: ... })`.
 *
 * @param dbName - IndexedDB database name
 *
 * @example
 * ```typescript
 * import { createIndexedDBStore } from "@kyneta/indexeddb-store"
 *
 * const exchange = new Exchange({
 *   store: await createIndexedDBStore("my-exchange-db"),
 * })
 * ```
 */
/**
 * The key range holding exactly the keys that start with `prefix`.
 * IndexedDB compares strings by UTF-16 code unit.
 */
function prefixRange(prefix: string): IDBKeyRange {
  const upper = prefixSuccessor(prefix, "code-unit")
  return upper === null
    ? IDBKeyRange.lowerBound(prefix)
    : IDBKeyRange.bound(prefix, upper, false, true)
}

export async function createIndexedDBStore(dbName: string): Promise<Store> {
  return IndexedDBStore.open(dbName)
}

/**
 * Delete an IndexedDB database entirely.
 *
 * Useful for test cleanup and development. The database must not be
 * open — call `store.close()` before deleting.
 */
export async function deleteIndexedDBStore(dbName: string): Promise<void> {
  await req(indexedDB.deleteDatabase(dbName))
}

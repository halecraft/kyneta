// indexeddb-store — IndexedDB storage backend for @kyneta/exchange.
//
// Implements the Store interface using the browser's native IndexedDB API.
//
// Database schema (version 1):
//   Object store "meta":
//     keyPath: "docId"
//     value: { docId: string, meta: StoreMeta }
//
//   Object store "records":
//     keyPath: "id" (autoIncrement)
//     indexes: { "byDoc": keyPath "docId", unique: false }
//     value: { docId: string, record: StoreRecord }
//
// Structured clone handles StoreRecord natively — no binary envelope needed.
// Auto-increment keys preserve insertion order without manual seqNo management.

import {
  type DocId,
  resolveMetaFromBatch,
  type Store,
  type StoreMeta,
  type StoreRecord,
} from "@kyneta/exchange"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const META_STORE = "meta"
const RECORDS_STORE = "records"
const BY_DOC_INDEX = "byDoc"
const DB_VERSION = 1

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
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: "docId" })
      }

      if (!db.objectStoreNames.contains(RECORDS_STORE)) {
        const recordsStore = db.createObjectStore(RECORDS_STORE, {
          keyPath: "id",
          autoIncrement: true,
        })
        recordsStore.createIndex(BY_DOC_INDEX, "docId", { unique: false })
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
    return new IndexedDBStore(db)
  }

  // -----------------------------------------------------------------------
  // Store interface
  // -----------------------------------------------------------------------

  async append(docId: DocId, record: StoreRecord): Promise<void> {
    const tx = this.#db.transaction([META_STORE, RECORDS_STORE], "readwrite")
    const metaStore = tx.objectStore(META_STORE)
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

  async replace(docId: DocId, records: StoreRecord[]): Promise<void> {
    const tx = this.#db.transaction([META_STORE, RECORDS_STORE], "readwrite")
    const metaStore = tx.objectStore(META_STORE)
    const recordsStore = tx.objectStore(RECORDS_STORE)

    // Read + validate + delete + write in one transaction — no TOCTOU race.
    const existing = (await req(metaStore.get(docId))) as MetaRow | undefined
    const existingMeta: StoreMeta | null = existing ? existing.meta : null
    const resolved = resolveMetaFromBatch(records, existingMeta)

    const index = recordsStore.index(BY_DOC_INDEX)
    const existingKeys = await req(index.getAllKeys(docId))
    for (const key of existingKeys) {
      recordsStore.delete(key)
    }
    for (const record of records) {
      recordsStore.add({ docId, record } satisfies RecordRow)
    }
    metaStore.put({ docId, meta: resolved } satisfies MetaRow)

    await txDone(tx)
  }

  async delete(docId: DocId): Promise<void> {
    const tx = this.#db.transaction([META_STORE, RECORDS_STORE], "readwrite")
    const metaStore = tx.objectStore(META_STORE)
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
    const tx = this.#db.transaction(META_STORE, "readonly")
    const row = (await req(tx.objectStore(META_STORE).get(docId))) as
      | MetaRow
      | undefined
    return row ? row.meta : null
  }

  async *listDocIds(prefix?: string): AsyncIterable<DocId> {
    const tx = this.#db.transaction(META_STORE, "readonly")
    const store = tx.objectStore(META_STORE)
    const range =
      prefix !== undefined
        ? IDBKeyRange.bound(prefix, `${prefix}\uffff`, false, true)
        : undefined
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
 * Returns a `Store` — pass directly to `Exchange({ stores: [...] })`.
 *
 * @param dbName - IndexedDB database name
 *
 * @example
 * ```typescript
 * import { createIndexedDBStore } from "@kyneta/indexeddb-store"
 *
 * const exchange = new Exchange({
 *   stores: [await createIndexedDBStore("my-exchange-db")],
 * })
 * ```
 */
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

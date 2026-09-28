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
//   Object store "store_meta": (store-global metadata: format version, seat pool)
//     keyPath: "key"
//     value: { key: string, value: unknown }
//
// Structured clone handles StoreRecord natively — no binary envelope needed.
// Auto-increment keys preserve insertion order without manual seqNo management,
// and are the store's marks: the database assigns them, so appends from
// several connections (tabs) over one database never collide.
//
// Seats are pooled through Web Locks: every page and worker of an origin
// shares them, and the browser releases a page's locks when it unloads or
// dies. The pool lives in `store_meta` under STORE_META_SEATS_KEY, and every
// write checks its seat's fence there, inside its own transaction.

import {
  assertSeatHeld,
  type DocId,
  freshPeerIds,
  type PeerId,
  parseSeatPool,
  planStoreOpen,
  planWriter,
  prefixSuccessor,
  resolveMetaFromBatch,
  type Seat,
  type Seating,
  STORE_META_FORMAT_KEY,
  STORE_META_SEATS_KEY,
  type Store,
  type StoreFormatVersion,
  type StoreMark,
  type StoreMeta,
  type StoreRecord,
  type WriteOptions,
} from "@kyneta/exchange"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DOC_META_STORE = "doc_meta"
const RECORDS_STORE = "records"
const BY_DOC_INDEX = "byDoc"
// Store-global metadata object store, distinct from the per-doc `doc_meta`
// map. Holds the on-disk format version (under STORE_META_FORMAT_KEY) and the
// seat pool (under STORE_META_SEATS_KEY), read on open and by each write's
// fence check — never through the Store interface. Context: jj:uvssotsy.
const STORE_META_STORE = "store_meta"
// Bumped 1 → 2 to introduce the `doc_meta` (renamed) and `store_meta` object
// stores via onupgradeneeded.
const DB_VERSION = 2

// IndexedDB owns its own on-disk format version (its row layout), checked on
// open by `planStoreOpen`. Independent of IDB's structural DB_VERSION,
// which versions object-store layout, not the data format.
// 1.1: `store_meta` holds the seat pool. Older stores read as an empty pool.
const STORE_FORMAT_VERSION: StoreFormatVersion = { major: 1, minor: 1 }

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
  /** The seat that writes this serialized document; absent while unclaimed. */
  readonly writer?: PeerId
}

function metaRow(
  docId: DocId,
  meta: StoreMeta,
  writer: PeerId | null,
): MetaRow {
  return writer === null ? { docId, meta } : { docId, meta, writer }
}

interface RecordRow {
  readonly id?: number // auto-increment primary key
  readonly docId: string
  readonly record: StoreRecord
}

// ---------------------------------------------------------------------------
// IndexedDBStore
// ---------------------------------------------------------------------------

/**
 * The part of the Web Locks `LockManager` seat allocation uses.
 * `navigator.locks` is one.
 */
export interface SeatLocks {
  request(
    name: string,
    options: { readonly ifAvailable?: boolean },
    callback: (lock: unknown) => Promise<void>,
  ): Promise<unknown>
  request<T>(name: string, callback: () => Promise<T>): Promise<T>
  query(): Promise<{
    readonly held?: readonly { readonly name?: string | undefined }[]
  }>
}

export interface IndexedDBStoreOptions {
  /**
   * The lock manager seats are allocated through. Defaults to
   * `navigator.locks`. `null`, or no `navigator.locks` (an insecure origin or
   * an old browser), issues a session seat: unique, but new on every open.
   */
  readonly locks?: SeatLocks | null
}

let warnedNoLocks = false

export class IndexedDBStore implements Store {
  readonly seat: Seat
  readonly #db: IDBDatabase
  /** Releases the seat lock; a no-op for a session seat. */
  readonly #releaseSeat: () => void

  private constructor(db: IDBDatabase, seat: Seat, releaseSeat: () => void) {
    this.#db = db
    this.seat = seat
    this.#releaseSeat = releaseSeat
  }

  /**
   * Open an IndexedDB-backed store, holding a seat from the database's pool.
   *
   * The database is created on first call; subsequent calls with the
   * same `dbName` reopen the existing database.
   */
  static async open(
    dbName: string,
    options: IndexedDBStoreOptions = {},
  ): Promise<IndexedDBStore> {
    const locks =
      options.locks === undefined
        ? ((globalThis.navigator?.locks as SeatLocks | undefined) ?? null)
        : options.locks
    const db = await openDatabase(dbName)
    try {
      if (locks === null) {
        if (!warnedNoLocks) {
          warnedNoLocks = true
          console.warn(
            "[indexeddb-store] Web Locks are unavailable, so every open is a new peer. " +
              "Serve the page from a secure context to keep one across reloads.",
          )
        }
        const seat = await openSeat(db, { kind: "session" })
        return new IndexedDBStore(db, seat, () => {})
      }
      const { seat, release } = await openPooledSeat(db, dbName, locks)
      return new IndexedDBStore(db, seat, release)
    } catch (error) {
      // A refused store must not leak its connection — an open handle would
      // block `deleteDatabase` and future opens.
      db.close()
      throw error
    }
  }

  /**
   * Throws `SeatLostError`, aborting `tx`, when this store's pooled seat has
   * been claimed again. `tx` must cover `store_meta`.
   */
  async #fence(tx: IDBTransaction): Promise<void> {
    if (this.seat.kind !== "pooled") return
    const row = (await req(
      tx.objectStore(STORE_META_STORE).get(STORE_META_SEATS_KEY),
    )) as StoreMetaRow | undefined
    try {
      assertSeatHeld(parseSeatPool(row?.value), this.seat)
    } catch (error) {
      tx.abort()
      throw error
    }
  }

  /** A write transaction: the documents, and the fence in `store_meta`. */
  #writeTransaction(): IDBTransaction {
    return this.#db.transaction(
      [DOC_META_STORE, RECORDS_STORE, STORE_META_STORE],
      "readwrite",
    )
  }

  // -----------------------------------------------------------------------
  // Store interface
  // -----------------------------------------------------------------------

  async append(
    docId: DocId,
    record: StoreRecord,
    options: WriteOptions,
  ): Promise<void> {
    const tx = this.#writeTransaction()
    await this.#fence(tx)
    const metaStore = tx.objectStore(DOC_META_STORE)
    const recordsStore = tx.objectStore(RECORDS_STORE)

    const existing = (await req(metaStore.get(docId))) as MetaRow | undefined
    const existingMeta: StoreMeta | null = existing ? existing.meta : null
    const writer = this.#writer(tx, docId, existing, options)

    if (record.kind === "entry") {
      if (existingMeta === null) {
        tx.abort()
        throw new Error(
          `Store: first record for doc '${docId}' must be meta, got entry`,
        )
      }
      if (writer !== (existing?.writer ?? null)) {
        metaStore.put(metaRow(docId, existingMeta, writer))
      }
    } else {
      const resolved = resolveMetaFromBatch([record], existingMeta)
      metaStore.put(metaRow(docId, resolved, writer))
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
    options: WriteOptions,
  ): Promise<void> {
    const tx = this.#writeTransaction()
    await this.#fence(tx)
    const metaStore = tx.objectStore(DOC_META_STORE)
    const recordsStore = tx.objectStore(RECORDS_STORE)

    // Read + validate + delete + write in one transaction — no TOCTOU race.
    const existing = (await req(metaStore.get(docId))) as MetaRow | undefined
    const existingMeta: StoreMeta | null = existing ? existing.meta : null
    const writer = this.#writer(tx, docId, existing, options)
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
    metaStore.put(metaRow(docId, resolved, writer))

    await txDone(tx)
  }

  async delete(docId: DocId): Promise<void> {
    const tx = this.#writeTransaction()
    await this.#fence(tx)
    const metaStore = tx.objectStore(DOC_META_STORE)
    const recordsStore = tx.objectStore(RECORDS_STORE)

    const existing = (await req(metaStore.get(docId))) as MetaRow | undefined
    this.#writer(tx, docId, existing, { authored: true })
    metaStore.delete(docId)

    const index = recordsStore.index(BY_DOC_INDEX)
    const keys = await req(index.getAllKeys(docId))
    for (const key of keys) {
      recordsStore.delete(key)
    }

    await txDone(tx)
  }

  async writerOf(docId: DocId): Promise<PeerId | null> {
    const tx = this.#db.transaction(DOC_META_STORE, "readonly")
    const row = (await req(tx.objectStore(DOC_META_STORE).get(docId))) as
      | MetaRow
      | undefined
    return row?.writer ?? null
  }

  /**
   * The writer to record after this write; aborts `tx` and throws
   * `WriterRefusedError` when another seat writes the document.
   */
  #writer(
    tx: IDBTransaction,
    docId: DocId,
    existing: MetaRow | undefined,
    options: WriteOptions,
  ): PeerId | null {
    try {
      return planWriter({
        docId,
        seat: this.seat,
        recorded: existing?.writer ?? null,
        authored: options.authored,
      })
    } catch (error) {
      tx.abort()
      throw error
    }
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
    this.#releaseSeat()
  }
}

// ---------------------------------------------------------------------------
// Opening: the format and the seat
// ---------------------------------------------------------------------------

interface StoreMetaRow {
  readonly key: string
  readonly value: unknown
}

/** What opening reads: the store-wide metadata, and whether any doc exists. */
async function readStoreMeta(db: IDBDatabase): Promise<{
  format: unknown
  pool: unknown
  hasData: boolean
}> {
  const tx = db.transaction([STORE_META_STORE, DOC_META_STORE], "readonly")
  const storeMeta = tx.objectStore(STORE_META_STORE)
  const format = (await req(storeMeta.get(STORE_META_FORMAT_KEY))) as
    | StoreMetaRow
    | undefined
  const pool = (await req(storeMeta.get(STORE_META_SEATS_KEY))) as
    | StoreMetaRow
    | undefined
  const docCount = await req(tx.objectStore(DOC_META_STORE).count())
  return { format: format?.value, pool: pool?.value, hasData: docCount > 0 }
}

/**
 * Read the store-wide metadata, plan the open, and write what it says. Throws
 * `StoreFormatVersionError` for a store this build cannot read.
 */
async function openSeat(
  db: IDBDatabase,
  seating: Seating,
  claim: (seat: Seat) => Promise<void> = async () => {},
): Promise<Seat> {
  const stored = await readStoreMeta(db)
  const plan = planStoreOpen({
    backend: "indexeddb",
    current: STORE_FORMAT_VERSION,
    storedFormat: stored.format,
    storeHasData: stored.hasData,
    storedPool: stored.pool,
    seating,
    fresh: freshPeerIds(),
  })
  if (plan.action === "refuse") throw plan.error
  await claim(plan.seat)
  if (plan.writeFormat !== undefined || plan.writePool !== undefined) {
    const tx = db.transaction(STORE_META_STORE, "readwrite")
    const storeMeta = tx.objectStore(STORE_META_STORE)
    if (plan.writeFormat !== undefined) {
      storeMeta.put({
        key: STORE_META_FORMAT_KEY,
        value: plan.writeFormat,
      } satisfies StoreMetaRow)
    }
    if (plan.writePool !== undefined) {
      storeMeta.put({
        key: STORE_META_SEATS_KEY,
        value: plan.writePool,
      } satisfies StoreMetaRow)
    }
    await txDone(tx)
  }
  return plan.seat
}

/**
 * Take a seat from the database's pool, under its allocation lock.
 *
 * A seat lock is only ever requested while holding `alloc`, so while this
 * holds it the set of held seats can shrink but not grow: the snapshot
 * `query()` gives is authoritative, any seat it shows free stays free, and
 * the one lock request cannot be refused.
 */
async function openPooledSeat(
  db: IDBDatabase,
  dbName: string,
  locks: SeatLocks,
): Promise<{ seat: Seat; release: () => void }> {
  const seatPrefix = `kyneta:${dbName}:seat:`
  let release: () => void = () => {}
  const seat = await locks.request(`kyneta:${dbName}:alloc`, async () => {
    const snapshot = await locks.query()
    const held = new Set<PeerId>()
    for (const lock of snapshot.held ?? []) {
      if (lock.name?.startsWith(seatPrefix)) {
        held.add(lock.name.slice(seatPrefix.length))
      }
    }
    return openSeat(db, { kind: "pooled", held }, async chosen => {
      const granted = await holdLock(locks, `${seatPrefix}${chosen.peerId}`)
      if (granted === null) {
        throw new Error(
          `[indexeddb-store] seat ${chosen.peerId} of '${dbName}' was taken ` +
            `outside its allocation lock; refusing a seat another holder may have`,
        )
      }
      release = granted
    }).catch((error: unknown) => {
      release()
      throw error
    })
  })
  return { seat, release }
}

/**
 * Request `name` without waiting, and hold it until the returned function is
 * called. `null` when another holder has it.
 *
 * The request's own promise settles only once the lock is released, so the
 * grant is reported through a promise of its own.
 */
function holdLock(
  locks: SeatLocks,
  name: string,
): Promise<(() => void) | null> {
  return new Promise((resolve, reject) => {
    locks
      .request(name, { ifAvailable: true }, lock => {
        if (lock === null) {
          resolve(null)
          return Promise.resolve()
        }
        return new Promise<void>(release => resolve(() => release()))
      })
      .catch(reject)
  })
}

// ---------------------------------------------------------------------------
// Factory functions
// ---------------------------------------------------------------------------

/**
 * Create an IndexedDB storage backend for browser-side persistence.
 *
 * Returns a `Store` — pass directly to `Exchange({ store: ... })`. The store
 * holds a seat from the database's pool until it closes or the page unloads,
 * so a page that reloads is the same peer.
 *
 * @param dbName - IndexedDB database name
 * @param options.locks - The lock manager seats come from; see
 *   `IndexedDBStoreOptions`
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
export async function createIndexedDBStore(
  dbName: string,
  options: IndexedDBStoreOptions = {},
): Promise<Store> {
  return IndexedDBStore.open(dbName, options)
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

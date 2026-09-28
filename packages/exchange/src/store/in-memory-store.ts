// in-memory-store — a Map-backed Store for testing.
//
// Supports an optional `sharedData` constructor arg so that several
// InMemoryStore instances open one storage — useful for simulating
// persist → restart → hydrate, and several Runtimes over one storage. The
// shared data holds the seat pool and which of its seats are held, so the
// instances over one storage issue seats as a real pooled backend does.

import type { DocId, PeerId } from "@kyneta/transport"
import {
  assertSeatHeld,
  freshPeerIds,
  type PooledSeat,
  type SeatPool,
} from "./seats.js"
import type { Store, StoreMark, StoreMeta, StoreRecord } from "./store.js"
import { resolveMetaFromBatch, validateAppend } from "./store.js"
import type { StoreFormatVersion } from "./store-format.js"
import { planStoreOpen } from "./store-open.js"

/**
 * The storage an `InMemoryStore` opens. Share one between instances to open
 * the same storage from each.
 */
export type InMemoryStoreData = {
  /** Each document's records, with the mark each was stored at. */
  records: Map<DocId, { mark: StoreMark; record: StoreRecord }[]>
  metadata: Map<DocId, StoreMeta>
  /** The mark the next record is stored at, across every document. */
  nextMark: StoreMark
  /**
   * The seat pool, and the seats open instances hold. `held` stands in for
   * the platform's locks: an instance adds its seat on open and removes it on
   * `close()`, and `abandonSeat` removes it as a dying holder's platform
   * would.
   */
  seats: { pool: SeatPool; held: Set<PeerId> }
}

/** An empty `InMemoryStoreData`. */
export function createInMemoryStoreData(): InMemoryStoreData {
  return {
    records: new Map(),
    metadata: new Map(),
    nextMark: 1,
    seats: { pool: { seats: [], fences: {} }, held: new Set() },
  }
}

/** The records stored for `docId`, in stream order. */
export function recordsOf(
  data: InMemoryStoreData,
  docId: DocId,
): readonly StoreRecord[] {
  return (data.records.get(docId) ?? []).map(stored => stored.record)
}

// In-memory data never outlives the code that wrote it, so its format is
// always this one.
const FORMAT: StoreFormatVersion = { major: 1, minor: 0 }

export class InMemoryStore implements Store {
  readonly seat: PooledSeat
  readonly #data: InMemoryStoreData
  #closed = false

  constructor(sharedData?: InMemoryStoreData) {
    this.#data = sharedData ?? createInMemoryStoreData()
    // Synchronous, so nothing else allocates between reading `held` and adding
    // this seat to it.
    const { seats } = this.#data
    const plan = planStoreOpen({
      backend: "in-memory",
      current: FORMAT,
      storedFormat: FORMAT,
      storeHasData: this.#data.metadata.size > 0,
      storedPool: seats.pool,
      seating: { kind: "pooled", held: seats.held },
      fresh: freshPeerIds(),
    })
    if (plan.action === "refuse") throw plan.error
    this.seat = plan.seat
    seats.pool = plan.writePool
    seats.held.add(this.seat.peerId)
  }

  /**
   * The storage this instance opened, seat pool included. Pass it to another
   * InMemoryStore's constructor to open the same storage from there, as a
   * restarted process or a second tab would.
   */
  getStorage(): InMemoryStoreData {
    return this.#data
  }

  /** Throws once the store is closed. */
  #open(): void {
    if (this.#closed) throw new Error("InMemoryStore: the store is closed")
  }

  /** Throws unless the store is open and still holds its seat. */
  #writable(): void {
    this.#open()
    assertSeatHeld(this.#data.seats.pool, this.seat)
  }

  /** Store `records` after everything `docId` holds, each at a fresh mark. */
  #push(docId: DocId, records: readonly StoreRecord[]): void {
    const stream = this.#data.records.get(docId) ?? []
    for (const record of records) {
      stream.push({ mark: this.#data.nextMark++, record })
    }
    this.#data.records.set(docId, stream)
  }

  async append(docId: DocId, record: StoreRecord): Promise<void> {
    this.#writable()
    const existingMeta = this.#data.metadata.get(docId) ?? null
    const resolved = validateAppend(docId, record, existingMeta)
    if (resolved !== null) this.#data.metadata.set(docId, resolved)
    this.#push(docId, [record])
  }

  async *loadAll(docId: DocId): AsyncIterable<StoreRecord> {
    this.#open()
    yield* recordsOf(this.#data, docId)
  }

  async mark(docId: DocId): Promise<StoreMark | null> {
    this.#open()
    return this.#data.records.get(docId)?.at(-1)?.mark ?? null
  }

  async compact(
    docId: DocId,
    records: StoreRecord[],
    through: StoreMark | null,
  ): Promise<void> {
    this.#writable()
    const existingMeta = this.#data.metadata.get(docId) ?? null
    const resolved = resolveMetaFromBatch(records, existingMeta)

    // One synchronous step: a reader sees the stream before or after.
    const kept = (this.#data.records.get(docId) ?? []).filter(
      stored => through === null || stored.mark > through,
    )
    this.#data.records.set(docId, kept)
    this.#push(docId, records)
    this.#data.metadata.set(docId, resolved)
  }

  async delete(docId: DocId): Promise<void> {
    this.#writable()
    this.#data.records.delete(docId)
    this.#data.metadata.delete(docId)
  }

  async currentMeta(docId: DocId): Promise<StoreMeta | null> {
    this.#open()
    return this.#data.metadata.get(docId) ?? null
  }

  async *listDocIds(prefix?: string): AsyncIterable<DocId> {
    this.#open()
    for (const docId of this.#data.metadata.keys()) {
      if (prefix === undefined || docId.startsWith(prefix)) {
        yield docId
      }
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    // Release the seat only if it is still this claim: after `abandonSeat`,
    // another instance may hold it now.
    const { seats } = this.#data
    if (seats.pool.fences[this.seat.peerId] === this.seat.fence) {
      seats.held.delete(this.seat.peerId)
    }
  }
}

/**
 * Release `store`'s seat without closing it, as the platform does for a
 * holder that dies: the next open may take the seat, and `store`'s writes then
 * fail with `SeatLostError`. For tests.
 */
export function abandonSeat(store: Store): void {
  if (!(store instanceof InMemoryStore)) {
    throw new Error("abandonSeat: not an InMemoryStore")
  }
  store.getStorage().seats.held.delete(store.seat.peerId)
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

/**
 * Create an in-memory storage backend for testing.
 *
 * Returns a `Store` — pass it to `Exchange({ store })`.
 *
 * Share one `sharedData` between instances to open the same storage from
 * each, simulating persist → restart → hydrate:
 *
 * ```typescript
 * const sharedData = createInMemoryStoreData()
 * const exchange1 = new Exchange({
 *   store: createInMemoryStore({ sharedData }),
 * })
 * // ... exchange1 persists data ...
 * await exchange1.shutdown()
 *
 * const exchange2 = new Exchange({
 *   store: createInMemoryStore({ sharedData }),
 * })
 * // exchange2 hydrates from the shared data
 * ```
 *
 * @param options.sharedData - The storage to open
 */
export function createInMemoryStore(
  options: { sharedData?: InMemoryStoreData } = {},
): Store {
  return new InMemoryStore(options.sharedData)
}

// in-memory-store — a Map-backed Store for testing.
//
// Supports an optional `sharedData` constructor arg so that several
// InMemoryStore instances open one storage — useful for simulating
// persist → restart → hydrate, and several Runtimes over one storage.

import type { DocId } from "@kyneta/transport"
import type { Store, StoreMark, StoreMeta, StoreRecord } from "./store.js"
import { resolveMetaFromBatch, validateAppend } from "./store.js"

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
}

/** An empty `InMemoryStoreData`. */
export function createInMemoryStoreData(): InMemoryStoreData {
  return { records: new Map(), metadata: new Map(), nextMark: 1 }
}

/** The records stored for `docId`, in stream order. */
export function recordsOf(
  data: InMemoryStoreData,
  docId: DocId,
): readonly StoreRecord[] {
  return (data.records.get(docId) ?? []).map(stored => stored.record)
}

export class InMemoryStore implements Store {
  readonly #data: InMemoryStoreData

  constructor(sharedData?: InMemoryStoreData) {
    this.#data = sharedData ?? createInMemoryStoreData()
  }

  /**
   * The storage this instance opened. Pass it to another InMemoryStore's
   * constructor to open the same storage from there, as a restarted process
   * or a second tab would.
   */
  getStorage(): InMemoryStoreData {
    return this.#data
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
    const existingMeta = this.#data.metadata.get(docId) ?? null
    const resolved = validateAppend(docId, record, existingMeta)
    if (resolved !== null) this.#data.metadata.set(docId, resolved)
    this.#push(docId, [record])
  }

  async *loadAll(docId: DocId): AsyncIterable<StoreRecord> {
    yield* recordsOf(this.#data, docId)
  }

  async mark(docId: DocId): Promise<StoreMark | null> {
    return this.#data.records.get(docId)?.at(-1)?.mark ?? null
  }

  async compact(
    docId: DocId,
    records: StoreRecord[],
    through: StoreMark | null,
  ): Promise<void> {
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
    this.#data.records.delete(docId)
    this.#data.metadata.delete(docId)
  }

  async currentMeta(docId: DocId): Promise<StoreMeta | null> {
    return this.#data.metadata.get(docId) ?? null
  }

  async *listDocIds(prefix?: string): AsyncIterable<DocId> {
    for (const docId of this.#data.metadata.keys()) {
      if (prefix === undefined || docId.startsWith(prefix)) {
        yield docId
      }
    }
  }

  async close(): Promise<void> {}
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

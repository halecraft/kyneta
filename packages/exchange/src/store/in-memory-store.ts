// in-memory-store — a Map-backed Store for testing.
//
// Supports an optional `sharedData` constructor arg so that multiple
// InMemoryStore instances can share the same underlying Maps —
// useful for simulating persist → restart → hydrate in tests.

import type { DocId } from "@kyneta/transport"
import type { Store, StoreMeta, StoreRecord } from "./store.js"
import { resolveMetaFromBatch } from "./store.js"

export type InMemoryStoreData = {
  records: Map<DocId, StoreRecord[]>
  metadata: Map<DocId, StoreMeta>
}

export class InMemoryStore implements Store {
  readonly #records: Map<DocId, StoreRecord[]>
  readonly #metadata: Map<DocId, StoreMeta>

  constructor(sharedData?: InMemoryStoreData) {
    this.#records = sharedData?.records ?? new Map()
    this.#metadata = sharedData?.metadata ?? new Map()
  }

  /**
   * Get the underlying storage data for sharing between instances.
   * Pass this to another InMemoryStore's constructor to
   * simulate persistent storage across exchange restarts.
   */
  getStorage(): InMemoryStoreData {
    return {
      records: this.#records,
      metadata: this.#metadata,
    }
  }

  async append(docId: DocId, record: StoreRecord): Promise<void> {
    const existingMeta = this.#metadata.get(docId) ?? null

    if (record.kind === "entry") {
      if (existingMeta === null) {
        throw new Error(
          `Store: first record for doc '${docId}' must be meta, got entry`,
        )
      }
    } else {
      const resolved = resolveMetaFromBatch([record], existingMeta)
      this.#metadata.set(docId, resolved)
    }

    const stream = this.#records.get(docId)
    if (stream) {
      stream.push(record)
    } else {
      this.#records.set(docId, [record])
    }
  }

  async *loadAll(docId: DocId): AsyncIterable<StoreRecord> {
    const stream = this.#records.get(docId)
    if (stream) {
      yield* stream
    }
  }

  async replace(docId: DocId, records: StoreRecord[]): Promise<void> {
    const existingMeta = this.#metadata.get(docId) ?? null

    const resolved = resolveMetaFromBatch(records, existingMeta)

    // A concurrent reader (in the same tick) sees either the old
    // array or the new one, never an empty state.
    this.#records.set(docId, [...records])
    this.#metadata.set(docId, resolved)
  }

  async delete(docId: DocId): Promise<void> {
    this.#records.delete(docId)
    this.#metadata.delete(docId)
  }

  async currentMeta(docId: DocId): Promise<StoreMeta | null> {
    return this.#metadata.get(docId) ?? null
  }

  async *listDocIds(prefix?: string): AsyncIterable<DocId> {
    for (const docId of this.#metadata.keys()) {
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
 * Returns a `Store` — pass directly to `Exchange({ stores: [...] })`.
 *
 * Use the `sharedData` option to share storage state between exchange
 * instances, simulating persist → restart → hydrate:
 *
 * ```typescript
 * const sharedData: InMemoryStoreData = {
 *   records: new Map(),
 *   metadata: new Map(),
 * }
 * const exchange1 = new Exchange({
 *   stores: [createInMemoryStore({ sharedData })],
 * })
 * // ... exchange1 persists data ...
 * await exchange1.shutdown()
 *
 * const exchange2 = new Exchange({
 *   stores: [createInMemoryStore({ sharedData })],
 * })
 * // exchange2 hydrates from the shared data
 * ```
 *
 * @param options.sharedData - Shared data maps for cross-instance persistence
 */
export function createInMemoryStore(
  options: { sharedData?: InMemoryStoreData } = {},
): Store {
  return new InMemoryStore(options.sharedData)
}

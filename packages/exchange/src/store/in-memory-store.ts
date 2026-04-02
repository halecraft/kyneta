// in-memory-store — a Map-backed Store for testing.
//
// Uses Map<DocId, StoreEntry[]> for entries and Map<DocId, DocMetadata>
// for per-document metadata. Entries are stored in insertion order.
// `replace` atomically swaps the array to a single-element array.
// `listDocIds` iterates the metadata map keys.
//
// Supports an optional `sharedData` constructor arg so that multiple
// InMemoryStore instances can share the same underlying Maps —
// useful for simulating persist → restart → hydrate in tests.
//
// The `createInMemoryStore()` factory function returns a
// `Store` directly for use in Exchange({ stores: [...] }).

import type { DocMetadata } from "@kyneta/schema"
import type { DocId } from "../types.js"
import type { Store, StoreEntry } from "./store.js"

export type InMemoryStoreData = {
  entries: Map<DocId, StoreEntry[]>
  metadata: Map<DocId, DocMetadata>
}

export class InMemoryStore implements Store {
  readonly #entries: Map<DocId, StoreEntry[]>
  readonly #metadata: Map<DocId, DocMetadata>

  constructor(sharedData?: InMemoryStoreData) {
    this.#entries = sharedData?.entries ?? new Map()
    this.#metadata = sharedData?.metadata ?? new Map()
  }

  /**
   * Get the underlying storage data for sharing between instances.
   * Pass this to another InMemoryStore's constructor to
   * simulate persistent storage across exchange restarts.
   */
  getStorage(): InMemoryStoreData {
    return {
      entries: this.#entries,
      metadata: this.#metadata,
    }
  }

  async lookup(docId: DocId): Promise<DocMetadata | null> {
    return this.#metadata.get(docId) ?? null
  }

  async ensureDoc(docId: DocId, metadata: DocMetadata): Promise<void> {
    if (!this.#metadata.has(docId)) {
      this.#metadata.set(docId, metadata)
    }
  }

  async append(docId: DocId, entry: StoreEntry): Promise<void> {
    const entries = this.#entries.get(docId)
    if (entries) {
      entries.push(entry)
    } else {
      this.#entries.set(docId, [entry])
    }
  }

  async *loadAll(docId: DocId): AsyncIterable<StoreEntry> {
    const entries = this.#entries.get(docId)
    if (entries) {
      yield* entries
    }
  }

  async replace(docId: DocId, entry: StoreEntry): Promise<void> {
    // Atomic swap — set the array to a single-element array in one
    // synchronous operation. A concurrent reader (in the same tick)
    // sees either the old array or the new one, never an empty state.
    this.#entries.set(docId, [entry])
  }

  async delete(docId: DocId): Promise<void> {
    this.#entries.delete(docId)
    this.#metadata.delete(docId)
  }

  async *listDocIds(): AsyncIterable<DocId> {
    yield* this.#metadata.keys()
  }
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
 *   entries: new Map(),
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
  options: {
    sharedData?: InMemoryStoreData
  } = {},
): Store {
  return new InMemoryStore(options.sharedData)
}
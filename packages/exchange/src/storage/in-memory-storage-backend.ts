// in-memory-storage-backend — a Map-backed StorageBackend for testing.
//
// Uses Map<DocId, StorageEntry[]> for entries and Map<DocId, DocMetadata>
// for per-document metadata. Entries are stored in insertion order.
// `replace` atomically swaps the array to a single-element array.
// `listDocIds` iterates the metadata map keys.
//
// Supports an optional `sharedData` constructor arg so that multiple
// InMemoryStorageBackend instances can share the same underlying Maps —
// useful for simulating persist → restart → hydrate in tests.
//
// The `createInMemoryStorage()` factory function returns a
// `StorageBackend` directly for use in Exchange({ storage: [...] }).

import type { DocMetadata } from "@kyneta/schema"
import type { DocId } from "../types.js"
import type { StorageBackend, StorageEntry } from "./storage-backend.js"

export type InMemoryStorageData = {
  entries: Map<DocId, StorageEntry[]>
  metadata: Map<DocId, DocMetadata>
}

export class InMemoryStorageBackend implements StorageBackend {
  readonly #entries: Map<DocId, StorageEntry[]>
  readonly #metadata: Map<DocId, DocMetadata>

  constructor(sharedData?: InMemoryStorageData) {
    this.#entries = sharedData?.entries ?? new Map()
    this.#metadata = sharedData?.metadata ?? new Map()
  }

  /**
   * Get the underlying storage data for sharing between instances.
   * Pass this to another InMemoryStorageBackend's constructor to
   * simulate persistent storage across exchange restarts.
   */
  getStorage(): InMemoryStorageData {
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

  async append(docId: DocId, entry: StorageEntry): Promise<void> {
    const entries = this.#entries.get(docId)
    if (entries) {
      entries.push(entry)
    } else {
      this.#entries.set(docId, [entry])
    }
  }

  async *loadAll(docId: DocId): AsyncIterable<StorageEntry> {
    const entries = this.#entries.get(docId)
    if (entries) {
      yield* entries
    }
  }

  async replace(docId: DocId, entry: StorageEntry): Promise<void> {
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
 * Returns a `StorageBackend` — pass directly to `Exchange({ storage: [...] })`.
 *
 * Use the `sharedData` option to share storage state between exchange
 * instances, simulating persist → restart → hydrate:
 *
 * ```typescript
 * const sharedData: InMemoryStorageData = {
 *   entries: new Map(),
 *   metadata: new Map(),
 * }
 * const exchange1 = new Exchange({
 *   storage: [createInMemoryStorage({ sharedData })],
 * })
 * // ... exchange1 persists data ...
 * await exchange1.shutdown()
 *
 * const exchange2 = new Exchange({
 *   storage: [createInMemoryStorage({ sharedData })],
 * })
 * // exchange2 hydrates from the shared data
 * ```
 *
 * @param options.sharedData - Shared data maps for cross-instance persistence
 */
export function createInMemoryStorage(
  options: {
    sharedData?: InMemoryStorageData
  } = {},
): StorageBackend {
  return new InMemoryStorageBackend(options.sharedData)
}
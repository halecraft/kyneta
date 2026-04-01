// in-memory-storage-backend — a Map-backed StorageBackend for testing.
//
// Uses Map<DocId, StorageEntry[]> internally. Entries are stored in
// insertion order. `replace` atomically swaps the array to a
// single-element array. `listDocIds` iterates the map keys.
//
// Supports an optional `sharedData` constructor arg so that multiple
// InMemoryStorageBackend instances can share the same underlying Map —
// useful for simulating persist → restart → hydrate in tests.
//
// The `createInMemoryStorage()` factory function returns an
// `AdapterFactory` for use in Exchange({ adapters: [...] }).

import type { AdapterFactory } from "../adapter/adapter.js"
import type { DocId } from "../types.js"
import { StorageAdapter } from "./storage-adapter.js"
import type { StorageBackend, StorageEntry } from "./storage-backend.js"

export class InMemoryStorageBackend implements StorageBackend {
  readonly #data: Map<DocId, StorageEntry[]>

  constructor(sharedData?: Map<DocId, StorageEntry[]>) {
    this.#data = sharedData ?? new Map()
  }

  /**
   * Get the underlying storage map for sharing between instances.
   * Pass this to another InMemoryStorageBackend's constructor to
   * simulate persistent storage across exchange restarts.
   */
  getStorage(): Map<DocId, StorageEntry[]> {
    return this.#data
  }

  async append(docId: DocId, entry: StorageEntry): Promise<void> {
    const entries = this.#data.get(docId)
    if (entries) {
      entries.push(entry)
    } else {
      this.#data.set(docId, [entry])
    }
  }

  async has(docId: DocId): Promise<boolean> {
    const entries = this.#data.get(docId)
    return entries != null && entries.length > 0
  }

  async *loadAll(docId: DocId): AsyncIterable<StorageEntry> {
    const entries = this.#data.get(docId)
    if (entries) {
      yield* entries
    }
  }

  async replace(docId: DocId, entry: StorageEntry): Promise<void> {
    // Atomic swap — set the array to a single-element array in one
    // synchronous operation. A concurrent reader (in the same tick)
    // sees either the old array or the new one, never an empty state.
    this.#data.set(docId, [entry])
  }

  async delete(docId: DocId): Promise<void> {
    this.#data.delete(docId)
  }

  async *listDocIds(): AsyncIterable<DocId> {
    yield* this.#data.keys()
  }
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

/**
 * Create an in-memory storage adapter factory for testing.
 *
 * Returns an `AdapterFactory` — pass directly to `Exchange({ adapters: [...] })`.
 *
 * Use the `sharedData` option to share storage state between exchange
 * instances, simulating persist → restart → hydrate:
 *
 * ```typescript
 * const sharedData = new Map()
 * const exchange1 = new Exchange({
 *   adapters: [createInMemoryStorage({ sharedData })],
 * })
 * // ... exchange1 persists data ...
 * await exchange1.shutdown()
 *
 * const exchange2 = new Exchange({
 *   adapters: [createInMemoryStorage({ sharedData })],
 * })
 * // exchange2 hydrates from the shared data
 * ```
 *
 * @param options.sharedData - Shared Map for cross-instance persistence
 * @param options.adapterType - Adapter type identifier (default: "in-memory-storage")
 * @param options.adapterId - Unique adapter instance identifier
 */
export function createInMemoryStorage(
  options: {
    sharedData?: Map<string, StorageEntry[]>
    adapterType?: string
    adapterId?: string
  } = {},
): AdapterFactory {
  const {
    sharedData,
    adapterType = "in-memory-storage",
    adapterId,
  } = options

  return () =>
    new StorageAdapter({
      backend: new InMemoryStorageBackend(sharedData),
      adapterType,
      adapterId,
    })
}
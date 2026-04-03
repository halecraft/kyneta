// storage — barrel file for the storage module.
//
// Re-exports the Store interface, StoreEntry type,
// InMemoryStore implementation, and factory function.

// ---------------------------------------------------------------------------
// Store interface and StoreEntry type
// ---------------------------------------------------------------------------

export type { Store, StoreEntry } from "./store.js"

// ---------------------------------------------------------------------------
// InMemoryStore — Map-backed backend for testing
// ---------------------------------------------------------------------------

export {
  InMemoryStore,
  type InMemoryStoreData,
} from "./in-memory-store.js"

// ---------------------------------------------------------------------------
// createInMemoryStore — factory function for Exchange({ stores: [...] })
// ---------------------------------------------------------------------------

export { createInMemoryStore } from "./in-memory-store.js"

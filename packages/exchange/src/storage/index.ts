// storage — barrel file for the storage module.
//
// Re-exports the StorageBackend interface, StorageEntry type,
// InMemoryStorageBackend implementation, and factory function.

// ---------------------------------------------------------------------------
// StorageBackend interface and StorageEntry type
// ---------------------------------------------------------------------------

export type { StorageBackend, StorageEntry } from "./storage-backend.js"

// ---------------------------------------------------------------------------
// InMemoryStorageBackend — Map-backed backend for testing
// ---------------------------------------------------------------------------

export {
  InMemoryStorageBackend,
  type InMemoryStorageData,
} from "./in-memory-storage-backend.js"

// ---------------------------------------------------------------------------
// createInMemoryStorage — factory function for Exchange({ storage: [...] })
// ---------------------------------------------------------------------------

export { createInMemoryStorage } from "./in-memory-storage-backend.js"
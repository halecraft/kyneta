// storage — barrel file for the storage module.
//
// Re-exports the StorageBackend interface, StorageEntry type,
// InMemoryStorageBackend implementation, and StorageAdapter base class.

// ---------------------------------------------------------------------------
// StorageBackend interface and StorageEntry type
// ---------------------------------------------------------------------------

export type { StorageBackend, StorageEntry } from "./storage-backend.js"

// ---------------------------------------------------------------------------
// InMemoryStorageBackend — Map-backed backend for testing
// ---------------------------------------------------------------------------

export { InMemoryStorageBackend } from "./in-memory-storage-backend.js"

// ---------------------------------------------------------------------------
// StorageAdapter — protocol translator base class
// ---------------------------------------------------------------------------

export { StorageAdapter } from "./storage-adapter.js"

// ---------------------------------------------------------------------------
// createInMemoryStorage — factory function for Exchange({ adapters: [...] })
// ---------------------------------------------------------------------------

export { createInMemoryStorage } from "./in-memory-storage-backend.js"
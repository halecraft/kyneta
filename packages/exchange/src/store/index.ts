// storage — barrel file for the storage module.
//
// Re-exports the Store interface, StoreRecord/StoreMeta types,
// resolveMetaFromBatch helper, InMemoryStore implementation,
// and factory function.

// ---------------------------------------------------------------------------
// Store interface, record types, and validation
// ---------------------------------------------------------------------------

export type { Store, StoreMark, StoreMeta, StoreRecord } from "./store.js"
export { resolveMetaFromBatch, validateAppend } from "./store.js"

// ---------------------------------------------------------------------------
// Store-format gate — store-level on-disk format compatibility
// ---------------------------------------------------------------------------

export {
  decideStoreFormat,
  parseStoreFormat,
  STORE_META_FORMAT_KEY,
  type StoreFormatDecision,
  type StoreFormatRefusal,
  type StoreFormatVersion,
  StoreFormatVersionError,
} from "./store-format.js"

// ---------------------------------------------------------------------------
// InMemoryStore — Map-backed backend for testing
// ---------------------------------------------------------------------------

export {
  createInMemoryStoreData,
  InMemoryStore,
  type InMemoryStoreData,
  recordsOf,
} from "./in-memory-store.js"

// ---------------------------------------------------------------------------
// createInMemoryStore — factory function for Exchange({ store })
// ---------------------------------------------------------------------------

export { createInMemoryStore } from "./in-memory-store.js"

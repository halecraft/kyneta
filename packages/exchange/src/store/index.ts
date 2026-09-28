// storage — barrel file for the storage module.
//
// Re-exports the Store interface, StoreRecord/StoreMeta types, the helpers
// backends share (validation, the store-format gate, seats and the open
// plan), and the InMemoryStore implementation.

// ---------------------------------------------------------------------------
// Store interface, record types, and validation
// ---------------------------------------------------------------------------

export type {
  KeyOrder,
  Store,
  StoreMark,
  StoreMeta,
  StoreRecord,
} from "./store.js"
export {
  prefixSuccessor,
  resolveMetaFromBatch,
  validateAppend,
} from "./store.js"

// ---------------------------------------------------------------------------
// Store-format gate — store-level on-disk format compatibility
// ---------------------------------------------------------------------------

export {
  decideStoreFormat,
  parseStoreFormat,
  STORE_META_FORMAT_KEY,
  STORE_META_SEATS_KEY,
  type StoreFormatDecision,
  type StoreFormatRefusal,
  type StoreFormatVersion,
  StoreFormatVersionError,
} from "./store-format.js"

// ---------------------------------------------------------------------------
// Seats — the identities a store issues, and opening a store
// ---------------------------------------------------------------------------

export {
  allocateSeat,
  assertSeatHeld,
  freshPeerIds,
  type OwnedSeat,
  type PooledSeat,
  parseSeatPool,
  type Seat,
  SeatLostError,
  type SeatPool,
  type SessionSeat,
  sessionSeat,
} from "./seats.js"
export {
  type OwnedSeating,
  type PooledSeating,
  planStoreOpen,
  type Seating,
  type SessionSeating,
  type StoreOpenInput,
  type StoreOpenPlan,
} from "./store-open.js"

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

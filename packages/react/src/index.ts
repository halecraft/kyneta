// @kyneta/react — thin React bindings over @kyneta/schema + @kyneta/exchange.
//
// Hooks:
//   ExchangeProvider, useExchange — Exchange context
//   useDocument — document access from Exchange
//   useValue — reactive subscription to a ref's plain value
//   useSyncStatus — reactive sync ready-state
//
// Re-exports a curated subset of @kyneta/schema and @kyneta/exchange
// so most app code only imports from @kyneta/react.

// ---------------------------------------------------------------------------
// Local hooks
// ---------------------------------------------------------------------------

export { ExchangeProvider, useExchange } from "./exchange-context.js"
export type { ExchangeProviderProps } from "./exchange-context.js"
export { useDocument } from "./use-document.js"
export { useValue } from "./use-value.js"
export { useSyncStatus } from "./use-sync-status.js"

// Store factories (Functional Core — framework-agnostic, independently testable)
export {
  createChangefeedStore,
  createSyncStore,
  createNullishStore,
} from "./store.js"
export type { ExternalStore, CallableRef } from "./store.js"

// ---------------------------------------------------------------------------
// Thin re-exports from @kyneta/schema
// ---------------------------------------------------------------------------

export { change, applyChanges, subscribe, subscribeNode, Schema, CHANGEFEED } from "@kyneta/schema"
export type { Ref, RRef, Plain, Changeset, Op, BoundSchema } from "@kyneta/schema"

// ---------------------------------------------------------------------------
// Thin re-exports from @kyneta/exchange
// ---------------------------------------------------------------------------

export { Exchange, sync, hasSync } from "@kyneta/exchange"
export type { ExchangeParams, SyncRef, ReadyState, DocId } from "@kyneta/exchange"
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

export type { ExchangeProviderProps } from "./exchange-context.js"
export { ExchangeProvider, useExchange } from "./exchange-context.js"
export type { CallableRef, ExternalStore } from "./store.js"
// Store factories (Functional Core — framework-agnostic, independently testable)
export {
  createChangefeedStore,
  createNullishStore,
  createSyncStore,
} from "./store.js"
export { useDocument } from "./use-document.js"
export { useSyncStatus } from "./use-sync-status.js"
export { useValue } from "./use-value.js"

// ---------------------------------------------------------------------------
// Thin re-exports from @kyneta/schema
// ---------------------------------------------------------------------------

export type {
  BoundSchema,
  Changeset,
  Op,
  Plain,
  Ref,
  RRef,
} from "@kyneta/schema"
export {
  applyChanges,
  CHANGEFEED,
  change,
  Schema,
  subscribe,
  subscribeNode,
} from "@kyneta/schema"

// ---------------------------------------------------------------------------
// Thin re-exports from @kyneta/exchange
// ---------------------------------------------------------------------------

export type {
  AdapterFactory,
  DocId,
  ExchangeParams,
  ReadyState,
  SyncRef,
} from "@kyneta/exchange"
export { Exchange, hasSync, sync } from "@kyneta/exchange"

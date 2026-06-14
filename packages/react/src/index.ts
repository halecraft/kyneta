// @kyneta/react — thin React bindings over @kyneta/schema + @kyneta/exchange.
//
// Hooks:
//   ExchangeProvider, useExchange — Exchange context
//   useDocument — document access from Exchange
//   useValue — reactive subscription to a ref's plain value
//   useSyncState — reactive per-peer sync state (raw array)
//   useDocReady — reactive monotonic readiness latch (the 90% gate)
//
// Re-exports a curated subset of @kyneta/schema and @kyneta/exchange
// so most app code only imports from @kyneta/react.

// ---------------------------------------------------------------------------
// Local hooks
// ---------------------------------------------------------------------------

export type { ExchangeProviderProps } from "./exchange-context.js"
export { ExchangeProvider, useExchange } from "./exchange-context.js"
export type { CallableRef, ExternalStore } from "./store.js"
// Store factories (Functional Core — framework-agnostic, independently testable).
// `createChangefeedStore` was removed in jj:smkurmok — `useValue` is now a
// derivation of `useTracked` over `@kyneta/reactive`. The Sync stores remain
// (they wrap SyncRef.onPeerSyncChange, not a changefeed).
export {
  createDerivedSyncStore,
  createNullishStore,
  createSyncStore,
} from "./store.js"
// Text adapter (framework-agnostic textarea ↔ TextRef binding)
export type { AttachOptions, TextRefLike } from "./text-adapter.js"
export { attach, diffText, transformSelection } from "./text-adapter.js"
export { useChangefeed } from "./use-changefeed.js"
export { useDocReady } from "./use-doc-ready.js"
export { useDocument } from "./use-document.js"
export { useExchangeSingleton } from "./use-exchange-singleton.js"
// useSelector / useTracked — auto-tracked reactive reads over @kyneta/reactive
export { useSelector } from "./use-selector.js"
export { useSyncState } from "./use-sync-state.js"
export type { UseTextOptions } from "./use-text.js"
export { useText } from "./use-text.js"
export { useTracked } from "./use-tracked.js"
export { useValue } from "./use-value.js"

// ---------------------------------------------------------------------------
// Thin re-exports from @kyneta/changefeed
// ---------------------------------------------------------------------------

export type { Changefeed, Changeset } from "@kyneta/changefeed"
export { CHANGEFEED } from "@kyneta/changefeed"

// ---------------------------------------------------------------------------
// Thin re-exports from @kyneta/schema
// ---------------------------------------------------------------------------

export type {
  BoundSchema,
  CommitOptions,
  Op,
  Plain,
  Ref,
  RRef,
} from "@kyneta/schema"
export {
  applyChanges,
  batch,
  Schema,
  subscribe,
  subscribeNode,
} from "@kyneta/schema"

// ---------------------------------------------------------------------------
// Thin re-exports from @kyneta/exchange
// ---------------------------------------------------------------------------

export type {
  Connectivity,
  DocChange,
  DocId,
  DocInfo,
  ExchangeParams,
  GatePredicate,
  LineListener,
  LineProtocol,
  PeerIdentityDetails,
  PeerSyncState,
  Policy,
  SyncRef,
  SyncStatusSummary,
} from "@kyneta/exchange"
export {
  AsyncQueue,
  createLineDocSchema,
  describeSyncStatus,
  Exchange,
  Governance,
  hasSync,
  isLineDocId,
  Line,
  lineDocId,
  parseLineDocId,
  routeLine,
  sync,
} from "@kyneta/exchange"

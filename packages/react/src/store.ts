// store — pure store factories (Functional Core).
//
// Two framework-agnostic functions that translate from kyneta's reactive
// protocols into the { subscribe, getSnapshot } contract consumed by
// React's useSyncExternalStore (and any other external-store consumer).
//
// Zero React imports. Independently testable with createDoc + batch().
//
// createSyncStore(syncRef) — subscribes to SyncRef.onPeerSyncChange(),
//   caches peerStates for referential stability.

import type { ChangeBase, ChangefeedProtocol } from "@kyneta/changefeed"
import { CHANGEFEED } from "@kyneta/changefeed"
import type { PeerSyncState, SyncRef } from "@kyneta/exchange"

// ---------------------------------------------------------------------------
// ExternalStore — the useSyncExternalStore contract
// ---------------------------------------------------------------------------

/**
 * The minimal contract that `useSyncExternalStore` consumes.
 *
 * - `subscribe(onStoreChange)` — register a listener, return unsubscribe
 * - `getSnapshot()` — return the current cached value (stable identity
 *   between changes)
 */
export interface ExternalStore<T> {
  subscribe: (onStoreChange: () => void) => () => void
  getSnapshot: () => T
}

// ---------------------------------------------------------------------------
// CallableRef — the type constraint for useValue
// ---------------------------------------------------------------------------

/**
 * A ref that is both callable (returns Plain<S>) and carries a
 * [CHANGEFEED]. Every Ref<S> from the standard interpreter stack
 * satisfies this constraint, as do primitive `@kyneta/changefeed`
 * sources like `createReactiveMap` and a `@kyneta/reactive` `Reactive`.
 *
 * The call signature `(...args: any[]) => any` allows ReturnType<R>
 * to recover Plain<S> without threading generics through HasChangefeed.
 */
export type CallableRef = ((...args: any[]) => any) & {
  readonly [CHANGEFEED]: ChangefeedProtocol<any, ChangeBase>
}

// Note: `createChangefeedStore` (the previous CHANGEFEED → ExternalStore
// adapter, a degenerate single-dependency reactive) was removed in jj:smkurmok.
// Its deep/shallow `hasRecursiveChangefeed` dispatch is now generalized inside
// `@kyneta/reactive`'s aspect → primitive resolution (jj:kpywvkpr); `useValue`
// is now `useTracked(() => ref())`. `createSyncStore` remains — it wraps
// `SyncRef.onPeerSyncChange` (not a changefeed) and is not subsumable by the
// reactive runtime.

// ---------------------------------------------------------------------------
// Nullish no-op store — stable singleton for null/undefined refs
// ---------------------------------------------------------------------------

const NOOP_UNSUBSCRIBE = () => {}
const NOOP_SUBSCRIBE = () => NOOP_UNSUBSCRIBE

/**
 * A stable no-op store for null/undefined refs. The snapshot is the
 * nullish value itself (null or undefined). subscribe is a no-op.
 *
 * Exported for use by useValue's nullish branch — ensures hook call
 * count is stable regardless of whether the ref is nullish.
 */
export function createNullishStore<T extends null | undefined>(
  value: T,
): ExternalStore<T> {
  return {
    subscribe: NOOP_SUBSCRIBE,
    getSnapshot: () => value,
  }
}

// ---------------------------------------------------------------------------
// createSyncStore — SyncRef → ExternalStore
// ---------------------------------------------------------------------------

/**
 * Create an external store backed by a SyncRef's per-peer sync state.
 *
 * The cached snapshot is the load-bearing part, not an optimization.
 * `syncRef.peerStates` builds a **fresh array on every read** (see
 * `Synchronizer.getPeerStates`), so returning it straight from `getSnapshot`
 * would hand `useSyncExternalStore` a new identity on every render. React
 * would read that as "the store changed" and re-render forever. Caching the
 * array and refreshing it only when the sync state actually moves is what
 * keeps that loop from forming.
 *
 * @param syncRef - A SyncRef from `sync(doc)`.
 * @returns An ExternalStore<PeerSyncState[]>.
 */
export function createSyncStore(
  syncRef: SyncRef,
): ExternalStore<PeerSyncState[]> {
  let snapshot: PeerSyncState[] = syncRef.peerStates

  return {
    subscribe: (onStoreChange: () => void) =>
      syncRef.onPeerSyncChange(() => {
        snapshot = syncRef.peerStates
        onStoreChange()
      }),
    getSnapshot: () => snapshot,
  }
}

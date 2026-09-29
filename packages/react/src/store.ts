// store — the external-store contract, and the one source that needs a
// factory to meet it (Functional Core).
//
// Zero React imports. Independently testable with createDoc + batch().
//
// createSyncStore(syncRef) — subscribes to SyncRef.onPeerSyncChange(),
//   caches peerStates for referential stability. Changefeed sources need no
//   factory: `useChangefeed` meets the contract with `current` directly, and
//   everything else goes through `useTracked`.

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

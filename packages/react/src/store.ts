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

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
// is now `useTracked(() => ref())`. `createSyncStore` / `createDerivedSyncStore`
// remain — they wrap `SyncRef.onPeerSyncChange` (not a changefeed) and are not
// subsumable by the reactive runtime.

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
 * Create an external store backed by a projection over a SyncRef.
 *
 * One subscription (`onPeerSyncChange`) drives any number of derived views:
 * the snapshot is `select(syncRef)`, recomputed on each peer-sync change and
 * cached for referential stability. A scalar select (e.g. `ref.ready`, a
 * boolean) is flicker-free — `useSyncExternalStore` bails out of re-render
 * via `Object.is` when the value is unchanged, even though the underlying
 * per-peer array churned.
 *
 * @param syncRef - A SyncRef from `sync(doc)`.
 * @param select - Pure projection from the SyncRef to the snapshot value.
 */
export function createDerivedSyncStore<T>(
  syncRef: SyncRef,
  select: (ref: SyncRef) => T,
): ExternalStore<T> {
  let snapshot: T = select(syncRef)

  const subscribe = (onStoreChange: () => void): (() => void) => {
    return syncRef.onPeerSyncChange(() => {
      snapshot = select(syncRef)
      onStoreChange()
    })
  }

  const getSnapshot = (): T => snapshot

  return { subscribe, getSnapshot }
}

/**
 * Create an external store backed by a SyncRef's per-peer sync state — the
 * `peerStates` array projection over {@link createDerivedSyncStore}.
 *
 * @param syncRef - A SyncRef from `sync(doc)`.
 * @returns An ExternalStore<PeerSyncState[]>.
 */
export function createSyncStore(
  syncRef: SyncRef,
): ExternalStore<PeerSyncState[]> {
  return createDerivedSyncStore(syncRef, ref => ref.peerStates)
}

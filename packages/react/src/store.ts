// store — pure store factories (Functional Core).
//
// Two framework-agnostic functions that translate from kyneta's reactive
// protocols into the { subscribe, getSnapshot } contract consumed by
// React's useSyncExternalStore (and any other external-store consumer).
//
// Zero React imports. Independently testable with createDoc + change().
//
// createChangefeedStore(ref) — subscribes to a ref's [CHANGEFEED],
//   caches the snapshot for referential stability. Dispatches deep
//   (subscribeTree) for schema-issued refs (every schema ref carries
//   TreeChangefeedProtocol) and shallow (subscribe) for universal-protocol
//   sources like ReactiveMap.
//
// createSyncStore(syncRef) — subscribes to SyncRef.onReadyStateChange(),
//   caches readyStates for referential stability.

import type { ChangeBase, ChangefeedProtocol } from "@kyneta/changefeed"
import { CHANGEFEED } from "@kyneta/changefeed"
import type { ReadyState, SyncRef } from "@kyneta/exchange"
import { hasTreeChangefeed } from "@kyneta/schema"

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
// CallableRef — the type constraint for useValue / createChangefeedStore
// ---------------------------------------------------------------------------

/**
 * A ref that is both callable (returns Plain<S>) and carries a
 * [CHANGEFEED]. Every Ref<S> from the standard interpreter stack
 * satisfies this constraint, as do primitive `@kyneta/changefeed`
 * sources like `createReactiveMap`. The store dispatches via
 * `subscribeTree` when available (schema refs) or `subscribe`
 * otherwise (universal sources).
 *
 * The call signature `(...args: any[]) => any` allows ReturnType<R>
 * to recover Plain<S> without threading generics through HasChangefeed.
 */
export type CallableRef = ((...args: any[]) => any) & {
  readonly [CHANGEFEED]: ChangefeedProtocol<any, ChangeBase>
}

// ---------------------------------------------------------------------------
// createChangefeedStore — CHANGEFEED → ExternalStore
// ---------------------------------------------------------------------------

/**
 * Create an external store backed by a ref's [CHANGEFEED].
 *
 * - Eagerly computes the initial snapshot via `ref()`.
 * - On changefeed notification, recomputes the snapshot and caches it.
 * - `getSnapshot()` returns the cached value — stable identity unless
 *   a real change occurred.
 * - For schema-issued refs (every schema ref carries
 *   `TreeChangefeedProtocol`), subscribes via `subscribeTree`
 *   (deep — fires on own-path + descendants).
 * - For primitive universal-protocol sources (e.g. `createReactiveMap`
 *   from `@kyneta/changefeed`), subscribes via `subscribe`.
 *
 * The branch discriminates between these two genuinely different shapes
 * at runtime via `hasTreeChangefeed`, which also narrows statically so
 * `subscribeTree` is type-safe with no cast.
 *
 * @param ref - A callable ref with [CHANGEFEED] (any Ref<S> or
 *   primitive universal source).
 * @returns An ExternalStore whose snapshot is ReturnType<typeof ref>.
 */
export function createChangefeedStore<R extends CallableRef>(
  ref: R,
): ExternalStore<ReturnType<R>> {
  // Eagerly compute initial snapshot.
  let snapshot: ReturnType<R> = ref()

  const subscribe = (onStoreChange: () => void): (() => void) => {
    const tick = (): void => {
      snapshot = ref()
      onStoreChange()
    }
    return hasTreeChangefeed(ref)
      ? // Inside this branch, ref[CHANGEFEED] is statically
        // TreeChangefeedProtocol, so subscribeTree is type-safe.
        ref[CHANGEFEED].subscribeTree(tick)
      : ref[CHANGEFEED].subscribe(tick)
  }

  const getSnapshot = (): ReturnType<R> => snapshot

  return { subscribe, getSnapshot }
}

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
 * Create an external store backed by a SyncRef's ready state.
 *
 * - Captures the initial `syncRef.readyStates` as the snapshot.
 * - On `onReadyStateChange`, updates the cached snapshot.
 * - `getSnapshot()` returns the cached array — stable identity unless
 *   a ready state change occurred.
 *
 * @param syncRef - A SyncRef from `sync(doc)`.
 * @returns An ExternalStore<ReadyState[]>.
 */
export function createSyncStore(syncRef: SyncRef): ExternalStore<ReadyState[]> {
  let snapshot: ReadyState[] = syncRef.readyStates

  const subscribe = (onStoreChange: () => void): (() => void) => {
    return syncRef.onReadyStateChange(readyStates => {
      snapshot = readyStates
      onStoreChange()
    })
  }

  const getSnapshot = (): ReadyState[] => snapshot

  return { subscribe, getSnapshot }
}

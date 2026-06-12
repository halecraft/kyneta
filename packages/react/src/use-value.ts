// use-value — reactive subscription to a ref's current plain value.
//
// useValue(ref) returns Plain<S> and re-renders when the ref changes. It is a
// derivation of useTracked (jj:smkurmok): `useValue(ref) ≡ useTracked(() =>
// ref())` — the deep-aspect corner of auto-tracking. Reading `ref()` deeply
// reports a `deep` dependency, so useValue re-renders on any descendant change
// (the same contract as before), now with version-driven change detection
// instead of a cached deep snapshot. Materialization (`ref()` → Plain<S>) is
// intrinsic to useValue's contract; the foundation makes its change *detection*
// exact, not its cost. To avoid materializing, project with `useSelector`.
//
// Uses a single conditional return type to handle null/undefined passthrough:
//   CallableRef → ReturnType<R>;  null → null;  undefined → undefined.

import { track } from "@kyneta/reactive"
import type { CallableRef } from "./store.js"
import { useTracked } from "./use-tracked.js"

// ---------------------------------------------------------------------------
// useValue
// ---------------------------------------------------------------------------

/**
 * Subscribe to a ref's current plain value.
 *
 * Returns `Plain<S>` — a plain JS snapshot — and re-renders when the ref (or
 * any descendant) changes. For composite refs this is a deep subscription;
 * for leaf refs, own-node only. Accepts `null` / `undefined` and returns them
 * unchanged (stable hook call count — the nullish case is handled inside the
 * tracked thunk, not via a conditional hook).
 *
 * ```tsx
 * const title = useValue(doc.title)        // string
 * const todo  = useValue(doc.todos.at(0))  // { id, text, done } | undefined-safe
 * const value = useValue(maybeRef)         // null | undefined passes through
 * ```
 *
 * @param ref - A callable ref with [CHANGEFEED], or null/undefined.
 * @returns The plain snapshot value, or null/undefined if input is nullish.
 */
export function useValue<R extends CallableRef | null | undefined>(
  ref: R,
): R extends CallableRef ? ReturnType<R> : R {
  // `track` reports plain HasChangefeed sources (ReactiveMap, index Collection)
  // that don't self-report; for schema refs it is a no-op pass-through (they
  // self-report deeply when called). Nullish passes through untracked.
  return useTracked(() =>
    ref == null ? (ref as unknown) : track(ref as CallableRef),
  ) as R extends CallableRef ? ReturnType<R> : R
}

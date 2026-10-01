// use-value — reactive subscription to a ref's current plain value.
//
// useValue(ref) is useSelector(ref, readValue): a selector that reads the
// whole value. Reading `ref()` reports a deep dependency, so useValue
// re-renders on any change below the ref. The value is the ref's read — a
// frozen snapshot that keeps its identity until something below the ref
// changes, and shares every subtree that did not. `readValue` is one
// module-level function, so the thunk is stable and a re-render for any other
// reason returns the same value.
//
// Uses a single conditional return type to handle null/undefined passthrough:
//   Feed → ReturnType<R>;  null → null;  undefined → undefined.

import type { Feed } from "@kyneta/changefeed"
import { track } from "@kyneta/reactive"
import { useSelector } from "./use-selector.js"

/**
 * Read a ref's value. `track` reports plain `HasChangefeed` sources (a
 * `ReactiveMap`, an index `Collection`) that don't report their own reads;
 * a schema ref reports itself when called. Nullish passes through untracked.
 */
const readValue = (ref: Feed<unknown> | null | undefined): unknown =>
  ref == null ? ref : track(ref)

/**
 * Subscribe to a ref's current plain value.
 *
 * Returns `Plain<S>` — a frozen snapshot — and re-renders when the ref (or
 * any descendant) changes. For composite refs this is a deep subscription;
 * for leaf refs, own-node only. The value keeps its identity across renders
 * until the ref's value changes, and an unchanged part of it keeps its
 * identity across that change, so `React.memo` children given a part of it
 * skip re-rendering. Accepts `null` / `undefined` and returns them unchanged
 * (stable hook call count — the nullish case is handled inside the selector,
 * not via a conditional hook).
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
export function useValue<R extends Feed<unknown> | null | undefined>(
  ref: R,
): R extends Feed<unknown> ? ReturnType<R> : R {
  return useSelector<Feed<unknown> | null | undefined, unknown>(
    ref,
    readValue,
  ) as R extends Feed<unknown> ? ReturnType<R> : R
}

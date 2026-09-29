// use-tracked — the bridge from @kyneta/reactive to React.
//
// useTracked(thunk) runs `thunk` as a reactive computation (jj:kpywvkpr): it
// auto-tracks exactly the kyneta nodes the thunk reads and re-renders the
// component only when one of them changes. No deps array, no `scope`, no
// `isEqual` — the dependency set is discovered from the reads.
//
// Mechanism: `useSyncExternalStore` subscribes to the reactive and uses its
// monotonic `version` as the change token — so a CRDT change drives a
// re-render. The returned value comes from `reactive.refresh(thunk)`, which
// re-runs only when the thunk is a new function or a tracked dependency fired
// since the last run, and otherwise returns the value it already has, with its
// identity. `version` advances iff a tracked dependency fired; there is no
// value comparison.

import { type Reactive, reactive } from "@kyneta/reactive"
import { useEffect, useRef, useSyncExternalStore } from "react"

/**
 * Subscribe a React component to a reactive computation over kyneta refs.
 *
 * The component re-renders exactly when a node the `thunk` read changes — a
 * `text` edit never re-renders a `done`-only selector.
 *
 * **Identity.** The value keeps its identity until a tracked read changes or
 * the thunk does. The thunk's identity is its change signal: a thunk that
 * closes over new props or state is a new function and re-runs, so an inline
 * thunk follows a `filter` prop with no deps array. To keep the value stable
 * across renders that change nothing, keep the thunk stable — React Compiler
 * memoizes an inline thunk on exactly what it captures, and `useCallback`
 * does the same by hand. Reads of kyneta documents are frozen snapshots that
 * share every unchanged subtree, so a stable value works with `React.memo`.
 *
 * **Purity.** The thunk must be pure over its captures and its tracked reads.
 * One that reads something untracked (`Date.now()`, `useRef().current`, an
 * outside store) returns a stale value once its identity is stable — the
 * contract of `useMemo` and `computed` too.
 *
 * ```tsx
 * const visible = useTracked(
 *   useCallback(
 *     () => [...doc.todos].filter(t => filter === "all" || t.done()),
 *     [filter],
 *   ),
 * )
 * ```
 *
 * @param thunk - A computation reading kyneta refs (and/or other reactives).
 * @returns The current value, recomputed when a dependency or the thunk changes.
 */
export function useTracked<T>(thunk: () => T): T {
  // One reactive per mount. Recreate if a prior teardown disposed it
  // (React StrictMode's dev mount→unmount→mount fires the cleanup below).
  const ref = useRef<Reactive<T> | null>(null)
  if (ref.current === null || ref.current.disposed) {
    ref.current = reactive(thunk)
  }
  const r = ref.current

  // Re-render when a tracked dependency fires. `version` is a stable token
  // (a number) — it does NOT change on the refresh() below, so no loop.
  useSyncExternalStore(
    r.subscribe,
    () => r.version,
    () => r.version,
  )

  // Dispose on unmount (and on recreate).
  useEffect(() => () => r.dispose(), [r])

  return r.refresh(thunk)
}

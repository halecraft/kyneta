// use-tracked — the bridge from @kyneta/reactive to React.
//
// useTracked(thunk) runs `thunk` as a reactive computation (jj:kpywvkpr): it
// auto-tracks exactly the kyneta nodes the thunk reads and re-renders the
// component only when one of them changes. No deps array, no `scope`, no
// `isEqual` — the dependency set is discovered from the reads.
//
// Mechanism: `useSyncExternalStore` subscribes to the reactive and uses its
// monotonic `version` as the (stable) change token — so a CRDT change drives a
// re-render. The returned value comes from `reactive.refresh()`, which re-runs
// the LATEST thunk closure every render (following props/state like a `filter`
// with no deps array) WITHOUT bumping `version` — so it never loops with the
// store. `version` is the rigorous token (advances iff a tracked dependency
// fired); there is no value comparison.

import { type Reactive, reactive } from "@kyneta/reactive"
import { useEffect, useRef, useSyncExternalStore } from "react"

/**
 * Subscribe a React component to a reactive computation over kyneta refs.
 *
 * The component re-renders exactly when a node the `thunk` read changes — a
 * `text` edit never re-renders a `done`-only selector. The `thunk` may freely
 * close over props/state (e.g. a URL `filter`) with **no deps array**: it
 * re-runs every render to follow the latest closure.
 *
 * ```tsx
 * const visible = useTracked(() =>
 *   [...doc.todos].filter(t => filter === "all" ? true : t.done()),
 * )
 * ```
 *
 * @param thunk - A computation reading kyneta refs (and/or other reactives).
 * @returns The current value, recomputed when dependencies (or the closure) change.
 */
export function useTracked<T>(thunk: () => T): T {
  // Latest closure, read by the reactive's thunk — so props/state are current.
  const thunkRef = useRef(thunk)
  thunkRef.current = thunk

  // One reactive per mount. Recreate if a prior teardown disposed it
  // (React StrictMode's dev mount→unmount→mount fires the cleanup below).
  const ref = useRef<Reactive<T> | null>(null)
  if (ref.current === null || ref.current.disposed) {
    ref.current = reactive(() => thunkRef.current())
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

  // Re-track with the latest closure and return the current value.
  return r.refresh()
}

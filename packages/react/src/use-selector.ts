// use-selector — project a ref to a derived value, reactively and parsimoniously.
//
// useSelector(ref, select) is useTracked over `() => select(ref)`, with that
// thunk memoized on `ref` and `select`. The component re-renders exactly when
// the nodes `select` actually reads change — not on unrelated edits, and with
// no deep materialization unless `select` asks for it. No options: no `scope`,
// no `watch`, no `isEqual` — auto-tracking (jj:vtpxvkyk + jj:kpywvkpr)
// subsumes them all.

import { hasChangefeed } from "@kyneta/changefeed"
import { useMemo } from "react"
import { useTracked } from "./use-tracked.js"

/**
 * Subscribe to a projection of a ref. `select` receives the ref (fully typed)
 * and reads whatever it needs; those reads become the dependency set.
 *
 * ```tsx
 * // Re-renders only when the visible set of todo refs changes (add/remove or
 * // a done flip crossing the filter) — a text edit does not re-render here.
 * const visible = useSelector(doc.todos, todos =>
 *   [...todos].filter(t => filter === "all" ? true : t.done()),
 * )
 * ```
 *
 * The result keeps its identity while `ref` and `select` keep theirs and
 * nothing `select` read changed. An inline `select` that closes over props is
 * a new function each render and re-runs, so it follows them with no deps
 * array; a stable one (React Compiler, `useCallback`) keeps the result stable.
 * `select` must be pure over what it captures and what it reads.
 *
 * @param ref - Any kyneta ref (or reactive source).
 * @param select - A pure projection reading from `ref`.
 * @returns The selected value, recomputed when its dependencies change.
 */
export function useSelector<R, T>(ref: R, select: (ref: R) => T): T {
  // The thunk's identity is useTracked's change signal, so it is keyed on
  // exactly the hook's own arguments.
  const thunk = useMemo(() => () => select(ref), [ref, select])
  const result = useTracked(thunk)
  if (result && hasChangefeed(result)) {
    throw new Error(
      "useSelector must return a projected value (or plain data), not a Kyneta Ref. " +
        "Either read the fields you need inside the selector, or materialize the node via `t => t()`.",
    )
  }
  return result
}

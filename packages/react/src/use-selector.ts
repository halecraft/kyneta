// use-selector — project a ref to a derived value, reactively and parsimoniously.
//
// useSelector(ref, select) ≡ useTracked(() => select(ref)). The component
// re-renders exactly when the nodes `select` actually reads change — not on
// unrelated edits, and with no deep-JSON materialization unless `select` asks
// for it. No options: no `scope`, no `watch`, no `isEqual` — auto-tracking
// (jj:vtpxvkyk + jj:kpywvkpr) subsumes them all.

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
 * `select` may close over props/state (e.g. `filter`) with no deps array.
 *
 * @param ref - Any kyneta ref (or reactive source).
 * @param select - A pure projection reading from `ref`.
 * @returns The selected value, recomputed when its dependencies change.
 */
export function useSelector<R, T>(ref: R, select: (ref: R) => T): T {
  return useTracked(() => select(ref))
}

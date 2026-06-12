// diff — the pure core of the reactive runtime (FC/IS).
//
// `diffDeps` is a pure function over dependency-key sets: given the keys a
// computation was subscribed to (`prev`) and the dependencies it read on its
// latest run (`next`), it returns which subscriptions to add, remove, and
// keep. The imperative shell (`reactive.ts`) executes the plan against a
// `WatcherTable`. Mirrors `@kyneta/index`'s pure `integrate` + imperative
// wiring split, and `@kyneta/machine`'s `Program.update` + runtime.
//
// Note on ordering: the runtime does NOT need a topological `flushOrder`.
// Reads are pull-on-read — reading a dirty dependency recomputes it first —
// so cross-dependency (DAG) glitch-freedom falls out without an explicit
// schedule. A per-flush epoch guard prevents double-recompute. See
// `reactive.ts`.

import type { Dependency } from "@kyneta/schema"

/**
 * The subscription delta between two dependency sets.
 *
 * - `add` — dependencies present in `next` but not `prev` (subscribe these).
 * - `remove` — keys present in `prev` but not `next` (unsubscribe these).
 * - `keep` — keys present in both (leave their subscriptions intact).
 */
export interface DepDiff {
  readonly add: Dependency[]
  readonly remove: string[]
  readonly keep: string[]
}

/**
 * Compute the subscription delta between the currently-subscribed keys
 * (`prev`) and the freshly-read dependencies (`next`).
 *
 * `next` is already deduped by key (`withReadScope` dedups), so each key
 * appears once. Pure — no subscriptions touched here.
 */
export function diffDeps(
  prev: ReadonlySet<string>,
  next: readonly Dependency[],
): DepDiff {
  const add: Dependency[] = []
  const keep: string[] = []
  const nextKeys = new Set<string>()

  for (const dep of next) {
    nextKeys.add(dep.key)
    if (prev.has(dep.key)) keep.push(dep.key)
    else add.push(dep)
  }

  const remove: string[] = []
  for (const key of prev) {
    if (!nextKeys.has(key)) remove.push(key)
  }

  return { add, remove, keep }
}

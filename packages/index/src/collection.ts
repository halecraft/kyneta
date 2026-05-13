// collection — the ℐ (integration) operator.
//
// Dual-weight rationale: raw ZSet multiplicity (`weight`) is tracked
// alongside the value map. Transitions emit only on clamped-weight boundaries
// (`0 ↔ positive`). Required so operators that can produce weight > 1
// (`union` with overlapping keys, non-injective `map`, `flatMap` with custom
// colliding `keyFn`) compose correctly — partial retraction decrements
// refcount instead of dropping the entry. See
// `experimental/perspective/LEARNINGS.md` (lines 764–780) for the same fix
// in a different package.

import type { ReactiveMap } from "@kyneta/changefeed"
import { createReactiveMap } from "@kyneta/changefeed"
import type { Source, SourceEvent } from "./source.js"
import type { ZSet } from "./zset.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CollectionChange =
  | { readonly type: "added"; readonly key: string }
  | { readonly type: "removed"; readonly key: string }

export type Collection<V> = ReactiveMap<string, V, CollectionChange> & {
  dispose(): void
}

// ---------------------------------------------------------------------------
// Functional core — pure `integrate`
// ---------------------------------------------------------------------------

export interface IntegrationStep<V> {
  readonly weights: ZSet
  readonly valueUpdates: ReadonlyMap<string, V>
  readonly valueDeletes: readonly string[]
  readonly transitions: readonly CollectionChange[]
}

/**
 * Transition rules:
 *   - `0 → positive`: emit `added`, write value.
 *   - `positive → 0`: emit `removed`, delete value.
 *   - `positive → positive` with positive delta: refresh value, no emission.
 *   - Otherwise: no emission, no value change.
 */
export function integrate<V>(
  weights: ZSet,
  event: SourceEvent<V>,
): IntegrationStep<V> {
  const nextWeights = new Map(weights)
  const valueUpdates = new Map<string, V>()
  const valueDeletes: string[] = []
  const removed: CollectionChange[] = []
  const added: CollectionChange[] = []

  for (const [key, delta] of event.delta) {
    const prev = nextWeights.get(key) ?? 0
    const next = prev + delta

    if (next === 0) {
      nextWeights.delete(key)
    } else {
      nextWeights.set(key, next)
    }

    const wasPresent = prev > 0
    const nowPresent = next > 0

    if (!wasPresent && nowPresent) {
      const value = event.values.get(key)
      if (value !== undefined) valueUpdates.set(key, value)
      added.push({ type: "added", key })
    } else if (wasPresent && !nowPresent) {
      valueDeletes.push(key)
      removed.push({ type: "removed", key })
    } else if (nowPresent && delta > 0) {
      const value = event.values.get(key)
      if (value !== undefined) valueUpdates.set(key, value)
    }
  }

  // Removals before additions: subscribers observing a regroup delta see the
  // entry leave its old group before joining the new one.
  return {
    weights: nextWeights,
    valueUpdates,
    valueDeletes,
    transitions: [...removed, ...added],
  }
}

// ---------------------------------------------------------------------------
// Collection.from — the single constructor
// ---------------------------------------------------------------------------

function from<V>(source: Source<V>): Collection<V> {
  // `any` here avoids TS2589 deep-instantiation errors with `createReactiveMap`'s
  // generic propagation; the outer cast restores `V`.
  const [map, mapHandle] = createReactiveMap<string, any, CollectionChange>()

  let weights: ZSet = new Map()

  // Bootstrap via snapshotZSet (not snapshot) so multiplicity from overlapping
  // upstreams flows into the initial weight map.
  const seeded = integrate<V>(weights, source.snapshotZSet())
  weights = seeded.weights
  for (const [k, v] of seeded.valueUpdates) mapHandle.set(k, v)
  for (const k of seeded.valueDeletes) mapHandle.delete(k)
  // Bootstrap does not emit: no subscribers can be attached yet, and the
  // materialized state is already correct.

  const unsub = source.subscribe(event => {
    const step = integrate<V>(weights, event)
    weights = step.weights

    for (const [k, v] of step.valueUpdates) mapHandle.set(k, v)
    for (const k of step.valueDeletes) mapHandle.delete(k)

    if (step.transitions.length > 0) {
      mapHandle.emit({ changes: [...step.transitions] })
    }
  })

  const collection = map as any
  collection.dispose = (): void => {
    unsub()
    source.dispose()
  }

  return collection as Collection<V>
}

// ---------------------------------------------------------------------------
// Collection namespace
// ---------------------------------------------------------------------------

export interface CollectionStatic {
  from<V>(source: Source<V>): Collection<V>
}

export const Collection: CollectionStatic = { from } as CollectionStatic

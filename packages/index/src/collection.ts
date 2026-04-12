// collection — the ℐ (integration) operator.
//
// A Collection<V> integrates a Source<V> stream into accumulated state.
// It is a ReactiveMap<string, V, CollectionChange> — a callable changefeed
// with `.get()`, `.has()`, `.keys()`, `.size`, iteration, `.subscribe()`,
// `.current`, and `[CHANGEFEED]`.
//
// `Collection.from(source)` is the single constructor.

import type { ReactiveMap } from "@kyneta/changefeed"
import { createReactiveMap } from "@kyneta/changefeed"
import type { Source } from "./source.js"
import { toAdded, toRemoved } from "./zset.js"

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
// Collection.from — the single constructor
// ---------------------------------------------------------------------------

function from<V>(source: Source<V>): Collection<V> {
  // Use `any` for the value parameter to avoid TS2589 deep instantiation
  const [map, mapHandle] = createReactiveMap<string, any, CollectionChange>()

  // Bootstrap from source snapshot (ℐ at t=0)
  const snapshot = source.snapshot()
  for (const [key, value] of snapshot) {
    mapHandle.set(key, value)
  }

  // Subscribe to source deltas
  const unsub = source.subscribe((event) => {
    const changes: CollectionChange[] = []

    // Apply removals first (so that a paired remove+add for the same key works)
    for (const key of toRemoved(event.delta)) {
      if (mapHandle.delete(key)) {
        changes.push({ type: "removed", key })
      }
    }

    // Apply additions
    for (const key of toAdded(event.delta)) {
      const value = event.values.get(key)
      if (value !== undefined) {
        const isNew = !map.has(key)
        mapHandle.set(key, value)
        if (isNew) {
          changes.push({ type: "added", key })
        }
      }
    }

    if (changes.length > 0) {
      mapHandle.emit({ changes })
    }
  })

  // Attach dispose
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
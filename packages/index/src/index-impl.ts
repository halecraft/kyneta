// index-impl — the Gₚ (grouping) operator.
//
// DBSP proves that grouping is linear: ΔGₚ = Gₚ. Structural membership
// changes from the Collection changefeed route directly through the
// partitioning function. Per-entry FK watchers (via KeySpec.watch)
// extend the model for reactive mutable refs.
//
// `get(groupKey)` returns a ReactiveMap scoped to a single group —
// the ℤ-set integration operator applied to a filtered stream of
// group deltas. This is the primary API for accessing group contents.

import type { Changefeed, ChangefeedProtocol, Changeset, ReactiveMap } from "@kyneta/changefeed"
import { CHANGEFEED, createReactiveMap } from "@kyneta/changefeed"
import type { Collection, CollectionChange } from "./collection.js"
import type { KeySpec } from "./key-spec.js"
import { add, negate, fromKeys, isEmpty } from "./zset.js"
import type { ZSet } from "./zset.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type IndexChange =
  | { readonly type: "group-added"; readonly groupKey: string; readonly entryKey: string }
  | { readonly type: "group-removed"; readonly groupKey: string; readonly entryKey: string }

export interface SecondaryIndex<V> extends Changefeed<ReadonlyMap<string, Set<string>>, IndexChange> {
  /** Reactive view of a single group. Returns a ReactiveMap that updates as entries join/leave. */
  get(groupKey: string): ReactiveMap<string, V, IndexChange>
  /** Which group keys an entry belongs to. */
  groupKeysFor(entryKey: string): string[]
  /** All distinct group keys. */
  keys(): string[]
  /** Count of distinct group keys. */
  readonly size: number
  /** Tear down all subscriptions. */
  dispose(): void
}

// ---------------------------------------------------------------------------
// regroupDelta — functional core (pure)
// ---------------------------------------------------------------------------

function regroupDelta(oldKeys: string[], newKeys: string[]): ZSet {
  return add(fromKeys(newKeys), negate(fromKeys(oldKeys)))
}

// ---------------------------------------------------------------------------
// Index.by — the single constructor
// ---------------------------------------------------------------------------

function by<V>(collection: Collection<V>, keySpec?: KeySpec<V>): SecondaryIndex<V> {
  // Default to identity grouping if no keySpec provided
  const spec: KeySpec<V> = keySpec ?? {
    groupKeys: (key: string, _value: V) => [key],
  }

  // groupKey → set of entryKeys
  const groups = new Map<string, Set<string>>()
  // entryKey → current list of groupKeys
  const entryGroups = new Map<string, string[]>()
  // entryKey → watcher unsubscribe
  const entryUnsubs = new Map<string, () => void>()
  // Subscribers for the index-level changefeed
  const subscribers = new Set<(changeset: Changeset<IndexChange>) => void>()
  // Track derived group views for cleanup on dispose
  const derivedUnsubs = new Set<() => void>()

  function emit(changeset: Changeset<IndexChange>): void {
    for (const cb of subscribers) {
      cb(changeset)
    }
  }

  function addToGroup(groupKey: string, entryKey: string): void {
    let set = groups.get(groupKey)
    if (!set) {
      set = new Set()
      groups.set(groupKey, set)
    }
    set.add(entryKey)
  }

  function removeFromGroup(groupKey: string, entryKey: string): void {
    const set = groups.get(groupKey)
    if (!set) return
    set.delete(entryKey)
    if (set.size === 0) {
      groups.delete(groupKey)
    }
  }

  function addEntry(entryKey: string, value: V): IndexChange[] {
    const groupKeys = spec.groupKeys(entryKey, value)
    entryGroups.set(entryKey, groupKeys)

    const changes: IndexChange[] = []
    for (const gk of groupKeys) {
      addToGroup(gk, entryKey)
      changes.push({ type: "group-added", groupKey: gk, entryKey })
    }

    // Install per-entry watcher if provided
    if (spec.watch) {
      const unsub = spec.watch(entryKey, value, () => {
        handleRegroup(entryKey, value)
      })
      entryUnsubs.set(entryKey, unsub)
    }

    return changes
  }

  function removeEntry(entryKey: string): IndexChange[] {
    const oldKeys = entryGroups.get(entryKey) ?? []
    entryGroups.delete(entryKey)

    const changes: IndexChange[] = []
    for (const gk of oldKeys) {
      removeFromGroup(gk, entryKey)
      changes.push({ type: "group-removed", groupKey: gk, entryKey })
    }

    // Unsubscribe per-entry watcher
    const unsub = entryUnsubs.get(entryKey)
    if (unsub) {
      unsub()
      entryUnsubs.delete(entryKey)
    }

    return changes
  }

  function handleRegroup(entryKey: string, value: V): void {
    const oldKeys = entryGroups.get(entryKey) ?? []
    const newKeys = spec.groupKeys(entryKey, value)

    // Use regroupDelta (FC) to compute the ZSet diff
    const delta = regroupDelta(oldKeys, newKeys)
    if (isEmpty(delta)) return

    // Apply structural changes — removals first, then additions
    const changes: IndexChange[] = []
    for (const [gk, weight] of delta) {
      if (weight < 0) {
        removeFromGroup(gk, entryKey)
        changes.push({ type: "group-removed", groupKey: gk, entryKey })
      }
    }
    for (const [gk, weight] of delta) {
      if (weight > 0) {
        addToGroup(gk, entryKey)
        changes.push({ type: "group-added", groupKey: gk, entryKey })
      }
    }
    entryGroups.set(entryKey, newKeys)

    if (changes.length > 0) {
      emit({ changes })
    }
  }

  // Bootstrap: index all existing collection entries
  for (const [entryKey, value] of collection as any) {
    addEntry(entryKey, value)
  }

  // Subscribe to collection changefeed for added/removed events
  const collectionUnsub = collection.subscribe((changeset: Changeset<CollectionChange>) => {
    const indexChanges: IndexChange[] = []

    for (const change of changeset.changes) {
      if (change.type === "added") {
        const value = (collection as any).get(change.key)
        if (value !== undefined) {
          indexChanges.push(...addEntry(change.key, value))
        }
      } else if (change.type === "removed") {
        indexChanges.push(...removeEntry(change.key))
      }
    }

    if (indexChanges.length > 0) {
      emit({ changes: indexChanges })
    }
  })

  // Build the changefeed protocol for the index-level changefeed
  const protocol: ChangefeedProtocol<ReadonlyMap<string, Set<string>>, IndexChange> = {
    get current(): ReadonlyMap<string, Set<string>> {
      return groups
    },
    subscribe(callback: (changeset: Changeset<IndexChange>) => void): () => void {
      subscribers.add(callback)
      return () => { subscribers.delete(callback) }
    },
  }

  // Build the index object
  const index: SecondaryIndex<V> = {
    [CHANGEFEED]: protocol,

    get current(): ReadonlyMap<string, Set<string>> {
      return groups
    },

    subscribe(cb: (changeset: Changeset<IndexChange>) => void): () => void {
      subscribers.add(cb)
      return () => { subscribers.delete(cb) }
    },

    get(groupKey: string): ReactiveMap<string, V, IndexChange> {
      const [map, mapHandle] = createReactiveMap<string, any, IndexChange>()

      // Bootstrap from current group state
      const entryKeys = groups.get(groupKey)
      if (entryKeys) {
        for (const entryKey of entryKeys) {
          const value = (collection as any).get(entryKey)
          if (value !== undefined) {
            mapHandle.set(entryKey, value)
          }
        }
      }

      // Subscribe to the parent index changefeed, filtered by groupKey
      const unsub = index.subscribe((changeset: Changeset<IndexChange>) => {
        const filtered: IndexChange[] = []
        for (const change of changeset.changes) {
          if (change.groupKey !== groupKey) continue
          if (change.type === "group-added") {
            const value = (collection as any).get(change.entryKey)
            if (value !== undefined) {
              mapHandle.set(change.entryKey, value)
              filtered.push(change)
            }
          } else if (change.type === "group-removed") {
            if (mapHandle.delete(change.entryKey)) {
              filtered.push(change)
            }
          }
        }
        if (filtered.length > 0) {
          mapHandle.emit({ changes: filtered })
        }
      })

      // Track for cleanup on parent dispose
      derivedUnsubs.add(unsub)

      return map as ReactiveMap<string, V, IndexChange>
    },

    groupKeysFor(entryKey: string): string[] {
      return entryGroups.get(entryKey) ?? []
    },

    keys(): string[] {
      return [...groups.keys()]
    },

    get size(): number {
      return groups.size
    },

    dispose(): void {
      collectionUnsub()
      for (const unsub of entryUnsubs.values()) {
        unsub()
      }
      entryUnsubs.clear()
      // Tear down all derived group views
      for (const unsub of derivedUnsubs) {
        unsub()
      }
      derivedUnsubs.clear()
    },
  }

  return index
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export { by }
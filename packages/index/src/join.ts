// join — the bilinear operator composing two secondary indexes.
//
// A JoinIndex<L, R> bridges two SecondaryIndex instances that share
// a common group-key space.
//
// `get(leftKey)` and `reverse(rightKey)` return ReactiveMap instances
// that maintain themselves as underlying indexes change.

import type {
  Changefeed,
  ChangefeedProtocol,
  Changeset,
  ReactiveMap,
} from "@kyneta/changefeed"
import { CHANGEFEED, createReactiveMap } from "@kyneta/changefeed"
import type { IndexChange, SecondaryIndex } from "./index-impl.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface JoinIndex<L, R> extends Changefeed<null, IndexChange> {
  /** Traverse left → right: reactive map of right-side entries for a left key. */
  get(leftKey: string): ReactiveMap<string, R, IndexChange>
  /** Traverse right → left: reactive map of left-side entries for a right key. */
  reverse(rightKey: string): ReactiveMap<string, L, IndexChange>
  /** Dispose both underlying indexes and tear down all subscriptions. */
  dispose(): void
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function join<L, R>(
  leftIndex: SecondaryIndex<L>,
  rightIndex: SecondaryIndex<R>,
): JoinIndex<L, R> {
  const subscribers = new Set<(changeset: Changeset<IndexChange>) => void>()
  const derivedUnsubs = new Set<() => void>()

  function emit(changeset: Changeset<IndexChange>): void {
    for (const cb of subscribers) {
      cb(changeset)
    }
  }

  const unsubLeft = leftIndex.subscribe((cs: Changeset<IndexChange>) => {
    emit(cs)
  })

  const unsubRight = rightIndex.subscribe((cs: Changeset<IndexChange>) => {
    emit(cs)
  })

  // Helper: build a reactive map by traversing from one index to another
  function createTraversalView<V>(
    fromIndex: SecondaryIndex<any>,
    toIndex: SecondaryIndex<V>,
    key: string,
  ): ReactiveMap<string, V, IndexChange> {
    const [map, mapHandle] = createReactiveMap<string, any, IndexChange>()

    // Bootstrap: key → group keys via fromIndex → entries via toIndex
    function rebuild(): void {
      const oldKeys = new Set(map.keys())
      const groupKeys = fromIndex.groupKeysFor(key)
      const newEntries = new Map<string, V>()
      for (const gk of groupKeys) {
        const groupMap = toIndex.get(gk)
        for (const [entryKey, value] of groupMap) {
          newEntries.set(entryKey, value)
        }
      }

      const changes: IndexChange[] = []

      // Remove entries no longer present
      for (const oldKey of oldKeys) {
        if (!newEntries.has(oldKey)) {
          mapHandle.delete(oldKey)
          changes.push({
            type: "group-removed",
            groupKey: key,
            entryKey: oldKey,
          })
        }
      }

      // Add new entries
      for (const [entryKey, value] of newEntries) {
        if (!oldKeys.has(entryKey)) {
          mapHandle.set(entryKey, value)
          changes.push({ type: "group-added", groupKey: key, entryKey })
        }
      }

      if (changes.length > 0) {
        mapHandle.emit({ changes })
      }
    }

    // Initial bootstrap
    const groupKeys = fromIndex.groupKeysFor(key)
    for (const gk of groupKeys) {
      const groupMap = toIndex.get(gk)
      for (const [entryKey, value] of groupMap) {
        mapHandle.set(entryKey, value)
      }
    }

    // Subscribe to both indexes — rebuild on any change that might affect us
    const unsubFrom = fromIndex.subscribe(() => {
      rebuild()
    })
    const unsubTo = toIndex.subscribe(() => {
      rebuild()
    })

    derivedUnsubs.add(unsubFrom)
    derivedUnsubs.add(unsubTo)

    return map as ReactiveMap<string, V, IndexChange>
  }

  // Build changefeed protocol
  const protocol: ChangefeedProtocol<null, IndexChange> = {
    get current(): null {
      return null
    },
    subscribe(
      callback: (changeset: Changeset<IndexChange>) => void,
    ): () => void {
      subscribers.add(callback)
      return () => {
        subscribers.delete(callback)
      }
    },
  }

  const joinIndex: JoinIndex<L, R> = {
    [CHANGEFEED]: protocol,

    get current(): null {
      return null
    },

    subscribe(cb: (changeset: Changeset<IndexChange>) => void): () => void {
      subscribers.add(cb)
      return () => {
        subscribers.delete(cb)
      }
    },

    get(leftKey: string): ReactiveMap<string, R, IndexChange> {
      return createTraversalView<R>(leftIndex, rightIndex, leftKey)
    },

    reverse(rightKey: string): ReactiveMap<string, L, IndexChange> {
      return createTraversalView<L>(rightIndex, leftIndex, rightKey)
    },

    dispose(): void {
      unsubLeft()
      unsubRight()
      for (const unsub of derivedUnsubs) {
        unsub()
      }
      derivedUnsubs.clear()
      leftIndex.dispose()
      rightIndex.dispose()
    },
  }

  return joinIndex
}

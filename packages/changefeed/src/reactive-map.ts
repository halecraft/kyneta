// reactive-map — a callable changefeed over a mutable Map.
//
// ReactiveMap<K, V, C> is a CallableChangefeed<ReadonlyMap<K, V>, C>
// with lifted collection accessors (.get, .has, .keys, .size, iteration).
// The handle provides raw map mutations (set, delete, clear) without
// automatic emission — the consumer decides when and what to emit.
//
// This extracts the recurring pattern of "callable changefeed over a
// ReadonlyMap with convenience accessors" (used by exchange.peers,
// exchange.documents and every @kyneta/index Collection) into a single
// combinator.

import { cachedSnapshot } from "./cached-snapshot.js"
import type { CallableChangefeed } from "./callable.js"
import { createCallable } from "./callable.js"
import type { ChangeBase } from "./change.js"
import type { Changeset } from "./changefeed.js"
import { createChangefeed } from "./changefeed.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A callable changefeed over a `ReadonlyMap<K, V>` with lifted
 * collection accessors.
 *
 * `reactiveMap()`, `.current` and the protocol's `current` all return one
 * **snapshot**: a copy of the map, the same `Map` instance until the map is
 * mutated and a new one after. So external-store consumers (e.g.
 * `useSyncExternalStore`) detect a change by identity alone, and a render
 * that changed nothing keeps its value. A `Map` cannot be frozen; the
 * snapshot's immutability rests on the `ReadonlyMap` type.
 *
 * `.get()`, `.has()`, `.keys()`, `.size`, and `[Symbol.iterator]()` read the
 * live internal map, which the snapshot always agrees with — no need to
 * unwrap `.current` first.
 *
 * Extends `CallableChangefeed` — assignable anywhere a
 * `CallableChangefeed<ReadonlyMap<K, V>, C>` or `Changefeed` is expected.
 */
export interface ReactiveMap<K, V, C extends ChangeBase = ChangeBase>
  extends CallableChangefeed<ReadonlyMap<K, V>, C> {
  /** Get the value for a key, or `undefined` if absent. */
  get(key: K): V | undefined
  /** Whether the map contains a key. */
  has(key: K): boolean
  /** An iterator over all keys. */
  keys(): IterableIterator<K>
  /** The number of entries. */
  readonly size: number
  /** Iterate over `[key, value]` pairs. */
  [Symbol.iterator](): IterableIterator<[K, V]>
}

/**
 * The producer-side handle for a `ReactiveMap`.
 *
 * Provides raw map mutations (`set`, `delete`, `clear`) that modify
 * the internal map **without** emitting changes. Call `emit()` with
 * the appropriate changeset after mutations are complete.
 *
 * This separation lets the consumer batch mutations and emit a single
 * changeset — e.g. `clear()` → N × `set()` → one `emit()`.
 */
export interface ReactiveMapHandle<K, V, C extends ChangeBase> {
  /** Insert or overwrite an entry. Does NOT emit. */
  set(key: K, value: V): void
  /** Remove an entry. Returns `true` if the key was present. Does NOT emit. */
  delete(key: K): boolean
  /** Remove all entries. Does NOT emit. */
  clear(): void
  /** Push a changeset to all subscribers. */
  emit(changeset: Changeset<C>): void
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a `ReactiveMap<K, V, C>` and its producer-side handle.
 *
 * The reactive map owns its internal `Map<K, V>`. Consumers read via
 * the `ReactiveMap` surface (call signature, `.get()`, `.has()`, etc.).
 * Producers mutate via the `ReactiveMapHandle` (`set`, `delete`,
 * `clear`) and push notifications via `emit`.
 *
 * ```ts
 * const [peers, handle] = createReactiveMap<PeerId, PeerInfo, PeerChange>()
 *
 * handle.set("alice", aliceInfo)
 * handle.emit({ changes: [{ type: "peer-joined", peer: aliceInfo }] })
 *
 * peers()          // ReadonlyMap snapshot, the same until the map changes
 * peers.current    // the same snapshot
 * peers.get("alice")  // aliceInfo (reads live map)
 * peers.size       // 1
 * ```
 */
export function createReactiveMap<K, V, C extends ChangeBase = ChangeBase>(): [
  ReactiveMap<K, V, C>,
  ReactiveMapHandle<K, V, C>,
] {
  const map = new Map<K, V>()

  // One snapshot, dropped by every handle mutation. Dropping on mutation
  // rather than on `emit` keeps it coherent with the lifted accessors
  // between a `set` and the `emit` that announces it.
  const snapshot = cachedSnapshot<ReadonlyMap<K, V>>(() => new Map(map))

  const [feed, emit] = createChangefeed<ReadonlyMap<K, V>, C>(snapshot.get)

  // The map's own accessors read the live map, so they see a `set` before the
  // `emit` that announces it, as the snapshot does.
  const reactiveMap = Object.defineProperties(createCallable(feed), {
    get: { value: (key: K): V | undefined => map.get(key), enumerable: true },
    has: { value: (key: K): boolean => map.has(key), enumerable: true },
    keys: { value: (): IterableIterator<K> => map.keys(), enumerable: true },
    size: { get: (): number => map.size, enumerable: true },
    [Symbol.iterator]: {
      value: (): IterableIterator<[K, V]> => map[Symbol.iterator](),
      enumerable: true,
    },
  }) as ReactiveMap<K, V, C>

  // ── Handle (producer side) ──

  const handle: ReactiveMapHandle<K, V, C> = {
    set(key: K, value: V): void {
      map.set(key, value)
      snapshot.invalidate()
    },
    delete(key: K): boolean {
      const removed = map.delete(key)
      if (removed) snapshot.invalidate()
      return removed
    },
    clear(): void {
      if (map.size > 0) snapshot.invalidate()
      map.clear()
    },
    emit,
  }

  return [reactiveMap, handle]
}

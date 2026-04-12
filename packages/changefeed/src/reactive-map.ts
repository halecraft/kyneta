// reactive-map — a callable changefeed over a mutable Map.
//
// ReactiveMap<K, V, C> is a CallableChangefeed<ReadonlyMap<K, V>, C>
// with lifted collection accessors (.get, .has, .keys, .size, iteration).
// The handle provides raw map mutations (set, delete, clear) without
// automatic emission — the consumer decides when and what to emit.
//
// This extracts the recurring pattern of "callable changefeed over a
// ReadonlyMap with convenience accessors" (used by exchange.peers,
// Catalog, and future reactive collections) into a single combinator.

import type { ChangeBase } from "./change.js"
import type { CallableChangefeed } from "./callable.js"
import type { Changefeed, ChangefeedProtocol, Changeset } from "./changefeed.js"
import { CHANGEFEED, createChangefeed } from "./changefeed.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A callable changefeed over a `ReadonlyMap<K, V>` with lifted
 * collection accessors.
 *
 * `reactiveMap()` returns the current `ReadonlyMap<K, V>`.
 * `.get()`, `.has()`, `.keys()`, `.size`, and `[Symbol.iterator]()`
 * delegate to the internal map — no need to unwrap `.current` first.
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
 * peers()          // ReadonlyMap with one entry
 * peers.get("alice")  // aliceInfo
 * peers.size       // 1
 * ```
 */
export function createReactiveMap<
  K,
  V,
  C extends ChangeBase = ChangeBase,
>(): [ReactiveMap<K, V, C>, ReactiveMapHandle<K, V, C>] {
  const map = new Map<K, V>()

  // Create the base changefeed + emit pair.
  // The thunk reads the same Map instance — never reassigned.
  const [feed, emit] = createChangefeed<ReadonlyMap<K, V>, C>(() => map)

  // Build the callable function-object.
  // We construct it manually (rather than using createCallable) so we
  // can attach the collection accessors in one pass.
  const callable: any = () => map as ReadonlyMap<K, V>

  // ── Changefeed protocol ──

  Object.defineProperty(callable, CHANGEFEED, {
    get(): ChangefeedProtocol<ReadonlyMap<K, V>, C> {
      return feed[CHANGEFEED]
    },
    enumerable: false,
    configurable: false,
  })

  Object.defineProperty(callable, "current", {
    get(): ReadonlyMap<K, V> {
      return map
    },
    enumerable: true,
    configurable: false,
  })

  callable.subscribe = (
    callback: (changeset: Changeset<C>) => void,
  ): (() => void) => {
    return feed.subscribe(callback)
  }

  // ── Lifted collection accessors ──

  callable.get = (key: K): V | undefined => map.get(key)
  callable.has = (key: K): boolean => map.has(key)
  callable.keys = (): IterableIterator<K> => map.keys()

  Object.defineProperty(callable, "size", {
    get(): number {
      return map.size
    },
    enumerable: true,
    configurable: false,
  })

  callable[Symbol.iterator] = (): IterableIterator<[K, V]> => map[Symbol.iterator]()

  // ── Handle (producer side) ──

  const handle: ReactiveMapHandle<K, V, C> = {
    set(key: K, value: V): void {
      map.set(key, value)
    },
    delete(key: K): boolean {
      return map.delete(key)
    },
    clear(): void {
      map.clear()
    },
    emit,
  }

  return [callable as ReactiveMap<K, V, C>, handle]
}
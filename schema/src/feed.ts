// Feed — the unified reactive protocol.
//
// A feed is a reactive value with a head (current state) and a tail
// (a stream of actions describing future changes). You read the head
// to see what's there now; you subscribe to the tail to learn what
// changes next.
//
// The feed protocol is expressed through a single symbol: FEED.
// This replaces the previous two-symbol design (SNAPSHOT + REACTIVE).

import type { ActionBase } from "./action.js"

// ---------------------------------------------------------------------------
// Symbol
// ---------------------------------------------------------------------------

/**
 * The single symbol that marks a value as a feed. Accessing `obj[FEED]`
 * yields a `Feed<S, A>` — the head (current value) and tail (action stream).
 *
 * Uses `Symbol.for` so that multiple copies of this module (e.g. in
 * different bundle chunks) share the same symbol identity.
 */
export const FEED: unique symbol = Symbol.for("kinetic:feed") as any

// ---------------------------------------------------------------------------
// Core interfaces
// ---------------------------------------------------------------------------

/**
 * A feed is a coalgebra: head gives the current state, subscribe gives
 * the stream of future changes (actions). In automata-theory terms this
 * is a Moore machine with a push-based transition stream.
 *
 * Properties:
 * - `head` is a getter — always returns the live current value
 * - `subscribe` returns an unsubscribe function
 * - Static (non-reactive) sources return a feed whose tail never emits:
 *   `{ head: value, subscribe: () => () => {} }`
 */
export interface Feed<S, A extends ActionBase = ActionBase> {
  /** The head — current value, always live (a getter). */
  readonly head: S
  /** The tail — subscribe to actions as they flow. Returns an unsubscribe function. */
  subscribe(callback: (action: A) => void): () => void
}

/**
 * An object that carries a feed under the `[FEED]` symbol.
 *
 * Any ref, interpreted node, or enriched value can implement this
 * interface to participate in the reactive protocol.
 */
export interface Feedable<S = unknown, A extends ActionBase = ActionBase> {
  readonly [FEED]: Feed<S, A>
}

// ---------------------------------------------------------------------------
// WeakMap-based caching
// ---------------------------------------------------------------------------

/**
 * Module-scoped WeakMap that caches Feed instances per object reference.
 *
 * Properties:
 * - No per-instance allocation at construction time
 * - Feed created lazily on first access
 * - Referential identity: `ref[FEED] === ref[FEED]`
 * - GC-safe: WeakMap entry disappears when ref is collected
 */
const feeds = new WeakMap<object, Feed<any, any>>()

/**
 * Returns the cached feed for `ref`, or creates one via `factory` and caches it.
 *
 * Usage (on a ref class prototype):
 * ```ts
 * get [FEED](): Feed<S, A> {
 *   return getOrCreateFeed(this, () => ({
 *     get head() { return readCurrentValue(self) },
 *     subscribe: (cb) => subscribeToChanges(self, cb),
 *   }))
 * }
 * ```
 */
export function getOrCreateFeed<S, A extends ActionBase>(
  ref: object,
  factory: () => Feed<S, A>,
): Feed<S, A> {
  let feed = feeds.get(ref) as Feed<S, A> | undefined
  if (!feed) {
    feed = factory()
    feeds.set(ref, feed)
  }
  return feed
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

/**
 * Returns `true` if `value` has a `[FEED]` property, i.e. it implements
 * the `Feedable` interface.
 */
export function isFeedable<S = unknown, A extends ActionBase = ActionBase>(
  value: unknown,
): value is Feedable<S, A> {
  return (
    value !== null &&
    value !== undefined &&
    typeof value === "object" &&
    FEED in (value as object)
  )
}

// ---------------------------------------------------------------------------
// Static feed helper
// ---------------------------------------------------------------------------

/**
 * Creates a feed that never emits actions — useful for static/non-reactive
 * data sources that still need to participate in the feed protocol.
 */
export function staticFeed<S>(head: S): Feed<S, never> {
  return {
    get head() {
      return head
    },
    subscribe() {
      return () => {}
    },
  }
}
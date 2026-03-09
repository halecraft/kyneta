// Changefeed — the unified reactive protocol.
//
// A changefeed is a reactive value with a current state and a stream
// of future changes. You read `current` to see what's there now;
// you subscribe to learn what changes next.
//
// The changefeed protocol is expressed through a single symbol: CHANGEFEED.
// This replaces the previous two-symbol design (SNAPSHOT + REACTIVE).

import type { ChangeBase } from "./change.js"

// ---------------------------------------------------------------------------
// Symbol
// ---------------------------------------------------------------------------

/**
 * The single symbol that marks a value as a changefeed. Accessing
 * `obj[CHANGEFEED]` yields a `Changefeed<S, C>` — the current value
 * and a stream of future changes.
 *
 * Uses `Symbol.for` so that multiple copies of this module (e.g. in
 * different bundle chunks) share the same symbol identity.
 */
export const CHANGEFEED: unique symbol = Symbol.for("kinetic:changefeed") as any

// ---------------------------------------------------------------------------
// Core interfaces
// ---------------------------------------------------------------------------

/**
 * A changefeed is a coalgebra: `current` gives the live state,
 * `subscribe` gives the stream of future changes. In automata-theory
 * terms this is a Moore machine with a push-based transition stream.
 *
 * Properties:
 * - `current` is a getter — always returns the live current value
 * - `subscribe` returns an unsubscribe function
 * - Static (non-reactive) sources return a changefeed whose tail never emits:
 *   `{ current: value, subscribe: () => () => {} }`
 */
export interface Changefeed<S, C extends ChangeBase = ChangeBase> {
  /** The current value, always live (a getter). */
  readonly current: S
  /** Subscribe to future changes. Returns an unsubscribe function. */
  subscribe(callback: (change: C) => void): () => void
}

/**
 * An object that carries a changefeed under the `[CHANGEFEED]` symbol.
 *
 * Any ref, interpreted node, or enriched value can implement this
 * interface to participate in the reactive protocol.
 */
export interface HasChangefeed<S = unknown, A extends ChangeBase = ChangeBase> {
  readonly [CHANGEFEED]: Changefeed<S, A>
}

// ---------------------------------------------------------------------------
// WeakMap-based caching
// ---------------------------------------------------------------------------

/**
 * Module-scoped WeakMap that caches Changefeed instances per object reference.
 *
 * Properties:
 * - No per-instance allocation at construction time
 * - Changefeed created lazily on first access
 * - Referential identity: `ref[CHANGEFEED] === ref[CHANGEFEED]`
 * - GC-safe: WeakMap entry disappears when ref is collected
 */
const changefeeds = new WeakMap<object, Changefeed<any, any>>()

/**
 * Returns the cached changefeed for `ref`, or creates one via `factory`
 * and caches it.
 *
 * Usage (on a ref class prototype):
 * ```ts
 * get [CHANGEFEED](): Changefeed<S, C> {
 *   return getOrCreateChangefeed(this, () => ({
 *     get current() { return readCurrentValue(self) },
 *     subscribe: (cb) => subscribeToChanges(self, cb),
 *   }))
 * }
 * ```
 */
export function getOrCreateChangefeed<S, A extends ChangeBase>(
  ref: object,
  factory: () => Changefeed<S, A>,
): Changefeed<S, A> {
  let cf = changefeeds.get(ref) as Changefeed<S, A> | undefined
  if (!cf) {
    cf = factory()
    changefeeds.set(ref, cf)
  }
  return cf
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

/**
 * Returns `true` if `value` has a `[CHANGEFEED]` property, i.e. it
 * implements the `HasChangefeed` interface.
 */
export function hasChangefeed<S = unknown, A extends ChangeBase = ChangeBase>(
  value: unknown,
): value is HasChangefeed<S, A> {
  return (
    value !== null &&
    value !== undefined &&
    typeof value === "object" &&
    CHANGEFEED in (value as object)
  )
}

// ---------------------------------------------------------------------------
// Static feed helper
// ---------------------------------------------------------------------------

/**
 * Creates a changefeed that never emits changes — useful for static/
 * non-reactive data sources that still need to participate in the
 * changefeed protocol.
 */
export function staticChangefeed<S>(head: S): Changefeed<S, never> {
  return {
    get current() {
      return head
    },
    subscribe() {
      return () => {}
    },
  }
}

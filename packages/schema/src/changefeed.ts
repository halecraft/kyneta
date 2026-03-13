// Changefeed — the unified reactive protocol.
//
// A changefeed is a reactive value with a current state and a stream
// of future changes. You read `current` to see what's there now;
// you subscribe to learn what changes next.
//
// The changefeed protocol is expressed through a single symbol: CHANGEFEED.
// This replaces the previous two-symbol design (SNAPSHOT + REACTIVE).

import type { ChangeBase } from "./change.js"
import type { Path } from "./interpret.js"

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
export const CHANGEFEED: unique symbol = Symbol.for("kyneta:changefeed") as any

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
// Compositional changefeed — tree-level observation
// ---------------------------------------------------------------------------

/**
 * A tree event carries a change together with its relative origin path.
 *
 * When a `subscribeTree` subscriber receives a `TreeEvent`, `origin`
 * is the path from the subscription point down to where the change
 * actually occurred. When the change is at the subscription point
 * itself, `origin` is `[]`.
 */
export interface TreeEvent {
  readonly origin: Path
  readonly change: ChangeBase
}

/**
 * Extension of `Changefeed` for tree-structured (composite) refs.
 *
 * `subscribe` remains node-level — it fires only for changes at this
 * node's own path (e.g., `SequenceChange` for lists, `ReplaceChange`
 * for products).
 *
 * `subscribeTree` fires for all descendant changes with relative
 * origin paths, making it a strict superset of `subscribe` (tree
 * subscribers also see own-path changes with `origin: []`).
 *
 * Only composite refs (products, sequences, maps) implement this.
 * Leaf refs (scalars, text, counters) implement plain `Changefeed`.
 */
export interface ComposedChangefeed<S, C extends ChangeBase = ChangeBase>
  extends Changefeed<S, C> {
  /** Subscribe to changes at this node and all descendants. */
  subscribeTree(callback: (event: TreeEvent) => void): () => void
}

/**
 * An object that carries a composed changefeed under the `[CHANGEFEED]`
 * symbol — i.e. a composite ref with tree-level observation.
 */
export interface HasComposedChangefeed<
  S = unknown,
  A extends ChangeBase = ChangeBase,
> {
  readonly [CHANGEFEED]: ComposedChangefeed<S, A>
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
    (typeof value === "object" || typeof value === "function") &&
    CHANGEFEED in (value as object)
  )
}

/**
 * Returns `true` if `value` has a `[CHANGEFEED]` property whose value
 * has a `subscribeTree` method — i.e. it implements `HasComposedChangefeed`.
 */
export function hasComposedChangefeed<
  S = unknown,
  A extends ChangeBase = ChangeBase,
>(value: unknown): value is HasComposedChangefeed<S, A> {
  if (!hasChangefeed(value)) return false
  const cf = value[CHANGEFEED]
  return typeof (cf as any).subscribeTree === "function"
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

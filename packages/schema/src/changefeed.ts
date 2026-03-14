// Changefeed — the unified reactive protocol.
//
// A changefeed is a reactive value with a current state and a stream
// of future changes. You read `current` to see what's there now;
// you subscribe to learn what changes next.
//
// The changefeed protocol is expressed through a single symbol: CHANGEFEED.
// This replaces the previous two-symbol design (SNAPSHOT + REACTIVE).
//
// Changes are delivered as `Changeset<C>` — a batch of one or more
// changes with optional provenance metadata. Auto-commit wraps a
// single change in a degenerate changeset of one; transactions and
// `applyChanges` deliver multi-change batches. The subscriber API
// is uniform regardless of batch size.

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
// Changeset — the unit of batch delivery
// ---------------------------------------------------------------------------

/**
 * A changeset is the unit of delivery through the changefeed protocol.
 * It wraps one or more changes with optional batch-level metadata.
 *
 * - Auto-commit produces a degenerate changeset of one change.
 * - Transactions and `applyChanges` produce multi-change batches.
 * - `origin` carries provenance for the entire batch (e.g. "sync",
 *   "undo", "local"). Individual changes do not carry provenance —
 *   the batch does.
 *
 * The subscriber API always receives a `Changeset`, making it uniform
 * regardless of how the changes were produced.
 */
export interface Changeset<C = ChangeBase> {
  /** The individual changes in this batch. */
  readonly changes: readonly C[]
  /** Provenance of the batch (e.g. "sync", "undo", "local"). */
  readonly origin?: string
}

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
 * - Subscribers receive a `Changeset<C>` — a batch of changes with
 *   optional provenance. For auto-commit (single mutation), the
 *   changeset contains exactly one change.
 * - Static (non-reactive) sources return a changefeed whose tail never emits:
 *   `{ current: value, subscribe: () => () => {} }`
 */
export interface Changefeed<S, C extends ChangeBase = ChangeBase> {
  /** The current value, always live (a getter). */
  readonly current: S
  /** Subscribe to future changes. Returns an unsubscribe function. */
  subscribe(callback: (changeset: Changeset<C>) => void): () => void
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
 * A tree event carries a change together with its relative path.
 *
 * When a `subscribeTree` subscriber receives a `TreeEvent`, `path`
 * is the path from the subscription point down to where the change
 * actually occurred. When the change is at the subscription point
 * itself, `path` is `[]`.
 *
 * Note: this field was previously named `origin`, but was renamed to
 * `path` to avoid collision with the provenance `origin` field on
 * `Changeset`.
 */
export interface TreeEvent<C extends ChangeBase = ChangeBase> {
  /** Relative path from subscription point to where the change occurred. */
  readonly path: Path
  /** The change that occurred. */
  readonly change: C
}

/**
 * Extension of `Changefeed` for tree-structured (composite) refs.
 *
 * `subscribe` remains node-level — it fires only for changes at this
 * node's own path (e.g., `SequenceChange` for lists, `ReplaceChange`
 * for products).
 *
 * `subscribeTree` fires for all descendant changes with relative
 * paths, making it a strict superset of `subscribe` (tree
 * subscribers also see own-path changes with `path: []`).
 *
 * Both `subscribe` and `subscribeTree` deliver `Changeset` batches.
 * `subscribeTree` delivers `Changeset<TreeEvent<C>>` — each entry
 * in the batch carries the relative path where the change occurred.
 *
 * Only composite refs (products, sequences, maps) implement this.
 * Leaf refs (scalars, text, counters) implement plain `Changefeed`.
 */
export interface ComposedChangefeed<S, C extends ChangeBase = ChangeBase>
  extends Changefeed<S, C> {
  /** Subscribe to changes at this node and all descendants. */
  subscribeTree(callback: (changeset: Changeset<TreeEvent<C>>) => void): () => void
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
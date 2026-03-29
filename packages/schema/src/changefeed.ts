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

import type { ChangeBase, ReplaceChange } from "./change.js"
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
// Op — the atomic unit of the delta algebra
// ---------------------------------------------------------------------------

/**
 * An addressed delta — the atomic unit of change in the delta algebra.
 *
 * Every mutation, notification, and sync payload decomposes into Ops.
 * An Op is a (Path, Change) pair: the path addresses a node in the
 * schema tree, the change describes the delta at that node.
 */
export interface Op<C extends ChangeBase = ChangeBase> {
  readonly path: Path
  readonly change: C
}

// ---------------------------------------------------------------------------
// Op transformations
// ---------------------------------------------------------------------------

/**
 * Expand container-level map ops into leaf-level replace ops.
 *
 * CRDT substrates (Loro, Yjs) fire events at container boundaries —
 * a map/struct container fires a single event with per-key diffs.
 * Kyneta's changefeed model subscribes at leaf paths. This function
 * bridges the gap: a `MapChange` at path `p` with `{ set: { k: v } }`
 * becomes a `ReplaceChange` at path `[...p, k]` with `{ value: v }`.
 *
 * Non-map ops (text, sequence, counter, tree) pass through unchanged —
 * their event paths already match their changefeed subscription paths.
 *
 * This is the right adjoint to the implicit leaf→container composition
 * that happens on the outbound path (e.g., `replaceChangeToDiff`).
 */
export function expandMapOpsToLeaves(ops: readonly Op[]): Op<ReplaceChange | ChangeBase>[] {
  const result: Op<ReplaceChange | ChangeBase>[] = []

  for (const op of ops) {
    if (op.change.type !== "map") {
      result.push(op)
      continue
    }

    const mapChange = op.change as { type: "map"; set?: Record<string, unknown>; delete?: string[] }

    if (mapChange.set) {
      for (const [key, value] of Object.entries(mapChange.set)) {
        result.push({
          path: [...op.path, { type: "key", key }],
          change: { type: "replace", value },
        })
      }
    }

    if (mapChange.delete) {
      for (const key of mapChange.delete) {
        result.push({
          path: [...op.path, { type: "key", key }],
          change: { type: "replace", value: undefined },
        })
      }
    }
  }

  return result
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
 * `subscribeTree` delivers `Changeset<Op<C>>` — each entry
 * in the batch carries the relative path where the change occurred.
 *
 * Only composite refs (products, sequences, maps) implement this.
 * Leaf refs (scalars, text, counters) implement plain `Changefeed`.
 */
export interface ComposedChangefeed<S, C extends ChangeBase = ChangeBase>
  extends Changefeed<S, C> {
  /** Subscribe to changes at this node and all descendants. */
  subscribeTree(callback: (changeset: Changeset<Op<C>>) => void): () => void
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

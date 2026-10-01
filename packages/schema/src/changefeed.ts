// Changefeed — schema-specific extensions to the universal reactive contract.
//
// The universal reactive contract (CHANGEFEED symbol, Changeset, ChangefeedProtocol,
// Changefeed, HasChangefeed, hasChangefeed, staticChangefeed, changefeed projector,
// createChangefeed) lives in @kyneta/changefeed. This module contains only
// schema-specific extensions that depend on Path, Op, or built-in change types.
//
// What lives here:
// - Op<C> — addressed delta (requires Path from interpret.ts)
// - expandProductMapChanges() — a struct's map event as field writes
// - RecursiveChangefeedProtocol<S, C> — tree-level observation (requires Op)
// - HasRecursiveChangefeed<S, C> — marker for tree-changefeed carriers
// - hasRecursiveChangefeed() — type guard for tree-changefeed carriers
// - getOrCreateChangefeed() — WeakMap-based caching for lazy protocol creation

import type { ChangeBase } from "@kyneta/changefeed"
import {
  CHANGEFEED,
  type ChangefeedProtocol,
  type Changeset,
  hasChangefeed,
} from "@kyneta/changefeed"
import { isMapChange } from "./change.js"
import { walkPath } from "./fold-path.js"
import type { RawPath } from "./path.js"
import { KIND, type Schema as SchemaNode } from "./schema.js"
import { planSubtreeEffect, projectChange } from "./subtree-effect.js"

// ---------------------------------------------------------------------------
// Re-exports from @kyneta/changefeed used by schema internals
// ---------------------------------------------------------------------------

// These are NOT re-exported from index.ts — consumers import them from
// @kyneta/changefeed directly. They are imported here only so that
// schema-internal files can import from "../changefeed.js" for schema-specific
// symbols while getting contract types from the same module scope.

export type { ChangefeedProtocol, Changeset }
export { CHANGEFEED, hasChangefeed }

// ---------------------------------------------------------------------------
// Op — the atomic unit of the delta algebra
// ---------------------------------------------------------------------------

/**
 * A delta at a coordinate — the atomic unit of change in the delta algebra.
 *
 * Every mutation, notification, and sync payload decomposes into Ops.
 * An Op is a (path, change) pair: the path names a node in the schema tree,
 * the change describes the delta at that node.
 *
 * An op is a value. Its path is a `RawPath`, the coordinate the op wrote when
 * it was made, so a held op still replays there after the document moves on.
 * A ref's live `AddressedPath` would not: its list indices advance as items
 * are inserted and deleted before them.
 */
export interface Op<C extends ChangeBase = ChangeBase> {
  readonly path: RawPath
  readonly change: C
}

// ---------------------------------------------------------------------------
// Op transformations
// ---------------------------------------------------------------------------

/**
 * Split each `MapChange` at a struct into the field writes it makes.
 *
 * Every announcer states a change at the grain the store keeps it, and a
 * struct keeps its fields one by one. A writer changes a field with a write at
 * the field; the plain substrate replays that, and `diffOps` announces it for
 * ephemeral. Loro and Yjs keep a struct as one map container, so their event
 * bridges see a map change at the struct; they run this before announcing, so
 * that on every substrate a write to a field is a change at the field and a
 * struct-level `subscribeNode` never fires for it.
 *
 * A `MapChange` whose path resolves to a product becomes, for each field in
 * its scope (`planSubtreeEffect`), the change as seen from that field
 * (`projectChange`): a `replace` of the value written there, or
 * `replace(undefined)` for a removed key. Delivery reaches the subscribers
 * below a map change by the same two functions. Every other op, a record's
 * map change included, passes through: a writer writes a record's keys at the
 * record.
 *
 * A clear at a product is refused: its fields are declared, and nothing
 * clears them.
 */
export function expandProductMapChanges(
  ops: readonly Op[],
  schema: SchemaNode,
): Op[] {
  return ops.flatMap(op => {
    if (!isMapChange(op.change)) return [op]
    const walk = walkPath(undefined, schema, op.path)
    if (walk.stop !== "complete" || walk.schema[KIND] !== "product") {
      return [op]
    }
    const effect = planSubtreeEffect(op.change)
    // Only a clear rewrites a map change's whole scope.
    if (effect === "all") {
      throw new Error(
        `expandProductMapChanges: a clear at the struct "${op.path.format()}"; only a record can be cleared.`,
      )
    }
    if (effect === "none") return []
    return effect.keys.map(key => {
      const path = op.path.field(key)
      return { path, change: projectChange(op.change, path.segments.slice(-1)) }
    })
  })
}

// ---------------------------------------------------------------------------
// Recursive (descendants-propagating) changefeed — schema-specific extension
// ---------------------------------------------------------------------------
//
// "Recursive" propagates over the descendants of a schema-shaped subtree
// of refs. Distinct from `Schema.tree`, the CRDT primitive (see
// schema.ts) — keeping the names apart is what motivates "recursive"
// over "tree" here.

/**
 * The schema-specific extension of `ChangefeedProtocol` that adds
 * `subscribeDescendants` — observe own-path + descendants with relative paths.
 *
 * Every schema-issued changefeed (leaves and composites alike)
 * implements this. For a composite ref, `subscribeDescendants` aggregates
 * own-path changes with children's descendant-streams (paths prefixed
 * appropriately). For a leaf ref, `subscribeDescendants` is the trivial
 * own-path lift: every change is delivered as a single `Op` whose
 * `path` is the leaf's registry-aware root (empty relative path).
 * A leaf is a subtree of size 1.
 *
 * `subscribe` remains node-level — it fires only for changes at this
 * node's own path. Both `subscribe` and `subscribeDescendants` deliver
 * `Changeset` batches. `subscribeDescendants` delivers `Changeset<Op<C>>`,
 * where each event in the batch carries the relative path where the
 * change occurred.
 */
export interface RecursiveChangefeedProtocol<
  S,
  C extends ChangeBase = ChangeBase,
> extends ChangefeedProtocol<S, C> {
  /** Subscribe to changes at this node and all descendants. */
  subscribeDescendants(
    callback: (changeset: Changeset<Op<C>>) => void,
  ): () => void
}

/**
 * An object that carries a recursive (descendants-propagating)
 * changefeed protocol under the `[CHANGEFEED]` symbol — every
 * schema-issued ref satisfies this.
 */
export interface HasRecursiveChangefeed<
  S = unknown,
  A extends ChangeBase = ChangeBase,
> {
  readonly [CHANGEFEED]: RecursiveChangefeedProtocol<S, A>
}

// ---------------------------------------------------------------------------
// WeakMap-based caching
// ---------------------------------------------------------------------------

/**
 * Module-scoped WeakMap that caches ChangefeedProtocol instances per object
 * reference.
 *
 * Properties:
 * - No per-instance allocation at construction time
 * - ChangefeedProtocol created lazily on first access
 * - Referential identity: `ref[CHANGEFEED] === ref[CHANGEFEED]`
 * - GC-safe: WeakMap entry disappears when ref is collected
 */
const changefeeds = new WeakMap<object, ChangefeedProtocol<any, any>>()

/**
 * Returns the cached changefeed protocol for `ref`, or creates one via
 * `factory` and caches it.
 *
 * Usage (on a ref class prototype):
 * ```ts
 * get [CHANGEFEED](): ChangefeedProtocol<S, C> {
 *   return getOrCreateChangefeed(this, () => ({
 *     get current() { return readCurrentValue(self) },
 *     subscribe: (cb) => subscribeToChanges(self, cb),
 *   }))
 * }
 * ```
 */
export function getOrCreateChangefeed<S, A extends ChangeBase>(
  ref: object,
  factory: () => ChangefeedProtocol<S, A>,
): ChangefeedProtocol<S, A> {
  let cf = changefeeds.get(ref) as ChangefeedProtocol<S, A> | undefined
  if (!cf) {
    cf = factory()
    changefeeds.set(ref, cf)
  }
  return cf
}

// ---------------------------------------------------------------------------
// Type guard — recursive (descendants-propagating) changefeed
// ---------------------------------------------------------------------------

/**
 * Returns `true` if `value` has a `[CHANGEFEED]` property whose value
 * has a `subscribeDescendants` method — i.e. it implements `HasRecursiveChangefeed`.
 *
 * Returns `true` for every schema-issued ref (leaves and composites);
 * the guard's purpose is distinguishing schema-issued changefeeds from
 * primitive `createChangefeed()` sources, which carry only the
 * universal `ChangefeedProtocol` and have no `subscribeDescendants`.
 */
export function hasRecursiveChangefeed<
  S = unknown,
  A extends ChangeBase = ChangeBase,
>(value: unknown): value is HasRecursiveChangefeed<S, A> {
  if (!hasChangefeed(value)) return false
  const cf = value[CHANGEFEED]
  return (
    "subscribeDescendants" in cf &&
    typeof cf.subscribeDescendants === "function"
  )
}

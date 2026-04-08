// Changefeed — schema-specific extensions to the universal reactive contract.
//
// The universal reactive contract (CHANGEFEED symbol, Changeset, ChangefeedProtocol,
// Changefeed, HasChangefeed, hasChangefeed, staticChangefeed, changefeed projector,
// createChangefeed) lives in @kyneta/changefeed. This module contains only
// schema-specific extensions that depend on Path, Op, or built-in change types.
//
// What lives here:
// - Op<C> — addressed delta (requires Path from interpret.ts)
// - expandMapOpsToLeaves() — map op expansion (requires Op, ReplaceChange)
// - ComposedChangefeedProtocol<S, C> — tree-level observation (requires Op)
// - HasComposedChangefeed<S, C> — marker for composed changefeed
// - hasComposedChangefeed() — type guard for composed changefeed
// - getOrCreateChangefeed() — WeakMap-based caching for lazy protocol creation

import type { ChangeBase } from "@kyneta/changefeed"
import {
  CHANGEFEED,
  type ChangefeedProtocol,
  type Changeset,
  hasChangefeed,
} from "@kyneta/changefeed"
import type { ReplaceChange } from "./change.js"
import type { Path } from "./interpret.js"
import { advanceSchema, KIND, type Schema as SchemaNode } from "./schema.js"

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
 * Expand container-level map ops into leaf-level replace ops, informed
 * by the document schema.
 *
 * CRDT substrates (Loro, Yjs) fire events at container boundaries —
 * a map/struct container fires a single event with per-key diffs.
 * Products (structs) and maps (records) both produce `MapChange`, but
 * their changefeed contracts differ:
 *
 * - **Product** (fixed keys): expand `MapChange` → per-key `ReplaceChange`
 *   at child paths. The product changefeed wires static child listeners.
 * - **Map** (dynamic keys): preserve `MapChange` at the map's own path.
 *   The map changefeed needs the structural event for dynamic subscription
 *   management (`handleStructuralChange`).
 *
 * The schema determines which case applies. `advanceSchema` walks the
 * schema tree to the op's path; the structural kind there decides.
 *
 * Root path (length 0) is always expanded — this covers `_props` scalar
 * fields whose path was stripped by the Loro event bridge.
 *
 * Non-map ops (text, sequence, counter, tree) pass through unchanged.
 */
export function expandMapOpsToLeaves(
  ops: readonly Op[],
  schema: SchemaNode,
): Op<ReplaceChange | ChangeBase>[] {
  const result: Op<ReplaceChange | ChangeBase>[] = []

  for (const op of ops) {
    if (op.change.type !== "map") {
      result.push(op)
      continue
    }

    // Determine whether to expand based on the schema kind at the op's path.
    // Products → expand. Maps → preserve. Root (length 0) → always expand.
    if (
      op.path.length > 0 &&
      resolveSchemaKindAtPath(schema, op.path) === "map"
    ) {
      result.push(op)
      continue
    }

    const mapChange = op.change as {
      type: "map"
      set?: Record<string, unknown>
      delete?: string[]
    }

    if (mapChange.set) {
      for (const [key, value] of Object.entries(mapChange.set)) {
        result.push({
          path: op.path.field(key),
          change: { type: "replace", value },
        })
      }
    }

    if (mapChange.delete) {
      for (const key of mapChange.delete) {
        result.push({
          path: op.path.field(key),
          change: { type: "replace", value: undefined },
        })
      }
    }
  }

  return result
}

/**
 * Walk the schema tree to the given path and return the structural kind.
 *
 * Returns `"product"` for structs (expand), `"map"` for records (preserve),
 * or `"other"` as a fallback (expand as safe default).
 *
 * Pure function — no I/O, no mutation.
 */
function resolveSchemaKindAtPath(
  schema: SchemaNode,
  path: Path,
): "product" | "map" | "other" {
  try {
    let current = schema
    // Unwrap the root annotation (e.g. doc → product)
    while (current[KIND] === "annotated" && current.schema !== undefined) {
      current = current.schema
    }
    // Walk each segment except the last — we want the schema AT the path,
    // not the schema of the path's child.
    for (const segment of path.segments) {
      current = advanceSchema(current, segment)
    }
    // Unwrap annotations at the target position
    while (current[KIND] === "annotated" && current.schema !== undefined) {
      current = current.schema
    }
    if (current[KIND] === "product") return "product"
    if (current[KIND] === "map") return "map"
    return "other"
  } catch {
    // Schema walk failed (e.g. sum mid-path, unknown field) — safe fallback
    return "other"
  }
}

// ---------------------------------------------------------------------------
// Compositional changefeed — tree-level observation
// ---------------------------------------------------------------------------

/**
 * Extension of `ChangefeedProtocol` for tree-structured (composite) refs.
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
 * Leaf refs (scalars, text, counters) implement plain `ChangefeedProtocol`.
 */
export interface ComposedChangefeedProtocol<
  S,
  C extends ChangeBase = ChangeBase,
> extends ChangefeedProtocol<S, C> {
  /** Subscribe to changes at this node and all descendants. */
  subscribeTree(callback: (changeset: Changeset<Op<C>>) => void): () => void
}

/**
 * An object that carries a composed changefeed protocol under the
 * `[CHANGEFEED]` symbol — i.e. a composite ref with tree-level observation.
 */
export interface HasComposedChangefeed<
  S = unknown,
  A extends ChangeBase = ChangeBase,
> {
  readonly [CHANGEFEED]: ComposedChangefeedProtocol<S, A>
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
// Type guard — composed changefeed
// ---------------------------------------------------------------------------

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

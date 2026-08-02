// fold-path — the one schema-guided traversal of a Path, and its projections.
//
// The substrate-blind sibling of `Path.read(state)`. Where `Path.read` walks a
// plain JS object by segment-resolved keys, this walks a substrate-native
// container tree, threading the schema and an optional identity binding at each
// step. Backends supply only the per-step substrate dispatch, as a
// `PathStepper`; everything else lives here.
//
// `walkPath` is the traversal. Everything else in this file is a projection of
// it that adds one policy:
//
//   walkPath           reports where the walk stopped; never throws
//     ├─ foldPath      resolves a substrate value; throws on a bad path
//     ├─ pathSchema    returns just the schema
//     └─ findOpaqueBoundary  reports where an opaque subtree begins
//
// The `ephemeral` substrate's own schema lookup (`state-tree.ts`) is a fourth.
//
// Two semantic invariants live here, in exactly one place:
//
// 1. **Identity-keying at product-field boundaries only.** When
//    `seg.role === "field"`, the absolute schema path is extended via
//    `extendSchemaPathKey` and used to look up `binding.forward.get(key)`.
//    `entry` (map/set/tree) and `index` (sequence/movable) segments pass
//    through with the raw key — they are not identity-keyed.
//
// 2. **Opaque-boundary stop.** Some subtrees are stored as ONE plain value in
//    the parent container rather than as nested CRDT containers: a `sum`
//    (which is what `.nullable()` expands to) and a `.json()` node. Once a walk
//    reaches one, the schema has nothing further to offer — remaining segments
//    resolve against the value instead. `walkPath` reports this as a `boundary`
//    stop and each projection decides what to do about it.
//
//    These were once two invariants, one per boundary kind, and the split was
//    the bug: a walker could learn the json half and miss the sum half, which
//    is exactly what happened. They are one rule because they describe one
//    storage decision — see `needsContainer` in `materialize-value.ts`, which
//    makes it from the writing side.
//
// Why one traversal and not several: these projections used to be separate
// hand-rolled loops over `path.segments`, and they drifted. One stopped
// correctly at a sum, one walked past it into a throw, one caught the throw and
// answered `undefined`. Each shipped a different bug from the same missing
// case. A rule that lives in a doc comment is not enforced; a rule that lives
// in the only code path is.

import type { SchemaBinding } from "./migration.js"
import type { Path, Segment } from "./path.js"
import type { Schema as SchemaNode } from "./schema.js"
import { stepSchema } from "./schema.js"

// ---------------------------------------------------------------------------
// PathStepper — backend-local single-step navigation
// ---------------------------------------------------------------------------

/**
 * One step of a schema-guided path fold. Backends provide this; `foldPath`
 * drives the fold around it.
 *
 * - `current`: the substrate's current container or root (e.g. a `LoroDoc`,
 *   a Loro container, a `Y.Map`, etc.). Type-erased to `unknown` at the
 *   primitive level so backends type their wrappers naturally.
 * - `nextSchema`: the schema at the next position. Needed by backends like
 *   Loro whose root dispatch picks a typed accessor from the next field's
 *   `[KIND]`. Yjs's `instanceof`-based dispatch ignores this.
 * - `segment`: the path segment driving the step.
 * - `identity`: the identity hash from the SchemaBinding when this is a
 *   product-field boundary; otherwise `undefined`. Backends use this in
 *   place of `segment.resolve()` when keying into identity-keyed containers.
 */
export type PathStepper = (
  current: unknown,
  nextSchema: SchemaNode,
  segment: Segment,
  identity: string | undefined,
) => unknown

/**
 * Result of `foldPath`: the resolved value at the terminal position
 * and the schema at that position.
 *
 * For schema-only walks (via `pathSchema` or `foldPath` with a no-op
 * stepper), `resolved` is `undefined` and is ignored.
 */
export interface PathFoldResult {
  readonly resolved: unknown
  readonly schema: SchemaNode
}

// ---------------------------------------------------------------------------
// extendSchemaPathKey — shared accumulator for binding-lookup keys
// ---------------------------------------------------------------------------

/**
 * Extend a binding-lookup key with one field segment. Empty `prev`
 * produces just `segment`; non-empty produces `${prev}.${segment}`.
 *
 * Used by both the reader (`foldPath`, per-field-segment accumulation)
 * and the writer (`migration.ts:deriveBindingRecursive`, recursive
 * descent into product fields). Centralizing the join means the
 * writer/reader contract for binding keys lives in exactly one place.
 */
export function extendSchemaPathKey(prev: string, segment: string): string {
  return prev ? `${prev}.${segment}` : segment
}

// ---------------------------------------------------------------------------
// walkPath — the one traversal
// ---------------------------------------------------------------------------

/**
 * Where a schema-guided walk stopped, and what it found there.
 *
 * - `complete` — the walk consumed every segment.
 * - `boundary` — it reached a node the substrate stores as ONE opaque value.
 *   Segments from `consumed` onward have to be resolved against the *value*
 *   instead, because the schema has no further structure to offer.
 * - `mismatch` — the path contradicts the schema. `reason` is ready to throw.
 *
 * `consumed` counts segments the walk got through. On `boundary` the boundary
 * segment itself *is* consumed, so it sits at `consumed - 1` and the segments
 * still needing resolution begin at `consumed`. That one piece of index
 * arithmetic is what every caller depends on, so it is stated here rather than
 * left to be re-derived.
 */
export type PathWalk =
  | {
      readonly stop: "complete"
      readonly schema: SchemaNode
      readonly consumed: number
      readonly resolved: unknown
    }
  | {
      readonly stop: "boundary"
      readonly schema: SchemaNode
      readonly consumed: number
      readonly resolved: unknown
    }
  | {
      readonly stop: "mismatch"
      readonly consumed: number
      readonly segment: Segment
      readonly reason: string
    }

/**
 * Walk a path alongside its schema. Never throws.
 *
 * This is the only traversal in the package. `foldPath`, `pathSchema`,
 * `findOpaqueBoundary`, and the `ephemeral` substrate's schema lookup are all thin
 * projections of it, differing only in what they do with the result.
 *
 * That consolidation is the point. These used to be separate hand-rolled loops
 * over `path.segments`, and they drifted: one stopped correctly at a sum, one
 * walked into the throw, one caught the throw and returned `undefined`. Each
 * shipped a different bug from the same missing case. Reporting the stop as
 * data instead of raising it means the decision is made once, here, and every
 * caller inherits it.
 *
 * Returning `mismatch` rather than throwing lets each caller pick its own
 * policy — `foldPath` throws, the `ephemeral` substrate's lookup tolerates. That split is the
 * functional-core / imperative-shell shape: this function reports what
 * happened, its callers decide what to do about it.
 *
 * `stepInto` is optional. Schema-only callers omit it and ignore `resolved`.
 *
 * For an empty path, returns `complete` with zero stepper calls.
 */
export function walkPath(
  root: unknown,
  rootSchema: SchemaNode,
  path: Path,
  stepInto?: PathStepper,
  binding?: SchemaBinding,
): PathWalk {
  let current: unknown = root
  let schema = rootSchema
  // Accumulator for the binding lookup key. Only `field` segments
  // contribute — `entry` and `index` segments are not identity-keyed.
  let absPath = ""
  const segments = path.segments

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i] as Segment
    const step = stepSchema(schema, seg)

    if (step.kind === "mismatch") {
      return {
        stop: "mismatch",
        consumed: i,
        segment: seg,
        reason: step.reason,
      }
    }

    let identity: string | undefined
    if (binding && seg.role === "field") {
      absPath = extendSchemaPathKey(absPath, seg.coord() as string)
      identity = binding.forward.get(absPath) as string | undefined
    }

    // The stepper runs for the boundary segment too, and only then do we stop.
    // Stopping one step earlier would look equivalent but is not: the backends'
    // steppers are what turn a segment into a container, so skipping this call
    // would hand `resolveYjsType` the boundary's *parent* rather than the
    // boundary value itself.
    current = stepInto?.(current, step.schema, seg, identity)
    schema = step.schema

    if (step.kind === "boundary") {
      return { stop: "boundary", schema, consumed: i + 1, resolved: current }
    }
  }

  return {
    stop: "complete",
    schema,
    consumed: segments.length,
    resolved: current,
  }
}

// ---------------------------------------------------------------------------
// foldPath — the value-resolving projection
// ---------------------------------------------------------------------------

/**
 * Schema-guided left-fold over `path.segments`, resolving a substrate value.
 *
 * A projection of {@link walkPath} that adds the two policies a value walk
 * needs: descend the remaining segments by plain property access once the
 * schema stops being able to navigate, and treat a malformed path as an error.
 *
 * For an empty path, returns `{ resolved: root, schema: rootSchema }`
 * with zero stepper calls.
 */
export function foldPath(
  root: unknown,
  rootSchema: SchemaNode,
  path: Path,
  stepInto: PathStepper,
  binding?: SchemaBinding,
): PathFoldResult {
  const walk = walkPath(root, rootSchema, path, stepInto, binding)

  if (walk.stop === "mismatch") throw new Error(walk.reason)
  if (walk.stop === "complete") {
    return { resolved: walk.resolved, schema: walk.schema }
  }

  // Past the boundary the substrate has nothing left to navigate, so the
  // remaining segments read straight off the opaque value. Works for string
  // keys and numeric indices alike — JS coerces `arr[0]` to `arr["0"]`.
  let current = walk.resolved
  const segments = path.segments
  for (let j = walk.consumed; j < segments.length; j++) {
    const remaining = segments[j] as Segment
    current = (current as Record<string, unknown> | undefined)?.[
      remaining.coord() as string
    ]
  }
  return { resolved: current, schema: walk.schema }
}

// ---------------------------------------------------------------------------
// pathSchema — schema-only specialization
// ---------------------------------------------------------------------------

/**
 * Resolve the schema at a path. Schema-only specialization of `foldPath`:
 * passes a no-op stepper and returns only `.schema`. The sum-boundary
 * rule applies uniformly — on a sum-interior path, the returned schema
 * is the sum schema (the variant cannot be determined without a value).
 *
 * Used by callers that need the schema at a path but not the substrate
 * value: change-mapping target-schema resolution, changefeed kind
 * classification.
 */
export function pathSchema(
  rootSchema: SchemaNode,
  path: Path,
  binding?: SchemaBinding,
): SchemaNode {
  return foldPath(undefined, rootSchema, path, () => undefined, binding).schema
}

// ---------------------------------------------------------------------------
// findOpaqueBoundary — where along a path an opaque subtree begins
// ---------------------------------------------------------------------------

/**
 * Result of {@link findOpaqueBoundary}: where a path first crosses into an
 * opaque subtree, as the segment that lands on it plus that segment's index.
 *
 * `prefixLength` is the index in `path.segments` of the boundary segment
 * itself. The substrate uses it to slice off the parent path (segments
 * `0..prefixLength`) for container resolution, and to read the boundary key
 * from `segments[prefixLength].resolve()`.
 */
export interface OpaqueBoundaryHit {
  /** Index in `path.segments` of the segment that crosses the boundary. */
  readonly prefixLength: number
  /** The segment that crosses the boundary (its resolve() is the key in the parent container). */
  readonly boundarySegment: Segment
}

/**
 * Walk a path alongside its schema, returning where it first crosses into a
 * subtree the substrate stores as one opaque value, or `null` if it never does.
 *
 * Substrate write paths call this once per `prepare`. A hit means the change
 * cannot be applied where it points and has to be widened into a whole-value
 * write of the entire subtree. A miss means the ordinary direct write path
 * applies.
 *
 * A hit is reported wherever the boundary sits, including when the path stops
 * exactly on it. That is not redundant, which is easy to assume: a `.json()`
 * list has no CRDT array behind it, so a `push` arrives as a change *at* the
 * boundary with nowhere to go, and widening is the only thing that can express
 * it. The same is true of a `.nullable()` collection.
 *
 * A projection of {@link walkPath}: a `boundary` stop is exactly a hit, and the
 * boundary segment sits one before `consumed`.
 */
export function findOpaqueBoundary(
  rootSchema: SchemaNode,
  path: Path,
  binding?: SchemaBinding,
): OpaqueBoundaryHit | null {
  const walk = walkPath(undefined, rootSchema, path, undefined, binding)
  if (walk.stop !== "boundary") return null
  const prefixLength = walk.consumed - 1
  return {
    prefixLength,
    boundarySegment: path.segments[prefixLength] as Segment,
  }
}

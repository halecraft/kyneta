// fold-path — schema-guided left-fold over a Path.
//
// The substrate-blind sibling of `Path.read(state)`. Where `Path.read`
// walks a plain JS object by segment-resolved keys, `foldPath` walks a
// substrate-native container tree, threading the schema and an optional
// identity binding at each step. Backends supply only the per-step
// substrate dispatch via a `PathStepper` — `foldPath` owns the fold
// skeleton, the identity-keying rule, and the sum/json-boundary
// short-circuits.
//
// Three semantic invariants live here, in exactly one place:
//
// 1. **Identity-keying at product-field boundaries only.** When
//    `seg.role === "field"`, the absolute schema path is extended via
//    `extendSchemaPathKey` and used to look up `binding.forward.get(key)`.
//    `entry` (map/set/tree) and `index` (sequence/movable) segments pass
//    through with the raw key — they are not identity-keyed.
//
// 2. **Sum-boundary short-circuit.** When the fold lands on a schema with
//    `[KIND] === "sum"`, all remaining segments resolve via plain JS
//    property access on the returned value. Sum variants are PlainSchema
//    by construction — no CRDT containers exist inside them — so the
//    substrate has nothing to navigate past the sum boundary.
//
// 3. **JSON-boundary short-circuit.** When the fold lands on a schema
//    carrying the `JSON_BOUNDARY` marker (struct.json/list.json/
//    record.json), the entire subtree is stored as a single plain JSON
//    value in the parent CRDT container. Like the sum case, all
//    remaining segments descend via plain JS property access — there
//    are no CRDT containers inside a json subtree to navigate.
//
// `pathSchema` is the schema-only specialization: `foldPath` with a no-op
// stepper, returning only `.schema`. Used by callers that need the schema
// at a path but not the substrate value (change-mapping target resolution,
// changefeed kind classification).

import type { SchemaBinding } from "./migration.js"
import type { Path, Segment } from "./path.js"
import type { Schema as SchemaNode } from "./schema.js"
import { advanceSchema, isJsonBoundary, KIND } from "./schema.js"

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
// foldPath — the schema-guided fold
// ---------------------------------------------------------------------------

/**
 * Schema-guided left-fold over `path.segments`. Drives the per-step
 * `stepInto` callback while enforcing the two semantic invariants
 * documented at the top of this file.
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
  let current: unknown = root
  let schema = rootSchema
  // Accumulator for the binding lookup key. Only `field` segments
  // contribute — `entry` and `index` segments are not identity-keyed.
  let absPath = ""
  const segments = path.segments
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i] as Segment
    const nextSchema = advanceSchema(schema, seg)

    let identity: string | undefined
    if (binding && seg.role === "field") {
      absPath = extendSchemaPathKey(absPath, seg.resolve() as string)
      identity = binding.forward.get(absPath) as string | undefined
    }

    current = stepInto(current, nextSchema, seg, identity)
    schema = nextSchema

    // Sum boundary — sum variants are PlainSchema, so remaining
    // segments descend via plain JS property access on the value.
    if (schema[KIND] === "sum") {
      for (let j = i + 1; j < segments.length; j++) {
        const remaining = segments[j] as Segment
        current = (current as Record<string, unknown> | undefined)?.[
          remaining.resolve() as string
        ]
      }
      return { resolved: current, schema }
    }

    // JSON boundary — struct.json/list.json/record.json. The entire
    // subtree is stored as a plain JSON value in the parent CRDT
    // container, so remaining segments descend via plain JS property
    // access (works for both string keys and numeric indices: JS
    // coerces `arr[0]` to `arr["0"]`). Symmetric with the sum case.
    if (isJsonBoundary(schema)) {
      for (let j = i + 1; j < segments.length; j++) {
        const remaining = segments[j] as Segment
        current = (current as Record<string, unknown> | undefined)?.[
          remaining.resolve() as string
        ]
      }
      return { resolved: current, schema }
    }
  }
  return { resolved: current, schema }
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
// findJsonBoundary — locate the nearest json-boundary ancestor along a path
// ---------------------------------------------------------------------------

/**
 * Result of {@link findJsonBoundary}: the first json-boundary ancestor
 * found while walking a path, expressed as the parent path (segments
 * before the boundary) plus the segment that lands on the boundary.
 *
 * `prefixLength` is the index in `path.segments` of the boundary
 * segment itself. The substrate uses this to slice off the parent
 * path (segments `0..prefixLength`) for `resolveContainer` and to
 * read the boundary key from `segments[prefixLength].resolve()`.
 */
export interface JsonBoundaryHit {
  /** Index in `path.segments` of the segment that crosses the boundary. */
  readonly prefixLength: number
  /** The segment that crosses the boundary (its resolve() is the key in the parent container). */
  readonly boundarySegment: Segment
}

/**
 * Walk a path alongside its schema, returning the first position where
 * the schema crosses a {@link JSON_BOUNDARY}-marked node, or `null` if
 * no such boundary exists on this path.
 *
 * Substrate write paths call this once per `prepare` to decide whether
 * the write targets a json subtree — if so, the write is routed to the
 * coalescing buffer (which stages the full boundary value as a plain
 * JSON write on the parent container) instead of generating nested
 * CRDT mutations. Non-json paths take the direct write path.
 */
export function findJsonBoundary(
  rootSchema: SchemaNode,
  path: Path,
  binding?: SchemaBinding,
): JsonBoundaryHit | null {
  let schema = rootSchema
  let absPath = ""
  const segments = path.segments
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i] as Segment
    const nextSchema = advanceSchema(schema, seg)

    if (binding && seg.role === "field") {
      // Mirrors the absPath accumulation in `foldPath`. Kept here so
      // a future identity-aware variant of findJsonBoundary can reuse
      // the same lookup discipline; currently unused but harmless.
      absPath = extendSchemaPathKey(absPath, seg.resolve() as string)
      void absPath
    }

    if (isJsonBoundary(nextSchema)) {
      return { prefixLength: i, boundarySegment: seg }
    }
    schema = nextSchema
  }
  return null
}

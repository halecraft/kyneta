// loro-resolve — Loro-specific path resolution.
//
// `stepIntoLoro` is the per-step substrate dispatch; `resolveContainer`
// applies the core `foldPath` primitive (from `@kyneta/schema`) around
// it. The semantic invariants of the fold — identity-keying at
// product-field boundaries, sum-boundary short-circuit — live in
// `fold-path.ts`, not here.
//
// The root case (LoroDoc) uses typed root container accessors
// (doc.getMap, doc.getText, etc.) based on the next field's [KIND].
// Non-root cases use generic container .get() methods with .kind()
// for runtime type discrimination.
//
// Root scalar fields (non-container types like Schema.string()) are
// stored in a single root LoroMap named PROPS_KEY ("_props"). This
// avoids creating a separate root container per scalar field.

import {
  foldPath,
  isJsonBoundary,
  KIND,
  type Path,
  type PathFoldResult,
  type PathStepper,
  type SchemaBinding,
  type Schema as SchemaNode,
  type Segment,
} from "@kyneta/schema"
import type { LoroDoc, LoroList, LoroMap, LoroMovableList } from "loro-crdt"
import { hasKind, isLoroDoc } from "./loro-guards.js"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The root LoroMap key used to store non-container scalar fields.
 * All root product fields that don't map to a Loro container type
 * (text, counter, list, movableList, tree, map, product) are stored
 * as entries in `doc.getMap(PROPS_KEY)`.
 */
export const PROPS_KEY = "_props"

// ---------------------------------------------------------------------------
// stepFromDoc — resolve a root-level container from a LoroDoc
// ---------------------------------------------------------------------------

/**
 * Get a root-level container or scalar from a LoroDoc using the schema
 * to determine which typed accessor to use.
 *
 * Container fields are accessed via `doc.getText(key)`, `doc.getMap(key)`,
 * etc. Non-container fields (scalars, sums) are stored in the shared
 * `_props` LoroMap and read via `doc.getMap(PROPS_KEY).get(key)`.
 *
 * After identity-keying, `key` is the identity hash (not the field name).
 */
function stepFromDoc(
  doc: LoroDoc,
  fieldSchema: SchemaNode,
  key: string,
): unknown {
  // JSON-boundary root fields (struct.json/list.json/record.json) live
  // in the shared _props LoroMap as a single plain JSON value — no
  // nested Loro container. The fold-path JSON_BOUNDARY short-circuit
  // takes over for any remaining segments via plain-JS descent.
  if (isJsonBoundary(fieldSchema)) {
    return (doc.getMap(PROPS_KEY) as LoroMap).get(key)
  }
  // Dispatch on the schema's [KIND] directly — no annotation unwrapping
  switch (fieldSchema[KIND]) {
    case "text":
    case "richtext":
      return doc.getText(key)
    case "counter":
      return doc.getCounter(key)
    case "movable":
      return doc.getMovableList(key)
    case "tree":
      return doc.getTree(key)
    case "set":
    case "product":
      return doc.getMap(key)
    case "sequence":
      return doc.getList(key)
    case "map":
      return doc.getMap(key)
    case "scalar":
    case "sum":
      // Non-container types: stored in the shared _props LoroMap.
      // Return the scalar value directly (not a container).
      return (doc.getMap(PROPS_KEY) as LoroMap).get(key)
    default:
      // Unknown kind — try _props as fallback
      return (doc.getMap(PROPS_KEY) as LoroMap).get(key)
  }
}

// ---------------------------------------------------------------------------
// stepFromContainer — resolve a child from a Loro container
// ---------------------------------------------------------------------------

/**
 * Step into a child of a Loro container using the segment and runtime
 * container kind discrimination.
 *
 * For Map kind, uses the identity hash (if provided) instead of the
 * segment's resolved field name. Lists and MovableLists use integer
 * indices — unchanged.
 */
function stepFromContainer(
  container: unknown,
  segment: Segment,
  identity?: string,
): unknown {
  if (!hasKind(container)) {
    // Plain value or unknown — cannot step further
    return undefined
  }

  const kind = container.kind()
  const resolved = segment.resolve()

  switch (kind) {
    case "Map":
      return (container as LoroMap).get(identity ?? (resolved as string))

    case "List":
      return (container as LoroList).get(resolved as number)

    case "MovableList":
      return (container as LoroMovableList).get(resolved as number)

    default:
      throw new Error(
        `loro-resolve: cannot step into container of kind "${kind}"`,
      )
  }
}

// ---------------------------------------------------------------------------
// stepIntoLoro — per-step substrate dispatch (PathStepper for Loro)
// ---------------------------------------------------------------------------

/**
 * Navigate one step deeper into the Loro container tree.
 *
 * If `current` is a LoroDoc (root), dispatches via the typed root
 * container accessors using `nextSchema` to determine the container type.
 * The key used is the identity hash when provided.
 *
 * If `current` is a Loro container, dispatches via `.get()` using
 * `.kind()` for runtime type discrimination. For Maps, uses the
 * identity hash when provided.
 */
export const stepIntoLoro: PathStepper = (
  current,
  nextSchema,
  segment,
  identity,
) => {
  if (isLoroDoc(current)) {
    return stepFromDoc(
      current,
      nextSchema,
      identity ?? (segment.resolve() as string),
    )
  }

  return stepFromContainer(current, segment, identity)
}

// ---------------------------------------------------------------------------
// resolveContainer — full path resolution via foldPath
// ---------------------------------------------------------------------------

/**
 * Resolve a Loro container (or scalar value) at the given path.
 *
 * Thin wrapper around `foldPath(stepIntoLoro, ...)`. Returns the
 * `PathFoldResult` shape from core — `{ resolved, schema }`.
 *
 * When a `binding` is provided, every product-field boundary uses the
 * identity hash from `binding.forward` instead of the field name.
 *
 * For an empty path, returns the doc itself with the root schema.
 */
export function resolveContainer(
  doc: LoroDoc,
  rootSchema: SchemaNode,
  path: Path,
  binding?: SchemaBinding,
): PathFoldResult {
  return foldPath(doc, rootSchema, path, stepIntoLoro, binding)
}

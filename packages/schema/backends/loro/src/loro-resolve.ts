// loro-resolve — Loro-specific container resolution.
//
// Implements stepIntoLoro and resolveContainer for schema-guided
// navigation of the Loro container tree.
//
// resolveContainer is a left-fold over path segments, accumulating
// (currentContainer, currentSchema) at each step. This mirrors how
// readByPath works for plain objects — but guided by the schema to
// know which Loro API to call.
//
// The root case (LoroDoc) uses typed root container accessors
// (doc.getMap, doc.getText, etc.) based on the schema's [KIND].
// Non-root cases use generic container .get() methods with .kind()
// for runtime type discrimination.
//
// Root scalar fields (non-container types like Schema.string()) are
// stored in a single root LoroMap named PROPS_KEY ("_props"). This
// avoids creating a separate root container per scalar field.
//
// Identity-keying: every product-field boundary uses the identity hash
// (from SchemaBinding) instead of the field name as the Loro container
// key. The binding is threaded through resolveContainer and stepIntoLoro.

import {
  advanceSchema,
  KIND,
  type Path,
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
// stepIntoLoro — single step of the fold
// ---------------------------------------------------------------------------

/**
 * Navigate one step deeper into the Loro container tree.
 *
 * If `current` is a LoroDoc (root), dispatches via the typed root
 * container accessors using the schema to determine the container type.
 * The key used is the identity hash when provided.
 *
 * If `current` is a Loro container, dispatches via `.get()` using
 * `.kind()` for runtime type discrimination. For Maps, uses the
 * identity hash when provided.
 *
 * @param current - The current position (LoroDoc or a container)
 * @param _currentSchema - The schema at the current position (used for root dispatch)
 * @param nextSchema - The schema of the child being navigated to
 * @param segment - The path segment to follow
 * @param identity - Optional identity hash to use instead of the segment's resolved value
 */
export function stepIntoLoro(
  current: unknown,
  _currentSchema: SchemaNode,
  nextSchema: SchemaNode,
  segment: Segment,
  identity?: string,
): unknown {
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
// resolveContainer — full path resolution via left-fold
// ---------------------------------------------------------------------------

/**
 * Result of resolving a Loro container at a path — includes both the
 * container (or scalar value) and the schema at that position.
 */
export interface ResolveResult {
  readonly container: unknown
  readonly schema: SchemaNode
}

/**
 * Resolve a Loro container (or scalar value) at the given path.
 *
 * Left-folds over path segments using `advanceSchema` for pure schema
 * descent and `stepIntoLoro` for Loro-specific container navigation.
 *
 * When a `binding` is provided, each step computes the absolute schema
 * path and looks up the identity hash from `binding.forward`. This
 * identity hash is used instead of the field name at every product-field
 * boundary (root and nested).
 *
 * Returns both the Loro container (or scalar value) at the terminal
 * position and the schema at that position.
 * For an empty path, returns the doc itself with the root schema.
 */
export function resolveContainer(
  doc: LoroDoc,
  rootSchema: SchemaNode,
  path: Path,
  binding?: SchemaBinding,
): ResolveResult {
  let current: unknown = doc
  let schema = rootSchema
  // Track the accumulated absolute schema path for identity lookup.
  // Only string (key) segments contribute — index segments are structural
  // and don't participate in identity-keying.
  let absPath = ""
  const segments = path.segments
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i] as Segment
    const nextSchema = advanceSchema(schema, seg)

    // Compute identity for this step if binding is provided and the
    // segment is a key (field name at a product boundary).
    let identity: string | undefined
    if (binding && seg.role === "key") {
      const segStr = seg.resolve() as string
      absPath = absPath ? `${absPath}.${segStr}` : segStr
      identity = binding.forward.get(absPath) as string | undefined
    }

    current = stepIntoLoro(current, schema, nextSchema, seg, identity)
    schema = nextSchema

    // Sum boundary: remaining segments resolve via plain JS property
    // access. Sound because sum variants are PlainSchema — no Loro
    // containers inside sums.
    if (schema[KIND] === "sum") {
      for (let j = i + 1; j < segments.length; j++) {
        const remaining = segments[j] as Segment
        current = (current as Record<string, unknown> | undefined)?.[
          remaining.resolve() as string
        ]
      }
      return { container: current, schema }
    }
  }
  return { container: current, schema }
}

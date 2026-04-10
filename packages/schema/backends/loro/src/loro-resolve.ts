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

import { advanceSchema, KIND, structuralKind, type Path, type Schema as SchemaNode, type Segment } from "@kyneta/schema"
import type { LoroDoc, LoroList, LoroMap, LoroMovableList } from "loro-crdt"

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
// Container type guards (via .kind(), never instanceof)
// ---------------------------------------------------------------------------

function isLoroDoc(value: unknown): value is LoroDoc {
  return (
    value !== null &&
    value !== undefined &&
    typeof value === "object" &&
    "getMap" in value &&
    "getText" in value &&
    "getList" in value &&
    "getCounter" in value &&
    typeof (value as any).getMap === "function" &&
    // LoroDoc has peerIdStr; containers do not
    "peerIdStr" in value
  )
}

function hasKind(value: unknown): value is { kind(): string } {
  return (
    value !== null &&
    value !== undefined &&
    typeof value === "object" &&
    "kind" in value &&
    typeof (value as any).kind === "function"
  )
}

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
 */
function stepFromDoc(
  doc: LoroDoc,
  fieldSchema: SchemaNode,
  key: string,
): unknown {
  // Dispatch on the schema's [KIND] directly — no annotation unwrapping
  switch (fieldSchema[KIND]) {
    case "text":
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
 */
function stepFromContainer(container: unknown, segment: Segment): unknown {
  if (!hasKind(container)) {
    // Plain value or unknown — cannot step further
    return undefined
  }

  const kind = container.kind()
  const resolved = segment.resolve()

  switch (kind) {
    case "Map":
      return (container as LoroMap).get(resolved as string)

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
 *
 * If `current` is a Loro container, dispatches via `.get()` using
 * `.kind()` for runtime type discrimination.
 *
 * @param current - The current position (LoroDoc or a container)
 * @param _currentSchema - The schema at the current position (used for root dispatch)
 * @param nextSchema - The schema of the child being navigated to
 * @param segment - The path segment to follow
 */
export function stepIntoLoro(
  current: unknown,
  _currentSchema: SchemaNode,
  nextSchema: SchemaNode,
  segment: Segment,
): unknown {
  if (isLoroDoc(current)) {
    return stepFromDoc(current, nextSchema, segment.resolve() as string)
  }

  return stepFromContainer(current, segment)
}

// ---------------------------------------------------------------------------
// resolveContainer — full path resolution via left-fold
// ---------------------------------------------------------------------------

/**
 * Resolve a Loro container (or scalar value) at the given path.
 *
 * Left-folds over path segments using `advanceSchema` for pure schema
 * descent and `stepIntoLoro` for Loro-specific container navigation.
 *
 * Returns the Loro container or scalar value at the terminal position.
 * For an empty path, returns the doc itself.
 */
export function resolveContainer(
  doc: LoroDoc,
  rootSchema: SchemaNode,
  path: Path,
): unknown {
  let current: unknown = doc
  let schema = rootSchema
  for (const seg of path.segments) {
    const nextSchema = advanceSchema(schema, seg)
    current = stepIntoLoro(current, schema, nextSchema, seg)
    schema = nextSchema
  }
  return current
}
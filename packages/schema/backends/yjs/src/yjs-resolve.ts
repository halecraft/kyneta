// yjs-resolve — Yjs-specific path resolution.
//
// Implements stepIntoYjs and resolveYjsType for schema-guided
// navigation of the Yjs shared type tree.
//
// resolveYjsType is a left-fold over path segments, accumulating
// (currentType, currentSchema) at each step. This mirrors how
// resolveContainer works for Loro — but uses `instanceof` for
// runtime type discrimination instead of Loro's `.kind()` method.
//
// Root container strategy: All schema fields are children of a single
// root `Y.Map` obtained via `doc.getMap("root")`. This root map holds
// shared types (Y.Text, Y.Array, Y.Map) and plain values uniformly.
// Using a single root Y.Map enables one `observeDeep` call that
// captures all mutations with correct relative paths.

import { advanceSchema } from "@kyneta/schema"
import type { Path, PathSegment } from "@kyneta/schema"
import type { Schema as SchemaNode } from "@kyneta/schema"
import * as Y from "yjs"

// ---------------------------------------------------------------------------
// stepIntoYjs — single step of the fold
// ---------------------------------------------------------------------------

/**
 * Navigate one step deeper into the Yjs shared type tree.
 *
 * Uses `instanceof` for runtime type discrimination:
 * - `Y.Map` → `.get(key)`
 * - `Y.Array` → `.get(index)`
 * - `Y.Text` → terminal (cannot step further)
 * - Plain value → terminal (return `undefined`)
 *
 * @param current - The current position (a Yjs shared type or plain value)
 * @param segment - The path segment to follow
 */
export function stepIntoYjs(
  current: unknown,
  segment: PathSegment,
): unknown {
  if (current instanceof Y.Map) {
    if (segment.type !== "key") {
      throw new Error(
        `yjs-resolve: Y.Map expects a key segment, got index`,
      )
    }
    return current.get(segment.key)
  }

  if (current instanceof Y.Array) {
    if (segment.type !== "index") {
      throw new Error(
        `yjs-resolve: Y.Array expects an index segment, got key "${segment.key}"`,
      )
    }
    return current.get(segment.index)
  }

  if (current instanceof Y.Text) {
    // Y.Text is a terminal type — cannot step further
    throw new Error(
      `yjs-resolve: cannot step into Y.Text with segment ${JSON.stringify(segment)}`,
    )
  }

  // Plain value — terminal, cannot step further
  return undefined
}

// ---------------------------------------------------------------------------
// resolveYjsType — full path resolution via left-fold
// ---------------------------------------------------------------------------

/**
 * Resolve a Yjs shared type (or plain value) at the given path.
 *
 * Left-folds over path segments using `advanceSchema` for pure schema
 * descent and `stepIntoYjs` for Yjs-specific navigation.
 *
 * Returns the Yjs shared type or plain value at the terminal position.
 * For an empty path, returns the root map itself.
 *
 * @param rootMap - The root `Y.Map` obtained via `doc.getMap("root")`
 * @param rootSchema - The root document schema
 * @param path - The path to resolve
 */
export function resolveYjsType(
  rootMap: Y.Map<any>,
  rootSchema: SchemaNode,
  path: Path,
): unknown {
  let current: unknown = rootMap
  let schema = rootSchema

  // Unwrap the root annotation (e.g. annotated("doc", product))
  // to reach the product schema whose fields are the root map's children.
  let rootProduct = rootSchema
  while (
    rootProduct._kind === "annotated" &&
    rootProduct.schema !== undefined
  ) {
    rootProduct = rootProduct.schema
  }

  for (let i = 0; i < path.length; i++) {
    const seg = path[i]!
    const nextSchema = advanceSchema(schema, seg)

    // For the first segment, we step into the root map directly.
    // For subsequent segments, we use stepIntoYjs on the current value.
    current = stepIntoYjs(current, seg)
    schema = nextSchema
  }

  return current
}
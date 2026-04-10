// store-reader — LoroReader implementation.
//
// Implements Reader via schema-guided live navigation of the
// Loro container tree. Each read operation resolves the container
// at the given path using resolveContainer, then extracts the
// appropriate value based on the Loro container kind.
//
// LoroText → .toString(), LoroCounter → .value, plain values as-is.
// Collections: LoroList/LoroMovableList → .length, LoroMap → .keys().

import type { Path, Reader, Schema as SchemaNode } from "@kyneta/schema"
import type { LoroDoc } from "loro-crdt"
import { hasKind } from "./loro-guards.js"
import { resolveContainer } from "./loro-resolve.js"

/**
 * Extract a scalar value from a Loro container or return a plain value as-is.
 *
 * - LoroText → `.toString()` (string)
 * - LoroCounter → `.value` (number)
 * - LoroMap → `.toJSON()` (plain object snapshot — for product/map reads)
 * - LoroList/LoroMovableList → `.toJSON()` (plain array snapshot)
 * - Plain values (string, number, boolean, null) → returned as-is
 */
function extractValue(resolved: unknown): unknown {
  if (!hasKind(resolved)) {
    // Plain scalar value (string, number, boolean, null, etc.)
    return resolved
  }

  const kind = resolved.kind()

  switch (kind) {
    case "Text":
      return (resolved as any).toString()
    case "Counter":
      return (resolved as any).value
    case "Map":
      return (resolved as any).toJSON()
    case "List":
    case "MovableList":
      return (resolved as any).toJSON()
    case "Tree":
      return (resolved as any).toJSON()
    default:
      return resolved
  }
}

// ---------------------------------------------------------------------------
// loroReader
// ---------------------------------------------------------------------------

/**
 * Creates a Reader that navigates the Loro container tree live,
 * using the schema as a type witness to determine which Loro API call
 * to make at each path segment.
 *
 * The reader is a live view — mutations to the underlying LoroDoc
 * (via `applyDiff` + `commit`, or `doc.import`) are immediately
 * visible through the reader.
 *
 * @param doc - The LoroDoc to read from.
 * @param schema - The root schema for the document.
 */
export function loroReader(doc: LoroDoc, schema: SchemaNode): Reader {
  return {
    read(path: Path): unknown {
      if (path.length === 0) {
        // Root read — return the full doc as JSON
        return (doc as any).toJSON()
      }
      const resolved = resolveContainer(doc, schema, path)
      return extractValue(resolved)
    },

    arrayLength(path: Path): number {
      const resolved = resolveContainer(doc, schema, path)
      if (!hasKind(resolved)) {
        // Plain array value (unlikely in Loro context, but handle gracefully)
        return Array.isArray(resolved) ? resolved.length : 0
      }
      const kind = resolved.kind()
      if (kind === "List" || kind === "MovableList") {
        return (resolved as any).length as number
      }
      return 0
    },

    keys(path: Path): string[] {
      const resolved = resolveContainer(doc, schema, path)
      if (!hasKind(resolved)) {
        // Plain object value
        if (
          resolved !== null &&
          resolved !== undefined &&
          typeof resolved === "object"
        ) {
          return Object.keys(resolved as Record<string, unknown>)
        }
        return []
      }
      const kind = resolved.kind()
      if (kind === "Map") {
        return (resolved as any).keys() as string[]
      }
      return []
    },

    hasKey(path: Path, key: string): boolean {
      const resolved = resolveContainer(doc, schema, path)
      if (!hasKind(resolved)) {
        // Plain object value
        if (
          resolved !== null &&
          resolved !== undefined &&
          typeof resolved === "object"
        ) {
          return key in (resolved as Record<string, unknown>)
        }
        return false
      }
      const kind = resolved.kind()
      if (kind === "Map") {
        return (resolved as any).get(key) !== undefined
      }
      return false
    },
  }
}

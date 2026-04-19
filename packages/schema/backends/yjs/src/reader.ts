// store-reader — YjsReader implementation.
//
// Implements Reader via schema-guided live navigation of the
// Yjs shared type tree. Each read operation resolves the shared type
// at the given path using resolveYjsType, then extracts the
// appropriate value based on `instanceof` discrimination.
//
// Y.Text → .toJSON() (string), Y.Map → .toJSON() (plain object),
// Y.Array → .toJSON() (plain array), plain values → as-is.
//
// Identity-keying: when a SchemaBinding is provided, resolveYjsType
// navigates Y.Map children using identity hashes instead of field names.

import type {
  Path,
  Reader,
  SchemaBinding,
  Schema as SchemaNode,
} from "@kyneta/schema"
import * as Y from "yjs"
import { resolveYjsType } from "./yjs-resolve.js"

// ---------------------------------------------------------------------------
// Value extraction
// ---------------------------------------------------------------------------

/**
 * Extract a plain value from a Yjs shared type or return a plain value as-is.
 *
 * - Y.Text → `.toJSON()` (string)
 * - Y.Map → `.toJSON()` (plain object snapshot — for product/map reads)
 * - Y.Array → `.toJSON()` (plain array snapshot)
 * - Plain values (string, number, boolean, null) → returned as-is
 */
function extractValue(resolved: unknown): unknown {
  if (resolved instanceof Y.Text) {
    return resolved.toJSON()
  }
  if (resolved instanceof Y.Map) {
    return resolved.toJSON()
  }
  if (resolved instanceof Y.Array) {
    return resolved.toJSON()
  }
  // Plain scalar value (string, number, boolean, null, etc.)
  return resolved
}

// ---------------------------------------------------------------------------
// yjsReader
// ---------------------------------------------------------------------------

/**
 * Creates a Reader that navigates the Yjs shared type tree live,
 * using the schema as a type witness to determine navigation at each
 * path segment.
 *
 * The reader is a live view — mutations to the underlying Y.Doc
 * (via `doc.transact()`, or `Y.applyUpdate()`) are immediately
 * visible through the reader.
 *
 * Internally obtains the root map via `doc.getMap("root")`.
 *
 * @param doc - The Y.Doc to read from.
 * @param schema - The root schema for the document.
 * @param binding - Optional SchemaBinding for identity-keyed navigation.
 */
export function yjsReader(
  doc: Y.Doc,
  schema: SchemaNode,
  binding?: SchemaBinding,
): Reader {
  const rootMap = doc.getMap("root")

  return {
    read(path: Path): unknown {
      if (path.length === 0) {
        // Root read — return the full root map as JSON
        return rootMap.toJSON()
      }
      const resolved = resolveYjsType(rootMap, schema, path, binding)
      return extractValue(resolved)
    },

    arrayLength(path: Path): number {
      const resolved = resolveYjsType(rootMap, schema, path, binding)
      if (resolved instanceof Y.Array) {
        return resolved.length
      }
      // Graceful fallback for plain array values
      if (Array.isArray(resolved)) {
        return resolved.length
      }
      return 0
    },

    keys(path: Path): string[] {
      const resolved = resolveYjsType(rootMap, schema, path, binding)
      if (resolved instanceof Y.Map) {
        return Array.from(resolved.keys())
      }
      // Graceful fallback for plain object values
      if (
        resolved !== null &&
        resolved !== undefined &&
        typeof resolved === "object" &&
        !Array.isArray(resolved)
      ) {
        return Object.keys(resolved as Record<string, unknown>)
      }
      return []
    },

    hasKey(path: Path, key: string): boolean {
      const resolved = resolveYjsType(rootMap, schema, path, binding)
      if (resolved instanceof Y.Map) {
        return resolved.has(key)
      }
      // Graceful fallback for plain object values
      if (
        resolved !== null &&
        resolved !== undefined &&
        typeof resolved === "object" &&
        !Array.isArray(resolved)
      ) {
        return key in (resolved as Record<string, unknown>)
      }
      return false
    },
  }
}

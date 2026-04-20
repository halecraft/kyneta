// store-reader — LoroReader implementation.
//
// Implements Reader via schema-guided live navigation of the
// Loro container tree. Each read operation resolves the container
// at the given path using resolveContainer, then extracts the
// appropriate value based on the Loro container kind.
//
// LoroText → .toString(), LoroCounter → .value, plain values as-is.
// Collections: LoroList/LoroMovableList → .length, LoroMap → .keys().
//
// Richtext: schema-guided dispatch uses toDelta() instead of toString().

import type {
  Path,
  Reader,
  RichTextDelta,
  RichTextSpan,
  SchemaBinding,
  Schema as SchemaNode,
} from "@kyneta/schema"
import { KIND } from "@kyneta/schema"
import type { Delta, LoroDoc } from "loro-crdt"
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

/**
 * Convert a Loro text delta array (from LoroText.toDelta()) to a
 * kyneta RichTextDelta (array of RichTextSpan).
 *
 * Loro format: `{ insert: string, attributes?: Record<string, unknown> }`
 * Kyneta format: `{ text: string, marks?: MarkMap }`
 */
function loroDeltaToRichTextDelta(deltas: Delta<string>[]): RichTextDelta {
  const spans: RichTextSpan[] = []
  for (const delta of deltas) {
    if (delta.insert !== undefined) {
      const attrs = (delta as any).attributes
      if (attrs && Object.keys(attrs).length > 0) {
        spans.push({ text: delta.insert, marks: attrs })
      } else {
        spans.push({ text: delta.insert })
      }
    }
  }
  return spans
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
export function loroReader(
  doc: LoroDoc,
  schema: SchemaNode,
  binding?: SchemaBinding,
): Reader {
  return {
    read(path: Path): unknown {
      if (path.length === 0) {
        // Root read — return the full doc as JSON
        return (doc as any).toJSON()
      }
      const result = resolveContainer(doc, schema, path, binding)

      // Richtext: use toDelta() and convert to RichTextDelta
      if (
        result.schema[KIND] === "richtext" &&
        hasKind(result.container) &&
        result.container.kind() === "Text"
      ) {
        const deltas = (result.container as any).toDelta() as Delta<string>[]
        return loroDeltaToRichTextDelta(deltas)
      }

      return extractValue(result.container)
    },

    arrayLength(path: Path): number {
      const { container } = resolveContainer(doc, schema, path, binding)
      if (!hasKind(container)) {
        // Plain array value (unlikely in Loro context, but handle gracefully)
        return Array.isArray(container) ? container.length : 0
      }
      const kind = container.kind()
      if (kind === "List" || kind === "MovableList") {
        return (container as any).length as number
      }
      return 0
    },

    keys(path: Path): string[] {
      const { container } = resolveContainer(doc, schema, path, binding)
      if (!hasKind(container)) {
        // Plain object value
        if (
          container !== null &&
          container !== undefined &&
          typeof container === "object"
        ) {
          return Object.keys(container as Record<string, unknown>)
        }
        return []
      }
      const kind = container.kind()
      if (kind === "Map") {
        return (container as any).keys() as string[]
      }
      return []
    },

    hasKey(path: Path, key: string): boolean {
      const { container } = resolveContainer(doc, schema, path, binding)
      if (!hasKind(container)) {
        // Plain object value
        if (
          container !== null &&
          container !== undefined &&
          typeof container === "object"
        ) {
          return key in (container as Record<string, unknown>)
        }
        return false
      }
      const kind = container.kind()
      if (kind === "Map") {
        return (container as any).get(key) !== undefined
      }
      return false
    },
  }
}

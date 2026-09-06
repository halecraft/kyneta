// loro-extract — shared value-extraction helpers for Loro containers.
//
// These functions are used by the materialize interpreter and other
// Loro internals to convert Loro containers into plain values.

import type { RichTextDelta, RichTextSpan } from "@kyneta/schema"
import type { Delta } from "loro-crdt"
import { hasKind } from "./loro-guards.js"

/**
 * Extract a scalar value from a Loro container or return a plain value as-is.
 *
 * - LoroText → `.toString()` (string)
 * - LoroCounter → `.value` (number)
 * - LoroMap → `.toJSON()` (plain object snapshot — for product/map reads)
 * - LoroList/LoroMovableList → `.toJSON()` (plain array snapshot)
 * - Plain values (string, number, boolean, null) → returned as-is
 *
 * `LoroTree` is deliberately omitted. `.toJSON()` on a tree returns a
 * nested `meta`/`children` shape with identity-hash field names — it
 * disagrees with `stepTree` / `TreeChange` / `LoroTree.toArray()`, the
 * four layers `Schema.tree` requires to agree. Tree reads go through
 * `resolveForest` (which uses `.toArray()`); this function falls through
 * to the default branch for trees, but no caller hits that path.
 */
export function extractValue(resolved: unknown): unknown {
  if (!hasKind(resolved)) {
    // Plain scalar value (string, number, boolean, null, etc.)
    return resolved
  }

  const kind = resolved.kind()

  switch (kind) {
    case "Text":
      return resolved.toString()
    case "Counter":
      return (resolved as any).value
    case "Map":
      return (resolved as any).toJSON()
    case "List":
    case "MovableList":
      return (resolved as any).toJSON()
    default:
      // Tree falls through here — handled separately by `resolveForest`.
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
export function loroDeltaToRichTextDelta(
  deltas: Delta<string>[],
): RichTextDelta {
  const spans: RichTextSpan[] = []
  for (const delta of deltas) {
    if (delta.insert !== undefined) {
      const attrs = delta.attributes
      if (attrs && Object.keys(attrs).length > 0) {
        spans.push({ text: delta.insert, marks: attrs })
      } else {
        spans.push({ text: delta.insert })
      }
    }
  }
  return spans
}

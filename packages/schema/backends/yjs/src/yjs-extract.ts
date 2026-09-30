// yjs-extract — shared value-extraction helpers for Yjs shared types.
//
// These functions are used by both the reader (yjsReader) and the
// materialize interpreter to convert Yjs shared types into plain values.

import {
  normalizeSpans,
  type RichTextDelta,
  type RichTextSpan,
} from "@kyneta/schema"
import * as Y from "yjs"

/**
 * Extract a plain value from a Yjs shared type or return a plain value as-is.
 *
 * - Y.Text → `.toJSON()` (string)
 * - Y.Map → `.toJSON()` (plain object snapshot — for product/map reads)
 * - Y.Array → `.toJSON()` (plain array snapshot)
 * - Plain values (string, number, boolean, null) → returned as-is
 */
export function extractValue(resolved: unknown): unknown {
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

/**
 * Convert a Y.Text's delta (Quill format) to a kyneta RichTextDelta.
 *
 * Yjs `.toDelta()` returns `{ insert: string, attributes?: Record<string, any> }[]`.
 * Kyneta RichTextDelta is `{ text: string, marks?: MarkMap }[]`.
 */
export function yTextToRichTextDelta(ytext: Y.Text): RichTextDelta {
  const delta = ytext.toDelta() as Array<{
    insert: string
    attributes?: Record<string, unknown>
  }>
  const spans: RichTextSpan[] = []
  for (const d of delta) {
    if (typeof d.insert !== "string") continue
    const span: RichTextSpan =
      d.attributes && Object.keys(d.attributes).length > 0
        ? { text: d.insert, marks: d.attributes }
        : { text: d.insert }
    spans.push(span)
  }
  // Normalized, as `loroDeltaToRichTextDelta` is, so a re-materialized
  // shadow reads as a stepped one does.
  return normalizeSpans(spans)
}

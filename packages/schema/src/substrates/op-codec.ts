// op-codec — ops as JSON-safe values, for the plain log and undo records.

import type { ChangeBase } from "../change.js"
import type { Op } from "../changefeed.js"
import { RawPath } from "../path.js"

// ---------------------------------------------------------------------------
// Op serialization — convert between Path objects and JSON-safe arrays
// ---------------------------------------------------------------------------

/** A JSON-safe representation of a path segment. */
export type SerializedSegment =
  | { type: "field"; field: string }
  | { type: "entry"; entry: string }
  | { type: "index"; index: number }

/** A JSON-safe representation of an Op. */
export interface SerializedOp {
  path: SerializedSegment[]
  change: ChangeBase
}

/**
 * Convert Ops with Path objects into JSON-safe form for serialization.
 * Extracts segments and produces plain `{ type, field/entry/index }` objects.
 *
 * `seg.resolve()` here never throws: an `Op`'s path is a `RawPath`, frozen
 * by the writable context when the op is made or decoded by
 * `deserializeOps`, and `RawSegment.resolve()` is total.
 */
export function serializeOps(ops: readonly Op[]): SerializedOp[] {
  return ops.map(op => ({
    path: op.path.segments.map(seg => {
      if (seg.role === "field") {
        return { type: "field" as const, field: seg.resolve() as string }
      }
      if (seg.role === "entry") {
        return { type: "entry" as const, entry: seg.resolve() as string }
      }
      return { type: "index" as const, index: seg.resolve() as number }
    }),
    change: op.change,
  }))
}

/**
 * Reconstruct Ops with RawPath objects from JSON-parsed data.
 * Converts plain `{ type, field/entry/index }` arrays back into RawPath instances.
 */
export function deserializeOps(raw: SerializedOp[]): Op[] {
  return raw.map(op => ({
    path: deserializePath(op.path),
    change: op.change,
  }))
}

export function deserializePath(segments: SerializedSegment[]): RawPath {
  let path = RawPath.empty
  for (const seg of segments) {
    if (seg.type === "field") {
      path = path.field(seg.field)
    } else if (seg.type === "entry") {
      path = path.entry(seg.entry)
    } else {
      path = path.item(seg.index)
    }
  }
  return path
}

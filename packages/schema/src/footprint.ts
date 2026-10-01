// footprint — the region of a document an undo record writes and depends on.
//
// Two records whose footprints are disjoint commute: either can be reverted
// first, and neither revert changes what the other finds. An undo stack
// across documents orders only steps whose footprints overlap. Each
// substrate states its records' footprint on `RevertibleCommit`, so the stack
// never reads a schema.

import type { Op } from "./changefeed.js"
import { landed, touchedBy, uncovered } from "./landing.js"
import type { Schema as SchemaNode } from "./schema.js"

/**
 * A region of one document: each path covers its subtree, as its
 * `segmentKeys`, up to the first list index. `[[]]` is the whole document,
 * and `[]` is nothing. Normalized: no path covers another.
 */
export type Footprint = readonly (readonly string[])[]

/** The whole document: what a strict stack's record depends on. */
export const WHOLE_DOCUMENT: Footprint = [[]]

/**
 * Where `ops` landed in a document of `schema`, at its storage grain
 * (`landed`), each path cut to its stable prefix (`Path.stablePrefix`), so it
 * names the same region through remote edits, remaps and a reload.
 */
export function footprintOf(schema: SchemaNode, ops: readonly Op[]): Footprint {
  const paths = touchedBy(ops).flatMap(touched =>
    landed(schema, touched).map(({ path }) => path.stablePrefix().segmentKeys),
  )
  return uncovered(paths, keys => keys)
}

/** Every path of `footprints`, normalized. */
export function footprintUnion(...footprints: readonly Footprint[]): Footprint {
  return uncovered(footprints.flat(), keys => keys)
}

/** Whether some path of `a` is a prefix of some path of `b`, or the reverse. */
export function footprintsOverlap(a: Footprint, b: Footprint): boolean {
  return a.some(p => b.some(q => isPrefix(p, q) || isPrefix(q, p)))
}

function isPrefix(prefix: readonly string[], of: readonly string[]): boolean {
  return prefix.length <= of.length && prefix.every((key, i) => key === of[i])
}

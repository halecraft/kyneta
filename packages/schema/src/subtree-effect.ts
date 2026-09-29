// subtree-effect — which part of the tree below a change's path it may have
// rewritten.
//
// Pure. A change either edits the node at its path in place, or may rewrite
// part of the tree below it wholesale. Everything that keeps per-coordinate
// state (addresses, memoized carriers, cached reads) asks this one function
// where that state may no longer hold, so no two of them can disagree.

import type { ChangeBase } from "./change.js"
import {
  isMapChange,
  isReplaceChange,
  isTreeChange,
  mapChangeEffects,
} from "./change.js"

/**
 * The part of the tree strictly below a change's path that the change may
 * have rewritten or removed.
 *
 * - `"none"`: nothing below the path, beyond what the change's own
 *   instructions say (a sequence edit's deletions are settled by advancing
 *   addresses, not here).
 * - `"all"`: anything below the path.
 * - `{ keys }`: the children at these segment keys, and anything below them.
 *   Never empty: a change that names no keys is `"none"`.
 *
 * Rewritten and removed are not told apart. Every consumer examines the
 * named coordinates, and whether each still exists decides the rest.
 */
export type SubtreeEffect =
  | "none"
  | "all"
  | { readonly keys: readonly string[] }

/**
 * What `change` may have rewritten below its path.
 *
 * - A `replace`, and a map change that clears, rewrite everything below.
 * - A map change without a clear rewrites the keys it writes or removes,
 *   read through `mapChangeEffects` so a key named in both lists has one
 *   rule everywhere.
 * - A tree change removes the nodes it deletes. Creates and moves leave
 *   every node's data where it was.
 * - Everything else — sequence and movable edits, text, counters, rich text,
 *   set ops, and any change type this package does not define — rewrites
 *   nothing below.
 */
export function planSubtreeEffect(change: ChangeBase): SubtreeEffect {
  if (isReplaceChange(change)) return "all"
  if (isMapChange(change)) {
    if (change.clear) return "all"
    const { set, remove } = mapChangeEffects(change, [])
    const keys = [...Object.keys(set), ...remove]
    return keys.length === 0 ? "none" : { keys }
  }
  if (isTreeChange(change)) {
    const keys: string[] = []
    for (const instruction of change.instructions) {
      if (instruction.action === "delete") keys.push(instruction.target)
    }
    return keys.length === 0 ? "none" : { keys }
  }
  return "none"
}

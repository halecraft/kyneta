// subtree-effect — which part of the tree below a change's path it may have
// rewritten, and what the change looks like from inside that part.
//
// Pure. A change either edits the node at its path in place, or may rewrite
// part of the tree below it wholesale. Everything that keeps per-coordinate
// state (addresses, memoized carriers, cached reads, subscribers, population)
// asks `planSubtreeEffect` where that state may no longer hold, so no two of
// them can disagree.

import type { ChangeBase } from "./change.js"
import {
  isMapChange,
  isReplaceChange,
  isTreeChange,
  mapChangeEffects,
  replaceChange,
  treeChange,
  trustAsOwned,
} from "./change.js"
import { RawPath, type Segment } from "./path.js"

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
 * - Everything else rewrites nothing below: sequence and movable edits, text,
 *   counters, rich text, set ops, and any change type this package does not
 *   define.
 */
export function planSubtreeEffect(change: ChangeBase): SubtreeEffect {
  if (isReplaceChange(change)) return "all"
  if (isMapChange(change)) {
    if (change.clear) return "all"
    const { set, remove } = mapChangeEffects(change, () => [])
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

/**
 * `change`, made at a path P, as seen from the coordinate at `relative`
 * below P, which lies in `planSubtreeEffect(change)`'s scope.
 *
 * - The coordinate's new value, as a `replace`: read along `relative` from a
 *   `replace`'s value, or from the value a map change writes at the key.
 * - `replace(undefined)` where the change removed it: a key a map change
 *   deletes or clears, anything below a deleted tree node, and any coordinate
 *   reached through a list item, since a rewrite leaves an item no
 *   correspondence (the item is dropped, as `planAddressFates` drops it).
 * - At a tree node the change deleted, the tree-delete terminal: a
 *   `TreeChange` deleting that node, the event a subscriber there
 *   pattern-matches as end-of-stream.
 *
 * This is how a subscriber below a coarse write hears it: delivery hands it
 * the projection, at its own relative root, while the op itself, and every
 * ancestor's changeset, stay as written. `expandProductMapChanges` uses the
 * same projection to split a struct's map event into field writes.
 */
export function projectChange(
  change: ChangeBase,
  relative: readonly Segment[],
): ChangeBase {
  const [head, ...rest] = relative
  if (head === undefined) return change
  if (isReplaceChange(change)) return valueAt(change.value, relative)
  if (isMapChange(change)) {
    // A key in scope is written or removed; `mapChangeEffects` says which.
    const { set } = mapChangeEffects(change, () => [])
    const key = String(head.coord())
    return Object.hasOwn(set, key) ? valueAt(set[key], rest) : removed()
  }
  if (isTreeChange(change)) {
    return rest.length === 0
      ? treeChange([{ action: "delete", target: String(head.coord()) }])
      : removed()
  }
  return removed()
}

/** A `replace` of what `value` holds at `relative`. */
function valueAt(value: unknown, relative: readonly Segment[]): ChangeBase {
  let path = RawPath.empty
  for (const segment of relative) {
    if (segment.role === "index") return removed()
    const key = String(segment.coord())
    path = segment.role === "field" ? path.field(key) : path.entry(key)
  }
  // The change's own payload, handed on to a subscriber below it.
  return replaceChange(trustAsOwned(path.read(value)))
}

function removed(): ChangeBase {
  return replaceChange(undefined)
}

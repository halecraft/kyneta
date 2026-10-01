// plain-access — one way to step from a plain container to its child.
//
// σ is plain JSON, so a path segment is a property access, except at a tree:
// σ holds a forest as a flat array of `{ id, parent, index, data }` nodes,
// and an `entry` segment there names a node by id and steps into its `data`.
// Reads (`AbstractPath.read`, `.get`) and writes (`applyChange`) both step
// through here, so the two cannot disagree about where a child lives.

import type { Segment } from "./path.js"

/** A node of the flat forest σ holds at a tree. */
interface ForestNode {
  readonly id: string
  readonly data: unknown
}

/**
 * Whether `arr` is the flat-forest shape `stepTree` produces. Recognized
 * structurally, so a path can step into a node's data without a schema. Asked
 * only at an `entry` segment, which keeps the test from misfiring on a list
 * whose items happen to have `id` and `data` keys.
 */
function isFlatForestArray(arr: readonly unknown[]): boolean {
  if (arr.length === 0) return false
  const first = arr[0]
  return (
    typeof first === "object" &&
    first !== null &&
    typeof (first as { id?: unknown }).id === "string" &&
    "data" in first
  )
}

function isForestStep(container: object, segment: Segment): boolean {
  return (
    segment.role === "entry" &&
    Array.isArray(container) &&
    isFlatForestArray(container)
  )
}

/**
 * The child of `container` at `segment`, or `undefined` when there is none.
 * Only an own property is a child, so a key such as `"constructor"` reads as
 * absent rather than reaching the prototype. Uses `coord()`, so a dead segment reads as absent rather than throwing: a
 * deleted key is absent, not a bug.
 */
export function childOf(container: unknown, segment: Segment): unknown {
  if (typeof container !== "object" || container === null) return undefined
  const key = segment.coord()
  if (isForestStep(container, segment)) {
    const node = (container as readonly ForestNode[]).find(n => n.id === key)
    return node?.data
  }
  const record = container as Record<string | number, unknown>
  return Object.hasOwn(record, key) ? record[key] : undefined
}

/**
 * Set the child of `container` at `segment` to `value`. `container` must be
 * unfrozen. At a forest node the node is replaced by a copy if it is frozen,
 * so the write never reaches a node a reader holds. Returns `false`, writing
 * nothing, when the forest has no node with that id.
 */
export function withChild(
  container: object,
  segment: Segment,
  value: unknown,
): boolean {
  const key = segment.coord()
  if (isForestStep(container, segment)) {
    const forest = container as ForestNode[]
    const index = forest.findIndex(n => n.id === key)
    if (index === -1) return false
    const node = forest[index] as ForestNode
    if (Object.isFrozen(node)) forest[index] = { ...node, data: value }
    else (node as { data: unknown }).data = value
    return true
  }
  ;(container as Record<string | number, unknown>)[key] = value
  return true
}

// facade/last-updated.ts — read the LWW timestamp from a state ref.
//
// Extracts the underlying `[Value, Timestamp]` tuple's timestamp from
// a `state` substrate ref.

import { hasTransact, PATH, TRANSACT } from "../interpreters/writable.js"
import { BACKING_DOC } from "../substrate.js"
import type { StateTree } from "../substrates/state-tree.js"
import { isStateTuple } from "../substrates/state-tree.js"

function getMaxTimestamp(tree: StateTree | undefined | null): number | null {
  if (tree === undefined || tree === null) return null
  if (isStateTuple(tree)) {
    return tree[1]
  }
  if (typeof tree !== "object" || Array.isArray(tree)) return null

  let maxTs: number | null = null
  for (const key of Object.keys(tree)) {
    const childTs = getMaxTimestamp(tree[key] as StateTree)
    if (childTs !== null) {
      if (maxTs === null || childTs > maxTs) {
        maxTs = childTs
      }
    }
  }
  return maxTs
}

/**
 * Reads the LWW timestamp for the given reference.
 *
 * This only works for references backed by the `state` substrate.
 * For any other substrate, or if the path does not resolve to a
 * tuple, it returns `null`.
 *
 * @param ref - A reference from a `state` document.
 * @returns The timestamp (in milliseconds since epoch) or `null`.
 */
export function lastUpdated(ref: unknown): number | null {
  if (!hasTransact(ref)) return null

  const ctx = ref[TRANSACT]
  const path = ref[PATH]

  if (!(BACKING_DOC in ctx)) return null

  const backingDoc = (ctx as any)[BACKING_DOC]

  // The backing doc for a `state` substrate is a StateTree.
  // We need to traverse the path to find the tuple.
  let current: unknown = backingDoc
  for (const segment of path.segments) {
    if (isStateTuple(current)) {
      // Reached a leaf prematurely.
      return null
    }
    if (
      typeof current !== "object" ||
      current === null ||
      Array.isArray(current)
    ) {
      return null
    }

    // We only support field and entry segments in state trees,
    // and both map to object properties.
    const key = String(segment.resolve())

    current = (current as Record<string, unknown>)[key]

    if (current === undefined) return null
  }

  if (isStateTuple(current)) {
    return current[1]
  }

  // If it's a container, its effective timestamp is the maximum
  // timestamp of all its leaves (the last time any part of it changed).
  return getMaxTimestamp(current as StateTree)
}

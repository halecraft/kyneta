// state-tree — CvRDT field-level LWW state space.
//
// Defines the core data structure and merge algebra for the `state` substrate.
// A StateTree is isomorphic to the document schema, but every scalar leaf
// is replaced with a `StateTuple = [value: unknown, timestamp: number]`.
//
// Because the `state` substrate supports only LWW laws (`"lww" | "lww-per-key"`),
// containers are limited to structs and maps. This creates a mathematically
// clean separation: any JSON array (`[]`) encountered in a StateTree is
// unambiguously a leaf tuple, not a sequence container.
//
// This enables `mergeStateTree` to be completely schema-blind, fulfilling
// the requirement that headless replicas (relays, stores) can merge entirety
// payloads without schema knowledge.

import type { PlainState } from "../reader.js"

// ---------------------------------------------------------------------------
// StateTuple & StateTree
// ---------------------------------------------------------------------------

/**
 * The fundamental LWW field-level state element.
 * `[0]` is the scalar value (or structural zero), `[1]` is the wall-clock timestamp.
 */
export type StateTuple = [value: unknown, timestamp: number]

/**
 * A recursive tree of tuples.
 * Containers are `Record<string, StateTree>`.
 * Leaves are `StateTuple`.
 */
export type StateTree = StateTuple | Record<string, any>

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/**
 * Check if a StateTree node is a leaf tuple.
 * Because sequences are not supported by `state.bind`, any Array is a StateTuple.
 */
export function isStateTuple(node: unknown): node is StateTuple {
  return Array.isArray(node) && node.length === 2 && typeof node[1] === "number"
}

// ---------------------------------------------------------------------------
// Merge Algebra (Join Semilattice)
// ---------------------------------------------------------------------------

/**
 * Schema-blind recursive merge of two StateTrees.
 *
 * This implements the $A \sqcup B$ join operation for the CvRDT.
 * For leaf tuples, it takes the maximum timestamp.
 * For containers, it takes the union of keys and recurses.
 *
 * Modifies `local` in-place and returns it.
 */
export function mergeStateTree(local: StateTree, remote: StateTree): StateTree {
  if (isStateTuple(local) && isStateTuple(remote)) {
    // Highest T wins. In a tie, arbitrarily pick remote to be deterministic
    // (though values should ideally be identical if T is identical).
    if (remote[1] >= local[1]) {
      local[0] = remote[0]
      local[1] = remote[1]
    }
    return local
  }

  // Type mismatch fallback (should not happen with valid peer data,
  // but if it does, LWW replacement is the safest degraded behavior).
  if (isStateTuple(local) || isStateTuple(remote)) {
    // We cannot merge a tuple with an object. Remote wins (overwrite).
    // Note: since we mutate local in place, if remote is an object,
    // we just replace local entirely. However, we can't cleanly mutate a tuple
    // into an object in-place in TS without returning it.
    // The safest is to return the remote clone.
    return deepClone(remote)
  }

  // Both are objects (containers). Union the keys.
  const l = local as Record<string, StateTree>
  const r = remote as Record<string, StateTree>

  for (const key of Object.keys(r)) {
    if (key in l) {
      l[key] = mergeStateTree(l[key], r[key])
    } else {
      l[key] = deepClone(r[key])
    }
  }

  return l
}

// ---------------------------------------------------------------------------
// PlainState Extraction (Shadow generation)
// ---------------------------------------------------------------------------

/**
 * Recursively strip timestamps from a StateTree to produce a canonical
 * `PlainState` shadow for the `plainReader`.
 *
 * Mutates `target` in place by projecting `tree` onto it, removing absent
 * keys and updating present ones.
 */
export function extractPlainState(tree: StateTree, target: PlainState): void {
  if (isStateTuple(tree)) {
    throw new Error(
      "extractPlainState requires a root container, received a tuple",
    )
  }

  const sourceObj = tree as Record<string, StateTree>

  for (const key of Object.keys(sourceObj)) {
    const child = sourceObj[key]
    if (isStateTuple(child)) {
      target[key] = child[0]
    } else {
      // It's a nested container.
      if (typeof target[key] !== "object" || target[key] === null) {
        target[key] = {}
      }
      extractPlainState(child, target[key] as PlainState)
    }
  }

  // Remove keys that are in target but not in source.
  for (const key of Object.keys(target)) {
    if (!(key in sourceObj)) {
      delete target[key]
    }
  }
}

// ---------------------------------------------------------------------------
// Clone Helper
// ---------------------------------------------------------------------------

function deepClone(value: any): any {
  if (Array.isArray(value)) return [value[0], value[1]] // StateTuple
  if (typeof value === "object" && value !== null) {
    const clone: Record<string, any> = {}
    for (const key of Object.keys(value)) {
      clone[key] = deepClone(value[key])
    }
    return clone
  }
  return value
}

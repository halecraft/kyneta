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
import { KIND, type Schema as SchemaNode } from "../schema.js"
import { Zero } from "../zero.js"

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
 *
 * When `schema` and `now` are supplied, the projection is time-aware:
 * any leaf whose `(schema.decayMs)` is set and whose tuple timestamp is
 * older than `now - decayMs` is replaced with `Zero.structural(schema)`
 * in the shadow. This is purely a projection — the underlying `StateTree`
 * math is never mutated, so the version clock does not advance and the
 * network never sees a synthesized "absent" write.
 *
 * Returns `true` if any field was masked by decay (used by the substrate's
 * `tick()` to decide whether to fire the changefeed).
 */
export function extractPlainState(
  tree: StateTree,
  target: PlainState,
  schema?: SchemaNode,
  now?: number,
): boolean {
  if (isStateTuple(tree)) {
    throw new Error(
      "extractPlainState requires a root container, received a tuple",
    )
  }

  const { anyDecayed } = extractInto(
    tree as Record<string, StateTree>,
    target,
    schema,
    now,
  )
  return anyDecayed
}

/**
 * Inner recursion. Walks `source` (a StateTree container) alongside
 * `schema` (when provided), projecting values into `target`.
 */
function extractInto(
  source: Record<string, StateTree>,
  target: PlainState,
  schema: SchemaNode | undefined,
  now: number | undefined,
): { anyDecayed: boolean; maxTimestamp: number } {
  let anyDecayed = false
  let maxTimestamp = 0

  let keys = Object.keys(source)

  // For discriminated unions, we MUST extract the discriminant field first.
  // Otherwise, if we extract sibling fields before the discriminant is updated in `target`,
  // `childSchemaForKey` will resolve schemas using the old (or structural zero) discriminant value.
  if (schema && schema[KIND] === "sum") {
    const sumSchema = schema as any
    if (sumSchema.discriminant !== undefined) {
      const discKey = sumSchema.discriminant
      keys = keys.sort((a, b) => {
        if (a === discKey) return -1
        if (b === discKey) return 1
        return 0
      })
    }
  }

  for (const key of keys) {
    const child = source[key]
    if (!isStateTuple(child)) {
      // Nested container. Resolve the child schema if we can.
      const childSchema = schema
        ? childSchemaForKey(schema, key, target)
        : undefined
      if (typeof target[key] !== "object" || target[key] === null) {
        target[key] = {}
      }
      const result = extractInto(
        child,
        target[key] as PlainState,
        childSchema,
        now,
      )
      if (result.anyDecayed) {
        anyDecayed = true
      }
      maxTimestamp = Math.max(maxTimestamp, result.maxTimestamp)
      continue
    }

    // Leaf tuple.
    const childSchema = schema
      ? childSchemaForKey(schema, key, target)
      : undefined

    maxTimestamp = Math.max(maxTimestamp, child[1])

    const decayed =
      childSchema !== undefined &&
      now !== undefined &&
      isExpired(childSchema, child, now)

    if (decayed) {
      target[key] = Zero.structural(childSchema)
      anyDecayed = true
    } else {
      target[key] = child[0]
    }
  }

  // Remove keys that are in target but not in source.
  for (const key of Object.keys(target)) {
    if (!(key in source)) {
      delete target[key]
    }
  }

  // Container decay: if this container schema has a decayMs and the latest
  // tuple within it has expired, decay the entire container to its structural zero.
  if (schema && now !== undefined) {
    const decayMs = (schema as { decayMs?: number }).decayMs
    if (
      decayMs !== undefined &&
      maxTimestamp > 0 &&
      now - maxTimestamp > decayMs
    ) {
      // Reset the target to the structural zero of this container
      const structuralZero = Zero.structural(schema) as Record<string, unknown>
      for (const key of Object.keys(target)) delete target[key]
      for (const [key, val] of Object.entries(structuralZero)) {
        target[key] = val
      }
      anyDecayed = true
    }
  }

  return { anyDecayed, maxTimestamp }
}

/**
 * Given a container schema, resolve the schema node for the named child.
 * `state` supports product (`fields`), map (`item`), and sum (`variantMap`).
 * Other kinds have no keyed children and return `undefined`.
 */
function childSchemaForKey(
  schema: SchemaNode,
  key: string,
  target: PlainState,
): SchemaNode | undefined {
  switch (schema[KIND]) {
    case "product":
      return (schema as { fields: Record<string, SchemaNode> }).fields[key]
    case "map":
      return (schema as { item: SchemaNode }).item
    case "sum": {
      const sumSchema = schema as any
      if (sumSchema.discriminant !== undefined) {
        // Discriminated union. Read the discriminant value from the target state.
        const discValue = target[sumSchema.discriminant]
        // If the discriminant value isn't populated in target yet, it means we might be extracting
        // it right now! If the key IS the discriminant, we can just return the schema of the discriminant
        // from the first variant (it's identical across all variants).
        if (key === sumSchema.discriminant) {
          const firstVariant = sumSchema.variants[0]
          return firstVariant.fields[key]
        }
        if (
          typeof discValue === "string" &&
          discValue in sumSchema.variantMap
        ) {
          const variantSchema = sumSchema.variantMap[discValue]
          // The nested field's schema is found on the active variant's fields
          return variantSchema.fields?.[key]
        }
      }
      return undefined
    }
    default:
      return undefined
  }
}

/**
 * True if the schema declares `decayMs` and the tuple's timestamp has
 * elapsed past the decay window measured from `now`.
 */
function isExpired(
  schema: SchemaNode,
  tuple: StateTuple,
  now: number,
): boolean {
  const decayMs = (schema as { decayMs?: number }).decayMs
  if (decayMs === undefined) return false
  return now - tuple[1] > decayMs
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

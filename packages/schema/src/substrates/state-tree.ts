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
// An *atomic register* — a `sum` variant or a `.json()` blob — is likewise
// stored as ONE leaf tuple whose value (the tuple's `[0]`) is the whole
// object, rather than being decomposed into per-field tuples. Atomicity is
// therefore encoded in the tree's *shape*: because a register is a single
// tuple, the schema-blind merge treats it atomically for free (see
// "Tree construction" below).
//
// This is what lets `mergeStateTree` be completely schema-blind, fulfilling
// the requirement that headless replicas (relays, stores) can merge entirety
// payloads without schema knowledge.

import type { ChangeBase } from "../change.js"
import type { Path } from "../interpret.js"
import { deepClonePlain } from "../inverse.js"
import { needsContainer } from "../materialize-value.js"
import type { PlainState } from "../reader.js"
import { advanceSchema, KIND, type Schema as SchemaNode } from "../schema.js"
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
 * A `sum`/`.json()` register is a single leaf tuple *by construction* (see
 * "Tree construction" below), so this schema-blind join merges it atomically
 * — highest-T wins on the whole variant, never blending fields across
 * variants. That structural encoding is exactly why merge needs no schema:
 * headless relays/stores converge on raw payloads without one.
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

  for (const key of Object.keys(source)) {
    const child = source[key]
    if (!isStateTuple(child)) {
      // Nested container. Resolve the child schema if we can.
      const childSchema = schema ? childSchemaForKey(schema, key) : undefined
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
    const childSchema = schema ? childSchemaForKey(schema, key) : undefined

    maxTimestamp = Math.max(maxTimestamp, child[1])

    const decayed =
      childSchema !== undefined &&
      now !== undefined &&
      isExpired(childSchema, child, now)

    if (decayed) {
      target[key] = Zero.structural(childSchema)
      anyDecayed = true
    } else {
      // A register (sum / .json()) is stored as one tuple whose value is a
      // whole object; clone it so the shadow never aliases the StateTree.
      const value = child[0]
      target[key] =
        typeof value === "object" && value !== null
          ? deepClonePlain(value)
          : value
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
 * The schema node for a named child of a container schema. `state`'s only
 * containers are product (`fields[key]`) and map (`item`) — a sum is stored as
 * one atomic leaf tuple, so it is never descended into and needs no case here.
 */
function childSchemaForKey(
  schema: SchemaNode,
  key: string,
): SchemaNode | undefined {
  switch (schema[KIND]) {
    case "product":
      return (schema as { fields: Record<string, SchemaNode> }).fields[key]
    case "map":
      return (schema as { item: SchemaNode }).item
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

// ---------------------------------------------------------------------------
// Tree construction — plain value / change → StateTree
// ---------------------------------------------------------------------------
// These build (or mutate) a StateTree from a plain value or a Change. They
// live here alongside the merge/extract algebra so the whole StateTree
// transform layer is one functional core; the `state` substrate (the
// imperative shell) just calls them.
//
// The one decision they share is leaf-vs-container. Products and maps
// decompose into per-field tuples — that is what gives `state` its
// field-level merge. Scalars and *registers* — a `sum` variant or a
// `.json()` blob, for which `needsContainer` is false — are stored as ONE
// `[value, timestamp]` tuple. Storing a register whole is what stops
// `mergeStateTree` from blending fields across variants: a sum is opaque to
// the CRDT, exactly like a scalar (variant fields are not independently
// addressable — a variant switch is a single whole-value `.set()`).

/**
 * Should `value` be decomposed into per-field tuples (a container), or stored
 * as one atomic tuple (a scalar or register)? Only a plain (non-array) object
 * can be a decomposed container. A missing schema falls back to the
 * historical "decompose any object" behavior.
 */
function isDecomposedContainer(
  value: unknown,
  nodeSchema: SchemaNode | undefined,
): boolean {
  const isPlainObject =
    typeof value === "object" && value !== null && !Array.isArray(value)
  if (!isPlainObject) return false
  return nodeSchema === undefined || needsContainer(nodeSchema)
}

/**
 * Wrap a leaf value in a `StateTuple`, deep-cloning objects/arrays (register
 * values) so the tree never aliases the caller's live value.
 */
function leafTuple(value: unknown, timestamp: number): StateTuple {
  const stored =
    typeof value === "object" && value !== null ? deepClonePlain(value) : value
  return [stored, timestamp]
}

/**
 * The schema node at `path`, or `undefined` if it can't be resolved. Walks one
 * segment at a time via `advanceSchema` (the same discipline as
 * `findJsonBoundary`). Write paths never target *inside* a register, so this
 * stops at the register boundary and never descends past a sum.
 */
function schemaAtPath(
  root: SchemaNode | undefined,
  path: Path,
): SchemaNode | undefined {
  if (!root) return undefined
  let node: SchemaNode = root
  for (const segment of path.segments) {
    try {
      node = advanceSchema(node, segment)
    } catch {
      return undefined
    }
  }
  return node
}

/**
 * Apply a change directly to the StateTree, stamping mutated leaves with the
 * given timestamp. `schema` is the document root schema; it is threaded so a
 * mutated register (sum / `.json()`) lands as a single atomic tuple instead of
 * being decomposed into blendable per-field tuples.
 */
export function applyChangeToStateTree(
  tree: StateTree,
  path: Path,
  change: ChangeBase,
  timestamp: number,
  schema: SchemaNode | undefined,
): void {
  if (path.length === 0) {
    if (change.type === "replace") {
      const val = (change as any).value
      if (typeof val === "object" && val !== null && !Array.isArray(val)) {
        // Deep replace of the whole root (always a product). Decompose so
        // nested registers still land atomically (schema threaded through).
        const newTree: Record<string, StateTree> = {}
        syncStateTreeToShadow(newTree, val, schema, timestamp)
        const target = tree as Record<string, StateTree>
        for (const k of Object.keys(target)) delete target[k]
        for (const k of Object.keys(newTree)) target[k] = newTree[k]
      } else {
        throw new Error("Cannot replace root with a scalar")
      }
    } else if (change.type === "map") {
      const target = tree as Record<string, StateTree>
      const mapChange = change as any
      for (const [key, instruction] of Object.entries(mapChange.entries)) {
        if ((instruction as any).type === "delete") {
          delete target[key]
        } else if ((instruction as any).type === "set") {
          const val = (instruction as any).value
          const childSchema = schema
            ? childSchemaForKey(schema, key)
            : undefined
          if (isDecomposedContainer(val, childSchema)) {
            const newTree: Record<string, StateTree> = {}
            syncStateTreeToShadow(newTree, val, childSchema, timestamp)
            target[key] = newTree
          } else {
            target[key] = leafTuple(val, timestamp)
          }
        }
      }
    }
    return
  }

  // Resolve the schema at the target node so a register replace stays atomic.
  const targetSchema = schemaAtPath(schema, path)

  // Traverse to the parent of the target node.
  let current: unknown = tree
  for (let i = 0; i < path.length - 1; i++) {
    const segment = path.segments[i]
    const key = String(segment.resolve())
    let next = (current as Record<string, unknown>)[key]
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      next = {}
      ;(current as Record<string, unknown>)[key] = next
    }
    current = next
  }

  const lastSegment = path.segments[path.length - 1]
  const key = String(lastSegment.resolve())
  const target = current as Record<string, StateTree>

  if (change.type === "replace") {
    const val = (change as any).value
    if (isDecomposedContainer(val, targetSchema)) {
      const newTree: Record<string, StateTree> = {}
      syncStateTreeToShadow(newTree, val, targetSchema, timestamp)
      target[key] = newTree
    } else {
      target[key] = leafTuple(val, timestamp)
    }
  } else if (change.type === "map") {
    let child = target[key]
    if (typeof child !== "object" || child === null || Array.isArray(child)) {
      child = {}
      target[key] = child
    }
    const mapChange = change as any
    const cTarget = child as Record<string, StateTree>
    for (const [k, instruction] of Object.entries(mapChange.entries)) {
      if ((instruction as any).type === "delete") {
        delete cTarget[k]
      } else if ((instruction as any).type === "set") {
        const val = (instruction as any).value
        // The map's item schema decides whether an entry is a register.
        const itemSchema = targetSchema
          ? childSchemaForKey(targetSchema, k)
          : undefined
        if (isDecomposedContainer(val, itemSchema)) {
          const newTree: Record<string, StateTree> = {}
          syncStateTreeToShadow(newTree, val, itemSchema, timestamp)
          cTarget[k] = newTree
        } else {
          cTarget[k] = leafTuple(val, timestamp)
        }
      }
    }
  }
}

/**
 * Propagate a plain value (from user mutations) into a StateTree, guided by
 * `schema`: containers decompose, scalars and registers become one tuple.
 */
export function syncStateTreeToShadow(
  tree: StateTree,
  plain: any,
  schema: SchemaNode | undefined,
  timestamp: number,
): void {
  if (isStateTuple(tree)) {
    throw new Error("Cannot sync into a root tuple.")
  }

  const target = tree as Record<string, StateTree>

  for (const key of Object.keys(plain)) {
    const val = plain[key]
    const childSchema = schema ? childSchemaForKey(schema, key) : undefined

    if (isDecomposedContainer(val, childSchema)) {
      // Container (product/map): reuse an existing subtree so a partial update
      // merges into it; replace a tuple/absent slot with a fresh container.
      if (!target[key] || isStateTuple(target[key])) {
        target[key] = {}
      }
      syncStateTreeToShadow(target[key], val, childSchema, timestamp)
    } else {
      // Scalar or register (sum / .json()): one atomic tuple.
      target[key] = leafTuple(val, timestamp)
    }
  }

  // Remove keys deleted from plain.
  for (const key of Object.keys(target)) {
    if (!(key in plain)) {
      delete target[key]
    }
  }
}

/**
 * Seed structural-zero defaults (timestamp 0 = genesis, lineage ⊥) for keys
 * missing from `tree`, guided by `schema` so a register default (e.g. a sum's
 * first variant) is seeded as one atomic tuple.
 */
export function insertStructuralZeros(
  tree: StateTree,
  defaults: any,
  schema: SchemaNode | undefined,
): void {
  if (isStateTuple(tree)) return

  const t = tree as Record<string, StateTree>

  for (const key of Object.keys(defaults)) {
    const defaultVal = defaults[key]
    const childSchema = schema ? childSchemaForKey(schema, key) : undefined

    if (!(key in t)) {
      if (isDecomposedContainer(defaultVal, childSchema)) {
        t[key] = {}
        insertStructuralZeros(t[key], defaultVal, childSchema)
      } else {
        t[key] = leafTuple(defaultVal, 0)
      }
    } else if (isDecomposedContainer(defaultVal, childSchema)) {
      // Present container: fill any nested gaps.
      insertStructuralZeros(t[key], defaultVal, childSchema)
    }
  }
}

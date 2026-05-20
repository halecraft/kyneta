// reader — shared utilities for reading, writing, and applying changes
// to a plain state object.
//
// These are backend-agnostic helpers used by multiple interpreters
// (writable, plain, validate, changefeed). Extracted from writable.ts
// to eliminate cross-module coupling.

import type { ChangeBase } from "./change.js"
import { isNonNullObject } from "./guards.js"
import type { Path } from "./path.js"
import { step } from "./step.js"

// ---------------------------------------------------------------------------
// FlatTreeNodeTopology — topology projection without per-node data
// ---------------------------------------------------------------------------

/**
 * Tree topology without per-node data — what `Reader.forestTopology`
 * returns. The catamorphism iterates topology and walks each node's data
 * lazily; interpreters that only need shape (addressing prepare-time
 * tombstoning) can iterate this without forcing per-node interpretation.
 *
 * Re-exported from `forest.ts` for proximity to its sibling types.
 */
export interface FlatTreeNodeTopology {
  readonly id: string
  readonly parent: string | null
  readonly index: number
}

// ---------------------------------------------------------------------------
// PlainState type
// ---------------------------------------------------------------------------

/**
 * A plain JS object used as the backing state for the plain substrate.
 * The writable interpreter reads from and writes to this object,
 * proving no CRDT runtime is needed.
 */
export type PlainState = Record<string, unknown>

// ---------------------------------------------------------------------------
// Reader — abstract read interface for interpreter state access
// ---------------------------------------------------------------------------

/**
 * Abstract read interface for the interpreter stack.
 *
 * Interpreters read from state exclusively through this interface,
 * allowing substrates to provide their own read semantics. The plain
 * substrate wraps a `Record<string, unknown>` via `plainReader`;
 * a Loro substrate navigates the Loro container tree directly.
 */
export interface Reader {
  /** Read the value at the given path. */
  read(path: Path): unknown
  /** Length of the sequence at the given path. */
  arrayLength(path: Path): number
  /** Keys of the map/product at the given path. */
  keys(path: Path): string[]
  /** Whether the map/product at the given path contains the key. */
  hasKey(path: Path, key: string): boolean
  /**
   * Topology at a `Schema.tree` path — substrate-blind. The third reader
   * family (after value reads and length/keys) — kept here so the
   * catamorphism's `tree` case has a uniform topology source across
   * substrates. Returns `[]` for substrates that don't support trees.
   */
  forestTopology(path: Path): readonly FlatTreeNodeTopology[]
}

/**
 * Wraps a plain JS object in a Reader.
 *
 * **Liveness invariant:** The returned reader is a *live view* — mutations
 * to the state via `applyChange` are immediately visible through the
 * reader. The reader and the mutator share the same backing object.
 *
 * Other substrates (e.g. Loro) provide their own Reader that reads
 * from a different backing structure (the Loro container tree).
 */
export function plainReader(state: Record<string, unknown>): Reader {
  return {
    read: path => path.read(state),
    arrayLength: path => readArrayLength(state, path),
    keys: path => readKeys(state, path),
    hasKey: (path, key) => readHasKey(state, path, key),
    forestTopology: path => readForestTopology(state, path),
  }
}

/**
 * Project topology from the `stepTree` shadow shape. Defensive `[]`
 * fallback covers callers that hit a non-tree path with a tree-typed
 * reader (e.g. ill-formed test fixtures).
 */
function readForestTopology(
  state: unknown,
  path: Path,
): readonly FlatTreeNodeTopology[] {
  const value = path.read(state)
  if (!Array.isArray(value)) return []
  const result: FlatTreeNodeTopology[] = []
  for (const n of value) {
    if (isNonNullObject(n) && typeof n.id === "string") {
      result.push({
        id: n.id as string,
        parent: (n.parent as string | null) ?? null,
        index: (n.index as number) ?? 0,
      })
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// Read helpers (internal — used only by plainReader)
// ---------------------------------------------------------------------------

/**
 * Returns the length of the array at the given path.
 * Returns 0 if the value is not an array.
 */
function readArrayLength(state: unknown, path: Path): number {
  const arr = path.read(state)
  return Array.isArray(arr) ? arr.length : 0
}

/**
 * Returns the keys of the object at the given path.
 * Returns an empty array if the value is not a non-null object.
 */
function readKeys(state: unknown, path: Path): string[] {
  const obj = path.read(state)
  return isNonNullObject(obj) ? Object.keys(obj) : []
}

/**
 * Returns true if the object at the given path has the specified key.
 * Returns false if the value is not a non-null object or the key is missing.
 */
function readHasKey(state: unknown, path: Path, key: string): boolean {
  const obj = path.read(state)
  return isNonNullObject(obj) && key in obj
}

/**
 * Writes a value into a nested plain object at the given Path.
 * Creates intermediate objects as needed. `seg.resolve()` throws on a
 * dead address — writes to deleted refs should fail.
 */
export function writeByPath(
  state: PlainState,
  path: Path,
  value: unknown,
): void {
  if (path.length === 0) return
  const segments = path.segments
  let current: Record<string | number, unknown> = state
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]!
    const k = seg.resolve()
    // Symmetric to `AbstractPath.read`: `entry` traversal over the flat-
    // forest shadow looks up by id and steps into the node's `.data` so
    // writes target the per-node data, not array-by-index.
    if (
      seg.role === "entry" &&
      Array.isArray(current) &&
      isFlatForestArray(current)
    ) {
      const node = (current as Array<{ id: string; data: unknown }>).find(
        n => n != null && n.id === k,
      )
      if (!node) return
      if (
        node.data === null ||
        node.data === undefined ||
        typeof node.data !== "object"
      ) {
        node.data = {}
      }
      current = node.data as Record<string | number, unknown>
      continue
    }
    if (!isNonNullObject(current[k])) {
      current[k] = {}
    }
    current = current[k] as Record<string | number, unknown>
  }
  // Terminal segment — same flat-forest discrimination as the loop above.
  const last = segments[segments.length - 1]!
  const lastKey = last.resolve()
  if (
    last.role === "entry" &&
    Array.isArray(current) &&
    isFlatForestArray(current)
  ) {
    const node = (current as Array<{ id: string; data: unknown }>).find(
      n => n != null && n.id === lastKey,
    )
    if (node) node.data = value
    return
  }
  current[lastKey] = value
}

/**
 * Mirrors `isFlatForestArray` in `path.ts`. Duplicated to avoid pulling
 * the reader module into `path.ts`'s dependency graph.
 */
function isFlatForestArray(arr: readonly unknown[]): boolean {
  if (arr.length === 0) return false
  const first = arr[0]
  return (
    typeof first === "object" &&
    first !== null &&
    typeof (first as { id?: unknown }).id === "string" &&
    "data" in (first as object)
  )
}

// ---------------------------------------------------------------------------
// Change application
// ---------------------------------------------------------------------------

/**
 * Replace the contents of `target` with the contents of `source`,
 * preserving `target`'s object identity.
 *
 * Used by CRDT substrates' replay path: after `materializeXxxShadow`
 * produces a fresh `PlainState` from the merged CRDT tree, this copies
 * its keys onto the live shadow object so the existing `Reader` keeps
 * working (the reader closes over the shadow's identity, not its
 * current snapshot). Keys absent from `source` are deleted from
 * `target`.
 *
 * O(|source| + |target|). Shallow only — nested values share
 * references with `source`, which is fine here because the
 * materialiser produces fresh trees per call.
 */
export function syncShadow(target: PlainState, source: PlainState): void {
  for (const key of Object.keys(source)) {
    target[key] = source[key]
  }
  for (const key of Object.keys(target)) {
    if (!(key in source)) {
      delete target[key]
    }
  }
}

export function applyChange(
  state: PlainState,
  path: Path,
  change: ChangeBase,
): void {
  if (path.length === 0) {
    // Root-level change — apply step to the state itself and merge back
    const next = step(state as Record<string, unknown>, change)
    if (isNonNullObject(next)) {
      // Merge result keys into the state (preserving the state reference)
      for (const key of Object.keys(next)) {
        state[key] = next[key]
      }
      // Remove keys that were deleted
      for (const key of Object.keys(state)) {
        if (!(key in next)) {
          delete state[key]
        }
      }
    }
    return
  }
  const current = path.read(state)
  const next = step(current, change)
  writeByPath(state, path, next)
}

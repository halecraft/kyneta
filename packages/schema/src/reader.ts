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
  }
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
 * Creates intermediate objects as needed.
 *
 * Uses `seg.resolve()` for each segment — for dead addresses this
 * throws, which is the correct behavior (writes to dead refs should fail).
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
    const k = segments[i]!.resolve()
    if (!isNonNullObject(current[k])) {
      current[k] = {}
    }
    current = current[k] as Record<string | number, unknown>
  }
  current[segments[segments.length - 1]!.resolve()] = value
}

// ---------------------------------------------------------------------------
// Change application
// ---------------------------------------------------------------------------

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

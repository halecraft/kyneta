// Store — shared utilities for reading, writing, and applying changes
// to a plain JS object store.
//
// These are backend-agnostic helpers used by multiple interpreters
// (writable, plain, validate, changefeed). Extracted from writable.ts
// to eliminate cross-module coupling.

import type { Path } from "./interpret.js"
import type { ChangeBase } from "./change.js"
import { step } from "./step.js"
import { isNonNullObject } from "./guards.js"

// ---------------------------------------------------------------------------
// Store type
// ---------------------------------------------------------------------------

/**
 * A plain JS object used as the backing store. The writable interpreter
 * reads from and writes to this object, proving no CRDT runtime is needed.
 */
export type Store = Record<string, unknown>

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Resolves a segment key for JS object access.
 * Key segments use the key directly; index segments use the numeric index
 * (which JS coerces to a string for object/array access).
 */
function segKey(seg: Path[number]): string | number {
  return seg.type === "key" ? seg.key : seg.index
}

/**
 * Reads a value from a nested plain object by following a Path.
 */
export function readByPath(store: unknown, path: Path): unknown {
  let current: unknown = store
  for (const seg of path) {
    if (current === null || current === undefined) return undefined
    current = (current as Record<string | number, unknown>)[segKey(seg)]
  }
  return current
}

/**
 * Writes a value into a nested plain object at the given Path.
 * Creates intermediate objects as needed.
 */
export function writeByPath(store: Store, path: Path, value: unknown): void {
  if (path.length === 0) return
  let current: Record<string | number, unknown> = store
  for (let i = 0; i < path.length - 1; i++) {
    const k = segKey(path[i]!)
    if (!isNonNullObject(current[k])) {
      current[k] = {}
    }
    current = current[k] as Record<string | number, unknown>
  }
  current[segKey(path[path.length - 1]!)] = value
}

// ---------------------------------------------------------------------------
// Change application
// ---------------------------------------------------------------------------

export function applyChangeToStore(
  store: Store,
  path: Path,
  change: ChangeBase,
): void {
  if (path.length === 0) {
    // Root-level change — apply step to the store itself and merge back
    const next = step(store as Record<string, unknown>, change)
    if (isNonNullObject(next)) {
      // Merge result keys into the store (preserving the store reference)
      for (const key of Object.keys(next)) {
        store[key] = next[key]
      }
      // Remove keys that were deleted
      for (const key of Object.keys(store)) {
        if (!(key in next)) {
          delete store[key]
        }
      }
    }
    return
  }
  const current = readByPath(store, path)
  const next = step(current, change)
  writeByPath(store, path, next)
}
// Store — shared utilities for reading, writing, and applying changes
// to a plain JS object store.
//
// These are backend-agnostic helpers used by multiple interpreters
// (writable, plain, validate, changefeed). Extracted from writable.ts
// to eliminate cross-module coupling.

import type { ChangeBase } from "./change.js"
import { isNonNullObject } from "./guards.js"
import type { Path } from "./interpret.js"
import { step } from "./step.js"

// ---------------------------------------------------------------------------
// Store type
// ---------------------------------------------------------------------------

/**
 * A plain JS object used as the backing store. The writable interpreter
 * reads from and writes to this object, proving no CRDT runtime is needed.
 */
export type Store = Record<string, unknown>

// ---------------------------------------------------------------------------
// StoreReader — abstract read interface for interpreter store access
// ---------------------------------------------------------------------------

/**
 * Abstract read interface for the interpreter stack.
 *
 * Interpreters read from the store exclusively through this interface,
 * allowing substrates to provide their own read semantics. The plain
 * substrate wraps a `Record<string, unknown>` via `plainStoreReader`;
 * a Loro substrate would navigate the Loro container tree directly.
 */
export interface StoreReader {
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
 * Wraps a plain JS object in a StoreReader.
 *
 * **Liveness invariant:** The returned reader is a *live view* — mutations
 * to `store` via `applyChangeToStore` are immediately visible through the
 * reader. The reader and the mutator share the same backing object.
 *
 * Other substrates (e.g. Loro) provide their own StoreReader that reads
 * from a different backing structure (the Loro container tree).
 */
export function plainStoreReader(store: Record<string, unknown>): StoreReader {
  return {
    read: path => readByPath(store, path),
    arrayLength: path => storeArrayLength(store, path),
    keys: path => storeKeys(store, path),
    hasKey: (path, key) => storeHasKey(store, path, key),
  }
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Converts a `Path` to a stable string key for use as a `Map` key.
 *
 * Uses `\0` (null byte) as a delimiter — this character cannot appear
 * in JSON property names, so the encoding is injection-free.
 *
 * Shared across interpreter layers (`withChangefeed`, `withCaching`)
 * that maintain path-keyed handler maps.
 */
export function pathKey(path: Path): string {
  return path
    .map(seg => (seg.type === "key" ? seg.key : String(seg.index)))
    .join("\0")
}

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
 * Returns the length of the array at the given path in the store.
 * Returns 0 if the value is not an array.
 */
export function storeArrayLength(store: unknown, path: Path): number {
  const arr = readByPath(store, path)
  return Array.isArray(arr) ? arr.length : 0
}

/**
 * Returns the keys of the object at the given path in the store.
 * Returns an empty array if the value is not a non-null object.
 */
export function storeKeys(store: unknown, path: Path): string[] {
  const obj = readByPath(store, path)
  return isNonNullObject(obj) ? Object.keys(obj) : []
}

/**
 * Returns true if the object at the given path has the specified key.
 * Returns false if the value is not a non-null object or the key is missing.
 */
export function storeHasKey(store: unknown, path: Path, key: string): boolean {
  const obj = readByPath(store, path)
  return isNonNullObject(obj) && key in obj
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

// ---------------------------------------------------------------------------
// Sum dispatch — relocated to interpret.ts (alongside SumVariants)
// ---------------------------------------------------------------------------

/** @deprecated Import `dispatchSum` from `@kyneta/schema` or `interpret.js` instead. */
export { dispatchSum } from "./interpret.js"

// Store — shared utilities for reading, writing, and applying changes
// to a plain JS object store.
//
// These are backend-agnostic helpers used by multiple interpreters
// (writable, plain, validate, changefeed). Extracted from writable.ts
// to eliminate cross-module coupling.

import type { ChangeBase } from "./change.js"
import { isNonNullObject } from "./guards.js"
import type { Path, SumVariants } from "./interpret.js"
import {
  type DiscriminatedSumSchema,
  isNullableSum,
  type PositionalSumSchema,
  type SumSchema,
} from "./schema.js"
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
// Sum dispatch — shared variant resolution
// ---------------------------------------------------------------------------

/**
 * Resolves which sum variant to use based on runtime store state.
 *
 * Used by `readableInterpreter`, `withReadable`, and any interpreter
 * that needs store-driven variant dispatch. The logic is:
 *
 * 1. **Discriminated sums**: read the discriminant field from `value`.
 *    If the discriminant matches a variant in `variantMap`, dispatch
 *    via `variants.byKey()`. Otherwise fall back to the first variant.
 *
 * 2. **Nullable (positional) sums**: if the value is null/undefined,
 *    dispatch to variant 0 (the null variant); otherwise variant 1.
 *
 * 3. **General positional sums**: dispatch to variant 0 (first).
 *
 * Returns `undefined` if no variant can be resolved.
 */
export function dispatchSum<A>(
  value: unknown,
  schema: SumSchema,
  variants: SumVariants<A>,
): A | undefined {
  if (schema.discriminant !== undefined && variants.byKey) {
    // ── Discriminated sum ──────────────────────────────────────
    const discSchema = schema as DiscriminatedSumSchema

    if (isNonNullObject(value)) {
      const discValue = value[schema.discriminant]
      if (typeof discValue === "string" && discValue in discSchema.variantMap) {
        return variants.byKey(discValue)
      }
    }

    // Fallback: first variant
    const keys = Object.keys(discSchema.variantMap)
    if (keys.length > 0) {
      return variants.byKey(keys[0]!)
    }
    return undefined
  }

  // ── Positional sum ────────────────────────────────────────────
  if (variants.byIndex) {
    const posSchema = schema as PositionalSumSchema

    if (isNullableSum(posSchema)) {
      return value === null || value === undefined
        ? variants.byIndex(0) // null variant
        : variants.byIndex(1) // inner variant
    }

    // General positional sum: no runtime discriminator, use first
    return variants.byIndex(0)
  }

  return undefined
}

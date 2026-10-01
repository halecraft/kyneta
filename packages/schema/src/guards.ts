// guards — shared type-narrowing utilities.
//
// General-purpose predicates used across the schema package.
// Not tied to any specific module (store, interpreter, schema grammar).

/**
 * Returns `true` when `value` is non-null, non-undefined, and
 * `typeof value === "object"`.
 *
 * Does NOT exclude arrays — callers that need "plain object" semantics
 * should add `&& !Array.isArray(value)` themselves.
 *
 * Use this for store reads, validation, and anywhere "is this a plain
 * JS object?" is the correct semantic. A ref is a function, so this is
 * false for one: use `isPropertyHost` for a value that may be a ref.
 */
export function isNonNullObject(
  value: unknown,
): value is Record<string, unknown> {
  return value !== null && value !== undefined && typeof value === "object"
}

/**
 * Returns `true` when `value` is a plain JSON object.
 *
 * This is a stricter version of `isNonNullObject` that also excludes arrays.
 * Use this when you specifically need to verify that a value is a `{}` object
 * (e.g. for map/product CRDT materialization).
 */
export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return isNonNullObject(value) && !Array.isArray(value)
}

/**
 * Returns `true` when `value` can host properties: a non-null object or a
 * function. A ref is a function, so `isNonNullObject` is false for one.
 *
 * Does NOT return `true` for primitives (string, number, boolean, etc.),
 * `null`, or `undefined`.
 */
export function isPropertyHost(value: unknown): value is object {
  if (value === null || value === undefined) return false
  const t = typeof value
  return t === "object" || t === "function"
}

/**
 * Structural equality over plain JSON values.
 *
 * Single source of truth wherever two plain values have to be compared by
 * content: set membership (`stepSet`'s uniqueness invariant, `validate`'s
 * duplicate detection, `SetRef.has(value)`) and the ephemeral substrate's
 * decision about which fields a merge actually moved.
 *
 * Semantics:
 * - **Primitives**: `Object.is` (so `NaN === NaN`, but `+0 !== -0`).
 * - **Arrays**: same length, same elements at every index (recursive).
 * - **Plain objects**: same key set, same value at every key (recursive).
 * - **Mixed types**: not equal.
 *
 * Functions, symbols, Dates and other non-JSON values produce arbitrary
 * results. Every value the schema grammar can hold is JSON-compatible by
 * declaration, so this is a statement about misuse, not a gap.
 */
export function samePlainValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (a === null || b === null) return false
  if (typeof a !== "object" || typeof b !== "object") return false

  const aIsArray = Array.isArray(a)
  const bIsArray = Array.isArray(b)
  if (aIsArray !== bIsArray) return false

  if (aIsArray && bIsArray) {
    const arrA = a as readonly unknown[]
    const arrB = b as readonly unknown[]
    if (arrA.length !== arrB.length) return false
    for (let i = 0; i < arrA.length; i++) {
      if (!samePlainValue(arrA[i], arrB[i])) return false
    }
    return true
  }

  const objA = a as Record<string, unknown>
  const objB = b as Record<string, unknown>
  const aKeys = Object.keys(objA)
  const bKeys = Object.keys(objB)
  if (aKeys.length !== bKeys.length) return false
  for (const key of aKeys) {
    if (!Object.hasOwn(objB, key)) return false
    if (!samePlainValue(objA[key], objB[key])) return false
  }
  return true
}

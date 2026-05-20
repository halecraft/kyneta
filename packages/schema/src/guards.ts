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
 * JS object?" is the correct semantic. For code that needs to attach
 * properties to a result (which may be a function object), use
 * `isPropertyHost` instead.
 */
export function isNonNullObject(
  value: unknown,
): value is Record<string, unknown> {
  return value !== null && value !== undefined && typeof value === "object"
}

/**
 * Returns `true` when `value` can host properties — i.e. it is a
 * non-null object OR a function.
 *
 * Use this instead of `isNonNullObject` in code that attaches properties
 * to interpreter results (e.g. `enrich`, `withChangefeed`), because
 * callable refs are function objects that can carry properties.
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
 * Structural content equality for `Schema.set` members.
 *
 * Single source of truth for set membership — consumed by `stepSet`
 * (uniqueness invariant), `validate` (duplicate detection), and
 * `SetRef.has(value)` (membership query).
 *
 * Semantics:
 * - **Primitives**: `Object.is` (so `NaN === NaN`, but `+0 !== -0`).
 * - **Arrays**: same length, same elements at every index (recursive).
 * - **Plain objects**: same key set, same value at every key (recursive).
 * - **Mixed types**: not equal.
 *
 * Operates on JSON-compatible plain values. Functions, symbols, Dates,
 * and other non-JSON values produce arbitrary results — set members are
 * expected to be JSON-compatible.
 */
export function isSameSetMember(a: unknown, b: unknown): boolean {
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
      if (!isSameSetMember(arrA[i], arrB[i])) return false
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
    if (!isSameSetMember(objA[key], objB[key])) return false
  }
  return true
}

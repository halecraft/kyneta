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

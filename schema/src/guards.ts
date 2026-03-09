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
 */
export function isNonNullObject(value: unknown): value is Record<string, unknown> {
  return value !== null && value !== undefined && typeof value === "object"
}
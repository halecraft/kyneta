// clone — the one deep-copy primitive, kept in a module with no imports.
//
// A leaf module by design. Several subsystems need to snapshot a plain value
// on its way into somewhere that outlives the write, and they sit at different
// levels of the stack — the change vocabulary, the store boundary, the inverse
// algebra, the ephemeral substrate's register barrier. Putting the primitive
// where none of them import each other keeps any of them free to reach for it
// without creating an import cycle.

/**
 * Deep-clone a plain-JSON value.
 *
 * The name describes the mechanism (a `structuredClone` of a plain value),
 * not any one caller's intent, because several subsystems rely on it:
 *
 * - **Change construction** (`own` in `change.ts`) copies a caller-supplied
 *   value so the op that carries it cannot be rewritten by whoever passed it.
 * - **The store boundary** (`ownedForStore` in `reader.ts`) copies a payload
 *   before it enters the store, so a later write into that subtree cannot
 *   rewrite an op a subscriber is still holding.
 * - **Inverse construction** snapshots the pre-state it captures, so the
 *   recorded inverse is a value rather than a view.
 * - **The `ephemeral` substrate** uses it as an aliasing barrier when a whole
 *   register value (a sum variant or `.json()` blob) crosses the
 *   StateTree↔shadow boundary, so the two never share a mutable object.
 *
 * Primitives are returned as-is (clone is a no-op for `undefined`, `null`,
 * `boolean`, `number`, `string`, `bigint`, `symbol`). Objects and arrays
 * go through `structuredClone`. Plain JSON values round-trip faithfully
 * under `structuredClone`; the schema grammar is what guarantees the values
 * reaching here are plain.
 */
export function deepClonePlain<T>(value: T): T {
  if (value === null || value === undefined) return value
  const t = typeof value
  if (t === "object") return structuredClone(value)
  return value
}

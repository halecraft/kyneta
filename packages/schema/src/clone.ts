// clone — the deep-copy primitives, kept in a module with no imports.
//
// A leaf module by design. Several subsystems need to snapshot a plain value
// on its way into somewhere that outlives the write, or out to a reader, and
// they sit at different levels of the stack — the change vocabulary, the store
// boundary, the inverse algebra, the ephemeral substrate's register barrier,
// the read layer. Putting the primitive
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
 * - **The store boundary** (`ownedForStore` in `reader.ts`) copies a
 *   completed payload before it enters the store, so a later write into that
 *   subtree cannot rewrite an op a subscriber is still holding.
 * - **Inverse construction** snapshots the pre-state it captures, so the
 *   recorded inverse is a value rather than a view.
 * - **The `ephemeral` substrate** uses it as an aliasing barrier when a whole
 *   register value (a sum variant or `.json()` blob) crosses the
 *   StateTree↔shadow boundary, so the two never share a mutable object.
 * - **Reads** (`frozenClone`, below) copy a leaf's object value out of σ
 *   before freezing it, so a read never exposes, or freezes, the store.
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

/**
 * Copy a plain-JSON value and freeze every object in the copy, in one pass.
 *
 * What a read returns for a leaf whose value is an object (set members, a
 * rich-text delta, a `.json()` value): a snapshot nobody can mutate, taken
 * from σ without freezing σ itself. Primitives are returned as-is.
 */
export function frozenClone<T>(value: T): T {
  if (value === null || typeof value !== "object") return value
  if (Array.isArray(value)) {
    return Object.freeze(value.map(item => frozenClone(item))) as T
  }
  const copy: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) copy[key] = frozenClone(item)
  return Object.freeze(copy) as T
}

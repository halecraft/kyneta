// clone — copying and freezing plain values, kept in a module with no imports.
//
// A leaf module by design. The change vocabulary, the store, the inverse
// algebra, the ephemeral substrate and the read layer all copy or freeze plain
// values, and they sit at different levels of the package. Putting the
// primitives where none of them import each other keeps any of them free to
// reach for them without creating an import cycle.
//
// **The frozen invariant.** A frozen node's descendants are all frozen, or are
// `ArrayBuffer` views (`bytes`). No typed array can be frozen. A view is safe
// to leave unfrozen in σ because no write mutates one in place: a `bytes`
// scalar is replaced whole.
//
// The invariant holds because every value entering σ is new (a materializer's
// output, decoded wire data, `diffOps`'s copies) or owned (`own` in
// `change.ts` copies anything not already deeply frozen). A shallow-frozen
// object that slipped in would be skipped by `freezeTree` and leave mutable
// children behind a frozen parent.
//
// **The `bytes` hazard.** A read's byte array is σ's own. Mutating it changes
// σ without a write, so copy it first.

/**
 * Deep-clone a plain-JSON value: a `structuredClone` of an object, and a
 * primitive as it is. Plain JSON values, byte arrays included, round-trip
 * faithfully; the schema grammar is what guarantees the values reaching here
 * are plain.
 */
export function deepClonePlain<T>(value: T): T {
  if (value === null || value === undefined) return value
  const t = typeof value
  if (t === "object") return structuredClone(value)
  return value
}

/**
 * Freeze every unfrozen node under `value`, children before parents, and
 * return `value`. Stops at a node already frozen, since the frozen invariant
 * says everything below it is, so the walk costs only what is not yet frozen.
 * A byte array is left as it is.
 */
export function freezeTree<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value
  if (Object.isFrozen(value) || ArrayBuffer.isView(value)) return value
  // Indexed loops: this walks every child of a wide record a read froze and a
  // write then copied, and an iterator per node is measurable there.
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) freezeTree(value[i])
  } else {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record)
    for (let i = 0; i < keys.length; i++) freezeTree(record[keys[i] as string])
  }
  return Object.freeze(value)
}

/**
 * A one-level copy of `node` if it is frozen, and `node` itself otherwise:
 * what a write changes in place of a node a read froze (`applyChange`). The
 * copy's children are shared, and stay frozen.
 */
export function thaw<T>(node: T): T {
  if (typeof node !== "object" || node === null || !Object.isFrozen(node)) {
    return node
  }
  if (Array.isArray(node)) return node.slice() as T
  // A key loop rather than a spread: it copies a wide record about twice as
  // fast, and a write after a whole-record read copies the record.
  const record = node as Record<string, unknown>
  const copy: Record<string, unknown> = {}
  const keys = Object.keys(record)
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i] as string
    copy[key] = record[key]
  }
  return copy as T
}

/**
 * Whether `value` is frozen all the way down. Stops at the first node that is
 * not. A byte array answers `false`, so whoever asks before sharing a value
 * (`own`) copies bytes, and σ never holds a caller's array.
 */
export function isDeeplyFrozen(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return true
  if (ArrayBuffer.isView(value) || !Object.isFrozen(value)) return false
  if (Array.isArray(value)) return value.every(isDeeplyFrozen)
  for (const key of Object.keys(value)) {
    if (!isDeeplyFrozen((value as Record<string, unknown>)[key])) return false
  }
  return true
}

// navigable — the types of a ref's navigation, for the collections that
// navigate by index or key.
//
// Types only: the members live on each ref's prototype (`navigate.ts`). These
// interfaces capture the pure structural addressing surface
// (coalgebra: A → F(A)) without any reading or mutation concerns.
//
// The hierarchy:
//   NavigableSequenceRef<T>       — .at(), .length, [Symbol.iterator]
//     ↑ extends
//   ReadableSequenceRef<T, V>     — adds (), .get()
//
//   NavigableMapRef<T>            — .at(), .has(), .keys(), .size, etc.
//     ↑ extends
//   ReadableMapRef<T, V>          — adds (), .get()
//
// SequenceRef (mutation-only) is intentionally NOT in this hierarchy —
// it provides .push(), .insert(), .delete() with no overlap.

/**
 * Navigation-only interface for sequence refs.
 *
 * Provides structural addressing into an ordered collection:
 * - `.at(index)` returns a child ref (or `undefined` for out-of-bounds)
 * - `.length` reflects the current store array length
 * - `[Symbol.iterator]` yields child refs
 *
 * No call signature (no reading), no mutation methods.
 */
export interface NavigableSequenceRef<T = unknown> {
  at(this: NavigableSequenceRef<T>, index: number): T | undefined
  readonly length: number
  [Symbol.iterator](): Iterator<T>
}

/**
 * Navigation-only interface for map refs.
 *
 * Provides structural addressing into a keyed collection:
 * - `.at(key)` returns a child ref (or `undefined` for missing keys)
 * - `.has(key)` checks key existence
 * - `.keys()` returns current store keys
 * - `.size` reflects the current entry count
 * - `.entries()` yields `[key, childRef]` pairs
 * - `.values()` yields child refs
 * - `[Symbol.iterator]` yields `[key, childRef]` pairs
 *
 * No call signature (no reading), no mutation methods.
 */
export interface NavigableMapRef<T = unknown> {
  at(this: NavigableMapRef<T>, key: string): T | undefined
  has(this: NavigableMapRef<T>, key: string): boolean
  keys(this: NavigableMapRef<T>): string[]
  readonly size: number
  entries(this: NavigableMapRef<T>): IterableIterator<[string, T]>
  values(this: NavigableMapRef<T>): IterableIterator<T>
  [Symbol.iterator](): IterableIterator<[string, T]>
}

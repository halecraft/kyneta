// Navigable type interfaces — navigation-only collection refs.
//
// These interfaces capture the pure structural addressing surface
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
//
// See .plans/navigation-layer.md §Phase 3, Task 3.1.

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
  at: (index: number) => T | undefined
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
  at(key: string): T | undefined
  has(key: string): boolean
  keys(): string[]
  readonly size: number
  entries(): IterableIterator<[string, T]>
  values(): IterableIterator<T>
  [Symbol.iterator](): IterableIterator<[string, T]>
}

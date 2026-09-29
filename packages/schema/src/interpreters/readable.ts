// Readable type definitions — type-level interpretation for readable refs.
//
// This module contains only **type-level** definitions:
//   - ReadableSequenceRef, ReadableMapRef, Readable<S>
//   - RefContext re-export
//
// The runtime implementation has been factored into composable transformers:
//   withReadable (src/interpreters/with-readable.ts) — reading + navigation
//   withCaching  (src/interpreters/with-caching.ts)  — identity-preserving caching

import type { Plain, PlainFlatTreeNode } from "../interpreter-types.js"
import type {
  CounterSchema,
  DiscriminatedSumSchema,
  MapSchema,
  MovableSequenceSchema,
  PositionalSumSchema,
  ProductSchema,
  ScalarSchema,
  Schema,
  SequenceSchema,
  SetSchema,
  TextSchema,
  TreeSchema,
} from "../schema.js"
import type { NavigableMapRef, NavigableSequenceRef } from "./navigable.js"

// ---------------------------------------------------------------------------
// ReadableDiscriminantProductRef — hybrid product ref for discriminated unions
// ---------------------------------------------------------------------------

/**
 * Produces a hybrid readable product ref where the discriminant field `D`
 * resolves to its `Plain<S>` value (a raw string literal), while all other
 * fields remain full recursive `Readable<S>` refs.
 *
 * Enables standard TypeScript discriminated union narrowing on read-only refs.
 */
type ReadableDiscriminantProductRef<
  F extends Record<string, Schema>,
  D extends string,
> = (() => { readonly [K in keyof F]: Plain<F[K]> }) & {
  readonly [K in keyof F]: K extends D ? Plain<F[K]> : Readable<F[K]>
}

// Re-export RefContext for consumers
export type { RefContext } from "../interpreter-types.js"

// ---------------------------------------------------------------------------
// Readable<S> — type-level interpretation for readable refs
// ---------------------------------------------------------------------------

/**
 * An interface for readable sequence refs: callable + navigation.
 *
 * Extends `NavigableSequenceRef<T>` (structural addressing: `.at()`,
 * `.length`, `[Symbol.iterator]`) and adds reading concerns:
 * - Call signature `(): readonly V[]` returns a frozen array snapshot
 * - `.get(i)` returns the plain value at index (not a ref)
 */
export interface ReadableSequenceRef<T = unknown, V = unknown>
  extends NavigableSequenceRef<T> {
  (): readonly V[]
  /** Read the plain value at index. Returns undefined for out-of-bounds. */
  get: (index: number) => V | undefined
}

/**
 * An interface for readable map refs: callable + Map-like navigation.
 *
 * Extends `NavigableMapRef<T>` (structural addressing: `.at()`, `.has()`,
 * `.keys()`, `.size`, `.entries()`, `.values()`, `[Symbol.iterator]`) and
 * adds reading concerns:
 * - Call signature `(): Readonly<Record<string, V>>` returns a frozen record
 *   snapshot
 * - `.get(key)` returns the plain value at key (not a ref)
 */
export interface ReadableMapRef<T = unknown, V = unknown>
  extends NavigableMapRef<T> {
  /** Callable: returns a frozen deep snapshot of the entire map. */
  (): Readonly<Record<string, V>>
  /** Read the plain value at key. Returns undefined if key is not in the store. Equivalent to `.at(key)?.()`. */
  get(key: string): V | undefined
}

/**
 * Recursive read-layer projection of a tree node. `data` is a live
 * `Readable<I>` ref (not a plain value) so `.roots[i].data.label()`
 * keeps working through structural changes.
 */
export interface ReadableTreeNode<I extends Schema> {
  readonly id: string
  readonly parent: string | null
  readonly data: Readable<I>
  readonly children: readonly ReadableTreeNode<I>[]
}

/**
 * User-facing read surface for `Schema.tree`. Call `()` for the flat
 * snapshot (matches `Plain<TreeSchema<I>>` so it serializes 1:1 with the
 * shadow); use `.roots` for the recursive projection and `.node(id)`
 * for keyed lookup. `WritableTreeRef` extends this with `.create`,
 * `.delete`, `.move`.
 */
export interface ReadableTreeRef<I extends Schema> {
  /** Deep-plain snapshot of the entire forest (flat shape, matches `Plain<S>`). */
  (): readonly PlainFlatTreeNode<I>[]
  /** Recursive projection roots (sorted by `index` per parent). */
  readonly roots: readonly ReadableTreeNode<I>[]
  /** Lookup by stable id. Returns undefined for unknown/deleted ids. */
  node(id: string): ReadableTreeNode<I> | undefined
  /** Depth-first iteration (parent-then-children). */
  [Symbol.iterator](): IterableIterator<ReadableTreeNode<I>>
  /** Total node count. */
  readonly size: number
}

/**
 * An interface for readable set refs: callable + native-Set-like ergonomics.
 *
 * Sets are ref-layer **leaf-shaped** — there are no addressable per-member
 * child refs, no `.at(value)`. Membership is content-equal (via
 * `samePlainValue`), not identity.
 *
 * - Call signature `(): readonly V[]` returns a frozen array snapshot —
 *   matches `Plain<SetSchema<I>> = readonly Plain<I>[]`.
 * - `.has(value)` runs structural-equality membership check.
 * - `.size` reports member count.
 * - `[Symbol.iterator]` iterates plain values (not refs).
 */
export interface ReadableSetRef<V = unknown> {
  /** Callable: returns a frozen deep snapshot of the set as an array. */
  (): readonly V[]
  /** Structural-equality membership query (uses `samePlainValue`). */
  has(value: V): boolean
  /** Member count. */
  readonly size: number
  /** Iterates plain values in stored order. */
  [Symbol.iterator](): IterableIterator<V>
}

/**
 * Computes the readable ref type for a given schema type.
 *
 * This is the type-level counterpart to `readableInterpreter`. Every
 * node is callable (`ref()` returns `Plain<S>`). Structural nodes have
 * navigation. Leaf nodes have `[Symbol.toPrimitive]`.
 *
 * ```ts
 * const s = Schema.struct({
 *   title: Schema.string(),
 *   count: Schema.number(),
 * })
 *
 * type Doc = Readable<typeof s>
 * // doc() → { title: string, count: number }
 * // doc.title() → string
 * // doc.count() → number
 * ```
 */
export type Readable<S extends Schema> =
  // --- First-class leaf types ---
  S extends TextSchema
    ? (() => string) & { [Symbol.toPrimitive](hint: string): string }
    : S extends CounterSchema
      ? (() => number) & {
          [Symbol.toPrimitive](hint: string): number | string
        }
      : // --- First-class container types ---
        S extends SetSchema<infer I>
        ? ReadableSetRef<Plain<I>>
        : S extends TreeSchema<infer Inner>
          ? ReadableTreeRef<Inner>
          : S extends MovableSequenceSchema<infer I>
            ? ReadableSequenceRef<Readable<I>, Plain<I>>
            : // --- Scalar ---
              S extends ScalarSchema<infer _K, infer V>
              ? (() => V) & { [Symbol.toPrimitive](hint: string): V | string }
              : // --- Product ---
                S extends ProductSchema<infer F>
                ? (() => { readonly [K in keyof F]: Plain<F[K]> }) & {
                    readonly [K in keyof F]: Readable<F[K]>
                  }
                : // --- Sequence ---
                  S extends SequenceSchema<infer I>
                  ? ReadableSequenceRef<Readable<I>, Plain<I>>
                  : // --- Map ---
                    S extends MapSchema<infer I>
                    ? ReadableMapRef<Readable<I>, Plain<I>>
                    : // --- Sum ---
                      S extends PositionalSumSchema<infer V>
                      ? V extends readonly [
                          ScalarSchema<"null", any>,
                          infer Inner extends Schema,
                        ]
                        ? (() => Plain<Inner> | null) & {
                            [Symbol.toPrimitive](
                              hint: string,
                            ): Plain<Inner> | null | string
                          }
                        : Readable<V[number]>
                      : S extends DiscriminatedSumSchema<infer D, infer V>
                        ? ReadableDiscriminantProductRef<V[number]["fields"], D>
                        : unknown

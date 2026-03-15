// Readable type definitions — type-level interpretation for readable refs.
//
// This module contains only **type-level** definitions:
//   - ReadableSequenceRef, ReadableMapRef, Readable<S>
//   - RefContext re-export
//
// The runtime implementation has been factored into composable transformers:
//   withReadable (src/interpreters/with-readable.ts) — reading + navigation
//   withCaching  (src/interpreters/with-caching.ts)  — identity-preserving caching

import type {
  Schema,
  ScalarSchema,
  ProductSchema,
  SequenceSchema,
  MapSchema,
  AnnotatedSchema,
  PositionalSumSchema,
  DiscriminatedSumSchema,
} from "../schema.js"
import type { Plain } from "../interpreter-types.js"
import type { NavigableSequenceRef, NavigableMapRef } from "./navigable.js"

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
 * - Call signature `(): V[]` returns a plain array snapshot
 * - `.get(i)` returns the plain value at index (not a ref)
 */
export interface ReadableSequenceRef<T = unknown, V = unknown>
  extends NavigableSequenceRef<T> {
  (): V[]
  /** Read the plain value at index. Returns undefined for out-of-bounds. */
  get: (index: number) => V | undefined
}

/**
 * An interface for readable map refs: callable + Map-like navigation.
 *
 * Extends `NavigableMapRef<T>` (structural addressing: `.at()`, `.has()`,
 * `.keys()`, `.size`, `.entries()`, `.values()`, `[Symbol.iterator]`) and
 * adds reading concerns:
 * - Call signature `(): Record<string, V>` returns a plain record snapshot
 * - `.get(key)` returns the plain value at key (not a ref)
 */
export interface ReadableMapRef<T = unknown, V = unknown>
  extends NavigableMapRef<T> {
  /** Callable: returns a deep plain snapshot of the entire map. */
  (): Record<string, V>
  /** Read the plain value at key. Returns undefined if key is not in the store. Equivalent to `.at(key)?.()`. */
  get(key: string): V | undefined
}

/**
 * Computes the readable ref type for a given schema type.
 *
 * This is the type-level counterpart to `readableInterpreter`. Every
 * node is callable (`ref()` returns `Plain<S>`). Structural nodes have
 * navigation. Leaf nodes have `[Symbol.toPrimitive]`.
 *
 * ```ts
 * const s = Schema.doc({
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
  // --- Annotated: dispatch on tag ---
  S extends AnnotatedSchema<infer Tag, infer Inner>
    ? Tag extends "text"
      ? (() => string) & { [Symbol.toPrimitive](hint: string): string }
      : Tag extends "counter"
        ? (() => number) & {
            [Symbol.toPrimitive](hint: string): number | string
          }
        : Tag extends "doc"
          ? Inner extends ProductSchema<infer F>
            ? (() => { [K in keyof F]: Plain<F[K]> }) & {
                readonly [K in keyof F]: Readable<F[K]>
              }
            : unknown
          : Tag extends "movable"
            ? Inner extends SequenceSchema<infer I>
              ? ReadableSequenceRef<Readable<I>, Plain<I>>
              : unknown
            : Tag extends "tree"
              ? Inner extends Schema
                ? Readable<Inner>
                : unknown
              : // Unknown annotation with inner — delegate
                Inner extends Schema
                ? Readable<Inner>
                : unknown
    : // --- Scalar ---
      S extends ScalarSchema<infer _K, infer V>
      ? (() => V) & { [Symbol.toPrimitive](hint: string): V | string }
      : // --- Product ---
        S extends ProductSchema<infer F>
        ? (() => { [K in keyof F]: Plain<F[K]> }) & {
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
              ? V extends readonly [ScalarSchema<"null", any>, infer Inner extends Schema]
                ? (() => Plain<Inner> | null) & { [Symbol.toPrimitive](hint: string): Plain<Inner> | null | string }
                : Readable<V[number]>
              : S extends DiscriminatedSumSchema<infer _D, infer V>
                ? Readable<V[number]>
                : unknown
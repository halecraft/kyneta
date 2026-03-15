// interpreter-types — shared type definitions used across interpreters.
//
// These are pure type-level definitions with no runtime code. They live
// here to break the circular dependency between readable.ts and writable.ts:
//
//   - RefContext is the minimal read-only context (used by readable, extended by writable)
//   - Plain<S> is the schema-to-plain-JS-type mapping (used by readable, writable, validate)
//
// Previously RefContext lived in writable.ts (and was re-exported by readable.ts)
// and Plain<S> lived in writable.ts (forcing readable.ts to duplicate it as ReadablePlain<S>).

import type { Store } from "./store.js"
import type {
  Schema,
  ScalarSchema,
  ProductSchema,
  SequenceSchema,
  MapSchema,
  AnnotatedSchema,
  PositionalSumSchema,
  DiscriminatedSumSchema,
} from "./schema.js"

// ---------------------------------------------------------------------------
// RefContext — minimal context for read-only interpretation
// ---------------------------------------------------------------------------

/**
 * The minimal context for read-only interpretation. Contains only a
 * store — enough to read values at any path.
 *
 * This is the base context type. `WritableContext` extends it with
 * dispatch and transaction support (`beginTransaction`/`commit`/`abort`).
 * Each layer adds only what it needs.
 */
export interface RefContext {
  readonly store: Store
}

// ---------------------------------------------------------------------------
// Plain<S> — type-level interpretation from schema type to plain JS type
// ---------------------------------------------------------------------------

/**
 * Computes the plain JavaScript/JSON type for a given schema type.
 *
 * This is the foundational type-level interpretation: it maps schema
 * nodes to bare JavaScript values (string, number, arrays, objects).
 *
 * Use `Plain<S>` for `toJSON()` return types, serialization boundaries,
 * snapshot types, and anywhere you need the "just data" shape of a schema.
 *
 * ```ts
 * const s = Schema.doc({
 *   title: Schema.string(),
 *   count: Schema.number(),
 *   items: Schema.list(Schema.struct({
 *     name: Schema.string(),
 *     done: Schema.boolean(),
 *   })),
 *   settings: Schema.struct({
 *     darkMode: Schema.boolean(),
 *   }),
 *   metadata: Schema.record(Schema.any()),
 * })
 *
 * type Doc = Plain<typeof s>
 * // = {
 * //     title: string
 * //     count: number
 * //     items: { name: string; done: boolean }[]
 * //     settings: { darkMode: boolean }
 * //     metadata: { [key: string]: unknown }
 * //   }
 * ```
 */
export type Plain<S extends Schema> =
  // --- Annotated: dispatch on tag ---
  S extends AnnotatedSchema<infer Tag, infer Inner>
    ? Tag extends "text"
      ? string
      : Tag extends "counter"
        ? number
        : Tag extends "doc"
          ? Inner extends ProductSchema<infer F>
            ? { [K in keyof F]: Plain<F[K]> }
            : unknown
          : Tag extends "movable"
            ? Inner extends SequenceSchema<infer I>
              ? Plain<I>[]
              : unknown
            : Tag extends "tree"
              ? Inner extends Schema
                ? Plain<Inner>
                : unknown
              : // Unknown annotation with inner — delegate
                Inner extends Schema
                ? Plain<Inner>
                : unknown
    : // --- Scalar ---
      S extends ScalarSchema<infer _K, infer V>
      ? V
      : // --- Product ---
        S extends ProductSchema<infer F>
        ? { [K in keyof F]: Plain<F[K]> }
        : // --- Sequence ---
          S extends SequenceSchema<infer I>
          ? Plain<I>[]
          : // --- Map ---
            S extends MapSchema<infer I>
            ? { [key: string]: Plain<I> }
            : // --- Sum ---
              S extends PositionalSumSchema<infer V>
              ? Plain<V[number]>
              : S extends DiscriminatedSumSchema<infer _D, infer V>
                ? Plain<V[number]>
                : unknown

// ---------------------------------------------------------------------------
// Seed<S> — deep-partial plain type for document seeds
// ---------------------------------------------------------------------------

/**
 * Computes the deep-partial plain type for a schema seed value.
 *
 * Structurally equivalent to a recursive `DeepPartial<Plain<S>>`, but
 * decomposed into helper types (`SeedFields`, `SeedAnnotated`) to stay
 * within TS's conditional type depth budget. `Partial<Plain<S>>` triggers
 * TS2589 on complex schemas; `Seed<S>` does not.
 *
 * Products have all keys optional; scalars and leaf annotations resolve
 * to their `Plain` value type; sequences, maps, and sums delegate to
 * `Plain<S>` (seeds at these positions are atomic — you provide the full
 * value or omit it).
 *
 * ```ts
 * const s = Schema.doc({
 *   title: Schema.annotated("text"),
 *   count: Schema.annotated("counter"),
 *   settings: Schema.struct({
 *     darkMode: Schema.boolean(),
 *   }),
 * })
 *
 * type DocSeed = Seed<typeof s>
 * // = {
 * //     title?: string
 * //     count?: number
 * //     settings?: { darkMode?: boolean }
 * //   }
 * ```
 */
export type Seed<S extends Schema> =
  // --- Annotated: indexed access on tag, delegate to helper ---
  S extends AnnotatedSchema
    ? SeedAnnotated<S["tag"], S>
  // --- Scalar ---
  : S extends ScalarSchema<infer _K, infer V>
    ? V
  // --- Product ---
  : S extends ProductSchema<infer F>
    ? SeedFields<F>
  // --- Sequence ---
  : S extends SequenceSchema<infer I>
    ? Plain<I>[]
  // --- Map ---
  : S extends MapSchema<infer I>
    ? { [key: string]: Plain<I> }
  // --- Sum (delegate to Plain) ---
  : S extends PositionalSumSchema<infer V>
    ? Plain<V[number]>
  : S extends DiscriminatedSumSchema<infer _D, infer V>
    ? Plain<V[number]>
  : unknown

// Helper: resolve product fields with optional keys — isolates the mapped type
type SeedFields<F extends Record<string, Schema>> = { [K in keyof F]?: Seed<F[K]> }

// Helper: resolve an annotated schema given its tag and the full annotated node
type SeedAnnotated<Tag extends string, S extends AnnotatedSchema> =
  Tag extends "text" ? string
  : Tag extends "counter" ? number
  : Tag extends "doc"
    ? S extends AnnotatedSchema<any, ProductSchema<infer F>> ? SeedFields<F> : unknown
  : Tag extends "movable"
    ? S extends AnnotatedSchema<any, SequenceSchema<infer I>> ? Plain<I>[] : unknown
  : Tag extends "tree"
    ? S extends AnnotatedSchema<any, infer Inner extends Schema> ? Seed<Inner> : unknown
  : S extends AnnotatedSchema<any, infer Inner extends Schema> ? Seed<Inner> : unknown
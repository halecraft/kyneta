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

import type {
  AnnotatedSchema,
  DiscriminatedSumSchema,
  MapSchema,
  PositionalSumSchema,
  ProductSchema,
  ScalarSchema,
  Schema,
  SequenceSchema,
} from "./schema.js"
import type { Path } from "./path.js"
import type { StoreReader } from "./store.js"

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
  readonly store: StoreReader
  /**
   * The root path for the interpreter stack. Determines the concrete
   * Path type for all descendants.
   *
   * - `undefined` (default): `interpretImpl` uses `RawPath.empty` —
   *   all paths are positional `RawPath` instances.
   * - Set by `withAddressing` to an `AddressedPath` root — all paths
   *   are identity-stable `AddressedPath` instances.
   */
  readonly rootPath?: Path
  /**
   * Hook called after each child ref is created by `interpretImpl`.
   *
   * Installed by `withAddressing` for ref registration (linking the
   * Address to its ref) and attaching the `deleted` getter.
   *
   * Non-addressing stacks don't set this — the optional call is a no-op.
   */
  readonly onRefCreated?: (path: Path, ref: unknown) => void
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

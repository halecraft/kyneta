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

import type { Path } from "./path.js"
import type { Reader } from "./reader.js"
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
} from "./schema.js"

// ---------------------------------------------------------------------------
// RefContext — minimal context for read-only interpretation
// ---------------------------------------------------------------------------

/**
 * The minimal context for read-only interpretation. Contains only a
 * reader — enough to read values at any path.
 *
 * This is the base context type. `WritableContext` extends it with
 * dispatch and transaction support (`beginTransaction`/`commit`/`abort`).
 * Each layer adds only what it needs.
 */
export interface RefContext {
  readonly reader: Reader
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
 * const s = Schema.struct({
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
  // --- First-class CRDT types ---
  S extends TextSchema
    ? string
    : S extends CounterSchema
      ? number
      : S extends SetSchema<infer I>
        ? Plain<I>[]
        : S extends TreeSchema<infer Inner>
          ? Plain<Inner>
          : S extends MovableSequenceSchema<infer I>
            ? Plain<I>[]
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

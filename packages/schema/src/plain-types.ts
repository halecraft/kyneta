// plain-types — the type of a schema's plain value (`Plain<S>`), and the
// plain flat-tree node.
//
// Types only. Refs (`ref/readable.ts`), the folds (`interpreters/`) and the
// change vocabulary all use `Plain<S>`, so it lives apart from each of them.

import type { RichTextDelta } from "./change.js"

// ---------------------------------------------------------------------------
// PlainFlatTreeNode — Plain-form flat-forest node (matches the shadow)
// ---------------------------------------------------------------------------

/**
 * Plain-form one tree node — `{id, parent, index, data: Plain<I>}`.
 *
 * `Plain<TreeSchema<I>>` is the canonical flat-array snapshot, matching
 * `LoroTree.toArray()`, `stepTree`, and `TreeChange`. The recursive
 * projection a tree ref's `.roots` returns is not the canonical Plain
 * shape.
 */
export interface PlainFlatTreeNode<I extends Schema> {
  readonly id: string
  readonly parent: string | null
  readonly index: number
  readonly data: Plain<I>
}

import type {
  CounterSchema,
  DiscriminatedSumSchema,
  MapSchema,
  MovableSequenceSchema,
  PositionalSumSchema,
  ProductSchema,
  RichTextSchema,
  ScalarSchema,
  Schema,
  SequenceSchema,
  SetSchema,
  TextSchema,
  TreeSchema,
} from "./schema.js"

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
 * Readonly throughout: a read is a frozen snapshot shared by every consumer,
 * so mutating one is a type error here and a `TypeError` at runtime. Write
 * through the ref (`doc.items.push(item)`) to change the document. The modifiers sit inside
 * each clause rather than in a wrapping `DeepReadonly`, which would recurse
 * again through the result and push instantiation depth toward TS2589. A
 * `.json()` scalar keeps its declared type `V` for the same reason, though its
 * value is frozen too.
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
 * //     readonly title: string
 * //     readonly count: number
 * //     readonly items: readonly { readonly name: string; readonly done: boolean }[]
 * //     readonly settings: { readonly darkMode: boolean }
 * //     readonly metadata: { readonly [key: string]: unknown }
 * //   }
 * ```
 */
export type Plain<S extends Schema> =
  // --- First-class CRDT types ---
  S extends TextSchema
    ? string
    : S extends RichTextSchema
      ? RichTextDelta
      : S extends CounterSchema
        ? number
        : S extends SetSchema<infer I>
          ? readonly Plain<I>[]
          : S extends TreeSchema<infer Inner>
            ? readonly PlainFlatTreeNode<Inner>[]
            : S extends MovableSequenceSchema<infer I>
              ? readonly Plain<I>[]
              : // --- Scalar ---
                S extends ScalarSchema<infer _K, infer V>
                ? V
                : // --- Product ---
                  S extends ProductSchema<infer F>
                  ? { readonly [K in keyof F]: Plain<F[K]> }
                  : // --- Sequence ---
                    S extends SequenceSchema<infer I>
                    ? readonly Plain<I>[]
                    : // --- Map ---
                      S extends MapSchema<infer I>
                      ? { readonly [key: string]: Plain<I> }
                      : // --- Sum ---
                        S extends PositionalSumSchema<infer V>
                        ? Plain<V[number]>
                        : S extends DiscriminatedSumSchema<infer _D, infer V>
                          ? Plain<V[number]>
                          : unknown

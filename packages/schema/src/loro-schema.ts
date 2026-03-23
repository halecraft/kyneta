// LoroSchema — Loro-specific constructor namespace.
//
// Re-exports everything from the backend-agnostic Schema grammar, plus
// Loro-specific annotation constructors (text, counter, movableList, tree)
// and a `plain` sub-namespace that enforces composition constraints
// (no CRDT containers inside value blobs).
//
// Loro developers import only LoroSchema — one namespace, one import:
//
//   import { LoroSchema } from "@kyneta/schema"
//
//   LoroSchema.doc({
//     title: LoroSchema.text(),
//     tasks: LoroSchema.movableList(
//       LoroSchema.plain.struct({
//         name: LoroSchema.plain.string(),
//         done: LoroSchema.plain.boolean(),
//       }),
//     ),
//   })

import type { Schema as SchemaType } from "./schema.js"
import {
  type AnnotatedSchema,
  type DiscriminatedSumSchema,
  type MapSchema,
  type PlainProductSchema,
  type PlainSchema,
  type PositionalSumSchema,
  type ProductSchema,
  type ScalarSchema,
  Schema,
  type SequenceSchema,
} from "./schema.js"

// ---------------------------------------------------------------------------
// Loro-specific annotation constructors
// ---------------------------------------------------------------------------

/**
 * Collaborative text (CRDT). Produces `annotated("text")`.
 *
 * The annotation implies scalar string semantics for reads,
 * but the backend provides collaborative editing (insert, delete, marks).
 */
function text(): AnnotatedSchema<"text", undefined> {
  return Schema.annotated("text")
}

/**
 * Counter (CRDT). Produces `annotated("counter")`.
 *
 * The annotation implies scalar number semantics for reads,
 * but the backend provides increment/decrement.
 */
function counter(): AnnotatedSchema<"counter", undefined> {
  return Schema.annotated("counter")
}

/**
 * Movable list (CRDT with move semantics).
 * Produces `annotated("movable", sequence(item))`.
 */
function movableList<I extends SchemaType>(
  item: I,
): AnnotatedSchema<"movable", SequenceSchema<I>> {
  return Schema.annotated("movable", Schema.sequence(item))
}

/**
 * Hierarchical tree with typed node data (CRDT).
 * Produces `annotated("tree", nodeData)`.
 *
 * The `nodeData` schema describes the shape of each tree node's data.
 */
function tree<S extends SchemaType>(nodeData: S): AnnotatedSchema<"tree", S> {
  return Schema.annotated("tree", nodeData)
}

// ---------------------------------------------------------------------------
// Plain sub-namespace — composition-constrained constructors
// ---------------------------------------------------------------------------
// These are the constructors Loro developers use for "value blobs" —
// plain data stored inside CRDT containers. The parameter types are
// constrained to `PlainSchema` (the annotation-free subset of Schema),
// which prevents nesting CRDT containers (text, counter, movable list,
// tree) inside plain values at compile time.
//
// Return types remain as the original Schema interfaces (ProductSchema,
// SequenceSchema, etc.) so that downstream consumers — interpret(),
// Plain<S>, Writable<S>, describe(), validate() — work unchanged.

const plain = {
  /** Scalar string. With options, produces a constrained scalar. */
  string<V extends string = string>(
    ...options: V[]
  ): ScalarSchema<"string", V> {
    return Schema.string(...options)
  },

  /** Scalar number. With options, produces a constrained scalar. */
  number<V extends number = number>(
    ...options: V[]
  ): ScalarSchema<"number", V> {
    return Schema.number(...options)
  },

  /** Scalar boolean. With options, produces a constrained scalar. */
  boolean<V extends boolean = boolean>(
    ...options: V[]
  ): ScalarSchema<"boolean", V> {
    return Schema.boolean(...options)
  },

  /** Scalar null. */
  null(): ScalarSchema<"null"> {
    return Schema.null()
  },

  /** Scalar undefined. */
  undefined(): ScalarSchema<"undefined"> {
    return Schema.undefined()
  },

  /** Binary data. */
  bytes(): ScalarSchema<"bytes"> {
    return Schema.bytes()
  },

  /** Opaque value — any type. */
  any(): ScalarSchema<"any"> {
    return Schema.any()
  },

  /** Fixed-key plain struct (product with no annotation).
   *  Fields are constrained to `PlainSchema` — no CRDT annotations allowed. */
  struct<F extends Record<string, PlainSchema>>(fields: F): ProductSchema<F> {
    return Schema.struct(fields)
  },

  /** Dynamic-key plain record (map with no annotation).
   *  Item schema is constrained to `PlainSchema`. */
  record<I extends PlainSchema>(item: I): MapSchema<I> {
    return Schema.record(item)
  },

  /** Plain array (sequence with no annotation).
   *  Item schema is constrained to `PlainSchema`. */
  array<I extends PlainSchema>(item: I): SequenceSchema<I> {
    return Schema.list(item)
  },

  /** Union of plain schemas.
   *  Variants are constrained to `PlainSchema`. */
  union<V extends PlainSchema[]>(...variants: [...V]): PositionalSumSchema<V> {
    return Schema.sum(variants)
  },

  /** Discriminated union of plain schemas.
   *  Each variant must be a plain product declaring the discriminant field. */
  discriminatedUnion<D extends string, V extends PlainProductSchema[]>(
    discriminant: D,
    variants: [...V],
  ): DiscriminatedSumSchema<D, V> {
    return Schema.discriminatedUnion(discriminant, variants)
  },
} as const

// ---------------------------------------------------------------------------
// LoroSchema namespace — Schema + Loro annotations + plain
// ---------------------------------------------------------------------------

/**
 * Loro-specific schema constructors. Re-exports the backend-agnostic
 * `Schema` grammar and adds Loro-specific annotations and composition
 * constraints.
 *
 * ```ts
 * const myDoc = LoroSchema.doc({
 *   title: LoroSchema.text(),
 *   count: LoroSchema.counter(),
 *   tasks: LoroSchema.movableList(
 *     LoroSchema.plain.struct({
 *       name: LoroSchema.plain.string(),
 *       done: LoroSchema.plain.boolean(),
 *     }),
 *   ),
 *   labels: LoroSchema.plain.record(LoroSchema.plain.string()),
 * })
 * ```
 *
 * **Scalars (leaf values):**
 * `LoroSchema.string`, `LoroSchema.number`, `LoroSchema.boolean`,
 * `LoroSchema.null`, `LoroSchema.undefined`, `LoroSchema.bytes`,
 * `LoroSchema.any`
 *
 * **Structural composites:**
 * `LoroSchema.struct`, `LoroSchema.list`, `LoroSchema.record`,
 * `LoroSchema.union`, `LoroSchema.discriminatedUnion`,
 * `LoroSchema.nullable`
 *
 * **Loro-specific annotations:**
 * `LoroSchema.text`, `LoroSchema.counter`,
 * `LoroSchema.movableList`, `LoroSchema.tree`
 *
 * **Root:**
 * `LoroSchema.doc`
 *
 * **Plain values (composition-constrained):**
 * `LoroSchema.plain.string`, `LoroSchema.plain.number`, etc.
 * `LoroSchema.plain.struct`, `LoroSchema.plain.record`,
 * `LoroSchema.plain.array`, `LoroSchema.plain.union`,
 * `LoroSchema.plain.discriminatedUnion`
 *
 * **Low-level (grammar-native, power users):**
 * `LoroSchema.scalar`, `LoroSchema.product`, `LoroSchema.sequence`,
 * `LoroSchema.map`, `LoroSchema.sum`, `LoroSchema.discriminatedSum`,
 * `LoroSchema.annotated`
 */
export const LoroSchema = {
  // --- Re-exported from Schema (backend-agnostic base grammar) ---

  // Low-level structural constructors
  scalar: Schema.scalar,
  product: Schema.product,
  sequence: Schema.sequence,
  map: Schema.map,
  sum: Schema.sum,
  discriminatedSum: Schema.discriminatedSum,
  annotated: Schema.annotated,

  // Scalars (leaf values)
  string: Schema.string,
  number: Schema.number,
  boolean: Schema.boolean,
  null: Schema.null,
  undefined: Schema.undefined,
  bytes: Schema.bytes,
  any: Schema.any,

  // Structural composites
  struct: Schema.struct,
  list: Schema.list,
  record: Schema.record,
  union: Schema.union,
  discriminatedUnion: Schema.discriminatedUnion,
  nullable: Schema.nullable,

  // Root
  doc: Schema.doc,

  // --- Loro-specific annotations ---
  text,
  counter,
  movableList,
  tree,

  // --- Composition-constrained plain values ---
  plain,
} as const

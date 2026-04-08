// LoroSchema — Loro-specific constructor namespace.
//
// Only Loro container constructors are available at the top level.
// Plain values (scalars, sums) are available via `LoroSchema.plain.*`.
//
// Loro developers import only LoroSchema — one namespace, one import:
//
//   import { LoroSchema } from "@kyneta/loro-schema"
//
//   LoroSchema.doc({
//     title: LoroSchema.text(),
//     tasks: LoroSchema.movableList(
//       LoroSchema.plain.struct({
//         name: LoroSchema.plain.string(),
//         done: LoroSchema.plain.boolean(),
//       }),
//     ),
//     darkMode: LoroSchema.plain.boolean(),  // → stored in _props
//   })

import type { Schema as SchemaType } from "@kyneta/schema"
import {
  type AnnotatedSchema,
  type DiscriminatedSumSchema,
  type ExtractTags,
  type MapSchema,
  type PlainProductSchema,
  type PlainSchema,
  type PositionalSumSchema,
  type ProductSchema,
  type ScalarSchema,
  Schema,
  type SequenceSchema,
} from "@kyneta/schema"

// ---------------------------------------------------------------------------
// LoroDocFieldSchema — what is valid as a direct child of LoroSchema.doc()
// ---------------------------------------------------------------------------

/**
 * Schema types that are valid as direct children of a `LoroDoc`.
 *
 * **Loro containers** — map to real Loro CRDT containers at the root:
 * - `ProductSchema` → `LoroMap` (via `LoroSchema.struct`)
 * - `SequenceSchema` → `LoroList` (via `LoroSchema.list`)
 * - `MapSchema` → `LoroMap` (via `LoroSchema.record`)
 * - `AnnotatedSchema` → `LoroText`, `LoroCounter`, `LoroMovableList`,
 *   `LoroTree` (via `LoroSchema.text`, `.counter`, `.movableList`, `.tree`)
 *
 * **Plain values** — stored in the shared `_props` `LoroMap`:
 * - `PlainSchema` — scalars (`LoroSchema.plain.boolean()`, etc.) and
 *   plain structural types (`LoroSchema.plain.struct(...)`, etc.)
 *
 * This excludes non-plain `SumSchema` (sums containing annotations),
 * which cannot be stored as root fields. Plain sums are allowed via
 * `PlainSchema` (e.g. `LoroSchema.plain.nullable(LoroSchema.plain.string())`).
 */
export type LoroDocFieldSchema =
  | ProductSchema
  | SequenceSchema
  | MapSchema
  | AnnotatedSchema
  | PlainSchema

// ---------------------------------------------------------------------------
// Loro-specific annotation constructors
// ---------------------------------------------------------------------------

/**
 * Collaborative text (CRDT). Produces `annotated("text")`.
 *
 * The annotation implies scalar string semantics for reads,
 * but the backend provides collaborative editing (insert, delete, marks).
 */
function text(): AnnotatedSchema<"text", undefined, "text"> {
  return Schema.annotated("text")
}

/**
 * Counter (CRDT). Produces `annotated("counter")`.
 *
 * The annotation implies scalar number semantics for reads,
 * but the backend provides increment/decrement.
 */
function counter(): AnnotatedSchema<"counter", undefined, "counter"> {
  return Schema.annotated("counter")
}

/**
 * Movable list (CRDT with move semantics).
 * Produces `annotated("movable", sequence(item))`.
 */
function movableList<I extends SchemaType>(
  item: I,
): AnnotatedSchema<"movable", SequenceSchema<I, ExtractTags<I>>, "movable" | ExtractTags<I>> {
  return Schema.annotated("movable", Schema.sequence(item))
}

/**
 * Hierarchical tree with typed node data (CRDT).
 * Produces `annotated("tree", nodeData)`.
 *
 * The `nodeData` schema describes the shape of each tree node's data.
 */
function tree<S extends SchemaType>(nodeData: S): AnnotatedSchema<"tree", S, "tree" | ExtractTags<S>> {
  return Schema.annotated("tree", nodeData)
}

// ---------------------------------------------------------------------------
// Root document constructor (constrained to LoroDocFieldSchema)
// ---------------------------------------------------------------------------

/**
 * Loro document root. Constrains fields to `LoroDocFieldSchema` —
 * only Loro containers and plain values are accepted.
 *
 * Loro containers (struct, list, record, text, counter, etc.) get their
 * own root-level Loro container. Plain values (scalars, plain sums) are
 * stored in the shared `_props` LoroMap.
 *
 * ```ts
 * LoroSchema.doc({
 *   title: LoroSchema.text(),              // → LoroText
 *   items: LoroSchema.list(...),           // → LoroList
 *   darkMode: LoroSchema.plain.boolean(),  // → _props.darkMode
 * })
 * ```
 */
function doc<F extends Record<string, LoroDocFieldSchema>>(
  fields: F,
): AnnotatedSchema<"doc", ProductSchema<F, ExtractTags<F[keyof F]>>, "doc" | ExtractTags<F[keyof F]>> {
  return Schema.doc(fields as Record<string, SchemaType>) as any
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
  struct<F extends Record<string, PlainSchema>>(fields: F): ProductSchema<F, ExtractTags<F[keyof F]>> {
    return Schema.struct(fields)
  },

  /** Dynamic-key plain record (map with no annotation).
   *  Item schema is constrained to `PlainSchema`. */
  record<I extends PlainSchema>(item: I): MapSchema<I, ExtractTags<I>> {
    return Schema.record(item)
  },

  /** Plain array (sequence with no annotation).
   *  Item schema is constrained to `PlainSchema`. */
  array<I extends PlainSchema>(item: I): SequenceSchema<I, ExtractTags<I>> {
    return Schema.list(item)
  },

  /** Union of plain schemas.
   *  Variants are constrained to `PlainSchema`. */
  union<V extends PlainSchema[]>(...variants: [...V]): PositionalSumSchema<V, ExtractTags<V[number]>> {
    return Schema.sum(variants)
  },

  /** Discriminated union of plain schemas.
   *  Each variant must be a plain product declaring the discriminant field. */
  discriminatedUnion<D extends string, V extends PlainProductSchema[]>(
    discriminant: D,
    variants: [...V],
  ): DiscriminatedSumSchema<D, V, ExtractTags<V[number]>> {
    return Schema.discriminatedUnion(discriminant, variants)
  },

  /**
   * Nullable plain value. Produces `sum([inner, null()])`.
   *
   * Only plain schemas are accepted — Loro containers (text, counter, etc.)
   * cannot be null. A `LoroText` is always a `LoroText`; if you need
   * "this field might not exist", use a `LoroSchema.record()` where the
   * key may or may not be present.
   */
  nullable<S extends PlainSchema>(
    inner: S,
  ): PositionalSumSchema<[ScalarSchema<"null">, S], ExtractTags<S>> {
    return Schema.nullable(inner)
  },
} as const

// ---------------------------------------------------------------------------
// LoroSchema namespace
// ---------------------------------------------------------------------------

/**
 * Loro-specific schema constructors.
 *
 * Only Loro container constructors are available at the top level.
 * Plain values (scalars, sums, nullable) are available via `LoroSchema.plain.*`.
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
 *   labels: LoroSchema.record(LoroSchema.plain.string()),
 *   darkMode: LoroSchema.plain.boolean(),  // → stored in _props
 * })
 * ```
 *
 * **Loro containers (root-level):**
 * `LoroSchema.struct`, `LoroSchema.list`, `LoroSchema.record`
 *
 * **Loro-specific annotations:**
 * `LoroSchema.text`, `LoroSchema.counter`,
 * `LoroSchema.movableList`, `LoroSchema.tree`
 *
 * **Root:**
 * `LoroSchema.doc` — constrained to `LoroDocFieldSchema`
 *
 * **Plain values (composition-constrained):**
 * `LoroSchema.plain.string`, `LoroSchema.plain.number`,
 * `LoroSchema.plain.boolean`, `LoroSchema.plain.null`,
 * `LoroSchema.plain.undefined`, `LoroSchema.plain.bytes`,
 * `LoroSchema.plain.any`, `LoroSchema.plain.struct`,
 * `LoroSchema.plain.record`, `LoroSchema.plain.array`,
 * `LoroSchema.plain.union`, `LoroSchema.plain.discriminatedUnion`,
 * `LoroSchema.plain.nullable`
 */
export const LoroSchema = {
  // --- Structural composites (map to real Loro containers) ---
  struct: Schema.struct,
  list: Schema.list,
  record: Schema.record,

  // --- Root ---
  doc,

  // --- Loro-specific annotations ---
  text,
  counter,
  movableList,
  tree,

  // --- Composition-constrained plain values ---
  plain,
} as const

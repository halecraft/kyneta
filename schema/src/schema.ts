// Schema — a single recursive type for document structure.
//
// The grammar has five structural constructors (scalar, product, sequence,
// map, sum) plus an open annotation mechanism. Annotations attach backend
// semantics (collaborative text, counter, movable list, tree) without
// changing the recursive structure.
//
// The container/value distinction from Loro's runtime is NOT part of this
// grammar — it's an interpretation concern. The developer-facing
// constructor API (Schema.text(), Schema.struct(), etc.) is sugar that
// produces annotated nodes in the unified grammar.

// ---------------------------------------------------------------------------
// Scalar kinds — leaf values (not a separate recursive grammar)
// ---------------------------------------------------------------------------

/**
 * The set of built-in scalar kinds. This is intentionally a string union
 * rather than a recursive type — scalars are terminal.
 *
 * Third-party backends can use custom scalar kinds via the `annotated`
 * mechanism (e.g. `annotated("timestamp", scalar("number"))`).
 */
export type ScalarKind =
  | "string"
  | "number"
  | "boolean"
  | "null"
  | "undefined"
  | "bytes"
  | "any"

// ---------------------------------------------------------------------------
// Schema — the unified recursive type
// ---------------------------------------------------------------------------

/**
 * A schema node. This is the fixed point of a functor with six cases:
 *
 * - `scalar(kind)` — leaf value
 * - `product(fields)` — fixed-key record (struct, doc)
 * - `sequence(item)` — ordered collection (list)
 * - `map(item)` — dynamic-key collection (record)
 * - `sum(variants)` — tagged union
 * - `annotated(tag, schema?)` — semantic enrichment
 *
 * The grammar is backend-agnostic. Backends attach meaning via annotations.
 */
export type Schema =
  | ScalarSchema
  | ProductSchema
  | SequenceSchema
  | MapSchema
  | SumSchema
  | AnnotatedSchema

// --- Scalar ------------------------------------------------------------------

export interface ScalarSchema<K extends ScalarKind = ScalarKind> {
  readonly _kind: "scalar"
  readonly scalarKind: K
}

// --- Product -----------------------------------------------------------------

export interface ProductSchema<F extends Record<string, Schema> = Record<string, Schema>> {
  readonly _kind: "product"
  readonly fields: Readonly<F>
}

// --- Sequence ----------------------------------------------------------------

export interface SequenceSchema<I extends Schema = Schema> {
  readonly _kind: "sequence"
  readonly item: I
}

// --- Map ---------------------------------------------------------------------

export interface MapSchema<I extends Schema = Schema> {
  readonly _kind: "map"
  readonly item: I
}

// --- Sum ---------------------------------------------------------------------

/**
 * A sum (union) of schemas. Two flavors:
 *
 * 1. **Positional** — `variants` is an array of schemas (simple union).
 * 2. **Discriminated** — `discriminant` names the key used to distinguish
 *    variants, and `variantMap` maps discriminant values to schemas.
 *
 * Both flavors share the `_kind: "sum"` discriminant. If `discriminant`
 * is present, the sum is discriminated.
 */
export type SumSchema = PositionalSumSchema | DiscriminatedSumSchema

export interface PositionalSumSchema<V extends readonly Schema[] = readonly Schema[]> {
  readonly _kind: "sum"
  readonly variants: V
  readonly discriminant?: undefined
}

export interface DiscriminatedSumSchema<
  D extends string = string,
  M extends Record<string, Schema> = Record<string, Schema>,
> {
  readonly _kind: "sum"
  readonly discriminant: D
  readonly variantMap: Readonly<M>
  readonly variants?: undefined
}

// --- Annotated ---------------------------------------------------------------

/**
 * Semantic enrichment. An annotation wraps an optional inner schema with
 * a string tag and optional metadata. The tag set is open — backends
 * define their own.
 *
 * Built-in tags used by the Loro-flavored constructor API:
 * - `"text"` — collaborative text (inner: none, implies scalar string)
 * - `"counter"` — counter semantics (inner: none, implies scalar number)
 * - `"movable"` — move-capable sequence (inner: sequence)
 * - `"tree"` — hierarchical tree (inner: product for node data)
 * - `"doc"` — document root (inner: product)
 *
 * Third-party examples:
 * - `"timestamp"` — Firestore timestamp
 * - `"richtext"` — rich text with marks
 */
export interface AnnotatedSchema<
  T extends string = string,
  S extends Schema | undefined = Schema | undefined,
> {
  readonly _kind: "annotated"
  readonly tag: T
  readonly schema?: S
  readonly meta?: Readonly<Record<string, unknown>>
}

// ---------------------------------------------------------------------------
// Structural constructors (low-level, grammar-native)
// ---------------------------------------------------------------------------

function scalar<K extends ScalarKind>(scalarKind: K): ScalarSchema<K> {
  return { _kind: "scalar", scalarKind }
}

function product<F extends Record<string, Schema>>(fields: F): ProductSchema<F> {
  return { _kind: "product", fields }
}

function sequence<I extends Schema>(item: I): SequenceSchema<I> {
  return { _kind: "sequence", item }
}

function map<I extends Schema>(item: I): MapSchema<I> {
  return { _kind: "map", item }
}

function sum<V extends Schema[]>(variants: [...V]): PositionalSumSchema<V> {
  return { _kind: "sum", variants }
}

function discriminatedSum<
  D extends string,
  M extends Record<string, Schema>,
>(
  discriminant: D,
  variantMap: M,
): DiscriminatedSumSchema<D, M> {
  return { _kind: "sum", discriminant, variantMap }
}

function annotated<T extends string, S extends Schema | undefined = undefined>(
  tag: T,
  schema?: S,
  meta?: Record<string, unknown>,
): AnnotatedSchema<T, S> {
  return {
    _kind: "annotated",
    tag,
    ...(schema !== undefined && { schema }),
    ...(meta !== undefined && { meta }),
  } as AnnotatedSchema<T, S>
}

// ---------------------------------------------------------------------------
// Developer-facing sugar — Loro-flavored constructors
// ---------------------------------------------------------------------------
// These produce annotated nodes in the unified grammar but present the
// familiar Schema.text(), Schema.struct(), etc. API. The underlying
// representation is always the five structural kinds + annotated.

/**
 * Collaborative text (CRDT). Produces `annotated("text")`.
 *
 * The annotation implies scalar string semantics for reads,
 * but the backend provides collaborative editing (insert, delete, marks).
 */
function text(): AnnotatedSchema<"text", undefined> {
  return annotated("text")
}

/**
 * Counter (CRDT). Produces `annotated("counter")`.
 *
 * The annotation implies scalar number semantics for reads,
 * but the backend provides increment/decrement.
 */
function counter(): AnnotatedSchema<"counter", undefined> {
  return annotated("counter")
}

/**
 * Ordered list. Produces `sequence(item)`.
 */
function list<I extends Schema>(item: I): SequenceSchema<I> {
  return sequence(item)
}

/**
 * Movable list (CRDT with move semantics).
 * Produces `annotated("movable", sequence(item))`.
 */
function movableList<I extends Schema>(item: I): AnnotatedSchema<"movable", SequenceSchema<I>> {
  return annotated("movable", sequence(item))
}

/**
 * Fixed-key struct. Produces `product(fields)`.
 */
function struct<F extends Record<string, Schema>>(fields: F): ProductSchema<F> {
  return product(fields)
}

/**
 * Dynamic-key record. Produces `map(item)`.
 */
function record<I extends Schema>(item: I): MapSchema<I> {
  return map(item)
}

/**
 * Hierarchical tree with typed node data (CRDT).
 * Produces `annotated("tree", nodeData)`.
 *
 * The `nodeData` schema describes the shape of each tree node's data.
 */
function tree<S extends Schema>(nodeData: S): AnnotatedSchema<"tree", S> {
  return annotated("tree", nodeData)
}

/**
 * Document root. Produces `annotated("doc", product(fields))`.
 *
 * Structurally a product, but the "doc" annotation tells interpreters
 * this is the root entry point (analogous to TypedDoc in the current
 * codebase).
 */
function doc<F extends Record<string, Schema>>(fields: F): AnnotatedSchema<"doc", ProductSchema<F>> {
  return annotated("doc", product(fields))
}

// ---------------------------------------------------------------------------
// Scalar constructors (leaf values)
// ---------------------------------------------------------------------------

/** Scalar string. Produces `scalar("string")`. */
function string_(): ScalarSchema<"string"> {
  return scalar("string")
}

/** Scalar number. Produces `scalar("number")`. */
function number_(): ScalarSchema<"number"> {
  return scalar("number")
}

/** Scalar boolean. Produces `scalar("boolean")`. */
function boolean_(): ScalarSchema<"boolean"> {
  return scalar("boolean")
}

/** Scalar null. Produces `scalar("null")`. */
function null_(): ScalarSchema<"null"> {
  return scalar("null")
}

/** Scalar undefined. Produces `scalar("undefined")`. */
function undefined_(): ScalarSchema<"undefined"> {
  return scalar("undefined")
}

/** Binary data. Produces `scalar("bytes")`. */
function bytes(): ScalarSchema<"bytes"> {
  return scalar("bytes")
}

/** Opaque value — any type. Produces `scalar("any")`. */
function any(): ScalarSchema<"any"> {
  return scalar("any")
}

// ---------------------------------------------------------------------------
// Structural composite constructors (sum sugar)
// ---------------------------------------------------------------------------

/**
 * Positional union of schemas. Produces `sum(variants)`.
 *
 * ```ts
 * Schema.union(Schema.string(), Schema.number())
 * ```
 */
function union<V extends Schema[]>(...variants: [...V]): PositionalSumSchema<V> {
  return sum(variants)
}

/**
 * Discriminated union — variants keyed by discriminant value.
 * Produces `discriminatedSum(discriminant, variantMap)`.
 *
 * ```ts
 * Schema.discriminatedUnion("type", {
 *   text: Schema.struct({ body: Schema.string() }),
 *   image: Schema.struct({ url: Schema.string() }),
 * })
 * ```
 */
function discriminatedUnion<D extends string, M extends Record<string, Schema>>(
  discriminant: D,
  variantMap: M,
): DiscriminatedSumSchema<D, M> {
  return discriminatedSum(discriminant, variantMap)
}

/**
 * Nullable schema — sugar for `union(null, inner)`.
 * Produces `sum([scalar("null"), inner])`.
 *
 * ```ts
 * Schema.nullable(Schema.string()) // string | null
 * ```
 */
function nullable<S extends Schema>(inner: S): PositionalSumSchema<[ScalarSchema<"null">, S]> {
  return sum([null_(), inner])
}

// ---------------------------------------------------------------------------
// Schema namespace — all constructors gathered
// ---------------------------------------------------------------------------

/**
 * Schema constructors. Usage:
 *
 * ```ts
 * const myDoc = Schema.doc({
 *   title: Schema.text(),
 *   count: Schema.counter(),
 *   tags: Schema.list(Schema.string()),
 *   metadata: Schema.struct({
 *     author: Schema.string(),
 *     published: Schema.boolean(),
 *   }),
 * })
 * ```
 *
 * **Scalars (leaf values):**
 * `Schema.string`, `Schema.number`, `Schema.boolean`, `Schema.null`,
 * `Schema.undefined`, `Schema.bytes`, `Schema.any`
 *
 * **Structural composites:**
 * `Schema.struct`, `Schema.list`, `Schema.record`,
 * `Schema.union`, `Schema.discriminatedUnion`, `Schema.nullable`
 *
 * **Annotated (backend semantics):**
 * `Schema.text`, `Schema.counter`, `Schema.movableList`,
 * `Schema.tree`, `Schema.doc`
 *
 * **Low-level (grammar-native, power users):**
 * `Schema.scalar`, `Schema.product`, `Schema.sequence`, `Schema.map`,
 * `Schema.sum`, `Schema.discriminatedSum`, `Schema.annotated`
 */
export const Schema = {
  // Low-level structural constructors
  scalar,
  product,
  sequence,
  map,
  sum,
  discriminatedSum,
  annotated,

  // Scalars (leaf values)
  string: string_,
  number: number_,
  boolean: boolean_,
  null: null_,
  undefined: undefined_,
  bytes,
  any,

  // Structural composites
  struct,
  list,
  record,
  union,
  discriminatedUnion,
  nullable,

  // Annotated (backend semantics)
  text,
  counter,
  movableList,
  tree,
  doc,
} as const

// ---------------------------------------------------------------------------
// Utility: structural kind extraction
// ---------------------------------------------------------------------------

/**
 * Returns the structural kind of a schema node, looking through
 * annotations to find the underlying structure.
 *
 * For annotated nodes without an inner schema (e.g. `text()`, `counter()`),
 * returns `"annotated"` — the annotation IS the structure.
 *
 * For annotated nodes with an inner schema (e.g. `movableList()`, `doc()`),
 * returns `"annotated"` as well — callers that want the inner structural
 * kind should unwrap `.schema` themselves.
 */
export function structuralKind(schema: Schema): Schema["_kind"] {
  return schema._kind
}

/**
 * Returns `true` if the schema node is annotated (directly).
 */
export function isAnnotated(schema: Schema): schema is AnnotatedSchema {
  return schema._kind === "annotated"
}

/**
 * If the schema is annotated, returns the inner schema (if any).
 * Otherwise returns the schema itself.
 *
 * This is useful for interpreters that want to "see through" annotations
 * to the underlying structure while still being able to inspect the tag.
 */
export function unwrapAnnotation(schema: Schema): Schema | undefined {
  if (schema._kind === "annotated") {
    return schema.schema
  }
  return schema
}
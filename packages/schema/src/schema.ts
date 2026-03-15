// Schema — a single recursive type for document structure.
//
// The grammar has five structural constructors (scalar, product, sequence,
// map, sum) plus an open annotation mechanism. Annotations attach backend
// semantics without changing the recursive structure.
//
// This grammar is backend-agnostic. Backend-specific annotation
// constructors (e.g. LoroSchema.text(), LoroSchema.counter()) live in
// loro-schema.ts. The developer-facing Schema namespace provides only
// structural constructors and the open `annotated()` mechanism.

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

export interface ScalarSchema<
  K extends ScalarKind = ScalarKind,
  V extends ScalarPlain<K> = ScalarPlain<K>,
> {
  readonly _kind: "scalar"
  readonly scalarKind: K
  readonly constraint?: readonly V[]
}

/**
 * Maps a ScalarKind literal to the corresponding TypeScript plain type.
 *
 * Used as the default for the `V` type parameter on `ScalarSchema` and
 * by interpreters that need the "widest" type for a scalar kind.
 */
export type ScalarPlain<K extends ScalarKind> =
  K extends "string" ? string
  : K extends "number" ? number
  : K extends "boolean" ? boolean
  : K extends "null" ? null
  : K extends "undefined" ? undefined
  : K extends "bytes" ? Uint8Array
  : K extends "any" ? unknown
  : never

// --- Product -----------------------------------------------------------------

export interface ProductSchema<F extends Record<string, Schema> = Record<string, Schema>> {
  readonly _kind: "product"
  readonly fields: Readonly<F>
  readonly discriminantKey?: string
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
 *    variants. Each variant is a `ProductSchema` that declares the
 *    discriminant as a constrained string scalar field (Zod-style).
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
  V extends readonly ProductSchema[] = readonly ProductSchema[],
> {
  readonly _kind: "sum"
  readonly discriminant: D
  readonly variants: V
  /**
   * Derived lookup from discriminant value → variant ProductSchema.
   * Built eagerly by the constructor from each variant's discriminant
   * field constraint. Used by `dispatchSum`, `interpret`, `validate`,
   * `describe`, etc.
   */
  readonly variantMap: Readonly<Record<string, ProductSchema>>
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
// PlainSchema — the annotation-free subset of Schema
// ---------------------------------------------------------------------------

/**
 * The subset of the schema grammar that contains no annotations.
 *
 * `PlainSchema` is the recursive type used by `LoroSchema.plain.*`
 * constructors to enforce Loro's well-formedness rule: CRDT containers
 * (text, counter, movable list, tree) — which are all represented as
 * `AnnotatedSchema` — cannot appear inside plain value blobs.
 *
 * This type lives in the grammar layer (not in `LoroSchema`) because it
 * is a *structural* subset — "schema without annotations" — with no
 * backend-specific knowledge. Other backends with their own annotation
 * tags can reuse the same constraint.
 *
 * Every `PlainSchema` value is also a `Schema` value (structural subtype),
 * so plain schemas work with `interpret()`, `describe()`, `validate()`,
 * `Zero.structural()`, `Plain<S>`, and `Writable<S>` without casts.
 */
export type PlainSchema =
  | ScalarSchema
  | PlainProductSchema
  | PlainSequenceSchema
  | PlainMapSchema
  | PlainPositionalSumSchema
  | PlainDiscriminatedSumSchema

/**
 * Product (fixed-key record) constrained to plain children.
 * Structurally identical to `ProductSchema` but with the recursive
 * position narrowed to `PlainSchema`.
 */
export interface PlainProductSchema<
  F extends Record<string, PlainSchema> = Record<string, PlainSchema>,
> {
  readonly _kind: "product"
  readonly fields: Readonly<F>
  readonly discriminantKey?: string
}

/**
 * Sequence (ordered collection) constrained to plain children.
 */
export interface PlainSequenceSchema<I extends PlainSchema = PlainSchema> {
  readonly _kind: "sequence"
  readonly item: I
}

/**
 * Map (dynamic-key collection) constrained to plain children.
 */
export interface PlainMapSchema<I extends PlainSchema = PlainSchema> {
  readonly _kind: "map"
  readonly item: I
}

/**
 * Positional sum constrained to plain variants.
 */
export interface PlainPositionalSumSchema<
  V extends readonly PlainSchema[] = readonly PlainSchema[],
> {
  readonly _kind: "sum"
  readonly variants: V
  readonly discriminant?: undefined
}

/**
 * Discriminated sum constrained to plain variants.
 */
export interface PlainDiscriminatedSumSchema<
  D extends string = string,
  V extends readonly PlainProductSchema[] = readonly PlainProductSchema[],
> {
  readonly _kind: "sum"
  readonly discriminant: D
  readonly variants: V
  readonly variantMap: Readonly<Record<string, PlainProductSchema>>
}

// ---------------------------------------------------------------------------
// Structural constructors (low-level, grammar-native)
// ---------------------------------------------------------------------------

function scalar<K extends ScalarKind>(scalarKind: K): ScalarSchema<K>
function scalar<K extends ScalarKind, V extends ScalarPlain<K>>(
  scalarKind: K,
  constraint: readonly V[],
): ScalarSchema<K, V>
function scalar<K extends ScalarKind, V extends ScalarPlain<K>>(
  scalarKind: K,
  constraint?: readonly V[],
): ScalarSchema<K, V> {
  if (constraint !== undefined && constraint.length > 0) {
    return { _kind: "scalar", scalarKind, constraint } as ScalarSchema<K, V>
  }
  return { _kind: "scalar", scalarKind } as ScalarSchema<K, V>
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

/**
 * Build a variant lookup map from an array of product schemas.
 *
 * Each variant must have a field at `discriminant` whose schema is a
 * constrained string scalar (e.g. `Schema.string("text")`). The first
 * constraint value is used as the map key.
 *
 * @throws If any variant lacks the discriminant field.
 * @throws If any variant's discriminant field is not a constrained string scalar.
 * @throws If two variants share the same discriminant value.
 */
export function buildVariantMap<D extends string>(
  discriminant: D,
  variants: readonly ProductSchema[],
): Record<string, ProductSchema> {
  const map: Record<string, ProductSchema> = {}
  for (let i = 0; i < variants.length; i++) {
    const variant = variants[i]!
    const fieldSchema = variant.fields[discriminant]
    if (!fieldSchema) {
      throw new Error(
        `discriminatedUnion: variant ${i} is missing the discriminant field "${discriminant}".` +
        ` Each variant must include a field like { ${discriminant}: Schema.string("value") }.`,
      )
    }
    if (
      fieldSchema._kind !== "scalar" ||
      fieldSchema.scalarKind !== "string" ||
      !fieldSchema.constraint ||
      fieldSchema.constraint.length === 0
    ) {
      throw new Error(
        `discriminatedUnion: variant ${i}'s "${discriminant}" field must be a constrained string scalar` +
        ` (e.g. Schema.string("value")), got ${fieldSchema._kind}/${(fieldSchema as ScalarSchema).scalarKind ?? "?"}.`,
      )
    }
    const discValue = fieldSchema.constraint[0] as string
    if (discValue in map) {
      throw new Error(
        `discriminatedUnion: duplicate discriminant value "${discValue}" in variants ${Object.keys(map).indexOf(discValue)} and ${i}.`,
      )
    }
    map[discValue] = variant
  }
  return map
}

function discriminatedSum<
  D extends string,
  V extends ProductSchema[],
>(
  discriminant: D,
  variants: [...V],
): DiscriminatedSumSchema<D, V> {
  const variantMap = buildVariantMap(discriminant, variants)
  // Stamp each variant with the discriminant key so interpreter layers
  // can identify and special-case the discriminant field at runtime.
  for (const variant of variants) {
    ;(variant as any).discriminantKey = discriminant
  }
  return { _kind: "sum", discriminant, variants, variantMap }
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
// Developer-facing sugar — structural constructors
// ---------------------------------------------------------------------------
// These produce structural nodes in the unified grammar. Backend-specific
// annotation constructors (text, counter, movableList, tree) live in
// LoroSchema (src/loro-schema.ts).

/**
 * Ordered list. Produces `sequence(item)`.
 */
function list<I extends Schema>(item: I): SequenceSchema<I> {
  return sequence(item)
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

/**
 * Scalar string. Produces `scalar("string")`.
 *
 * With options, produces a constrained scalar that narrows the type:
 * ```ts
 * Schema.string("public", "private") // ScalarSchema<"string", "public" | "private">
 * ```
 */
function string_<V extends string = string>(
  ...options: V[]
): ScalarSchema<"string", V> {
  return options.length > 0
    ? scalar("string", options)
    : scalar("string") as ScalarSchema<"string", V>
}

/**
 * Scalar number. Produces `scalar("number")`.
 *
 * With options, produces a constrained scalar that narrows the type:
 * ```ts
 * Schema.number(1, 2, 3) // ScalarSchema<"number", 1 | 2 | 3>
 * ```
 */
function number_<V extends number = number>(
  ...options: V[]
): ScalarSchema<"number", V> {
  return options.length > 0
    ? scalar("number", options)
    : scalar("number") as ScalarSchema<"number", V>
}

/**
 * Scalar boolean. Produces `scalar("boolean")`.
 *
 * With options, produces a constrained scalar that narrows the type:
 * ```ts
 * Schema.boolean(true) // ScalarSchema<"boolean", true>
 * ```
 */
function boolean_<V extends boolean = boolean>(
  ...options: V[]
): ScalarSchema<"boolean", V> {
  return options.length > 0
    ? scalar("boolean", options)
    : scalar("boolean") as ScalarSchema<"boolean", V>
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
 * Discriminated union — each variant declares the discriminant field.
 *
 * Follows the Zod/Valibot convention: every variant is a product
 * (struct) that includes the discriminant as a constrained string
 * scalar field. The discriminant value is the field's constraint.
 *
 * ```ts
 * Schema.discriminatedUnion("type", [
 *   Schema.struct({ type: Schema.string("text"), body: Schema.string() }),
 *   Schema.struct({ type: Schema.string("image"), url: Schema.string() }),
 * ])
 * ```
 *
 * @throws If any variant lacks the discriminant field.
 * @throws If any variant's discriminant field is not a constrained string scalar.
 * @throws If two variants share the same discriminant value.
 */
function discriminatedUnion<D extends string, V extends ProductSchema[]>(
  discriminant: D,
  variants: [...V],
): DiscriminatedSumSchema<D, V> {
  return discriminatedSum(discriminant, variants)
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
 * **Root:**
 * `Schema.doc`
 *
 * **Low-level (grammar-native, power users):**
 * `Schema.scalar`, `Schema.product`, `Schema.sequence`, `Schema.map`,
 * `Schema.sum`, `Schema.discriminatedSum`, `Schema.annotated`
 *
 * Backend-specific annotation constructors (text, counter, movableList,
 * tree) live in `LoroSchema`. See `src/loro-schema.ts`.
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

  // Root
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
 * Returns `true` if the schema is the nullable sugar pattern:
 * a positional sum with exactly 2 variants where the first is `scalar("null")`.
 *
 * This is the pattern produced by `Schema.nullable(inner)`.
 */
export function isNullableSum(schema: PositionalSumSchema): boolean {
  return (
    schema.variants.length === 2 &&
    schema.variants[0]!._kind === "scalar" &&
    (schema.variants[0] as ScalarSchema).scalarKind === "null"
  )
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
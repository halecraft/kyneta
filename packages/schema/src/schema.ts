// Schema — a single recursive type for document structure.
//
// The grammar has five structural constructors (scalar, product, sequence,
// map, sum) plus first-class leaf/container types (text, counter, set,
// tree, movable). The `.json()` modifier on struct/list/record creates
// a merge boundary — everything below is an inert JSON blob.
//
// This grammar is backend-agnostic. Substrates declare closed composition-law
// sets via `[LAWS]` and enforce them at `bind()` time.

import type {
  IdentityManifest,
  MigrationInput,
  MigrationPrimitive,
} from "./migration.js"
import { migrationMethods } from "./migration.js"
import type { Segment } from "./path.js"

// ---------------------------------------------------------------------------
// KIND — symbol-keyed runtime discriminant
// ---------------------------------------------------------------------------

/** Runtime discriminant for the Schema union. Symbol-keyed: invisible to
 *  JSON.stringify and Object.keys, but TypeScript narrows on it. */
export const KIND = Symbol("kyneta:kind")
export type KindSymbol = typeof KIND

// ---------------------------------------------------------------------------
// LAWS — phantom composition-law accumulator (type-level only)
// ---------------------------------------------------------------------------

/** Phantom composition-law accumulator. Type-level only — never populated
 *  at runtime. Enables compile-time bind() validation via ExtractLaws<S>. */
export const LAWS = Symbol("kyneta:laws")
export type LawsSymbol = typeof LAWS

/**
 * The algebraic rule governing how pairs of operations compose when they
 * arrive concurrently. Each schema kind emits one composition law; the
 * binding check verifies that the (schema, substrate) pair can faithfully
 * execute every law the schema requires.
 */
export type CompositionLaw =
  | "lww" // Terminal: ReplaceChange — last writer wins
  | "additive" // Terminal: IncrementChange — commutative monoid
  | "positional-ot" // Positional: Instruction streams — OT transform
  | "positional-ot-move" // Positional + move: Instruction + MoveChange
  | "lww-per-key" // Named: MapChange — independent LWW per key
  | "add-wins-per-key" // Named: MapChange — add wins concurrent delete
  | "tree-move" // Hierarchical: TreeInstruction — subtree-move, cycle-free
  | "lww-tag-replaced" // Tagged coproduct: VariantChange — LWW tag, payload replaced

// ---------------------------------------------------------------------------
// Scalar kinds — leaf values (not a separate recursive grammar)
// ---------------------------------------------------------------------------

/**
 * The set of built-in scalar kinds. This is intentionally a string union
 * rather than a recursive type — scalars are terminal.
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
 * A schema node. This is the fixed point of a functor with eleven cases:
 *
 * - `scalar(kind)` — leaf value
 * - `product(fields)` — fixed-key record (struct)
 * - `sequence(item)` — ordered collection (list)
 * - `map(item)` — dynamic-key collection (record)
 * - `sum(variants)` — tagged union
 * - `text()` — collaborative text (character-level CRDT)
 * - `counter()` — additive counter (increment/decrement CRDT)
 * - `set(item)` — unordered collection with add-wins semantics
 * - `tree(nodeData)` — hierarchical tree with move operations
 * - `movable(item)` — ordered collection with move operations
 * - `richtext(marks)` — collaborative rich text with formatting marks
 *
 * The grammar is backend-agnostic. Substrates declare which composition
 * laws they support via closed law sets.
 */
export type Schema =
  | ScalarSchema
  | ProductSchema
  | SequenceSchema
  | MapSchema
  | SumSchema
  | TextSchema
  | CounterSchema
  | SetSchema
  | TreeSchema
  | MovableSequenceSchema
  | RichTextSchema

// --- Scalar ------------------------------------------------------------------

export interface ScalarSchema<
  K extends ScalarKind = ScalarKind,
  V extends ScalarPlain<K> = ScalarPlain<K>,
  Laws extends string = "lww",
> {
  readonly [KIND]: "scalar"
  readonly scalarKind: K
  readonly constraint?: readonly V[]
  readonly [LAWS]?: Laws

  nullable(): NullableSumOf<ScalarSchema<K, V, Laws>, Laws>
}

/**
 * Maps a ScalarKind literal to the corresponding TypeScript plain type.
 *
 * Used as the default for the `V` type parameter on `ScalarSchema` and
 * by interpreters that need the "widest" type for a scalar kind.
 */
export type ScalarPlain<K extends ScalarKind> = K extends "string"
  ? string
  : K extends "number"
    ? number
    : K extends "boolean"
      ? boolean
      : K extends "null"
        ? null
        : K extends "undefined"
          ? undefined
          : K extends "bytes"
            ? Uint8Array
            : K extends "any"
              ? unknown
              : never

// --- Product -----------------------------------------------------------------

export interface ProductSchema<
  F extends Record<string, Schema> = Record<string, Schema>,
  Laws extends string = string,
> {
  readonly [KIND]: "product"
  readonly fields: Readonly<F>
  readonly discriminantKey?: string
  readonly [LAWS]?: Laws

  // -- Migration methods (mixed in by product() via Object.assign) ----------

  /** Append a migration step. Accepts non-T2 primitives directly,
   *  or T2 primitives wrapped via `.drop()`. */
  migrated(...inputs: MigrationInput[]): ProductSchema<F, Laws>
  /** Append an epoch boundary (T3 or bare reset). */
  epoch(...primitives: MigrationPrimitive[]): ProductSchema<F, Laws>
  /** Set the base identity manifest (must precede migrated/epoch). */
  migrationBase(manifest: IdentityManifest): ProductSchema<F, Laws>

  nullable(): NullableSumOf<ProductSchema<F, Laws>, Laws>
}

// --- Sequence ----------------------------------------------------------------

export interface SequenceSchema<
  I extends Schema = Schema,
  Laws extends string = string,
> {
  readonly [KIND]: "sequence"
  readonly item: I
  readonly [LAWS]?: Laws

  nullable(): NullableSumOf<SequenceSchema<I, Laws>, Laws>
}

// --- Map ---------------------------------------------------------------------

export interface MapSchema<
  I extends Schema = Schema,
  Laws extends string = string,
> {
  readonly [KIND]: "map"
  readonly item: I
  readonly [LAWS]?: Laws

  nullable(): NullableSumOf<MapSchema<I, Laws>, Laws>
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
 * Both flavors share the `[KIND]: "sum"` discriminant. If `discriminant`
 * is present, the sum is discriminated.
 *
 * **Sum variants must be `PlainSchema`.** Sums are always LWW — the value
 * is replaced atomically. Placing a non-LWW type (text, counter, set,
 * tree, movable) inside a sum is a merge-semantic contradiction.
 */
export type SumSchema = PositionalSumSchema | DiscriminatedSumSchema

export interface PositionalSumSchema<
  V extends readonly PlainSchema[] = readonly PlainSchema[],
  Laws extends string = string,
> {
  readonly [KIND]: "sum"
  readonly variants: V
  readonly discriminant?: undefined
  readonly [LAWS]?: Laws

  nullable(): NullableSumOf<PositionalSumSchema<V, Laws>, Laws>
}

export interface DiscriminatedSumSchema<
  D extends string = string,
  V extends readonly PlainProductSchema[] = readonly PlainProductSchema[],
  Laws extends string = string,
> {
  readonly [KIND]: "sum"
  readonly discriminant: D
  readonly variants: V
  /**
   * Derived lookup from discriminant value → variant ProductSchema.
   * Built eagerly by the constructor from each variant's discriminant
   * field constraint. Used by `dispatchSum`, `interpret`, `validate`,
   * `describe`, etc.
   */
  readonly variantMap: Readonly<Record<string, PlainProductSchema>>
  readonly [LAWS]?: Laws

  nullable(): NullableSumOf<DiscriminatedSumSchema<D, V, Laws>, Laws>
}

// --- Text --------------------------------------------------------------------

/**
 * Collaborative text — character-level CRDT with insert/delete/mark
 * operations. A first-class leaf type with its own operation algebra.
 *
 * `text()` is NOT `PlainSchema` — it requires non-LWW merge and cannot
 * appear inside sums or `.json()` subtrees.
 */
export interface TextSchema<Laws extends string = "positional-ot"> {
  readonly [KIND]: "text"
  readonly [LAWS]?: Laws
}

// --- Counter -----------------------------------------------------------------

/**
 * Additive counter — increment/decrement CRDT. A first-class leaf type.
 *
 * `counter()` is NOT `PlainSchema` — it requires non-LWW merge and cannot
 * appear inside sums or `.json()` subtrees.
 */
export interface CounterSchema<Laws extends string = "additive"> {
  readonly [KIND]: "counter"
  readonly [LAWS]?: Laws
}

// --- Set ---------------------------------------------------------------------

/**
 * Unordered collection with add-wins semantics. Structurally analogous
 * to `map` but with set operations (add, delete, has).
 *
 * `set()` is NOT `PlainSchema` — it requires non-LWW merge and cannot
 * appear inside sums or `.json()` subtrees.
 */
export interface SetSchema<
  I extends Schema = Schema,
  Laws extends string = string,
> {
  readonly [KIND]: "set"
  readonly item: I
  readonly [LAWS]?: Laws
}

// --- Tree --------------------------------------------------------------------

/**
 * Hierarchical tree with move-subtree operations. Each node carries
 * structured data (`nodeData`). Trees navigate by node ID, support
 * parent/child relationships, and have move-subtree operations.
 *
 * `tree()` is NOT `PlainSchema` — it requires non-LWW merge and cannot
 * appear inside sums or `.json()` subtrees.
 */
export interface TreeSchema<
  S extends Schema = Schema,
  Laws extends string = string,
> {
  readonly [KIND]: "tree"
  readonly nodeData: S
  readonly [LAWS]?: Laws
}

// --- MovableSequence ---------------------------------------------------------

/**
 * Ordered collection with move operations. Structurally analogous to
 * `sequence` but with additional move/reorder operations.
 *
 * `movableList()` is NOT `PlainSchema` — it requires non-LWW merge and
 * cannot appear inside sums or `.json()` subtrees.
 */
export interface MovableSequenceSchema<
  I extends Schema = Schema,
  Laws extends string = string,
> {
  readonly [KIND]: "movable"
  readonly item: I
  readonly [LAWS]?: Laws
}

// --- RichText ----------------------------------------------------------------

/**
 * Expand behaviors for mark boundaries (Peritext model).
 *
 * - `"before"` — typing before the mark extends it
 * - `"after"` — typing after the mark extends it
 * - `"both"` — typing at either boundary extends it
 * - `"none"` — typing at neither boundary extends it
 */
export type MarkExpand = "before" | "after" | "none" | "both"

/**
 * Declared on the schema, read by substrates at `bind()` time:
 * Loro calls `configTextStyle()`, Yjs handles it implicitly.
 */
export interface MarkConfig {
  readonly [markName: string]: { readonly expand: MarkExpand }
}

/**
 * Collaborative rich text — character-level CRDT with formatting marks.
 *
 * The `marks` property declares the mark vocabulary and Peritext expand
 * behavior. This is structural data — two documents with different mark
 * vocabularies are structurally different (like two structs with different
 * fields).
 */
export interface RichTextSchema<Laws extends string = "positional-ot"> {
  readonly [KIND]: "richtext"
  readonly marks: MarkConfig
  readonly [LAWS]?: Laws
}

// ---------------------------------------------------------------------------
// PlainSchema — the subset of Schema that doesn't require non-LWW merge
// ---------------------------------------------------------------------------

/**
 * The subset of the schema grammar that requires only LWW merge.
 *
 * `PlainSchema` is the input constraint for:
 * - `.json()` modifier (merge boundary — everything below is inert JSON)
 * - Sum variants (sums are always LWW — variants are replaced atomically)
 *
 * This type excludes `TextSchema`, `CounterSchema`, `SetSchema`,
 * `TreeSchema`, `MovableSequenceSchema`, and `RichTextSchema` — they all
 * require non-LWW merge semantics that are contradicted by LWW contexts.
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
  Laws extends string = string,
> extends ProductSchema<F, Laws> {}

/**
 * Sequence (ordered collection) constrained to plain children.
 */
export interface PlainSequenceSchema<
  I extends PlainSchema = PlainSchema,
  Laws extends string = string,
> extends SequenceSchema<I, Laws> {}

/**
 * Map (dynamic-key collection) constrained to plain children.
 */
export interface PlainMapSchema<
  I extends PlainSchema = PlainSchema,
  Laws extends string = string,
> extends MapSchema<I, Laws> {}

/**
 * Positional sum constrained to plain variants.
 */
export interface PlainPositionalSumSchema<
  V extends readonly PlainSchema[] = readonly PlainSchema[],
  Laws extends string = string,
> extends PositionalSumSchema<V, Laws> {}

/**
 * Discriminated sum constrained to plain variants.
 */
export interface PlainDiscriminatedSumSchema<
  D extends string = string,
  V extends readonly PlainProductSchema[] = readonly PlainProductSchema[],
  Laws extends string = string,
> extends DiscriminatedSumSchema<D, V, Laws> {}

// ---------------------------------------------------------------------------
// ExtractLaws — single-level indexed access for law extraction
// ---------------------------------------------------------------------------

/**
 * Extract the accumulated composition-law tags from a schema type.
 *
 * Single-level indexed access — NOT recursive. Laws are accumulated
 * by constructors during schema construction (a type-level catamorphism).
 */
export type ExtractLaws<S> = S extends { readonly [LAWS]?: infer T }
  ? T extends string
    ? T
    : never
  : never

// ---------------------------------------------------------------------------
// StructuralKind — the set of base structural kinds
// ---------------------------------------------------------------------------

/**
 * The base structural kinds that interpreters and substrates can map to.
 * New first-class types map to these structural analogs.
 */
export type StructuralKind = "scalar" | "product" | "sequence" | "map" | "sum"

// ---------------------------------------------------------------------------
// NullableSumSchema — the result type of `.nullable()`
// ---------------------------------------------------------------------------

/**
 * The schema produced by `.nullable()` — a positional sum of `[null, S]`.
 */
export type NullableSumSchema<S extends PlainSchema> = PositionalSumSchema<
  [ScalarSchema<"null">, S],
  "lww-tag-replaced" | "lww" | ExtractLaws<S>
>

// ---------------------------------------------------------------------------
// NullableSumOf — structural return type for `.nullable()` methods
// ---------------------------------------------------------------------------

/**
 * The structural shape returned by `.nullable()`. Mirrors
 * `PositionalSumSchema<[ScalarSchema<"null">, S], ...>` but without
 * inheriting its `PlainSchema[]` constraint on `V`, allowing
 * `.nullable()` to live on all structural schema interfaces regardless
 * of whether their children are plain.
 *
 * Structurally compatible with `PositionalSumSchema` when `S` is plain —
 * callers who expect a `PositionalSumSchema` or `PlainSchema` can use
 * the result without casts.
 */
export interface NullableSumOf<S, Laws extends string = string> {
  readonly [KIND]: "sum"
  readonly variants: readonly [ScalarSchema<"null">, S]
  readonly discriminant?: undefined
  readonly [LAWS]?: "lww-tag-replaced" | "lww" | Laws

  nullable(): NullableSumOf<
    NullableSumOf<S, Laws>,
    "lww-tag-replaced" | "lww" | Laws
  >
}

// ---------------------------------------------------------------------------
// withPlainModifiers — attach fluent `.nullable()` to a schema object
// ---------------------------------------------------------------------------

/**
 * Attach fluent `.nullable()` to a schema object at runtime.
 *
 * Only attached to schemas satisfying `PlainSchema` — the absence of
 * `.nullable()` from non-plain schemas (text, counter, set, tree,
 * movableList, richText) communicates incompatibility at the API surface.
 *
 * Type safety for callers is enforced by the `.nullable()` method
 * declared on the structural schema interfaces.
 */
function withPlainModifiers(schema: any): any {
  Object.defineProperty(schema, "nullable", {
    value() {
      const result = sum([null_(), schema])
      return withPlainModifiers(result)
    },
    enumerable: false,
    configurable: true,
    writable: true,
  })
  return schema
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
    return withPlainModifiers({
      [KIND]: "scalar",
      scalarKind,
      constraint,
    } as ScalarSchema<K, V>)
  }
  return withPlainModifiers({ [KIND]: "scalar", scalarKind } as ScalarSchema<
    K,
    V
  >)
}

function product<F extends Record<string, Schema>>(
  fields: F,
): ProductSchema<F, "lww-per-key" | ExtractLaws<F[keyof F]>> {
  return withPlainModifiers(
    Object.assign({ [KIND]: "product", fields }, migrationMethods),
  )
}

function sequence<I extends Schema>(
  item: I,
): SequenceSchema<I, "positional-ot" | ExtractLaws<I>> {
  return withPlainModifiers({ [KIND]: "sequence", item })
}

function map<I extends Schema>(
  item: I,
): MapSchema<I, "lww-per-key" | ExtractLaws<I>> {
  return withPlainModifiers({ [KIND]: "map", item })
}

function sum<V extends PlainSchema[]>(
  variants: [...V],
): PositionalSumSchema<V, "lww-tag-replaced" | ExtractLaws<V[number]>> {
  return withPlainModifiers({ [KIND]: "sum", variants })
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
  variants: readonly PlainProductSchema[],
): Record<string, PlainProductSchema> {
  const map: Record<string, PlainProductSchema> = {}
  for (let i = 0; i < variants.length; i++) {
    const variant = variants[i]
    if (!variant) continue
    const fieldSchema = variant.fields[discriminant]
    if (!fieldSchema) {
      throw new Error(
        `discriminatedUnion: variant ${i} is missing the discriminant field "${discriminant}".` +
          ` Each variant must include a field like { ${discriminant}: Schema.string("value") }.`,
      )
    }
    if (
      fieldSchema[KIND] !== "scalar" ||
      fieldSchema.scalarKind !== "string" ||
      !fieldSchema.constraint ||
      fieldSchema.constraint.length === 0
    ) {
      throw new Error(
        `discriminatedUnion: variant ${i}'s "${discriminant}" field must be a constrained string scalar` +
          ` (e.g. Schema.string("value")), got ${fieldSchema[KIND]}/${(fieldSchema as ScalarSchema).scalarKind ?? "?"}.`,
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

function discriminatedSum<D extends string, V extends PlainProductSchema[]>(
  discriminant: D,
  variants: [...V],
): DiscriminatedSumSchema<D, V, "lww-tag-replaced" | ExtractLaws<V[number]>> {
  const variantMap = buildVariantMap(discriminant, variants)
  // Stamp each variant with the discriminant key so interpreter layers
  // can identify and special-case the discriminant field at runtime.
  for (const variant of variants) {
    ;(variant as any).discriminantKey = discriminant
  }
  return withPlainModifiers({
    [KIND]: "sum",
    discriminant,
    variants,
    variantMap,
  })
}

// ---------------------------------------------------------------------------
// First-class leaf/container constructors
// ---------------------------------------------------------------------------

function text(): TextSchema<"positional-ot"> {
  return { [KIND]: "text" } as TextSchema<"positional-ot">
}

function counter(): CounterSchema<"additive"> {
  return { [KIND]: "counter" } as CounterSchema<"additive">
}

function set<I extends Schema>(
  item: I,
): SetSchema<I, "add-wins-per-key" | ExtractLaws<I>> {
  return { [KIND]: "set", item } as any
}

function tree<S extends Schema>(
  nodeData: S,
): TreeSchema<S, "tree-move" | ExtractLaws<S>> {
  return { [KIND]: "tree", nodeData } as any
}

function movableList<I extends Schema>(
  item: I,
): MovableSequenceSchema<I, "positional-ot-move" | ExtractLaws<I>> {
  return { [KIND]: "movable", item } as any
}

function richText(marks: MarkConfig): RichTextSchema<"positional-ot"> {
  return { [KIND]: "richtext", marks } as RichTextSchema<"positional-ot">
}

// ---------------------------------------------------------------------------
// Developer-facing sugar — structural constructors
// ---------------------------------------------------------------------------

/**
 * Ordered list. Produces `sequence(item)`.
 *
 * `list.json(item)` constrains children to `PlainSchema` and produces
 * a schema with only `"lww"` as its law (merge boundary).
 */
function list<I extends Schema>(
  item: I,
): SequenceSchema<I, "positional-ot" | ExtractLaws<I>> {
  return sequence(item)
}

/**
 * `.json()` modifier for list — merge boundary.
 * Everything below is an inert JSON blob. No child laws propagated.
 */
list.json = function listJson<I extends PlainSchema>(
  item: I,
): SequenceSchema<I, "lww"> {
  return withPlainModifiers({ [KIND]: "sequence", item })
}

/**
 * Fixed-key struct. Produces `product(fields)`.
 *
 * `struct.json(fields)` constrains children to `PlainSchema` and produces
 * a schema with only `"lww"` as its law (merge boundary).
 */
function struct<F extends Record<string, Schema>>(
  fields: F,
): ProductSchema<F, "lww-per-key" | ExtractLaws<F[keyof F]>> {
  return product(fields)
}

/**
 * `.json()` modifier for struct — merge boundary.
 * Everything below is an inert JSON blob. No child laws propagated.
 */
struct.json = function structJson<F extends Record<string, PlainSchema>>(
  fields: F,
): ProductSchema<F, "lww"> {
  return withPlainModifiers(product(fields))
}

/**
 * Dynamic-key record. Produces `map(item)`.
 *
 * `record.json(item)` constrains children to `PlainSchema` and produces
 * a schema with only `"lww"` as its law (merge boundary).
 */
function record<I extends Schema>(
  item: I,
): MapSchema<I, "lww-per-key" | ExtractLaws<I>> {
  return map(item)
}

/**
 * `.json()` modifier for record — merge boundary.
 * Everything below is an inert JSON blob. No child laws propagated.
 */
record.json = function recordJson<I extends PlainSchema>(
  item: I,
): MapSchema<I, "lww"> {
  return withPlainModifiers({ [KIND]: "map", item })
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
  return (
    options.length > 0 ? scalar("string", options) : scalar("string")
  ) as any
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
  return (
    options.length > 0 ? scalar("number", options) : scalar("number")
  ) as any
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
  return (
    options.length > 0 ? scalar("boolean", options) : scalar("boolean")
  ) as any
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
 * Variants must be `PlainSchema` — sums are always LWW.
 *
 * ```ts
 * Schema.union(Schema.string(), Schema.number())
 * ```
 */
function union<V extends PlainSchema[]>(
  ...variants: [...V]
): PositionalSumSchema<V, "lww-tag-replaced" | ExtractLaws<V[number]>> {
  return sum(variants)
}

/**
 * Discriminated union — each variant declares the discriminant field.
 *
 * Follows the Zod/Valibot convention: every variant is a product
 * (struct) that includes the discriminant as a constrained string
 * scalar field. The discriminant value is the field's constraint.
 *
 * Variants must be `PlainProductSchema` — sums are always LWW.
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
function discriminatedUnion<D extends string, V extends PlainProductSchema[]>(
  discriminant: D,
  variants: [...V],
): DiscriminatedSumSchema<D, V, "lww-tag-replaced" | ExtractLaws<V[number]>> {
  return discriminatedSum(discriminant, variants)
}

// ---------------------------------------------------------------------------
// Schema namespace — all constructors gathered
// ---------------------------------------------------------------------------

/**
 * Schema constructors. Usage:
 *
 * ```ts
 * const myDoc = Schema.struct({
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
 * `Schema.union`, `Schema.discriminatedUnion`
 *
 * **Fluent modifiers (on plain schemas only):**
 * `.nullable()` — produces `sum([null, inner])`.
 * Available on all plain schema types (scalar, product, sequence, map, sum).
 * Not available on CRDT types (text, counter, set, tree, movableList, richText).
 *
 * ```ts
 * Schema.string().nullable()           // string | null
 * Schema.struct({ x: Schema.number() }).nullable()  // { x: number } | null
 * ```
 *
 * **First-class CRDT types:**
 * `Schema.text`, `Schema.counter`, `Schema.set`, `Schema.tree`,
 * `Schema.movableList`
 *
 * **Merge boundary:**
 * `Schema.struct.json`, `Schema.list.json`, `Schema.record.json`
 *
 * **Low-level (grammar-native, power users):**
 * `Schema.scalar`, `Schema.product`, `Schema.sequence`, `Schema.map`,
 * `Schema.sum`, `Schema.discriminatedSum`
 */
export const Schema = {
  // Low-level structural constructors
  scalar,
  product,
  sequence,
  map,
  sum,
  discriminatedSum,

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

  // First-class CRDT types
  text,
  counter,
  set,
  tree,
  movableList,
  richText,
} as const

// ---------------------------------------------------------------------------
// Utility: structural kind extraction
// ---------------------------------------------------------------------------

/**
 * Returns the structural kind of a schema node, mapping first-class
 * CRDT types to their structural analogs.
 *
 * | `[KIND]`    | `structuralKind()` return |
 * |-------------|---------------------------|
 * | `"scalar"`  | `"scalar"`                |
 * | `"product"` | `"product"`               |
 * | `"sequence"`| `"sequence"`              |
 * | `"map"`     | `"map"`                   |
 * | `"sum"`     | `"sum"`                   |
 * | `"text"`    | `"scalar"`                |
 * | `"counter"` | `"scalar"`                |
 * | `"set"`     | `"map"`                   |
 * | `"tree"`    | `"product"`               |
 * | `"movable"` | `"sequence"`              |
 */
export function structuralKind(schema: Schema): StructuralKind {
  switch (schema[KIND]) {
    case "text":
    case "counter":
    case "richtext":
      return "scalar"
    case "set":
      return "map"
    case "tree":
      return "product"
    case "movable":
      return "sequence"
    default:
      return schema[KIND]
  }
}

/**
 * Returns `true` if the schema is the nullable sugar pattern:
 * a positional sum with exactly 2 variants where the first is `scalar("null")`.
 *
 * This is the pattern produced by `inner.nullable()`.
 */
export function isNullableSum(schema: PositionalSumSchema): boolean {
  return (
    schema.variants.length === 2 &&
    schema.variants[0]?.[KIND] === "scalar" &&
    (schema.variants[0] as ScalarSchema).scalarKind === "null"
  )
}

// ---------------------------------------------------------------------------
// advanceSchema — pure schema descent for a single path segment
// ---------------------------------------------------------------------------

/**
 * Given a schema node and a path segment, returns the child schema at
 * that position.
 *
 * This is the pure schema descent extracted from the logic implicit in
 * `interpretImpl`'s field/item path construction. It walks one step
 * down the schema tree — no store access, no Loro dependency.
 *
 * First-class types are dispatched directly:
 * - `text` / `counter` — leaf types, cannot advance (throws)
 * - `set` — advance to `.item` on any key (like map)
 * - `tree` — advance to `.nodeData` then descend (like product)
 * - `movable` — advance to `.item` on index (like sequence)
 *
 * Sum types are never advanced through — sums resolve by value (store
 * inspection), not by path segment. If a field's schema is a sum,
 * `advanceSchema` on the parent product returns the sum as-is.
 *
 * @throws If the segment type doesn't match the schema kind (e.g.,
 *   index segment on a product, or key segment on a scalar).
 */
export function advanceSchema(schema: Schema, segment: Segment): Schema {
  switch (schema[KIND]) {
    case "product": {
      if (segment.role !== "key") {
        throw new Error(
          `advanceSchema: product expects a key segment, got index segment`,
        )
      }
      const key = segment.resolve() as string
      const fieldSchema = schema.fields[key]
      if (!fieldSchema) {
        throw new Error(`advanceSchema: product has no field "${key}"`)
      }
      return fieldSchema
    }

    case "sequence": {
      if (segment.role !== "index") {
        throw new Error(
          `advanceSchema: sequence expects an index segment, got key segment "${segment.resolve()}"`,
        )
      }
      return schema.item
    }

    case "map": {
      if (segment.role !== "key") {
        throw new Error(
          `advanceSchema: map expects a key segment, got index segment`,
        )
      }
      return schema.item
    }

    case "scalar":
      throw new Error(
        `advanceSchema: cannot advance into a scalar (kind: ${schema.scalarKind})`,
      )

    case "sum":
      throw new Error(
        `advanceSchema: cannot advance through a sum (sums resolve by value, not by path segment)`,
      )

    case "text":
      throw new Error(
        `advanceSchema: cannot advance into text (leaf type, no inner schema)`,
      )

    case "counter":
      throw new Error(
        `advanceSchema: cannot advance into counter (leaf type, no inner schema)`,
      )

    case "set": {
      if (segment.role !== "key") {
        throw new Error(
          `advanceSchema: set expects a key segment, got index segment`,
        )
      }
      return schema.item
    }

    case "tree": {
      // Advance into node data — delegates to the inner schema.
      // Full tree navigation (by node ID) is deferred.
      return advanceSchema(schema.nodeData, segment)
    }

    case "movable": {
      if (segment.role !== "index") {
        throw new Error(
          `advanceSchema: movable sequence expects an index segment, got key segment "${segment.resolve()}"`,
        )
      }
      return schema.item
    }

    case "richtext":
      throw new Error(
        `advanceSchema: cannot advance into richtext (leaf type, no inner schema)`,
      )
  }
}

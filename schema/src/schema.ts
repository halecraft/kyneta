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

export interface ScalarSchema {
  readonly _kind: "scalar"
  readonly scalarKind: ScalarKind
}

// --- Product -----------------------------------------------------------------

export interface ProductSchema {
  readonly _kind: "product"
  readonly fields: Readonly<Record<string, Schema>>
}

// --- Sequence ----------------------------------------------------------------

export interface SequenceSchema {
  readonly _kind: "sequence"
  readonly item: Schema
}

// --- Map ---------------------------------------------------------------------

export interface MapSchema {
  readonly _kind: "map"
  readonly item: Schema
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

export interface PositionalSumSchema {
  readonly _kind: "sum"
  readonly variants: readonly Schema[]
  readonly discriminant?: undefined
}

export interface DiscriminatedSumSchema {
  readonly _kind: "sum"
  readonly discriminant: string
  readonly variantMap: Readonly<Record<string, Schema>>
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
export interface AnnotatedSchema {
  readonly _kind: "annotated"
  readonly tag: string
  readonly schema?: Schema
  readonly meta?: Readonly<Record<string, unknown>>
}

// ---------------------------------------------------------------------------
// Structural constructors (low-level, grammar-native)
// ---------------------------------------------------------------------------

function scalar(scalarKind: ScalarKind): ScalarSchema {
  return { _kind: "scalar", scalarKind }
}

function product(fields: Record<string, Schema>): ProductSchema {
  return { _kind: "product", fields }
}

function sequence(item: Schema): SequenceSchema {
  return { _kind: "sequence", item }
}

function map(item: Schema): MapSchema {
  return { _kind: "map", item }
}

function sum(variants: Schema[]): PositionalSumSchema {
  return { _kind: "sum", variants }
}

function discriminatedSum(
  discriminant: string,
  variantMap: Record<string, Schema>,
): DiscriminatedSumSchema {
  return { _kind: "sum", discriminant, variantMap }
}

function annotated(
  tag: string,
  schema?: Schema,
  meta?: Record<string, unknown>,
): AnnotatedSchema {
  return {
    _kind: "annotated",
    tag,
    ...(schema !== undefined && { schema }),
    ...(meta !== undefined && { meta }),
  }
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
function text(): AnnotatedSchema {
  return annotated("text")
}

/**
 * Counter (CRDT). Produces `annotated("counter")`.
 *
 * The annotation implies scalar number semantics for reads,
 * but the backend provides increment/decrement.
 */
function counter(): AnnotatedSchema {
  return annotated("counter")
}

/**
 * Ordered list. Produces `sequence(item)`.
 */
function list(item: Schema): SequenceSchema {
  return sequence(item)
}

/**
 * Movable list (CRDT with move semantics).
 * Produces `annotated("movable", sequence(item))`.
 */
function movableList(item: Schema): AnnotatedSchema {
  return annotated("movable", sequence(item))
}

/**
 * Fixed-key struct. Produces `product(fields)`.
 */
function struct(fields: Record<string, Schema>): ProductSchema {
  return product(fields)
}

/**
 * Dynamic-key record. Produces `map(item)`.
 */
function record(item: Schema): MapSchema {
  return map(item)
}

/**
 * Hierarchical tree with typed node data (CRDT).
 * Produces `annotated("tree", nodeData)`.
 *
 * The `nodeData` schema describes the shape of each tree node's data.
 */
function tree(nodeData: Schema): AnnotatedSchema {
  return annotated("tree", nodeData)
}

/**
 * Document root. Produces `annotated("doc", product(fields))`.
 *
 * Structurally a product, but the "doc" annotation tells interpreters
 * this is the root entry point (analogous to TypedDoc in the current
 * codebase).
 */
function doc(fields: Record<string, Schema>): AnnotatedSchema {
  return annotated("doc", product(fields))
}

// ---------------------------------------------------------------------------
// Plain value constructors — Schema.plain.*
// ---------------------------------------------------------------------------
// These produce bare structural nodes (no annotation). They correspond
// to what the current codebase calls "value shapes" — plain data stored
// inside containers, not independently addressable CRDTs.

const plain = {
  /** Scalar string. */
  string(): ScalarSchema {
    return scalar("string")
  },

  /** Scalar number. */
  number(): ScalarSchema {
    return scalar("number")
  },

  /** Scalar boolean. */
  boolean(): ScalarSchema {
    return scalar("boolean")
  },

  /** Scalar null. */
  null(): ScalarSchema {
    return scalar("null")
  },

  /** Scalar undefined. */
  undefined(): ScalarSchema {
    return scalar("undefined")
  },

  /** Binary data. */
  bytes(): ScalarSchema {
    return scalar("bytes")
  },

  /** Opaque value — any type. */
  any(): ScalarSchema {
    return scalar("any")
  },

  /** Fixed-key plain struct (product with no annotation). */
  struct(fields: Record<string, Schema>): ProductSchema {
    return product(fields)
  },

  /** Dynamic-key plain record (map with no annotation). */
  record(item: Schema): MapSchema {
    return map(item)
  },

  /** Plain array (sequence with no annotation). */
  array(item: Schema): SequenceSchema {
    return sequence(item)
  },

  /** Union of schemas. */
  union(...variants: Schema[]): PositionalSumSchema {
    return sum(variants)
  },

  /** Discriminated union — variants keyed by discriminant value. */
  discriminatedUnion(
    discriminant: string,
    variantMap: Record<string, Schema>,
  ): DiscriminatedSumSchema {
    return discriminatedSum(discriminant, variantMap)
  },
} as const

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
 *   tags: Schema.list(Schema.plain.string()),
 *   metadata: Schema.struct({
 *     author: Schema.plain.string(),
 *     published: Schema.plain.boolean(),
 *   }),
 * })
 * ```
 *
 * **Low-level (grammar-native):**
 * `Schema.scalar`, `Schema.product`, `Schema.sequence`, `Schema.map`,
 * `Schema.sum`, `Schema.discriminatedSum`, `Schema.annotated`
 *
 * **High-level (Loro-flavored sugar):**
 * `Schema.text`, `Schema.counter`, `Schema.list`, `Schema.movableList`,
 * `Schema.struct`, `Schema.record`, `Schema.tree`, `Schema.doc`
 *
 * **Plain values:**
 * `Schema.plain.string`, `Schema.plain.number`, `Schema.plain.boolean`,
 * `Schema.plain.null`, `Schema.plain.undefined`, `Schema.plain.bytes`,
 * `Schema.plain.any`, `Schema.plain.struct`, `Schema.plain.record`,
 * `Schema.plain.array`, `Schema.plain.union`, `Schema.plain.discriminatedUnion`
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

  // Loro-flavored sugar
  text,
  counter,
  list,
  movableList,
  struct,
  record,
  tree,
  doc,

  // Plain value constructors
  plain,
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
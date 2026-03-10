// interpret — the generic catamorphism over the schema functor.
//
// An Interpreter<Ctx, A> is an F-algebra: one case per structural kind
// that collapses a schema node into a result of type A. The `interpret`
// function walks the schema tree, applying the interpreter at each node.
//
// Key design decisions:
// - Product fields are thunks (() => A) — laziness preserved
// - Sequence/map children are closures ((index/key) => A)
// - Annotations pass through: the interpreter sees the tag, meta,
//   and (if present) the already-interpreted inner result

import type {
  Schema,
  ScalarSchema,
  ProductSchema,
  SequenceSchema,
  MapSchema,
  SumSchema,
  AnnotatedSchema,
  PositionalSumSchema,
  DiscriminatedSumSchema,
} from "./schema.js"

// ---------------------------------------------------------------------------
// Path — breadcrumb trail through the schema tree
// ---------------------------------------------------------------------------

/**
 * A path segment identifies a position within the schema tree.
 * Used by interpreters that need to know "where am I" (e.g. for
 * reading from a store, building path selectors, etc.).
 */
export type PathSegment =
  | { readonly type: "key"; readonly key: string }
  | { readonly type: "index"; readonly index: number }

export type Path = readonly PathSegment[]

// ---------------------------------------------------------------------------
// Interpreter interface
// ---------------------------------------------------------------------------

/**
 * An interpreter is an F-algebra over the schema functor. It has one
 * case per structural kind, each producing a result of type `A`.
 *
 * `Ctx` is the context type — it flows unchanged through the tree walk.
 * Interpreters that need context accumulation (e.g. narrowing a read
 * path at each product level) should use closures to capture derived
 * child contexts rather than mutating Ctx.
 *
 * ### Laziness contract
 *
 * - **Product fields** are `Record<string, () => A>` — thunks. The
 *   interpreter decides when (and whether) to force each one. This
 *   preserves the cache-on-first-access pattern used throughout the
 *   codebase.
 *
 * - **Sequence/Map children** are closures `(index: number) => A` /
 *   `(key: string) => A`. The interpreter calls them to create child
 *   interpretations on demand.
 *
 * ### Annotations
 *
 * The `annotated` case receives the tag, optional metadata, the raw
 * inner schema (if any), and a thunk that produces the interpreted
 * inner result (if there is an inner schema). The interpreter decides
 * what to do: ignore annotations, dispatch on tag, delegate to inner, etc.
 */
export interface Interpreter<Ctx, A> {
  scalar(ctx: Ctx, path: Path, schema: ScalarSchema): A

  product(
    ctx: Ctx,
    path: Path,
    schema: ProductSchema,
    fields: Readonly<Record<string, () => A>>,
  ): A

  sequence(
    ctx: Ctx,
    path: Path,
    schema: SequenceSchema,
    item: (index: number) => A,
  ): A

  map(
    ctx: Ctx,
    path: Path,
    schema: MapSchema,
    item: (key: string) => A,
  ): A

  sum(
    ctx: Ctx,
    path: Path,
    schema: SumSchema,
    variants: SumVariants<A>,
  ): A

  annotated(
    ctx: Ctx,
    path: Path,
    schema: AnnotatedSchema,
    inner: (() => A) | undefined,
  ): A
}

/**
 * Sum variant access — provides lazy access to interpreted variants.
 *
 * For positional sums: `byIndex(i)` returns the i-th variant's interpretation.
 * For discriminated sums: `byKey(k)` returns the named variant's interpretation.
 */
export interface SumVariants<A> {
  /** For positional sums — access variant by index. */
  readonly byIndex?: (index: number) => A
  /** For discriminated sums — access variant by discriminant value. */
  readonly byKey?: (key: string) => A
}

// ---------------------------------------------------------------------------
// interpret — the catamorphism
// ---------------------------------------------------------------------------

/**
 * Walks a schema tree, applying the interpreter at each node.
 *
 * This is the single generic tree walker that replaces the 10+ parallel
 * `switch (shape._type)` dispatch sites in the current codebase.
 *
 * ```ts
 * const result = interpret(mySchema, myInterpreter, myContext)
 * ```
 *
 * The catamorphism is bottom-up: children are interpreted before parents,
 * but lazily — product children are wrapped in thunks, and sequence/map
 * children are wrapped in closures, so the interpreter controls when
 * (and whether) children are actually evaluated.
 */
export function interpret<Ctx, A>(
  schema: Schema,
  interp: Interpreter<Ctx, A>,
  ctx: Ctx,
  path: Path = [],
): A {
  switch (schema._kind) {
    case "scalar":
      return interp.scalar(ctx, path, schema)

    case "product": {
      // Build thunks for each field — lazy, not pre-computed
      const fieldThunks: Record<string, () => A> = {}
      for (const key of Object.keys(schema.fields)) {
        const fieldSchema = schema.fields[key]!
        const fieldPath: Path = [...path, { type: "key", key }]
        // Each thunk captures its own key and path
        fieldThunks[key] = () => interpret(fieldSchema, interp, ctx, fieldPath)
      }
      return interp.product(ctx, path, schema, fieldThunks)
    }

    case "sequence": {
      // Item closure: caller provides an index, gets back an interpreted child
      const itemFn = (index: number): A => {
        const itemPath: Path = [...path, { type: "index", index }]
        return interpret(schema.item, interp, ctx, itemPath)
      }
      return interp.sequence(ctx, path, schema, itemFn)
    }

    case "map": {
      // Item closure: caller provides a key, gets back an interpreted child
      const itemFn = (key: string): A => {
        const itemPath: Path = [...path, { type: "key", key }]
        return interpret(schema.item, interp, ctx, itemPath)
      }
      return interp.map(ctx, path, schema, itemFn)
    }

    case "sum": {
      const variants: SumVariants<A> = {}
      if (schema.discriminant !== undefined) {
        // Discriminated sum
        const discSchema = schema as DiscriminatedSumSchema
        ;(variants as { byKey: (key: string) => A }).byKey = (
          key: string,
        ): A => {
          const variantSchema = discSchema.variantMap[key]
          if (!variantSchema) {
            throw new Error(
              `interpret: discriminated sum has no variant for key "${key}"`,
            )
          }
          return interpret(variantSchema, interp, ctx, path)
        }
      } else {
        // Positional sum
        const posSchema = schema as PositionalSumSchema
        ;(variants as { byIndex: (index: number) => A }).byIndex = (
          index: number,
        ): A => {
          const variantSchema = posSchema.variants[index]
          if (!variantSchema) {
            throw new Error(
              `interpret: positional sum has no variant at index ${index}`,
            )
          }
          return interpret(variantSchema, interp, ctx, path)
        }
      }
      return interp.sum(ctx, path, schema, variants)
    }

    case "annotated": {
      // If there's an inner schema, provide a thunk for it
      const innerThunk: (() => A) | undefined =
        schema.schema !== undefined
          ? () => interpret(schema.schema!, interp, ctx, path)
          : undefined

      return interp.annotated(ctx, path, schema, innerThunk)
    }
  }
}

// ---------------------------------------------------------------------------
// Partial interpreter helper
// ---------------------------------------------------------------------------

/**
 * Creates an interpreter where every case delegates to a single fallback,
 * with optional overrides. Useful for writing interpreters that only
 * care about a few cases.
 *
 * ```ts
 * const myInterp = createInterpreter<MyCtx, string>(
 *   (ctx, path, schema) => "default",
 *   {
 *     scalar: (ctx, path, schema) => `scalar:${schema.scalarKind}`,
 *   },
 * )
 * ```
 */
export function createInterpreter<Ctx, A>(
  fallback: (ctx: Ctx, path: Path, schema: Schema) => A,
  overrides: Partial<Interpreter<Ctx, A>> = {},
): Interpreter<Ctx, A> {
  return {
    scalar:
      overrides.scalar ??
      ((ctx, path, schema) => fallback(ctx, path, schema)),
    product:
      overrides.product ??
      ((ctx, path, schema, _fields) => fallback(ctx, path, schema)),
    sequence:
      overrides.sequence ??
      ((ctx, path, schema, _item) => fallback(ctx, path, schema)),
    map:
      overrides.map ??
      ((ctx, path, schema, _item) => fallback(ctx, path, schema)),
    sum:
      overrides.sum ??
      ((ctx, path, schema, _variants) => fallback(ctx, path, schema)),
    annotated:
      overrides.annotated ??
      ((ctx, path, schema, _inner) => fallback(ctx, path, schema)),
  }
}
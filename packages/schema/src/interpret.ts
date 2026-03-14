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
//
// The module also provides:
// - InterpreterLayer — a typed wrapper around an interpreter transformer
// - InterpretBuilder — fluent API for composing layers before running
//   the catamorphism: `interpret(schema, ctx).with(readable).with(writable).done()`
// - Pre-built layers live in `./layers.ts` to avoid circular imports.

import { bottomInterpreter } from "./interpreters/bottom.js"
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
// InterpreterLayer — typed wrapper for interpreter transformers
// ---------------------------------------------------------------------------

/**
 * An `InterpreterLayer` wraps an interpreter transformer function with
 * explicit input/output context types. Layers are the building blocks
 * of the fluent `InterpretBuilder` API.
 *
 * Each layer takes a base interpreter and returns an enhanced interpreter.
 * The context type may widen (e.g. `RefContext` → `WritableContext`) and
 * the result type may gain capabilities (e.g. `A & HasNavigation`).
 *
 * ```ts
 * import { readable, writable, changefeed } from "@kyneta/schema"
 *
 * interpret(schema, ctx)
 *   .with(readable)
 *   .with(writable)
 *   .with(changefeed)
 *   .done()
 * ```
 *
 * Pre-built layers are exported from `./layers.ts` (and re-exported
 * from the barrel `index.ts`).
 */
export interface InterpreterLayer<InCtx, OutCtx> {
  /** Human-readable name for debugging and toString(). */
  readonly name: string
  /**
   * Transforms a base interpreter into an enhanced interpreter.
   * May widen the context type (InCtx → OutCtx).
   */
  readonly transform: (base: Interpreter<InCtx, any>) => Interpreter<OutCtx, any>
}

// ---------------------------------------------------------------------------
// InterpretBuilder — fluent API for composing interpreters
// ---------------------------------------------------------------------------

/**
 * A fluent builder for composing interpreter layers before running the
 * catamorphism. Created by `interpret(schema, ctx)` (the two-arg overload).
 *
 * ```ts
 * const doc = interpret(schema, ctx)
 *   .with(readable)
 *   .with(writable)
 *   .with(changefeed)
 *   .done()
 * ```
 *
 * Each `.with(layer)` applies a transformer. `.done()` runs the single
 * catamorphism walk with the composed interpreter.
 *
 * The builder accumulates layers — each `.with()` returns a new builder
 * with the layer appended.
 */
export interface InterpretBuilder<Ctx, A> {
  /**
   * Add a layer to the interpreter stack.
   *
   * The layer's `transform` receives the current interpreter and returns
   * an enhanced interpreter. The context type may widen.
   */
  with<NewCtx>(
    layer: InterpreterLayer<Ctx, NewCtx>,
  ): InterpretBuilder<NewCtx, A>

  /**
   * Run the catamorphism with the composed interpreter and return the result.
   */
  done(): A
}

// ---------------------------------------------------------------------------
// interpret — the catamorphism (with fluent overload)
// ---------------------------------------------------------------------------

/**
 * Walks a schema tree, applying the interpreter at each node.
 *
 * This is the single generic tree walker that replaces the 10+ parallel
 * `switch (shape._type)` dispatch sites in the current codebase.
 *
 * **Three-arg form** (direct):
 * ```ts
 * const result = interpret(mySchema, myInterpreter, myContext)
 * ```
 *
 * **Two-arg form** (fluent builder):
 * ```ts
 * const doc = interpret(schema, ctx)
 *   .with(readable)
 *   .with(writable)
 *   .with(changefeed)
 *   .done()
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
  path?: Path,
): A
export function interpret<Ctx>(
  schema: Schema,
  ctx: Ctx,
): InterpretBuilder<Ctx, unknown>
export function interpret<Ctx, A>(
  schema: Schema,
  interpOrCtx: Interpreter<Ctx, A> | Ctx,
  ctx?: Ctx,
  path?: Path,
): A | InterpretBuilder<Ctx, unknown> {
  // Overload resolution: if the second argument has all six interpreter
  // methods, it's an Interpreter. Otherwise it's a context object.
  if (isInterpreter(interpOrCtx)) {
    return interpretImpl(schema, interpOrCtx as Interpreter<Ctx, A>, ctx!, path ?? [])
  }
  // Two-arg form: return a fluent builder
  return createBuilder(schema, interpOrCtx as Ctx)
}

/**
 * Returns true if `value` looks like an Interpreter (has all six case methods).
 */
function isInterpreter(value: unknown): boolean {
  if (value === null || value === undefined || typeof value !== "object") return false
  const obj = value as Record<string, unknown>
  return (
    typeof obj.scalar === "function" &&
    typeof obj.product === "function" &&
    typeof obj.sequence === "function" &&
    typeof obj.map === "function" &&
    typeof obj.sum === "function" &&
    typeof obj.annotated === "function"
  )
}

/**
 * Creates a fluent InterpretBuilder that accumulates layers and runs the
 * catamorphism on `.done()`.
 *
 * The builder starts with `bottomInterpreter` as the base. Each `.with(layer)`
 * appends a transformer. `.done()` composes all layers left-to-right, then
 * runs `interpretImpl(schema, composedInterpreter, ctx, [])`.
 *
 * Layers are captured as an immutable snapshot — each `.with()` creates a
 * new array rather than mutating a shared one, so branching builders is safe.
 */
function createBuilder<Ctx>(
  schema: Schema,
  ctx: Ctx,
  layers: ReadonlyArray<InterpreterLayer<any, any>> = [],
): InterpretBuilder<Ctx, unknown> {
  return {
    with<NewCtx>(layer: InterpreterLayer<Ctx, NewCtx>): InterpretBuilder<NewCtx, unknown> {
      return createBuilder<NewCtx>(schema, ctx as unknown as NewCtx, [...layers, layer])
    },
    done(): unknown {
      if (layers.length === 0) {
        throw new Error(
          "InterpretBuilder: no layers added. Use .with(readable) etc. before .done()",
        )
      }
      // Start from bottomInterpreter and apply each layer's transform
      // in sequence. The import is safe because bottom.ts only has
      // `import type` from interpret.ts (erased at compile time).
      let interp: Interpreter<any, any> = bottomInterpreter
      for (const layer of layers) {
        interp = layer.transform(interp)
      }
      return interpretImpl(schema, interp, ctx, [])
    },
  }
}

// ---------------------------------------------------------------------------
// interpretImpl — the actual catamorphism walk
// ---------------------------------------------------------------------------

function interpretImpl<Ctx, A>(
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
        fieldThunks[key] = () => interpretImpl(fieldSchema, interp, ctx, fieldPath)
      }
      return interp.product(ctx, path, schema, fieldThunks)
    }

    case "sequence": {
      // Item closure: caller provides an index, gets back an interpreted child
      const itemFn = (index: number): A => {
        const itemPath: Path = [...path, { type: "index", index }]
        return interpretImpl(schema.item, interp, ctx, itemPath)
      }
      return interp.sequence(ctx, path, schema, itemFn)
    }

    case "map": {
      // Item closure: caller provides a key, gets back an interpreted child
      const itemFn = (key: string): A => {
        const itemPath: Path = [...path, { type: "key", key }]
        return interpretImpl(schema.item, interp, ctx, itemPath)
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
          return interpretImpl(variantSchema, interp, ctx, path)
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
          return interpretImpl(variantSchema, interp, ctx, path)
        }
      }
      return interp.sum(ctx, path, schema, variants)
    }

    case "annotated": {
      // If there's an inner schema, provide a thunk for it
      const innerThunk: (() => A) | undefined =
        schema.schema !== undefined
          ? () => interpretImpl(schema.schema!, interp, ctx, path)
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
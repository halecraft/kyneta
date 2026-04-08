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

import type { HasChangefeed } from "@kyneta/changefeed"
import { isNonNullObject } from "./guards.js"
import type { HasRead } from "./interpreters/bottom.js"
import { bottomInterpreter } from "./interpreters/bottom.js"
import type { HasTransact } from "./interpreters/writable.js"
import type { Path } from "./path.js"
import { RawPath } from "./path.js"
import type { Ref, RRef, RWRef } from "./ref.js"
import {
  KIND,
  type AnnotatedSchema,
  type DiscriminatedSumSchema,
  type MapSchema,
  type PositionalSumSchema,
  type ProductSchema,
  type ScalarSchema,
  type Schema,
  type SequenceSchema,
  type SumSchema,
  isNullableSum,
} from "./schema.js"

// ---------------------------------------------------------------------------
// Path — re-exported from path.ts
// ---------------------------------------------------------------------------

export type { Path, RawSegment, Segment } from "./path.js"
export { RawPath, rawIndex, rawKey } from "./path.js"

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

  map(ctx: Ctx, path: Path, schema: MapSchema, item: (key: string) => A): A

  sum(ctx: Ctx, path: Path, schema: SumSchema, variants: SumVariants<A>): A

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
// Sum dispatch — shared variant resolution
// ---------------------------------------------------------------------------

/**
 * Resolves which sum variant to use based on runtime store state.
 *
 * Used by `readableInterpreter`, `withReadable`, and any interpreter
 * that needs store-driven variant dispatch. The logic is:
 *
 * 1. **Discriminated sums**: read the discriminant field from `value`.
 *    If the discriminant matches a variant in `variantMap`, dispatch
 *    via `variants.byKey()`. Otherwise fall back to the first variant.
 *
 * 2. **Nullable (positional) sums**: if the value is null/undefined,
 *    dispatch to variant 0 (the null variant); otherwise variant 1.
 *
 * 3. **General positional sums**: dispatch to variant 0 (first).
 *
 * Returns `undefined` if no variant can be resolved.
 */
export function dispatchSum<A>(
  value: unknown,
  schema: SumSchema,
  variants: SumVariants<A>,
): A | undefined {
  if (schema.discriminant !== undefined && variants.byKey) {
    // ── Discriminated sum ──────────────────────────────────────
    const discSchema = schema as DiscriminatedSumSchema

    if (isNonNullObject(value)) {
      const discValue = value[schema.discriminant]
      if (typeof discValue === "string" && discValue in discSchema.variantMap) {
        return variants.byKey(discValue)
      }
    }

    // Fallback: first variant
    const keys = Object.keys(discSchema.variantMap)
    if (keys.length > 0) {
      return variants.byKey(keys[0]!)
    }
    return undefined
  }

  // ── Positional sum ────────────────────────────────────────────
  if (variants.byIndex) {
    const posSchema = schema as PositionalSumSchema

    if (isNullableSum(posSchema)) {
      return value === null || value === undefined
        ? variants.byIndex(0) // null variant
        : variants.byIndex(1) // inner variant
    }

    // General positional sum: no runtime discriminator, use first
    return variants.byIndex(0)
  }

  return undefined
}

// ---------------------------------------------------------------------------
// Phantom brands — for fluent builder type inference
// ---------------------------------------------------------------------------

/**
 * Phantom brand symbols for the fluent builder path. Each pre-built layer
 * carries a brand; `.with()` accumulates brands via intersection; `.done()`
 * uses `Resolve<S, Brands>` to select the correct ref tier.
 *
 * These are type-only — zero runtime cost. The three-arg path uses
 * structural checks on `A` (via `ResolveCarrier`) instead.
 */
declare const READABLE_BRAND: unique symbol
declare const WRITABLE_BRAND: unique symbol
declare const CHANGEFEED_BRAND: unique symbol

export type ReadableBrand = { readonly [READABLE_BRAND]: true }
export type WritableBrand = { readonly [WRITABLE_BRAND]: true }
export type ChangefeedBrand = { readonly [CHANGEFEED_BRAND]: true }

// ---------------------------------------------------------------------------
// Resolve<S, Brands> — fluent builder tier selection
// ---------------------------------------------------------------------------

/**
 * Selects the schema-level ref type based on accumulated phantom brands
 * from the fluent builder's `.with()` chain.
 *
 * - `ReadableBrand & WritableBrand & ChangefeedBrand` → `Ref<S>` (full stack)
 * - `ReadableBrand & WritableBrand` → `RWRef<S>` (read-write, no changefeed)
 * - `ReadableBrand` → `RRef<S>` (read-only)
 * - Otherwise → `unknown` (custom/unbranded layers — cast needed)
 *
 * Order matters — most specific first.
 */
export type Resolve<S extends Schema, Brands> = Brands extends ReadableBrand &
  WritableBrand &
  ChangefeedBrand
  ? Ref<S>
  : Brands extends ReadableBrand & WritableBrand
    ? RWRef<S>
    : Brands extends ReadableBrand
      ? RRef<S>
      : unknown

// ---------------------------------------------------------------------------
// ResolveCarrier<S, A> — three-arg tier selection
// ---------------------------------------------------------------------------

/**
 * Selects the schema-level ref type based on structural capabilities
 * present in the carrier type `A` from the three-arg `interpret()` path.
 *
 * This works because transformer return types are now honest:
 * - `withWritable` returns `Interpreter<Ctx, A & HasTransact>`
 * - `withChangefeed` returns `Interpreter<Ctx, A & HasChangefeed>`
 * - `withReadable` returns `Interpreter<Ctx, A & HasRead>` (already the case)
 *
 * Resolution tiers:
 * - `HasRead & HasTransact & HasChangefeed` → `Ref<S>` (full stack)
 * - `HasRead & HasTransact` (no changefeed) → `RWRef<S>` (read-write)
 * - Otherwise → raw `A` (read-only or degraded stacks keep carrier brands)
 *
 * Both `Ref<S>` and `RWRef<S>` require `HasRead` — a carrier that can't
 * read has no business being typed as a schema-level ref (which promises
 * a call signature returning `Plain<S>`). Write-only stacks
 * (`withWritable(bottom)`) fall through to raw `A`.
 *
 * Read-only stacks also fall through to `A` rather than resolving to
 * `RRef<S>`. This preserves carrier brand types (`HasCaching`, `HasRead`,
 * etc.) that internal tests verify. Users who want `Readable<S>` on a
 * read-only stack should use the fluent builder path instead.
 *
 * **Usage**: `ResolveCarrier` cannot appear directly in an overload return
 * type because `Ref<S>` / `RWRef<S>` are deeply recursive (~20 conditional
 * levels) and TypeScript hits TS2589 when `S` is an abstract generic. The
 * three-arg `interpret()` overload returns raw `A` instead. Use
 * `ResolveCarrier` explicitly at call sites or in type annotations:
 *
 * ```ts
 * const doc: ResolveCarrier<typeof schema, typeof interp extends Interpreter<any, infer A> ? A : never>
 *   = interpret(schema, interp, ctx)
 * // Or more commonly, just use the fluent builder which infers automatically.
 * ```
 */
export type ResolveCarrier<S extends Schema, A> = [A] extends [
  HasRead & HasTransact & HasChangefeed,
]
  ? Ref<S>
  : [A] extends [HasRead & HasTransact]
    ? RWRef<S>
    : A

// ---------------------------------------------------------------------------
// InterpreterLayer — typed wrapper for interpreter transformers
// ---------------------------------------------------------------------------

/**
 * An `InterpreterLayer` wraps an interpreter transformer function with
 * explicit input/output context types and an optional phantom brand.
 * Layers are the building blocks of the fluent `InterpretBuilder` API.
 *
 * Each layer takes a base interpreter and returns an enhanced interpreter.
 * The context type may widen (e.g. `RefContext` → `WritableContext`) and
 * the result type may gain capabilities (e.g. `A & HasNavigation`).
 *
 * The `Brand` type parameter (default `unknown`) is a phantom type used
 * by the fluent builder to accumulate capability information via `.with()`.
 * Pre-built layers (`readable`, `writable`, `observation`) carry specific
 * brands; custom/user-defined layers keep the default `unknown`.
 *
 * ```ts
 * import { readable, writable, observation } from "@kyneta/schema"
 *
 * interpret(schema, ctx)
 *   .with(readable)
 *   .with(writable)
 *   .with(observation)
 *   .done()
 * ```
 *
 * Pre-built layers are exported from `./layers.ts` (and re-exported
 * from the barrel `index.ts`).
 */
export interface InterpreterLayer<InCtx, OutCtx, _Brand = unknown> {
  /** Human-readable name for debugging and toString(). */
  readonly name: string
  /**
   * Transforms a base interpreter into an enhanced interpreter.
   * May widen the context type (InCtx → OutCtx).
   */
  readonly transform: (
    base: Interpreter<InCtx, any>,
  ) => Interpreter<OutCtx, any>
}

// ---------------------------------------------------------------------------
// InterpretBuilder — fluent API for composing interpreters
// ---------------------------------------------------------------------------

/**
 * A fluent builder for composing interpreter layers before running the
 * catamorphism. Created by `interpret(schema, ctx)` (the two-arg overload).
 *
 * The builder carries the schema type `S` (for tier resolution), the
 * current context type `Ctx` (for layer compatibility), and accumulated
 * `Brands` (for `.done()` return type selection via `Resolve<S, Brands>`).
 *
 * ```ts
 * const doc = interpret(schema, ctx)
 *   .with(readable)    // Brands = unknown & ReadableBrand = ReadableBrand
 *   .with(writable)    // Brands = ReadableBrand & WritableBrand
 *   .with(observation)  // Brands = ReadableBrand & WritableBrand & ChangefeedBrand
 *   .done()            // → Ref<typeof schema>
 * ```
 *
 * Each `.with(layer)` applies a transformer and intersects the layer's brand.
 * `.done()` runs the catamorphism and returns `Resolve<S, Brands>`.
 *
 * The builder accumulates layers — each `.with()` returns a new builder
 * with the layer appended.
 */
export interface InterpretBuilder<S extends Schema, Ctx, Brands> {
  /**
   * Add a layer to the interpreter stack.
   *
   * The layer's `transform` receives the current interpreter and returns
   * an enhanced interpreter. The context type may widen. The layer's
   * phantom brand `B` is intersected into the accumulated `Brands`.
   */
  with<NewCtx, B = unknown>(
    layer: InterpreterLayer<Ctx, NewCtx, B>,
  ): InterpretBuilder<S, NewCtx, Brands & B>

  /**
   * Run the catamorphism with the composed interpreter and return the result.
   *
   * Returns `Resolve<S, Brands>` — the schema-level ref type selected by
   * the accumulated brands. For standard compositions:
   * - `readable` → `RRef<S>`
   * - `readable + writable` → `RWRef<S>`
   * - `readable + writable + observation` → `Ref<S>`
   * - Custom/unbranded → `unknown`
   */
  done(): Resolve<S, Brands>
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
 *   .with(observation)
 *   .done()
 * ```
 *
 * The catamorphism is bottom-up: children are interpreted before parents,
 * but lazily — product children are wrapped in thunks, and sequence/map
 * children are wrapped in closures, so the interpreter controls when
 * (and whether) children are actually evaluated.
 */
// Three-arg overload: returns `A` (the raw carrier type).
//
// The carrier type is already honest — `withWritable` contributes
// `& HasTransact`, `withChangefeed` contributes `& HasChangefeed` —
// so `A` carries full capability information. Users who need a
// schema-level type can use `ResolveCarrier<S, A>` explicitly, or
// use the fluent builder path which infers automatically.
//
// We intentionally return `A` rather than `ResolveCarrier<S, A>` because
// `Ref<S>` / `RWRef<S>` are deeply recursive conditional types that
// cause TS2589 "excessively deep" when placed in overload return positions
// with abstract `S extends Schema`.
export function interpret<S extends Schema, Ctx, A>(
  schema: S,
  interp: Interpreter<Ctx, A>,
  ctx: Ctx,
  path?: Path,
): A

// Two-arg overload — fluent builder.
export function interpret<S extends Schema, Ctx>(
  schema: S,
  ctx: Ctx,
): InterpretBuilder<S, Ctx, unknown>
export function interpret(
  schema: Schema,
  interpOrCtx: unknown,
  ctx?: unknown,
  path?: Path,
): any {
  // Overload resolution: if the second argument has all six interpreter
  // methods, it's an Interpreter. Otherwise it's a context object.
  if (isInterpreter(interpOrCtx)) {
    return interpretImpl(
      schema,
      interpOrCtx as Interpreter<any, any>,
      ctx!,
      path,
    )
  }
  // Two-arg form: return a fluent builder
  return createBuilder(schema, interpOrCtx)
}

/**
 * Returns true if `value` looks like an Interpreter (has all six case methods).
 */
function isInterpreter(value: unknown): boolean {
  if (value === null || value === undefined || typeof value !== "object")
    return false
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
function createBuilder(
  schema: Schema,
  ctx: unknown,
  layers: ReadonlyArray<InterpreterLayer<any, any, any>> = [],
): { with(layer: InterpreterLayer<any, any, any>): any; done(): unknown } {
  return {
    with(layer: InterpreterLayer<any, any, any>) {
      return createBuilder(schema, ctx, [...layers, layer])
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
      return interpretImpl(schema, interp, ctx)
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
  path?: Path,
): A {
  // Resolve the path. For the root call (path === undefined), ctx.rootPath
  // may not be set yet — withAddressing sets it on first method invocation.
  // We use RawPath.empty as a temporary root path; child-deriving closures
  // (field thunks, itemFn, innerThunk) re-read ctx.rootPath at execution
  // time so that withAddressing's rootPath is picked up.
  const isRootCall = path === undefined
  const resolvedPath: Path = path ?? (ctx as any)?.rootPath ?? RawPath.empty

  // onRefCreated hook — called after each child ref is created.
  // Installed by withAddressing for ref registration and deleted getter.
  // Read lazily so that hooks installed during interpretation are visible.
  const getOnRefCreated = () =>
    (ctx as any)?.onRefCreated as
      | ((path: Path, ref: unknown) => void)
      | undefined

  // For the root call, child-deriving closures need the path that
  // ctx.rootPath resolves to AFTER the first interpreter method has run
  // (which is when withAddressing installs rootPath). Non-root calls
  // use the explicitly-passed resolvedPath directly.
  const effectivePath = (): Path => {
    if (isRootCall) {
      return (ctx as any)?.rootPath ?? resolvedPath
    }
    return resolvedPath
  }

  switch (schema[KIND]) {
    case "scalar":
      return interp.scalar(ctx, resolvedPath, schema)

    case "product": {
      // Build thunks for each field — lazy, not pre-computed.
      // Thunks call effectivePath() at execution time (not capture time)
      // so that ctx.rootPath set by withAddressing is picked up.
      const fieldThunks: Record<string, () => A> = {}
      for (const key of Object.keys(schema.fields)) {
        const fieldSchema = schema.fields[key]!
        fieldThunks[key] = () => {
          const childPath = effectivePath().field(key)
          const result = interpretImpl(fieldSchema, interp, ctx, childPath)
          getOnRefCreated()?.(childPath, result)
          return result
        }
      }
      return interp.product(ctx, resolvedPath, schema, fieldThunks)
    }

    case "sequence": {
      // Item closure: caller provides an index, gets back an interpreted child.
      const itemFn = (index: number): A => {
        const childPath = effectivePath().item(index)
        const result = interpretImpl(schema.item, interp, ctx, childPath)
        getOnRefCreated()?.(childPath, result)
        return result
      }
      return interp.sequence(ctx, resolvedPath, schema, itemFn)
    }

    case "map": {
      // Item closure: caller provides a key, gets back an interpreted child.
      const itemFn = (key: string): A => {
        const childPath = effectivePath().field(key)
        const result = interpretImpl(schema.item, interp, ctx, childPath)
        getOnRefCreated()?.(childPath, result)
        return result
      }
      return interp.map(ctx, resolvedPath, schema, itemFn)
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
          return interpretImpl(variantSchema, interp, ctx, resolvedPath)
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
          return interpretImpl(variantSchema, interp, ctx, resolvedPath)
        }
      }
      return interp.sum(ctx, resolvedPath, schema, variants)
    }

    case "annotated": {
      // If there's an inner schema, provide a thunk for it.
      // Annotated reuses the parent path (no new segment appended).
      // The inner thunk uses effectivePath() so that withAddressing's
      // rootPath is picked up after the annotated method installs it.
      const innerThunk: (() => A) | undefined =
        schema.schema !== undefined
          ? () => {
              const innerPath = effectivePath()
              const result = interpretImpl(
                schema.schema!,
                interp,
                ctx,
                innerPath,
              )
              getOnRefCreated()?.(innerPath, result)
              return result
            }
          : undefined

      return interp.annotated(ctx, resolvedPath, schema, innerThunk)
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
      overrides.scalar ?? ((ctx, path, schema) => fallback(ctx, path, schema)),
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

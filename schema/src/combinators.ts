// Interpreter composition combinators.
//
// Given interpreters F and G, we can build:
// - enrich(F, decorator)  — decorate each result with additional protocol
// - product(F, G)         — pair two independent interpretations
// - overlay(F, G)         — structural merge with fallback
//
// These are interpreter-level combinators (they transform Interpreter
// instances). Distinct from Zero.overlay which operates on values.

import type {
  Interpreter,
  Path,
  SumVariants,
} from "./interpret.js"
import type {
  ScalarSchema,
  ProductSchema,
  SequenceSchema,
  MapSchema,
  SumSchema,
  AnnotatedSchema,
} from "./schema.js"
import { isNonNullObject } from "./guards.js"

// ---------------------------------------------------------------------------
// enrich — decorate each result with additional protocol
// ---------------------------------------------------------------------------

/**
 * A decorator function that takes an interpreted result and returns
 * additional protocol to merge into it. The decorator receives the
 * base result, the context, and the path.
 *
 * Decorators should return **symbol-keyed** properties only, to
 * preserve namespace isolation (string keys belong to the schema).
 */
export type Decorator<Ctx, A, P> = (
  result: A,
  ctx: Ctx,
  path: Path,
) => P

/**
 * Wraps an interpreter, running the base and then applying a decorator
 * to each result. The decorator adds protocol (typically symbol-keyed
 * properties) to the base interpretation.
 *
 * This is more appropriate than `product` when the added protocol
 * depends on the base result. Today's `TypedRef` is conceptually
 * `enrich(writable, withChangefeed)`.
 *
 * ```ts
 * const withChangefeed: Decorator<WritableContext, unknown, { [CHANGEFEED]: Changefeed }> =
 *   (result, ctx, path) => ({
 *     [CHANGEFEED]: getOrCreateChangefeed(result as object, () => createChangefeed(ctx, path)),
 *   })
 *
 * const enriched = enrich(writableInterpreter, withChangefeed)
 * const doc = interpret(schema, enriched, ctx)
 * // doc.title has both writable methods AND [CHANGEFEED]
 * ```
 *
 * The merge strategy uses `Object.assign` — the decorator's properties
 * are shallow-merged onto the base result. For symbol-keyed protocol
 * this is safe; for string-keyed properties it would clobber base keys
 * (which is why decorators should use symbols).
 */
export function enrich<Ctx, A, P>(
  base: Interpreter<Ctx, A>,
  decorator: Decorator<Ctx, A, P>,
): Interpreter<Ctx, A & P> {
  function decorate(result: A, ctx: Ctx, path: Path): A & P {
    const protocol = decorator(result, ctx, path)
    if (isNonNullObject(result)) {
      return Object.assign(result as object, protocol as object) as A & P
    }
    // For primitive results, wrap in an object that carries both
    // the value (via valueOf) and the protocol
    return Object.assign(
      Object.create(null) as object,
      { valueOf: () => result },
      protocol as object,
    ) as unknown as A & P
  }

  return {
    scalar(ctx: Ctx, path: Path, schema: ScalarSchema): A & P {
      return decorate(base.scalar(ctx, path, schema), ctx, path)
    },

    product(
      ctx: Ctx,
      path: Path,
      schema: ProductSchema,
      fields: Readonly<Record<string, () => (A & P)>>,
    ): A & P {
      // The catamorphism builds thunks that produce A & P (because
      // the interpreter is typed as Interpreter<Ctx, A & P>).
      // The base interpreter expects thunks that produce A.
      // We cast through — the thunks will return enriched values
      // but the base only reads the A part.
      const baseFields = fields as Readonly<Record<string, () => A>>
      return decorate(base.product(ctx, path, schema, baseFields), ctx, path)
    },

    sequence(
      ctx: Ctx,
      path: Path,
      schema: SequenceSchema,
      item: (index: number) => A & P,
    ): A & P {
      const baseItem = item as (index: number) => A
      return decorate(base.sequence(ctx, path, schema, baseItem), ctx, path)
    },

    map(
      ctx: Ctx,
      path: Path,
      schema: MapSchema,
      item: (key: string) => A & P,
    ): A & P {
      const baseItem = item as (key: string) => A
      return decorate(base.map(ctx, path, schema, baseItem), ctx, path)
    },

    sum(
      ctx: Ctx,
      path: Path,
      schema: SumSchema,
      variants: SumVariants<A & P>,
    ): A & P {
      const baseVariants = variants as SumVariants<A>
      return decorate(base.sum(ctx, path, schema, baseVariants), ctx, path)
    },

    annotated(
      ctx: Ctx,
      path: Path,
      schema: AnnotatedSchema,
      inner: (() => A & P) | undefined,
    ): A & P {
      const baseInner = inner as (() => A) | undefined
      return decorate(base.annotated(ctx, path, schema, baseInner), ctx, path)
    },
  }
}

// ---------------------------------------------------------------------------
// product — pair two independent interpretations
// ---------------------------------------------------------------------------

/**
 * Pairs two interpreters into one that produces tuples `[A, B]` at
 * every node. Each interpreter runs independently with the same
 * context and path.
 *
 * Product is appropriate for genuinely independent interpretations,
 * e.g. `product(plain, path)` — you want both a current value and a
 * path selector, computed independently.
 *
 * At product/struct nodes, the paired field thunks are unzipped
 * before being passed to each base interpreter.
 *
 * ```ts
 * const paired = product(plainInterpreter, zeroInterpreter)
 * const [plain, zero] = interpret(schema, paired, ctx)
 * ```
 */
export function product<Ctx, A, B>(
  f: Interpreter<Ctx, A>,
  g: Interpreter<Ctx, B>,
): Interpreter<Ctx, [A, B]> {
  return {
    scalar(ctx: Ctx, path: Path, schema: ScalarSchema): [A, B] {
      return [f.scalar(ctx, path, schema), g.scalar(ctx, path, schema)]
    },

    product(
      ctx: Ctx,
      path: Path,
      schema: ProductSchema,
      fields: Readonly<Record<string, () => [A, B]>>,
    ): [A, B] {
      // Unzip: from Record<string, () => [A, B]> to two
      // Record<string, () => A> and Record<string, () => B>
      const fieldsA: Record<string, () => A> = {}
      const fieldsB: Record<string, () => B> = {}
      for (const key of Object.keys(fields)) {
        const thunk = fields[key]!
        // Memoize the paired thunk so we only evaluate once
        let cached: [A, B] | undefined
        const force = (): [A, B] => {
          if (cached === undefined) cached = thunk()
          return cached
        }
        fieldsA[key] = () => force()[0]
        fieldsB[key] = () => force()[1]
      }
      return [
        f.product(ctx, path, schema, fieldsA),
        g.product(ctx, path, schema, fieldsB),
      ]
    },

    sequence(
      ctx: Ctx,
      path: Path,
      schema: SequenceSchema,
      item: (index: number) => [A, B],
    ): [A, B] {
      // Unzip item closures — memoize per index
      const cache = new Map<number, [A, B]>()
      const force = (index: number): [A, B] => {
        let v = cache.get(index)
        if (v === undefined) {
          v = item(index)
          cache.set(index, v)
        }
        return v
      }
      return [
        f.sequence(ctx, path, schema, (i) => force(i)[0]),
        g.sequence(ctx, path, schema, (i) => force(i)[1]),
      ]
    },

    map(
      ctx: Ctx,
      path: Path,
      schema: MapSchema,
      item: (key: string) => [A, B],
    ): [A, B] {
      const cache = new Map<string, [A, B]>()
      const force = (key: string): [A, B] => {
        let v = cache.get(key)
        if (v === undefined) {
          v = item(key)
          cache.set(key, v)
        }
        return v
      }
      return [
        f.map(ctx, path, schema, (k) => force(k)[0]),
        g.map(ctx, path, schema, (k) => force(k)[1]),
      ]
    },

    sum(
      ctx: Ctx,
      path: Path,
      schema: SumSchema,
      variants: SumVariants<[A, B]>,
    ): [A, B] {
      // Unzip variant accessors
      const variantsA: SumVariants<A> = {}
      const variantsB: SumVariants<B> = {}

      if (variants.byIndex) {
        const byIndex = variants.byIndex
        const indexCache = new Map<number, [A, B]>()
        const force = (i: number): [A, B] => {
          let v = indexCache.get(i)
          if (v === undefined) {
            v = byIndex(i)
            indexCache.set(i, v)
          }
          return v
        }
        ;(variantsA as { byIndex: (i: number) => A }).byIndex = (i) => force(i)[0]
        ;(variantsB as { byIndex: (i: number) => B }).byIndex = (i) => force(i)[1]
      }

      if (variants.byKey) {
        const byKey = variants.byKey
        const keyCache = new Map<string, [A, B]>()
        const force = (k: string): [A, B] => {
          let v = keyCache.get(k)
          if (v === undefined) {
            v = byKey(k)
            keyCache.set(k, v)
          }
          return v
        }
        ;(variantsA as { byKey: (k: string) => A }).byKey = (k) => force(k)[0]
        ;(variantsB as { byKey: (k: string) => B }).byKey = (k) => force(k)[1]
      }

      return [
        f.sum(ctx, path, schema, variantsA),
        g.sum(ctx, path, schema, variantsB),
      ]
    },

    annotated(
      ctx: Ctx,
      path: Path,
      schema: AnnotatedSchema,
      inner: (() => [A, B]) | undefined,
    ): [A, B] {
      if (inner === undefined) {
        return [
          f.annotated(ctx, path, schema, undefined),
          g.annotated(ctx, path, schema, undefined),
        ]
      }
      // Memoize the inner thunk
      let cached: [A, B] | undefined
      const force = (): [A, B] => {
        if (cached === undefined) cached = inner()
        return cached
      }
      return [
        f.annotated(ctx, path, schema, () => force()[0]),
        g.annotated(ctx, path, schema, () => force()[1]),
      ]
    },
  }
}

// ---------------------------------------------------------------------------
// overlay — structural merge with fallback
// ---------------------------------------------------------------------------

/**
 * A merge function that combines a primary result with a fallback result
 * at each node. The schema is provided for shape-aware merging.
 */
export type MergeFn<A> = (
  primary: A,
  fallback: A,
  path: Path,
) => A

/**
 * Combines two interpreters with a merge function applied at every node.
 * The primary interpreter is tried first; its result is merged with the
 * fallback interpreter's result using the provided merge function.
 *
 * This is NOT a simple `??` — the merge function can perform deep
 * structural merging (e.g. product fields merged per-key, sequences
 * merged per-item). The merge function receives both results and
 * decides how to combine them.
 *
 * This is how the CRDT state + zero system works:
 * `overlay(crdtInterpreter, zeroInterpreter, firstDefined)`
 *
 * ```ts
 * const firstDefined: MergeFn<unknown> = (primary, fallback) =>
 *   primary !== undefined ? primary : fallback
 *
 * const merged = overlay(crdtInterpreter, zeroInterpreter, firstDefined)
 * ```
 *
 * For a deeper structural merge at the value level (not the interpreter
 * level), use `Zero.overlay(primary, fallback, schema)` instead.
 */
export function overlay<Ctx, A>(
  primary: Interpreter<Ctx, A>,
  fallback: Interpreter<Ctx, A>,
  merge: MergeFn<A>,
): Interpreter<Ctx, A> {
  return {
    scalar(ctx: Ctx, path: Path, schema: ScalarSchema): A {
      return merge(
        primary.scalar(ctx, path, schema),
        fallback.scalar(ctx, path, schema),
        path,
      )
    },

    product(
      ctx: Ctx,
      path: Path,
      schema: ProductSchema,
      fields: Readonly<Record<string, () => A>>,
    ): A {
      return merge(
        primary.product(ctx, path, schema, fields),
        fallback.product(ctx, path, schema, fields),
        path,
      )
    },

    sequence(
      ctx: Ctx,
      path: Path,
      schema: SequenceSchema,
      item: (index: number) => A,
    ): A {
      return merge(
        primary.sequence(ctx, path, schema, item),
        fallback.sequence(ctx, path, schema, item),
        path,
      )
    },

    map(
      ctx: Ctx,
      path: Path,
      schema: MapSchema,
      item: (key: string) => A,
    ): A {
      return merge(
        primary.map(ctx, path, schema, item),
        fallback.map(ctx, path, schema, item),
        path,
      )
    },

    sum(
      ctx: Ctx,
      path: Path,
      schema: SumSchema,
      variants: SumVariants<A>,
    ): A {
      return merge(
        primary.sum(ctx, path, schema, variants),
        fallback.sum(ctx, path, schema, variants),
        path,
      )
    },

    annotated(
      ctx: Ctx,
      path: Path,
      schema: AnnotatedSchema,
      inner: (() => A) | undefined,
    ): A {
      return merge(
        primary.annotated(ctx, path, schema, inner),
        fallback.annotated(ctx, path, schema, inner),
        path,
      )
    },
  }
}

// ---------------------------------------------------------------------------
// Common merge functions
// ---------------------------------------------------------------------------

/**
 * A merge function that returns the primary if non-nullish, else fallback.
 * The simplest useful merge — no structural recursion.
 */
export function firstDefined<A>(primary: A, fallback: A): A {
  return primary !== undefined && primary !== null ? primary : fallback
}
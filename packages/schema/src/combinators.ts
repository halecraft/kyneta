// Interpreter composition combinators.
//
// Given interpreters F and G, we can build:
// - product(F, G)         — pair two independent interpretations
// - overlay(F, G)         — structural merge with fallback
//
// These are interpreter-level combinators (they transform Interpreter
// instances).

import type { Interpreter, Path, SumVariants } from "./interpret.js"
import type {
  CounterSchema,
  MapSchema,
  MovableSequenceSchema,
  ProductSchema,
  ScalarSchema,
  SequenceSchema,
  SetSchema,
  SumSchema,
  TextSchema,
  TreeSchema,
} from "./schema.js"

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
 * const paired = product(plainInterpreter, pathInterpreter)
 * const [plain, paths] = interpret(schema, paired, ctx)
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
        f.sequence(ctx, path, schema, i => force(i)[0]),
        g.sequence(ctx, path, schema, i => force(i)[1]),
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
        f.map(ctx, path, schema, k => force(k)[0]),
        g.map(ctx, path, schema, k => force(k)[1]),
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
        ;(variantsA as { byIndex: (i: number) => A }).byIndex = i => force(i)[0]
        ;(variantsB as { byIndex: (i: number) => B }).byIndex = i => force(i)[1]
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
        ;(variantsA as { byKey: (k: string) => A }).byKey = k => force(k)[0]
        ;(variantsB as { byKey: (k: string) => B }).byKey = k => force(k)[1]
      }

      return [
        f.sum(ctx, path, schema, variantsA),
        g.sum(ctx, path, schema, variantsB),
      ]
    },

    // --- First-class leaf types -----------------------------------------------

    text(ctx: Ctx, path: Path, schema: TextSchema): [A, B] {
      return [f.text(ctx, path, schema), g.text(ctx, path, schema)]
    },

    counter(ctx: Ctx, path: Path, schema: CounterSchema): [A, B] {
      return [f.counter(ctx, path, schema), g.counter(ctx, path, schema)]
    },

    // --- First-class container types ------------------------------------------

    set(
      ctx: Ctx,
      path: Path,
      schema: SetSchema,
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
        f.set(ctx, path, schema, k => force(k)[0]),
        g.set(ctx, path, schema, k => force(k)[1]),
      ]
    },

    tree(
      ctx: Ctx,
      path: Path,
      schema: TreeSchema,
      nodeData: () => [A, B],
    ): [A, B] {
      // Memoize the nodeData thunk
      let cached: [A, B] | undefined
      const force = (): [A, B] => {
        if (cached === undefined) cached = nodeData()
        return cached
      }
      return [
        f.tree(ctx, path, schema, () => force()[0]),
        g.tree(ctx, path, schema, () => force()[1]),
      ]
    },

    movable(
      ctx: Ctx,
      path: Path,
      schema: MovableSequenceSchema,
      item: (index: number) => [A, B],
    ): [A, B] {
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
        f.movable(ctx, path, schema, i => force(i)[0]),
        g.movable(ctx, path, schema, i => force(i)[1]),
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
export type MergeFn<A> = (primary: A, fallback: A, path: Path) => A

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
 * This is how the CRDT state + fallback system works:
 * `overlay(crdtInterpreter, fallbackInterpreter, firstDefined)`
 *
 * ```ts
 * const firstDefined: MergeFn<unknown> = (primary, fallback) =>
 *   primary !== undefined ? primary : fallback
 *
 * const merged = overlay(crdtInterpreter, fallbackInterpreter, firstDefined)
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

    map(ctx: Ctx, path: Path, schema: MapSchema, item: (key: string) => A): A {
      return merge(
        primary.map(ctx, path, schema, item),
        fallback.map(ctx, path, schema, item),
        path,
      )
    },

    sum(ctx: Ctx, path: Path, schema: SumSchema, variants: SumVariants<A>): A {
      return merge(
        primary.sum(ctx, path, schema, variants),
        fallback.sum(ctx, path, schema, variants),
        path,
      )
    },

    // --- First-class leaf types -----------------------------------------------

    text(ctx: Ctx, path: Path, schema: TextSchema): A {
      return merge(
        primary.text(ctx, path, schema),
        fallback.text(ctx, path, schema),
        path,
      )
    },

    counter(ctx: Ctx, path: Path, schema: CounterSchema): A {
      return merge(
        primary.counter(ctx, path, schema),
        fallback.counter(ctx, path, schema),
        path,
      )
    },

    // --- First-class container types ------------------------------------------

    set(ctx: Ctx, path: Path, schema: SetSchema, item: (key: string) => A): A {
      return merge(
        primary.set(ctx, path, schema, item),
        fallback.set(ctx, path, schema, item),
        path,
      )
    },

    tree(ctx: Ctx, path: Path, schema: TreeSchema, nodeData: () => A): A {
      return merge(
        primary.tree(ctx, path, schema, nodeData),
        fallback.tree(ctx, path, schema, nodeData),
        path,
      )
    },

    movable(
      ctx: Ctx,
      path: Path,
      schema: MovableSequenceSchema,
      item: (index: number) => A,
    ): A {
      return merge(
        primary.movable(ctx, path, schema, item),
        fallback.movable(ctx, path, schema, item),
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
// interpret — the generic catamorphism over the schema functor.
//
// An Interpreter<Ctx, A> is an F-algebra: one case per structural kind
// that collapses a schema node into a result of type A. The `interpret`
// function walks the schema tree, applying the interpreter at each node.
//
// Key design decisions:
// - Product fields are thunks (() => A) — laziness preserved
// - Sequence/map children are closures ((index/key) => A)
// - First-class CRDT types (text, counter, set, tree, movable) each
//   have a dedicated interpreter case
//
// It is the fold for what varies by use: materialize, zero, validate and
// describe each supply an interpreter. A document's refs are not built by it:
// they are one fixed construction (`ref/create.ts`).

import { isNonNullObject } from "./guards.js"
import type { Path } from "./path.js"
import { RawPath } from "./path.js"
import {
  type CounterSchema,
  type DiscriminatedSumSchema,
  isNullableSum,
  KIND,
  type MapSchema,
  type MovableSequenceSchema,
  type PositionalSumSchema,
  type ProductSchema,
  type RichTextSchema,
  type ScalarSchema,
  type Schema,
  type SequenceSchema,
  type SetSchema,
  type SumSchema,
  type TextSchema,
  type TreeSchema,
} from "./schema.js"

// ---------------------------------------------------------------------------
// Path — re-exported from path.ts
// ---------------------------------------------------------------------------

export type { Path, RawSegment, Segment } from "./path.js"
export { RawPath, rawEntry, rawField, rawIndex } from "./path.js"

// ---------------------------------------------------------------------------
// FlatTreeNode — the algebra arg shape for `Schema.tree`
// ---------------------------------------------------------------------------

/**
 * One node of the flat-forest catamorphism arg for `Schema.tree`. The
 * shape (`{id, parent, index, data}`) is shared across storage, change
 * vocabulary, shadow, and algebra arg — four layers agreeing on one
 * shape is the core invariant of `Schema.tree`'s design. The recursive
 * `ForestNode<A>` projection lives in `forest.ts` and is built lazily
 * at the read layer; it is not the canonical algebra shape.
 */
export interface FlatTreeNode<A> {
  readonly id: string
  readonly parent: string | null
  readonly index: number
  readonly data: A
}

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
 * ### First-class CRDT types
 *
 * `text` and `counter` are leaves — no child thunks. `set` and `movable`
 * take item closures (keyed by string / indexed by number). `tree` gets
 * two views over the same flat forest: `nodes()` for whole-forest
 * snapshots (matches the shadow / Loro `toArray()` / `TreeChange` shape)
 * and `node(id)` for per-id lookup, as a map's item closure is keyed.
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

  text(ctx: Ctx, path: Path, schema: TextSchema): A

  counter(ctx: Ctx, path: Path, schema: CounterSchema): A

  set(ctx: Ctx, path: Path, schema: SetSchema, item: (key: string) => A): A

  tree(
    ctx: Ctx,
    path: Path,
    schema: TreeSchema,
    nodes: () => readonly FlatTreeNode<A>[],
    node: (id: string) => A,
  ): A

  movable(
    ctx: Ctx,
    path: Path,
    schema: MovableSequenceSchema,
    item: (index: number) => A,
  ): A

  richtext(ctx: Ctx, path: Path, schema: RichTextSchema): A
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
 * The one rule for which variant σ holds: a sum ref's proxy, `materialize`,
 * `completeValue` and coordinate existence all apply it. The logic is:
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
      return variants.byKey(keys[0])
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
// interpret — the catamorphism
// ---------------------------------------------------------------------------

/**
 * Walks a schema tree, applying the interpreter at each node, and returns
 * the root's result.
 *
 * ```ts
 * const result = interpret(mySchema, myInterpreter, myContext)
 * ```
 *
 * Product children are thunks and sequence and map children closures, so
 * each case decides when, and whether, a child is interpreted. `path` is where the walk
 * starts, the root by default.
 */
export function interpret<S extends Schema, Ctx, A>(
  schema: S,
  interp: Interpreter<Ctx, A>,
  ctx: Ctx,
  path: Path = RawPath.empty,
): A {
  return interpretImpl(schema, interp, ctx, path)
}

// ---------------------------------------------------------------------------
// interpretImpl — the actual catamorphism walk
// ---------------------------------------------------------------------------

function interpretImpl<Ctx, A>(
  schema: Schema,
  interp: Interpreter<Ctx, A>,
  ctx: Ctx,
  path: Path,
): A {
  switch (schema[KIND]) {
    case "scalar": {
      return interp.scalar(ctx, path, schema)
    }

    case "product": {
      // Thunks, so the interpreter decides when and whether a field is
      // interpreted.
      const fieldThunks: Record<string, () => A> = {}
      for (const key of Object.keys(schema.fields)) {
        const fieldSchema = schema.fields[key]
        fieldThunks[key] = () =>
          interpretImpl(fieldSchema, interp, ctx, path.field(key))
      }
      return interp.product(ctx, path, schema, fieldThunks)
    }

    case "sequence": {
      // Item closure: caller provides an index, gets back an interpreted child.
      const itemFn = (index: number): A => {
        return interpretImpl(schema.item, interp, ctx, path.item(index))
      }
      return interp.sequence(ctx, path, schema, itemFn)
    }

    case "map": {
      // Item closure: caller provides a key, gets back an interpreted child.
      // Map keys are runtime entries — `.entry(key)`, not `.field(key)`.
      const itemFn = (key: string): A => {
        return interpretImpl(schema.item, interp, ctx, path.entry(key))
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

    case "text": {
      return interp.text(ctx, path, schema)
    }

    case "counter": {
      return interp.counter(ctx, path, schema)
    }

    case "set": {
      // Set members are runtime entries (value-addressed via hash key).
      const itemFn = (key: string): A => {
        return interpretImpl(schema.item, interp, ctx, path.entry(key))
      }
      return interp.set(ctx, path, schema, itemFn)
    }

    case "tree": {
      // `nodeFn(id)` and `nodesThunk()` are two views over the same per-node
      // interpretation. Splitting them lets per-id consumers (e.g. the
      // `.node(id)` lookup) avoid materializing the whole forest, while
      // whole-forest consumers (snapshot, plain shadow) still get one
      // function call. Topology comes from `reader.forestTopology` so
      // substrates without a Reader.forestTopology hook (defensive `?.`)
      // emit an empty forest rather than throwing.
      const nodeFn = (id: string): A => {
        return interpretImpl(schema.item, interp, ctx, path.node(id))
      }
      const nodesThunk = (): readonly FlatTreeNode<A>[] => {
        const topology = (
          ctx as unknown as { reader?: import("./reader.js").Reader }
        ).reader?.forestTopology(path)
        if (!topology) return []
        const out: FlatTreeNode<A>[] = []
        for (const n of topology) {
          out.push({
            id: n.id,
            parent: n.parent,
            index: n.index,
            data: nodeFn(n.id),
          })
        }
        return out
      }
      return interp.tree(ctx, path, schema, nodesThunk, nodeFn)
    }

    case "movable": {
      const itemFn = (index: number): A => {
        return interpretImpl(schema.item, interp, ctx, path.item(index))
      }
      return interp.movable(ctx, path, schema, itemFn)
    }

    case "richtext": {
      return interp.richtext(ctx, path, schema)
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
    text:
      overrides.text ?? ((ctx, path, schema) => fallback(ctx, path, schema)),
    counter:
      overrides.counter ?? ((ctx, path, schema) => fallback(ctx, path, schema)),
    set:
      overrides.set ??
      ((ctx, path, schema, _item) => fallback(ctx, path, schema)),
    tree:
      overrides.tree ??
      ((ctx, path, schema, _nodes, _node) => fallback(ctx, path, schema)),
    movable:
      overrides.movable ??
      ((ctx, path, schema, _item) => fallback(ctx, path, schema)),
    richtext:
      overrides.richtext ??
      ((ctx, path, schema) => fallback(ctx, path, schema)),
  }
}

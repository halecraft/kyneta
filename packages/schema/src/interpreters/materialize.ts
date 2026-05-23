// Materialize interpreter — builds plain values from a backend-agnostic resolver.
//
// The 11 interpreter cases partition cleanly into two families:
//
// 1. **Container cases** (backend-agnostic) — product and tree delegate
//    structurally without touching the resolver. Product forces all field
//    thunks into a record; tree returns the flat-forest snapshot via
//    the `nodes` thunk (topology from `resolveForest`).
//
// 2. **Resolution cases** — the remaining 9 cases call one of 6 resolver
//    methods, split into two sub-families:
//
//    - **Leaf resolvers** (return typed value or undefined = not present):
//      resolveValue (scalar, sum), resolveText, resolveCounter, resolveRichText
//
//    - **Container shape resolvers** (return structure metadata):
//      resolveLength (sequence, movable), resolveKeys (map, set)
//
// Three "array-collector" cases — sequence, movable, set — share the
// `collectArrayByLength` / `collectArrayByKeys` helpers and all produce
// `Plain<I>[]`. The map case produces `Record<string, Plain<I>>`. The
// shape distinction between set (array) and map (record) is the one
// place the catamorphism's separate `set` branch carries semantic weight.
//
// Zero fallback is delegated to `zeroInterpreter` (for scalars with
// constraint handling) and `Zero.structural` (for sum defaults). This
// avoids duplicating default-value logic.
//
// The closure-based design parallels `plainReader(state)` — the resolver
// closes over backend state, eliminating Ctx threading. The interpreter's
// Ctx is `void` because all state access is captured in the resolver.

import type { RichTextDelta } from "../change.js"
import { isNonNullObject } from "../guards.js"
import type { Interpreter, Path, SumVariants } from "../interpret.js"
import { INTERPRETER } from "../interpreter-types.js"
import type { FlatTreeNodeTopology } from "../reader.js"
import type {
  CounterSchema,
  MapSchema,
  MovableSequenceSchema,
  PositionalSumSchema,
  ProductSchema,
  RichTextSchema,
  ScalarSchema,
  SequenceSchema,
  SetSchema,
  SumSchema,
  TextSchema,
  TreeSchema,
} from "../schema.js"
import { isNullableSum } from "../schema.js"
import { Zero, zeroInterpreter } from "../zero.js"

// ---------------------------------------------------------------------------
// MaterializeResolver — backend-agnostic value resolution
// ---------------------------------------------------------------------------

export interface MaterializeResolver {
  // --- Leaf resolvers (return typed value or undefined = not present) ---
  resolveValue(path: Path): unknown
  resolveText(path: Path): string | undefined
  resolveCounter(path: Path): number | undefined
  resolveRichText(path: Path): RichTextDelta | undefined

  // --- Container shape resolvers ---
  resolveLength(path: Path): number
  resolveKeys(path: Path): string[]

  // --- Topology resolvers ---
  // Third resolver family. `Schema.tree` needs richer structural data
  // than leaf/length/keys can express; future graph-shaped CRDTs would
  // join the family with `resolveGraph` / `resolveDAG`.
  resolveForest(path: Path): readonly FlatTreeNodeTopology[]
}

// ---------------------------------------------------------------------------
// collectArray — shared array-collection helpers
// ---------------------------------------------------------------------------
//
// Three of the eleven interpreter cases — sequence, movable, set — all
// produce a flat `T[]` from an item callback. They differ only in how
// they enumerate children: by length (indexed) or by keys (set). Sharing
// these helpers eliminates parallel implementations.

function collectArrayByLength<T>(
  length: number,
  item: (index: number) => T,
): T[] {
  const result: T[] = new Array(length)
  for (let i = 0; i < length; i++) {
    result[i] = item(i)
  }
  return result
}

function collectArrayByKeys<T>(
  keys: readonly string[],
  item: (key: string) => T,
): T[] {
  const result: T[] = new Array(keys.length)
  for (let i = 0; i < keys.length; i++) {
    result[i] = item(keys[i] as string)
  }
  return result
}

// ---------------------------------------------------------------------------
// MaterializeContext — minimal ctx shape with a Reader-like topology hook
// ---------------------------------------------------------------------------

/**
 * Reader-shaped facade over a `MaterializeResolver`. Only `forestTopology`
 * is bridged — that's the one hook the catamorphism's tree case looks for
 * on `ctx.reader`. The materializer's other case-bodies talk to the
 * resolver directly via closure, not through the context.
 */
export interface MaterializeContext {
  readonly reader: {
    forestTopology: (path: Path) => readonly FlatTreeNodeTopology[]
  }
}

// ---------------------------------------------------------------------------
// createMaterializeInterpreter
// ---------------------------------------------------------------------------

export function materializeContextFromResolver(
  resolver: MaterializeResolver,
): MaterializeContext {
  return {
    reader: {
      forestTopology: (path: Path) => resolver.resolveForest(path),
    },
  }
}

export function createMaterializeInterpreter(
  resolver: MaterializeResolver,
): Interpreter<MaterializeContext, unknown> {
  return {
    [INTERPRETER]: true,

    // 1. scalar — resolve value, falling back to zeroInterpreter for defaults
    scalar(
      _ctx: MaterializeContext,
      path: Path,
      schema: ScalarSchema,
    ): unknown {
      const value = resolver.resolveValue(path)
      if (value === undefined) {
        return zeroInterpreter.scalar(undefined, path, schema)
      }
      return value
    },

    // 2. product — container case, no resolver needed
    product(
      _ctx: MaterializeContext,
      _path: Path,
      _schema: ProductSchema,
      fields: Readonly<Record<string, () => unknown>>,
    ): unknown {
      const result: Record<string, unknown> = {}
      for (const [key, thunk] of Object.entries(fields)) {
        result[key] = thunk()
      }
      return result
    },

    // 3. sequence — resolve length, collect items into array
    sequence(
      _ctx: MaterializeContext,
      path: Path,
      _schema: SequenceSchema,
      item: (index: number) => unknown,
    ): unknown {
      return collectArrayByLength(resolver.resolveLength(path), item)
    },

    // 4. map — resolve keys, iterate items
    map(
      _ctx: MaterializeContext,
      path: Path,
      _schema: MapSchema,
      item: (key: string) => unknown,
    ): unknown {
      const keys = resolver.resolveKeys(path)
      const result: Record<string, unknown> = {}
      for (const key of keys) {
        result[key] = item(key)
      }
      return result
    },

    // 5. sum — discriminated or positional dispatch
    sum(
      _ctx: MaterializeContext,
      path: Path,
      schema: SumSchema,
      variants: SumVariants<unknown>,
    ): unknown {
      // Discriminated sum
      if (schema.discriminant !== undefined && variants.byKey) {
        const value = resolver.resolveValue(path)
        if (isNonNullObject(value)) {
          const discValue = value[schema.discriminant]
          if (typeof discValue === "string") {
            return variants.byKey(discValue)
          }
        }
        return Zero.structural(schema)
      }

      // Positional sum
      if (variants.byIndex) {
        const value = resolver.resolveValue(path)
        if (value === undefined) {
          return Zero.structural(schema)
        }
        const posSchema = schema as PositionalSumSchema
        if (isNullableSum(posSchema)) {
          return value === null ? variants.byIndex(0) : variants.byIndex(1)
        }
        return variants.byIndex(0)
      }

      return Zero.structural(schema)
    },

    // 6. text — resolve text, default to ""
    text(_ctx: MaterializeContext, path: Path, _schema: TextSchema): unknown {
      return resolver.resolveText(path) ?? ""
    },

    // 7. counter — resolve counter, default to 0
    counter(
      _ctx: MaterializeContext,
      path: Path,
      _schema: CounterSchema,
    ): unknown {
      return resolver.resolveCounter(path) ?? 0
    },

    // 8. set — collect into array (distinct from map, which produces a Record).
    // The catamorphism's `set` branch carries semantic weight here:
    // `Plain<SetSchema<I>> = Plain<I>[]` (not `Record<string, T>`).
    // Iteration order is the resolver's `resolveKeys` order — opaque to
    // the materializer but stable for a given doc state.
    set(
      _ctx: MaterializeContext,
      path: Path,
      _schema: SetSchema,
      item: (key: string) => unknown,
    ): unknown {
      return collectArrayByKeys(resolver.resolveKeys(path), item)
    },

    // 9. tree — structural, forces the flat-forest projection.
    // Topology comes from `resolver.resolveForest(path)` via the catamorphism's
    // `reader.forestTopology` lookup; each node's `data: unknown` is the result
    // of recursive schema interpretation. The materializer just forces the thunk.
    tree(
      _ctx: MaterializeContext,
      _path: Path,
      _schema: TreeSchema,
      nodes: () => readonly import("../interpret.js").FlatTreeNode<unknown>[],
    ): unknown {
      return nodes()
    },

    // 10. movable — resolve length, collect items into array
    movable(
      _ctx: MaterializeContext,
      path: Path,
      _schema: MovableSequenceSchema,
      item: (index: number) => unknown,
    ): unknown {
      return collectArrayByLength(resolver.resolveLength(path), item)
    },

    // 11. richtext — resolve rich text, default to []
    richtext(
      _ctx: MaterializeContext,
      path: Path,
      _schema: RichTextSchema,
    ): unknown {
      return resolver.resolveRichText(path) ?? []
    },
  }
}

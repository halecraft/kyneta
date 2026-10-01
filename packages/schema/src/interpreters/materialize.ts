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
//    `resolveHasKey` is asked by no case: the reconcile's gather uses it to
//    read only the record keys λ holds (`reconcile-shadow.ts`).
//
// Three "array-collector" cases — sequence, movable, set — share the
// `collectArrayByLength` / `collectArrayByKeys` helpers and all produce
// `Plain<I>[]`. The map case produces `Record<string, Plain<I>>`. The
// shape distinction between set (array) and map (record) is the one
// place the catamorphism's separate `set` branch carries semantic weight.
//
// Zero fallback is delegated to `zeroInterpreter` (for scalars with
// constraint handling), and a sum's variant to `dispatchSum`, so neither
// rule has a second implementation here.
//
// The closure-based design parallels `plainReader(state)` — the resolver
// closes over backend state, eliminating Ctx threading. The interpreter's
// Ctx is `void` because all state access is captured in the resolver.

import type { RichTextDelta } from "../change.js"
import { isNonNullObject } from "../guards.js"
import type { Interpreter, Path, SumVariants } from "../interpret.js"
import { dispatchSum } from "../interpret.js"
import { INTERPRETER } from "../interpreter-types.js"
import { type FlatTreeNodeTopology, forestTopologyOf } from "../reader.js"
import type {
  CounterSchema,
  MapSchema,
  MovableSequenceSchema,
  ProductSchema,
  RichTextSchema,
  ScalarSchema,
  SequenceSchema,
  SetSchema,
  SumSchema,
  TextSchema,
  TreeSchema,
} from "../schema.js"
import { zeroInterpreter } from "../zero.js"

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
  /**
   * Whether the record at `path` holds the runtime key `key`: what
   * `resolveKeys(path).includes(key)` answers, without listing the keys.
   * Asked only of a record, never of a struct's field, whose existence the
   * schema decides; so a backend that keys fields by identity needs no
   * binding lookup here.
   */
  resolveHasKey(path: Path, key: string): boolean

  // --- Topology resolvers ---
  // Third resolver family. `Schema.tree` needs richer structural data
  // than leaf/length/keys can express; future graph-shaped CRDTs would
  // join the family with `resolveGraph` / `resolveDAG`.
  resolveForest(path: Path): readonly FlatTreeNodeTopology[]
}

// ---------------------------------------------------------------------------
// plainResolution: answers for a value held as plain JSON
// ---------------------------------------------------------------------------

/**
 * What each resolver method answers for a value the backend holds as plain
 * JSON rather than as a container of its own, such as the inside of a
 * `.json()` register. The fold does not special-case `.json()`: a `.json()`
 * list is a `sequence` node, so `resolveLength` is asked of a plain array.
 *
 * Shared so that every backend reads a register's interior the same way.
 */
export const plainResolution = {
  text: (value: unknown): string | undefined =>
    typeof value === "string" ? value : undefined,
  counter: (value: unknown): number | undefined =>
    typeof value === "number" ? value : undefined,
  richText: (value: unknown): RichTextDelta | undefined =>
    Array.isArray(value) ? (value as RichTextDelta) : undefined,
  length: (value: unknown): number => (Array.isArray(value) ? value.length : 0),
  keys: (value: unknown): string[] =>
    isNonNullObject(value) ? Object.keys(value) : [],
  hasKey: (value: unknown, key: string): boolean =>
    isNonNullObject(value) && Object.hasOwn(value, key),
} as const

/**
 * A resolver over a plain value: the fold over it completes the value, as
 * the backends' resolvers complete what they hold. Every method answers with
 * `plainResolution`, and a forest is read from the flat shadow shape.
 */
export function plainValueResolver(state: unknown): MaterializeResolver {
  const at = (path: Path): unknown => path.read(state)
  return {
    resolveValue: at,
    resolveText: path => plainResolution.text(at(path)),
    resolveCounter: path => plainResolution.counter(at(path)),
    resolveRichText: path => plainResolution.richText(at(path)),
    resolveLength: path => plainResolution.length(at(path)),
    resolveKeys: path => plainResolution.keys(at(path)),
    resolveHasKey: (path, key) => plainResolution.hasKey(at(path), key),
    resolveForest: path => forestTopologyOf(at(path)),
  }
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

    // 5. sum — the variant `dispatchSum` picks from the stored value, as
    // every read picks it.
    sum(
      _ctx: MaterializeContext,
      path: Path,
      schema: SumSchema,
      variants: SumVariants<unknown>,
    ): unknown {
      return dispatchSum(resolver.resolveValue(path), schema, variants)
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

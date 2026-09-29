// withCaching — adds identity-preserving child caching.
//
// This transformer takes an addressed interpreter (`withAddressing` beneath
// it) and memoizes its structural navigation:
//
// - Product: each field getter memoizes its child for the carrier's
//   lifetime (resolved/cached closure pattern).
// - Sequence, map, tree: `.at(i)`, `.at(key)` and `.node(id)` return the
//   carrier kept on the child's coordinate in the context's `CoordinateTrie`,
//   so a child has one carrier while it exists.
// - Sum: memoizes each variant's carrier.
// - Reads: every node's `[CALL]` value is kept on its coordinate (`read-cache`)
//   until a change reaches it, on a writable stack. Unchanged subtrees are
//   shared from one read to the next.
//
// Carriers need nothing when a change lands: addresses advance, die and
// revive in withAddressing's prepare stage, taking the carriers kept on their
// nodes with them, and a memoized carrier reads through its path. Reads do:
// this layer's own `after` stage clears the ones a change made stale.

import { coordinatePath } from "../coordinate-trie.js"
import type {
  FlatTreeNode,
  Interpreter,
  Path,
  SumVariants,
} from "../interpret.js"
import { INTERPRETER, type RefContext } from "../interpreter-types.js"
import { invalidateReads, readAt, storeRead } from "../read-cache.js"
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
import type { HasAddressing, HasCaching } from "./bottom.js"
import { CALL, markCaching } from "./bottom.js"
import { installKeyedCaching } from "./keyed-helpers.js"
import { installSequenceCaching } from "./sequence-helpers.js"
import { cachedTreeNodes } from "./tree-helpers.js"
import { hasPreparePipeline } from "./writable.js"

// ---------------------------------------------------------------------------
// Reads — the `[CALL]` memo and the stage that invalidates it
// ---------------------------------------------------------------------------

/** The key this layer registers its prepare stage under. */
const CACHING_STAGE: unique symbol = Symbol("kyneta:caching-stage")

/**
 * Memoize `result`'s read on its coordinate.
 *
 * Only on a writable stack: a read-only stack has no pipeline, so nothing
 * would ever tell a cached read it is stale, and its reads stay fresh values
 * (frozen all the same, by `withReadable`). Primitive values are never
 * stored — they have no identity to keep — and a read made while a `prepare`
 * is in progress is computed from σ and not stored, because the caches have
 * not all settled yet (`WritableContext.preparing`).
 */
function cacheReads(ctx: RefContext, path: Path, result: object): void {
  if (!hasPreparePipeline(ctx)) return
  const at = coordinatePath(ctx, path)
  ctx.addPrepareStage(CACHING_STAGE, {
    after: (changed, change) =>
      invalidateReads(at.trie, coordinatePath(ctx, changed), change),
  })

  const read = (result as { readonly [CALL]: () => unknown })[CALL]
  Object.defineProperty(result, CALL, {
    value: (): unknown => {
      if (ctx.preparing) return read()
      const cached = readAt(at.trie, at)
      if (cached !== undefined) return cached
      const value = read()
      if (typeof value === "object" && value !== null) {
        storeRead(at.trie, at, value)
      }
      return value
    },
    enumerable: true,
    configurable: true,
    writable: true,
  })
}

// ---------------------------------------------------------------------------
// withCaching — the interposition transformer
// ---------------------------------------------------------------------------

/**
 * Transformer that adds identity-preserving child caching to structural
 * navigation.
 *
 * Takes an `Interpreter<RefContext, A extends HasAddressing>` and returns
 * an `Interpreter<RefContext, A & HasCaching>`. The carrier identity is
 * preserved — `withCaching` wraps navigation methods on the existing
 * carrier, it does not replace it.
 *
 * After caching:
 * - `ref.title === ref.title` (product field identity)
 * - `seq.at(0) === seq.at(0)`, and an item keeps its carrier as it moves
 * - `map.at("k") === map.at("k")`, and a key set again gets its carrier back
 * - `tree.node(id) === tree.node(id)`
 *
 * Requires `withAddressing` beneath it: the carriers of list items, map
 * entries and tree nodes are kept on their coordinates in the trie it owns.
 */
export function withCaching<A extends HasAddressing>(
  base: Interpreter<RefContext, A>,
): Interpreter<RefContext, A & HasCaching> {
  return {
    [INTERPRETER]: true,
    // --- Scalar ---------------------------------------------------------------
    // A scalar's read is cached only when it is an object (`.json()`, `any`).
    scalar(ctx: RefContext, path: Path, schema: ScalarSchema): A & HasCaching {
      const result = base.scalar(ctx, path, schema)
      cacheReads(ctx, path, result)
      return result as A & HasCaching
    },

    // --- Product ---------------------------------------------------------------
    // Wrap field getters with resolved/cached memoization, for the carrier's
    // lifetime. A field's carrier reads through its path, so a change to the
    // product, even a replace of the whole of it, leaves it valid.
    product(
      ctx: RefContext,
      path: Path,
      schema: ProductSchema,
      fields: Readonly<Record<string, () => A & HasCaching>>,
    ): A & HasCaching {
      // Downcast thunks for the base interpreter
      const baseFields = fields as Readonly<Record<string, () => A>>
      const result = base.product(ctx, path, schema, baseFields)

      // Build per-field memoization state.
      // Skip the discriminant field — it's a raw store read from
      // withNavigation, not a ref thunk. No caching needed.
      const discKey = schema.discriminantKey
      const fieldState: Record<string, { resolved: boolean; cached: unknown }> =
        {}
      for (const key of Object.keys(fields)) {
        if (key === discKey) continue
        fieldState[key] = { resolved: false, cached: undefined }
      }

      // Override each field getter with memoization
      for (const key of Object.keys(fields)) {
        if (key === discKey) continue
        const thunk = fields[key]
        const state = fieldState[key]
        Object.defineProperty(result, key, {
          get() {
            if (!state.resolved) {
              state.cached = thunk()
              state.resolved = true
            }
            return state.cached
          },
          enumerable: true,
          configurable: true,
        })
      }

      cacheReads(ctx, path, result)
      markCaching(result)
      return result
    },

    // --- Sequence ---------------------------------------------------------------
    // One carrier per child, kept on its coordinate.
    sequence(
      ctx: RefContext,
      path: Path,
      schema: SequenceSchema,
      item: (index: number) => A & HasCaching,
    ): A & HasCaching {
      const baseItem = item as (index: number) => A
      const result = base.sequence(ctx, path, schema, baseItem)
      installSequenceCaching(result, ctx, path)
      cacheReads(ctx, path, result)
      return result as A & HasCaching
    },

    // --- Map -------------------------------------------------------------------
    // One carrier per child, kept on its coordinate.
    map(
      ctx: RefContext,
      path: Path,
      schema: MapSchema,
      item: (key: string) => A & HasCaching,
    ): A & HasCaching {
      const baseItem = item as (key: string) => A
      const result = base.map(ctx, path, schema, baseItem)
      installKeyedCaching(result, ctx, path)
      cacheReads(ctx, path, result)
      return result as A & HasCaching
    },

    // --- Sum -------------------------------------------------------------------
    // Memoize the instantiation of the variant carriers.
    // The `with-navigation` proxy will repeatedly access `variants` via `dispatchSum`
    // on every read. Memoizing here ensures we don't recreate the full nested
    // carrier stack every time a property is accessed on the sum proxy.
    sum(
      ctx: RefContext,
      path: Path,
      schema: SumSchema,
      variants: SumVariants<A & HasCaching>,
    ): A & HasCaching {
      const byKeyCache = new Map<string, A>()
      const byIndexCache = new Map<number, A>()

      const memoizedVariants: {
        byKey?: (key: string) => A
        byIndex?: (index: number) => A
      } = {}

      const byKeyResolver = variants.byKey
      if (byKeyResolver) {
        memoizedVariants.byKey = (key: string) => {
          let cached = byKeyCache.get(key)
          if (cached === undefined) {
            cached = byKeyResolver(key) as A
            byKeyCache.set(key, cached)
          }
          return cached
        }
      }

      const byIndexResolver = variants.byIndex
      if (byIndexResolver) {
        memoizedVariants.byIndex = (index: number) => {
          let cached = byIndexCache.get(index)
          if (cached === undefined) {
            cached = byIndexResolver(index) as A
            byIndexCache.set(index, cached)
          }
          return cached
        }
      }

      return base.sum(ctx, path, schema, memoizedVariants) as A & HasCaching
    },

    // --- Text ------------------------------------------------------------------
    // A text's read is a string, which has no identity to keep — pass through.
    text(ctx: RefContext, path: Path, schema: TextSchema): A & HasCaching {
      return base.text(ctx, path, schema) as A & HasCaching
    },

    // --- Counter ---------------------------------------------------------------
    // A counter's read is a number, which has no identity to keep — pass through.
    counter(
      ctx: RefContext,
      path: Path,
      schema: CounterSchema,
    ): A & HasCaching {
      return base.counter(ctx, path, schema) as A & HasCaching
    },

    // --- Set -------------------------------------------------------------------
    // Sets are leaf-shaped: no per-member child refs. The members are read,
    // and cached, whole.
    set(
      ctx: RefContext,
      path: Path,
      schema: SetSchema,
      item: (key: string) => A & HasCaching,
    ): A & HasCaching {
      const baseItem = item as (key: string) => A
      const result = base.set(ctx, path, schema, baseItem)
      cacheReads(ctx, path, result)
      return result as A & HasCaching
    },

    // --- Tree ------------------------------------------------------------------
    // Hand the layers below memoized per-node closures, so `.node(id)`,
    // `.roots`, iteration and the snapshot share one carrier per node.
    tree(
      ctx: RefContext,
      path: Path,
      schema: TreeSchema,
      _nodes: () => readonly FlatTreeNode<A & HasCaching>[],
      node: (id: string) => A & HasCaching,
    ): A & HasCaching {
      const cached = cachedTreeNodes(ctx, path, node as (id: string) => A)
      const result = base.tree(ctx, path, schema, cached.nodes, cached.node)
      cacheReads(ctx, path, result)
      return result as A & HasCaching
    },

    // --- Movable ---------------------------------------------------------------
    // One carrier per item, kept on its coordinate (like sequence).
    movable(
      ctx: RefContext,
      path: Path,
      schema: MovableSequenceSchema,
      item: (index: number) => A & HasCaching,
    ): A & HasCaching {
      const baseItem = item as (index: number) => A
      const result = base.movable(ctx, path, schema, baseItem)
      installSequenceCaching(result, ctx, path)
      cacheReads(ctx, path, result)
      return result as A & HasCaching
    },

    // --- RichText --------------------------------------------------------------
    // A rich-text read is a delta, an object, cached like any other.
    richtext(
      ctx: RefContext,
      path: Path,
      schema: RichTextSchema,
    ): A & HasCaching {
      const result = base.richtext(ctx, path, schema)
      cacheReads(ctx, path, result)
      return result as A & HasCaching
    },
  }
}

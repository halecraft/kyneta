// withCaching — adds identity-preserving child caching.
//
// This transformer takes any interpreter that produces HasNavigation
// carriers (i.e. withReadable(bottomInterpreter) or above) and wraps
// structural navigation with memoization:
//
// - Product: each field getter memoizes its child for the carrier's
//   lifetime (resolved/cached closure pattern).
// - Sequence: delegates to address table when withAddressing is in the
//   stack. The address table IS the cache — no separate Map<number, ref>.
//   Without withAddressing, .at(i) returns a fresh ref each time.
// - Map: same pattern as sequence — address table or fresh ref.
// - Sum: memoizes each variant's carrier.
//
// Nothing here reacts to changes. Addresses advance and tombstone in
// withAddressing's prepare stage, and a memoized carrier stays valid across
// changes because it reads through its path.

import type {
  FlatTreeNode,
  Interpreter,
  Path,
  SumVariants,
} from "../interpret.js"
import { INTERPRETER, type RefContext } from "../interpreter-types.js"
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

import type { HasCaching, HasNavigation } from "./bottom.js"
import { markCaching } from "./bottom.js"
import { installKeyedCaching } from "./keyed-helpers.js"
import { installSequenceCaching } from "./sequence-helpers.js"

// ---------------------------------------------------------------------------
// ADDRESS_TABLE discovery (via Symbol.for to avoid import coupling)
// ---------------------------------------------------------------------------

/**
 * Symbol for discovering address tables on sequence/map refs.
 * Matches the symbol defined in `with-addressing.ts`.
 */
const ADDRESS_TABLE_SYM = Symbol.for("kyneta:addressTable")

// ---------------------------------------------------------------------------
// withCaching — the interposition transformer
// ---------------------------------------------------------------------------

/**
 * Transformer that adds identity-preserving child caching to structural
 * navigation.
 *
 * Takes an `Interpreter<RefContext, A extends HasNavigation>` and returns
 * an `Interpreter<RefContext, A & HasCaching>`. The carrier identity is
 * preserved — `withCaching` wraps navigation methods on the existing
 * carrier, it does not replace it.
 *
 * After caching:
 * - `ref.title === ref.title` (product field identity)
 * - `seq.at(0) === seq.at(0)` (sequence child identity, when withAddressing is in stack)
 * - `map.at("k") === map.at("k")` (map child identity, when withAddressing is in stack)
 *
 * **Sequence/Map caching with addressing:**
 * When `withAddressing` is in the stack, the address table (discovered
 * via `[ADDRESS_TABLE]`) IS the cache. `.at(i)` looks up the address
 * at index `i` in the table, then retrieves the registered ref from
 * `byId`. Cache miss falls through to `baseAt(i)` which creates the
 * ref (and registers it in the address table via `onRefCreated`).
 *
 * **Sequence/Map caching without addressing:**
 * `.at(i)` calls `baseAt(i)` fresh every time — no memoization.
 * Product field caching still works (it's self-contained).
 */
export function withCaching<A extends HasNavigation>(
  base: Interpreter<RefContext, A>,
): Interpreter<RefContext, A & HasCaching> {
  return {
    [INTERPRETER]: true,
    // --- Scalar ---------------------------------------------------------------
    // No caching needed for scalars — pass through.
    scalar(ctx: RefContext, path: Path, schema: ScalarSchema): A & HasCaching {
      return base.scalar(ctx, path, schema) as A & HasCaching
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

      markCaching(result)
      return result
    },

    // --- Sequence ---------------------------------------------------------------
    // Delegate to address table for identity-preserving lookup.
    sequence(
      ctx: RefContext,
      path: Path,
      schema: SequenceSchema,
      item: (index: number) => A & HasCaching,
    ): A & HasCaching {
      const baseItem = item as (index: number) => A
      const result = base.sequence(ctx, path, schema, baseItem)
      installSequenceCaching(result, ADDRESS_TABLE_SYM)
      return result as A & HasCaching
    },

    // --- Map -------------------------------------------------------------------
    // Delegate to address table for identity-preserving lookup.
    map(
      ctx: RefContext,
      path: Path,
      schema: MapSchema,
      item: (key: string) => A & HasCaching,
    ): A & HasCaching {
      const baseItem = item as (key: string) => A
      const result = base.map(ctx, path, schema, baseItem)
      installKeyedCaching(result, ADDRESS_TABLE_SYM)
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
    // No caching needed for text — pass through.
    text(ctx: RefContext, path: Path, schema: TextSchema): A & HasCaching {
      return base.text(ctx, path, schema) as A & HasCaching
    },

    // --- Counter ---------------------------------------------------------------
    // No caching needed for counter — pass through.
    counter(
      ctx: RefContext,
      path: Path,
      schema: CounterSchema,
    ): A & HasCaching {
      return base.counter(ctx, path, schema) as A & HasCaching
    },

    // --- Set -------------------------------------------------------------------
    // Sets are leaf-shaped: no per-member child refs, so no address-table
    // cache. Every call to `()` re-reads through `ctx.reader`. Pass through
    // (same pattern as text/counter).
    set(
      ctx: RefContext,
      path: Path,
      schema: SetSchema,
      item: (key: string) => A & HasCaching,
    ): A & HasCaching {
      const baseItem = item as (key: string) => A
      return base.set(ctx, path, schema, baseItem) as A & HasCaching
    },

    // --- Tree ------------------------------------------------------------------
    // Per-node refs are cached by the inner recursion (each node's `data`
    // ref carries caching). The `.roots` projection is built fresh per
    // read; memoizing it per tree-version is a future optimization.
    tree(
      ctx: RefContext,
      path: Path,
      schema: TreeSchema,
      nodes: () => readonly FlatTreeNode<A & HasCaching>[],
      node: (id: string) => A & HasCaching,
    ): A & HasCaching {
      const baseNodes = nodes as unknown as () => readonly FlatTreeNode<A>[]
      const baseNode = node as unknown as (id: string) => A
      return base.tree(ctx, path, schema, baseNodes, baseNode) as A & HasCaching
    },

    // --- Movable ---------------------------------------------------------------
    // Delegate to address table for identity-preserving lookup (like sequence).
    movable(
      ctx: RefContext,
      path: Path,
      schema: MovableSequenceSchema,
      item: (index: number) => A & HasCaching,
    ): A & HasCaching {
      const baseItem = item as (index: number) => A
      const result = base.movable(ctx, path, schema, baseItem)
      installSequenceCaching(result, ADDRESS_TABLE_SYM)
      return result as A & HasCaching
    },

    // --- RichText --------------------------------------------------------------
    // No caching needed for richtext — pass through.
    richtext(
      ctx: RefContext,
      path: Path,
      schema: RichTextSchema,
    ): A & HasCaching {
      return base.richtext(ctx, path, schema) as A & HasCaching
    },
  }
}

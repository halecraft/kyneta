// withCaching — adds identity-preserving child caching and change-driven
// cache invalidation.
//
// This transformer takes any interpreter that produces HasNavigation
// carriers (i.e. withReadable(bottomInterpreter) or above) and wraps
// structural navigation with memoization:
//
// - Product: thunk memoization (resolved/cached closure pattern)
// - Sequence: delegates to address table when withAddressing is in the
//   stack. The address table IS the cache — no separate Map<number, ref>.
//   Without withAddressing, .at(i) returns a fresh ref each time.
// - Map: same pattern as sequence — address table or fresh ref.
//
// Each structural node gets an [INVALIDATE](change) method:
//
// - Product: clear all resolved flags (re-evaluate thunks on next access)
// - Sequence: no-op (withAddressing handles advancement in prepare)
// - Map: no-op (withAddressing handles tombstoning in prepare)
//
// Pipeline integration: when composed in a writable stack, withCaching
// hooks into the `prepare` phase via `ensureCacheWiring`. Each composite
// node registers its invalidation handler by path during interpretation.
// The `prepare` wrapper looks up the handler and calls it before
// forwarding to the inner prepare (store mutation). This means
// `withWritable` mutation methods don't need to call [INVALIDATE]
// directly — the pipeline handles it.

import type { ChangeBase } from "../change.js"
import type { Interpreter, Path, SumVariants } from "../interpret.js"
import type { RefContext } from "../interpreter-types.js"
import {
  type CounterSchema,
  KIND,
  type MapSchema,
  type MovableSequenceSchema,
  type ProductSchema,
  type RichTextSchema,
  type ScalarSchema,
  type SequenceSchema,
  type SetSchema,
  type SumSchema,
  type TextSchema,
  type TreeSchema,
} from "../schema.js"

import type { HasCaching, HasNavigation } from "./bottom.js"
import { installKeyedCaching } from "./keyed-helpers.js"
import { installSequenceCaching } from "./sequence-helpers.js"

// ---------------------------------------------------------------------------
// INVALIDATE symbol — composability hook for cache coordination
// ---------------------------------------------------------------------------

/**
 * Symbol for change-driven cache invalidation. Attached to product,
 * sequence, and map refs by `withCaching`.
 *
 * Each composite ref still carries `[INVALIDATE]` as a public symbol
 * for advanced direct use. However, in the standard writable stack,
 * invalidation is driven by the `prepare` pipeline — `ensureCacheWiring`
 * registers per-path handlers that fire automatically during
 * `ctx.prepare(path, change)`, before store mutation.
 *
 * Uses `Symbol.for` so multiple copies of this module share identity.
 */
export const INVALIDATE: unique symbol = Symbol.for("kyneta:invalidate") as any

// ---------------------------------------------------------------------------
// ADDRESS_TABLE discovery (via Symbol.for to avoid import coupling)
// ---------------------------------------------------------------------------

/**
 * Symbol for discovering address tables on sequence/map refs.
 * Matches the symbol defined in `with-addressing.ts`.
 */
const ADDRESS_TABLE_SYM = Symbol.for("kyneta:addressTable")

// ---------------------------------------------------------------------------
// ensureCacheWiring — prepare-pipeline integration (per-context, idempotent)
// ---------------------------------------------------------------------------

/**
 * Per-context state for the caching layer's prepare wrapping.
 *
 * - `handlers`: path-keyed map of invalidation handlers. Each composite
 *   node registers its handler here during interpretation.
 * - `originalPrepare`: the unwrapped prepare method, called after
 *   the invalidation handler fires.
 */
interface CacheWiringState {
  // Outer key: path where the handler fires. Inner key: registrant's own
  // path (the product/sequence/etc. that owns the handler). Re-registration
  // from the same registrant replaces — so re-interpretation of a sum's
  // current variant doesn't accrete dead handlers.
  readonly handlers: Map<string, Map<string, (change: ChangeBase) => void>>
  readonly originalPrepare: (path: Path, change: ChangeBase) => void
}

// WeakMap ensures a single prepare wrapper per context object,
// shared across all nodes interpreted with that context.
const cacheContextState = new WeakMap<object, CacheWiringState>()

/**
 * Returns `true` if `ctx` has a `prepare` method — i.e. it's a
 * `WritableContext`, not a plain `RefContext`. This duck-type check
 * allows `withCaching` to keep its `RefContext` type signature while
 * participating in the prepare pipeline when composed inside
 * `withWritable`.
 */
function hasPrepare(ctx: RefContext): ctx is RefContext & {
  prepare: (path: Path, change: ChangeBase) => void
} {
  return "prepare" in ctx && typeof (ctx as any).prepare === "function"
}

/**
 * Ensures the given context has its `prepare` wrapped for cache
 * invalidation. Returns the shared handler map, or `null` if the
 * context doesn't have `prepare` (read-only stack).
 *
 * - `prepare` wrapping: before forwarding to the inner prepare,
 *   looks up an invalidation handler by `path.key` and calls it
 *   if found. This invalidates the cache BEFORE store mutation, so
 *   subsequent reads (e.g. during subscriber notification after flush)
 *   see updated values.
 *
 * Uses the same structural pattern as `ensurePrepareWiring` in
 * `withChangefeed` — WeakMap + idempotent wrapping + path-keyed map.
 */
function ensureCacheWiring(
  ctx: RefContext,
): Map<string, Map<string, (change: ChangeBase) => void>> | null {
  if (!hasPrepare(ctx)) return null

  let state = cacheContextState.get(ctx)
  if (state) return state.handlers

  const handlers = new Map<
    string,
    Map<string, (change: ChangeBase) => void>
  >()
  const originalPrepare = ctx.prepare

  // Wrapped prepare: invalidate cache at path, then forward.
  const wrappedPrepare = (path: Path, change: ChangeBase): void => {
    const inner = handlers.get(path.key)
    if (inner) {
      for (const h of inner.values()) h(change)
    }
    originalPrepare(path, change)
  }

  ctx.prepare = wrappedPrepare

  state = { handlers, originalPrepare }
  cacheContextState.set(ctx, state)
  return handlers
}

/**
 * Registers an invalidation handler at `atPath`, keyed by `registrantPath`.
 *
 * Multiple registrants can share an `atPath`: parent and variant products
 * both register at a sum field's path. Re-registration from the same
 * `registrantPath` replaces the previous handler — so re-interpreting the
 * sum's current variant after a cache flush doesn't accrete dead handlers,
 * and storing them in a left-folded closure (the prior shape) wouldn't
 * blow the stack via composed recursion.
 *
 * `handlers === null` denotes a read-only stack (no prepare pipeline);
 * registration is a no-op there — invalidation runs only via direct
 * `ref[INVALIDATE](change)` calls.
 */
function registerCacheHandler(
  handlers: Map<string, Map<string, (change: ChangeBase) => void>> | null,
  registrantPath: Path,
  atPath: Path,
  handler: (change: ChangeBase) => void,
): void {
  if (!handlers) return
  const atKey = atPath.key
  let inner = handlers.get(atKey)
  if (!inner) {
    inner = new Map()
    handlers.set(atKey, inner)
  }
  inner.set(registrantPath.key, handler)
}

// ---------------------------------------------------------------------------
// withCaching — the interposition transformer
// ---------------------------------------------------------------------------

/**
 * Transformer that adds identity-preserving child caching to structural
 * navigation and change-driven cache invalidation via `[INVALIDATE]`.
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
 *
 * **Pipeline integration:** When composed inside `withWritable` (i.e.
 * the context is a `WritableContext`), `withCaching` hooks into the
 * `prepare` phase via `ensureCacheWiring`. Each composite node
 * registers its invalidation handler by path. The `prepare` wrapper
 * fires the handler before store mutation, so caches are invalidated
 * automatically for every change.
 */
export function withCaching<A extends HasNavigation>(
  base: Interpreter<RefContext, A>,
): Interpreter<RefContext, A & HasCaching> {
  return {
    // --- Scalar ---------------------------------------------------------------
    // No caching needed for scalars — pass through.
    scalar(ctx: RefContext, path: Path, schema: ScalarSchema): A & HasCaching {
      return base.scalar(ctx, path, schema) as A & HasCaching
    },

    // --- Product ---------------------------------------------------------------
    // Wrap field getters with resolved/cached memoization.
    product(
      ctx: RefContext,
      path: Path,
      schema: ProductSchema,
      fields: Readonly<Record<string, () => A & HasCaching>>,
    ): A & HasCaching {
      // Downcast thunks for the base interpreter
      const baseFields = fields as Readonly<Record<string, () => A>>
      const result = base.product(ctx, path, schema, baseFields) as any

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
        const thunk = fields[key]!
        const state = fieldState[key]!
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

      // INVALIDATE handler: clear all field caches.
      const invalidateProduct = (_change: ChangeBase): void => {
        for (const key of Object.keys(fieldState)) {
          fieldState[key]!.resolved = false
          fieldState[key]!.cached = undefined
        }
      }

      // Attach [INVALIDATE] on the ref (public API, direct use)
      result[INVALIDATE] = invalidateProduct

      // Register in the prepare pipeline (writable stacks only)
      const handlers = ensureCacheWiring(ctx)
      registerCacheHandler(handlers, path, path, invalidateProduct)

      // Unlike normal product fields (stable ref identity), variant switching
      // changes the ref entirely. Register parent invalidation at each sum
      // field's path so the cached ref is discarded on variant replacement.
      for (const key of Object.keys(schema.fields)) {
        const fieldSchema = schema.fields[key]
        if (fieldSchema && (fieldSchema as any)[KIND] === "sum") {
          const fieldPath = path.field(key)
          registerCacheHandler(handlers, path, fieldPath, invalidateProduct)
        }
      }

      return result as A & HasCaching
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
      const result = base.sequence(ctx, path, schema, baseItem) as any
      installSequenceCaching(
        result,
        path,
        ADDRESS_TABLE_SYM,
        INVALIDATE,
        (p, handler) =>
          registerCacheHandler(ensureCacheWiring(ctx), p, p, handler),
      )
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
      const result = base.map(ctx, path, schema, baseItem) as any
      installKeyedCaching(
        result,
        path,
        ADDRESS_TABLE_SYM,
        INVALIDATE,
        (p, handler) =>
          registerCacheHandler(ensureCacheWiring(ctx), p, p, handler),
      )
      return result as A & HasCaching
    },

    // --- Sum -------------------------------------------------------------------
    // Pass through — no caching for sum dispatch.
    sum(
      ctx: RefContext,
      path: Path,
      schema: SumSchema,
      variants: SumVariants<A & HasCaching>,
    ): A & HasCaching {
      const baseVariants = variants as SumVariants<A>
      return base.sum(ctx, path, schema, baseVariants) as A & HasCaching
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
    // Delegate to address table for identity-preserving lookup (like map).
    set(
      ctx: RefContext,
      path: Path,
      schema: SetSchema,
      item: (key: string) => A & HasCaching,
    ): A & HasCaching {
      const baseItem = item as (key: string) => A
      const result = base.set(ctx, path, schema, baseItem) as any
      installKeyedCaching(
        result,
        path,
        ADDRESS_TABLE_SYM,
        INVALIDATE,
        (p, handler) =>
          registerCacheHandler(ensureCacheWiring(ctx), p, p, handler),
      )
      return result as A & HasCaching
    },

    // --- Tree ------------------------------------------------------------------
    // Delegate via nodeData — the inner interpretation already has caching.
    // Wrap with product-style field memoization since tree surfaces nodeData
    // fields.
    tree(
      ctx: RefContext,
      path: Path,
      schema: TreeSchema,
      nodeData: () => A & HasCaching,
    ): A & HasCaching {
      const baseNodeData = nodeData as () => A
      return base.tree(ctx, path, schema, baseNodeData) as A & HasCaching
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
      const result = base.movable(ctx, path, schema, baseItem) as any
      installSequenceCaching(
        result,
        path,
        ADDRESS_TABLE_SYM,
        INVALIDATE,
        (p, handler) =>
          registerCacheHandler(ensureCacheWiring(ctx), p, p, handler),
      )
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

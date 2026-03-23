// withCaching — adds identity-preserving child caching and change-driven
// cache invalidation.
//
// This transformer takes any interpreter that produces HasNavigation
// carriers (i.e. withReadable(bottomInterpreter) or above) and wraps
// structural navigation with memoization:
//
// - Product: thunk memoization (resolved/cached closure pattern)
// - Sequence: Map<number, A> child cache wrapping .at(i)
// - Map: Map<string, A> child cache wrapping .at(key)
//
// Each structural node gets an [INVALIDATE](change) method that
// interprets the change surgically:
//
// - SequenceChange → shift/delete cached entries
// - MapChange → delete affected keys
// - ReplaceChange → clear all
// - Unknown → clear all (safe fallback)
//
// The logic is split into Functional Core (planCacheUpdate — pure,
// table-testable) and Imperative Shell (applyCacheOps — trivial Map
// mutation).
//
// Pipeline integration: when composed in a writable stack, withCaching
// hooks into the `prepare` phase via `ensureCacheWiring`. Each composite
// node registers its invalidation handler by path during interpretation.
// The `prepare` wrapper looks up the handler and calls it before
// forwarding to the inner prepare (store mutation). This means
// `withWritable` mutation methods don't need to call [INVALIDATE]
// directly — the pipeline handles it.
//
// See .plans/interpreter-decomposition.md §Phase 3.
// See .plans/apply-changes.md §Phase 4.

import type { ChangeBase, MapChange, SequenceChange } from "../change.js"
import { isMapChange, isReplaceChange, isSequenceChange } from "../change.js"
import type { Interpreter, Path, SumVariants } from "../interpret.js"
import type { RefContext } from "../interpreter-types.js"
import type {
  AnnotatedSchema,
  MapSchema,
  ProductSchema,
  ScalarSchema,
  SequenceSchema,
  SumSchema,
} from "../schema.js"
import { pathKey } from "../store.js"
import type { HasCaching, HasNavigation } from "./bottom.js"

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
 * The handler accepts a `ChangeBase` and interprets it surgically —
 * shifting indices, deleting keys, or clearing the entire cache
 * depending on the change type and node kind.
 *
 * Uses `Symbol.for` so multiple copies of this module share identity.
 */
export const INVALIDATE: unique symbol = Symbol.for("kyneta:invalidate") as any

// ---------------------------------------------------------------------------
// CacheInstruction — the instruction set for cache updates
// ---------------------------------------------------------------------------

/**
 * A cache update operation produced by `planCacheUpdate`.
 *
 * - `clear` — drop all cached entries
 * - `delete` — drop specific keys
 * - `shift` — re-key numeric entries: all entries with key >= `from`
 *   get their key adjusted by `delta`
 */
export type CacheInstruction<K = number | string> =
  | { readonly type: "clear" }
  | { readonly type: "delete"; readonly keys: K[] }
  | { readonly type: "shift"; readonly from: K; readonly delta: number }

// ---------------------------------------------------------------------------
// planCacheUpdate — Functional Core (pure, table-testable)
// ---------------------------------------------------------------------------

/**
 * Given a change and the kind of node it targets, produce a list of
 * cache operations that keep the cache consistent.
 *
 * This function inspects only the *structural* impact of changes
 * (retain counts, insert lengths, delete counts). It never reads
 * inserted item values.
 *
 * Unrecognized change types produce `[{ type: "clear" }]` as a safe
 * fallback.
 */
export function planCacheUpdate(
  change: ChangeBase,
  kind: "sequence" | "map" | "product",
): CacheInstruction<number | string>[] {
  // ReplaceChange always clears everything, regardless of node kind
  if (isReplaceChange(change)) {
    return [{ type: "clear" }]
  }

  if (kind === "sequence" && isSequenceChange(change)) {
    return planSequenceCacheUpdate(change)
  }

  if (kind === "map" && isMapChange(change)) {
    return planMapCacheUpdate(change)
  }

  // Product only responds to ReplaceChange (handled above).
  // Any other change type on a product is unexpected — clear as fallback.
  if (kind === "product") {
    return [{ type: "clear" }]
  }

  // Unrecognized change type — safe fallback
  return [{ type: "clear" }]
}

/**
 * Plan cache updates for a sequence change.
 *
 * Walks the retain/insert/delete ops to compute which cached indices
 * need to be deleted and which need to be shifted.
 */
function planSequenceCacheUpdate(
  change: SequenceChange,
): CacheInstruction<number | string>[] {
  const ops: CacheInstruction<number | string>[] = []
  let cursor = 0

  for (const op of change.instructions) {
    if ("retain" in op) {
      cursor += op.retain
    } else if ("insert" in op) {
      const count = op.insert.length
      if (count > 0) {
        // Inserting at `cursor` shifts all existing entries at cursor+
        // forward by `count`. If cursor is past all existing entries
        // (append), this is a no-op shift since there's nothing to shift.
        ops.push({ type: "shift", from: cursor, delta: count })
      }
    } else if ("delete" in op) {
      const count = op.delete
      if (count > 0) {
        // Delete entries [cursor, cursor+count)
        const deletedKeys: (number | string)[] = []
        for (let i = 0; i < count; i++) {
          deletedKeys.push(cursor + i)
        }
        ops.push({ type: "delete", keys: deletedKeys })
        // Shift entries at cursor+count down by count
        ops.push({ type: "shift", from: cursor + count, delta: -count })
      }
    }
  }

  return ops
}

/**
 * Plan cache updates for a map change.
 *
 * Map changes have `set` (keys to upsert) and `delete` (keys to remove).
 * Only deleted keys need cache eviction — set keys will be re-populated
 * on next access via .at(key).
 */
function planMapCacheUpdate(
  change: MapChange,
): CacheInstruction<number | string>[] {
  const ops: CacheInstruction<number | string>[] = []

  // Delete entries for removed keys
  if (change.delete && change.delete.length > 0) {
    ops.push({ type: "delete", keys: [...change.delete] })
  }

  // Set keys: evict from cache so next .at(key) re-creates the ref
  // with the new value. Without this, the cached ref would still read
  // the old value from the store (store is updated, but the child ref's
  // path-based read would return the new value — however the ref identity
  // would be stale if the key was previously deleted and re-added).
  if (change.set) {
    const setKeys = Object.keys(change.set)
    if (setKeys.length > 0) {
      ops.push({ type: "delete", keys: setKeys })
    }
  }

  return ops
}

// ---------------------------------------------------------------------------
// applyCacheOps — Imperative Shell (trivial Map mutation)
// ---------------------------------------------------------------------------

/**
 * Applies planned cache operations to an actual `Map`.
 *
 * - `clear` → map.clear()
 * - `delete` → iterate keys, map.delete(k)
 * - `shift` → re-key entries: collect affected, delete old keys, set new keys
 */
export function applyCacheOps<K extends number | string>(
  cache: Map<K, unknown>,
  ops: CacheInstruction<K>[],
): void {
  for (const op of ops) {
    switch (op.type) {
      case "clear":
        cache.clear()
        break

      case "delete":
        for (const key of op.keys) {
          cache.delete(key)
        }
        break

      case "shift": {
        // Collect entries that need shifting
        const toShift: Array<[K, unknown]> = []
        for (const [key, value] of cache) {
          if (typeof key === "number" && key >= (op.from as number)) {
            toShift.push([key, value])
          }
        }
        // Sort by key for deterministic processing
        toShift.sort((a, b) => (a[0] as number) - (b[0] as number))
        // Delete old keys
        for (const [key] of toShift) {
          cache.delete(key)
        }
        // Set new keys
        for (const [key, value] of toShift) {
          const newKey = ((key as number) + op.delta) as K
          if ((newKey as number) >= 0) {
            cache.set(newKey, value)
          }
        }
        break
      }
    }
  }
}

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
  readonly handlers: Map<string, (change: ChangeBase) => void>
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
 *   looks up an invalidation handler by `pathKey(path)` and calls it
 *   if found. This invalidates the cache BEFORE store mutation, so
 *   subsequent reads (e.g. during subscriber notification after flush)
 *   see updated values.
 *
 * Uses the same structural pattern as `ensurePrepareWiring` in
 * `withChangefeed` — WeakMap + idempotent wrapping + path-keyed map.
 */
function ensureCacheWiring(
  ctx: RefContext,
): Map<string, (change: ChangeBase) => void> | null {
  if (!hasPrepare(ctx)) return null

  let state = cacheContextState.get(ctx)
  if (state) return state.handlers

  const handlers = new Map<string, (change: ChangeBase) => void>()
  const originalPrepare = ctx.prepare

  // Wrapped prepare: invalidate cache at path, then forward.
  const wrappedPrepare = (path: Path, change: ChangeBase): void => {
    const key = pathKey(path)
    const handler = handlers.get(key)
    if (handler) handler(change)
    originalPrepare(path, change)
  }

  ctx.prepare = wrappedPrepare

  state = { handlers, originalPrepare }
  cacheContextState.set(ctx, state)
  return handlers
}

/**
 * Registers an invalidation handler at the given path.
 *
 * If `handlers` is null (read-only stack, no prepare pipeline),
 * this is a no-op — invalidation will only happen via direct
 * `ref[INVALIDATE](change)` calls.
 */
function registerCacheHandler(
  handlers: Map<string, (change: ChangeBase) => void> | null,
  path: Path,
  handler: (change: ChangeBase) => void,
): void {
  if (handlers) {
    handlers.set(pathKey(path), handler)
  }
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
 * - `seq.at(0) === seq.at(0)` (sequence child identity)
 * - `map.at("k") === map.at("k")` (map child identity)
 *
 * **Pipeline integration:** When composed inside `withWritable` (i.e.
 * the context is a `WritableContext`), `withCaching` hooks into the
 * `prepare` phase via `ensureCacheWiring`. Each composite node
 * registers its invalidation handler by path. The `prepare` wrapper
 * fires the handler before store mutation, so caches are invalidated
 * automatically for every change — whether from imperative mutation
 * methods or declarative `applyChanges`.
 *
 * In read-only stacks (`RefContext` without `prepare`), the pipeline
 * hook is skipped. `[INVALIDATE]` remains on refs as a public symbol
 * for direct use.
 *
 * ```ts
 * const cached = withCaching(withReadable(bottomInterpreter))
 * const ctx: RefContext = { store }
 * const doc = interpret(schema, cached, ctx)
 * doc.title === doc.title  // true (cached)
 * ```
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
      // Products always do a full clear (planCacheUpdate for product
      // always returns [{ type: "clear" }] for any change type).
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
      registerCacheHandler(handlers, path, invalidateProduct)

      return result as A & HasCaching
    },

    // --- Sequence ---------------------------------------------------------------
    // Wrap .at(i) with a Map<number, A> child cache.
    sequence(
      ctx: RefContext,
      path: Path,
      schema: SequenceSchema,
      item: (index: number) => A & HasCaching,
    ): A & HasCaching {
      // Downcast for base
      const baseItem = item as (index: number) => A
      const result = base.sequence(ctx, path, schema, baseItem) as any

      const childCache = new Map<number, unknown>()

      // Capture the base .at() — withReadable installed it
      const baseAt = result.at as (index: number) => unknown

      // Override .at() with caching
      Object.defineProperty(result, "at", {
        value: (index: number): unknown => {
          // Bounds check — delegate to base which returns undefined for OOB
          if (childCache.has(index)) {
            return childCache.get(index)
          }
          const child = baseAt.call(result, index)
          if (child !== undefined) {
            childCache.set(index, child)
          }
          return child
        },
        enumerable: false,
        configurable: true,
      })

      // INVALIDATE handler: surgical cache update
      const invalidateSequence = (change: ChangeBase): void => {
        const ops = planCacheUpdate(change, "sequence")
        applyCacheOps(childCache, ops as CacheInstruction<number>[])
      }

      // Attach [INVALIDATE] on the ref (public API, direct use)
      result[INVALIDATE] = invalidateSequence

      // Register in the prepare pipeline (writable stacks only)
      const handlers = ensureCacheWiring(ctx)
      registerCacheHandler(handlers, path, invalidateSequence)

      return result as A & HasCaching
    },

    // --- Map -------------------------------------------------------------------
    // Wrap .at(key) with a Map<string, A> child cache.
    map(
      ctx: RefContext,
      path: Path,
      schema: MapSchema,
      item: (key: string) => A & HasCaching,
    ): A & HasCaching {
      // Downcast for base
      const baseItem = item as (key: string) => A
      const result = base.map(ctx, path, schema, baseItem) as any

      const childCache = new Map<string, unknown>()

      // Capture the base .at() — withReadable installed it
      const baseAt = result.at as (key: string) => unknown

      // Override .at() with caching
      Object.defineProperty(result, "at", {
        value: (key: string): unknown => {
          if (childCache.has(key)) {
            return childCache.get(key)
          }
          const child = baseAt.call(result, key)
          if (child !== undefined) {
            childCache.set(key, child)
          }
          return child
        },
        enumerable: false,
        configurable: true,
      })

      // INVALIDATE handler: surgical cache update
      const invalidateMap = (change: ChangeBase): void => {
        const ops = planCacheUpdate(change, "map")
        applyCacheOps(childCache, ops as CacheInstruction<string>[])
      }

      // Attach [INVALIDATE] on the ref (public API, direct use)
      result[INVALIDATE] = invalidateMap

      // Register in the prepare pipeline (writable stacks only)
      const handlers = ensureCacheWiring(ctx)
      registerCacheHandler(handlers, path, invalidateMap)

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

    // --- Annotated -------------------------------------------------------------
    // Pass through — no caching for annotation handling.
    annotated(
      ctx: RefContext,
      path: Path,
      schema: AnnotatedSchema,
      inner: (() => A & HasCaching) | undefined,
    ): A & HasCaching {
      const baseInner = inner as (() => A) | undefined
      return base.annotated(ctx, path, schema, baseInner) as A & HasCaching
    },
  }
}

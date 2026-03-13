// Writable interpreter layer — mutation methods composed onto any carrier.
//
// This module provides:
// 1. WritableContext (extends RefContext with dispatch + transactions)
// 2. TRANSACT symbol — composability hook for discovering a ref's context
// 3. Mutation-only ref interfaces: ScalarRef, TextRef, CounterRef, SequenceRef
// 4. withWritable(base) — interpreter transformer that adds mutation methods
// 5. Writable<S> type-level interpretation
//
// Shared types used across interpreters (RefContext, Plain<S>) live in
// `../interpreter-types.ts` and are re-exported here for backward compat.
//
// withWritable is a pure extension — it has no bound on A and works with
// any carrier. Mutation methods are bolted on; reading is not required.
// Invalidate-before-dispatch: if the carrier has [INVALIDATE] (from
// withCaching), the change is sent to the cache BEFORE dispatch, so
// subscribers see consistent caches.
//
// See .plans/interpreter-decomposition.md §Phase 4.

import type { Interpreter, Path, SumVariants } from "../interpret.js"
import {
  isNullableSum,
  type Schema,
  type ScalarKind,
  type ScalarSchema,
  type ScalarPlain,
  type ProductSchema,
  type SequenceSchema,
  type MapSchema,
  type SumSchema,
  type AnnotatedSchema,
  type PositionalSumSchema,
  type DiscriminatedSumSchema,
} from "../schema.js"
import type { ChangeBase } from "../change.js"
import {
  textChange,
  sequenceChange,
  mapChange,
  replaceChange,
  incrementChange,
} from "../change.js"
import {
  type Store,
  readByPath,
  applyChangeToStore,
} from "../store.js"
import {
  INVALIDATE,
} from "./with-caching.js"
import type { RefContext, Plain } from "../interpreter-types.js"

// Re-export store utilities for backward compatibility
export { type Store, readByPath, writeByPath, applyChangeToStore } from "../store.js"

// Re-export shared types for backward compatibility
export type { RefContext, Plain } from "../interpreter-types.js"

// ---------------------------------------------------------------------------
// TRANSACT symbol — composability hook for discovering a ref's context
// ---------------------------------------------------------------------------

/**
 * Symbol that refs carry to expose their originating `WritableContext`.
 * This enables `change()` and other utilities to discover the context
 * from any ref without a WeakMap or re-interpretation.
 *
 * Follows the same pattern as `INVALIDATE` in `with-caching.ts` — a
 * composability hook defined in the layer that owns the concept.
 *
 * Uses `Symbol.for` so multiple copies share the same identity.
 */
export const TRANSACT: unique symbol = Symbol.for("kyneta:transact") as any

/**
 * An object that carries a `[TRANSACT]` symbol referencing the
 * `WritableContext` used during interpretation.
 */
export interface HasTransact {
  readonly [TRANSACT]: WritableContext
}

/**
 * Returns `true` if `value` has a `[TRANSACT]` symbol property.
 */
export function hasTransact(value: unknown): value is HasTransact {
  return (
    value !== null &&
    value !== undefined &&
    (typeof value === "object" || typeof value === "function") &&
    TRANSACT in (value as object)
  )
}

// ---------------------------------------------------------------------------
// WritableContext — shared state flowing through the tree
// ---------------------------------------------------------------------------

/**
 * The context shared across the entire interpreted tree. Extends
 * `RefContext` with mutation infrastructure and transaction support.
 *
 * Unlike the catamorphism's `path` parameter (which narrows
 * automatically), the context carries resources that are the *same*
 * at every level:
 *
 * - `store` — the root mutable store object (from `RefContext`)
 * - `dispatch` — sends a change to the store (applies via step)
 * - `beginTransaction` / `commit` / `abort` — transaction lifecycle
 *
 * By default, `dispatch` applies changes immediately (auto-commit).
 * During a transaction, `dispatch` buffers changes internally until
 * `commit()` replays them through the normal dispatch path.
 *
 * The "where am I" information comes from the catamorphism's `path`
 * parameter, not from the context. This means the context doesn't need
 * to be re-derived at each level — it's the same object throughout.
 *
 * **No observation infrastructure here.** Subscriber notification is
 * provided by the changefeed layer which wraps `dispatch` to add
 * notification after each change is applied.
 */
export interface WritableContext extends RefContext {
  readonly dispatch: (path: Path, change: ChangeBase) => void
  /** Enter a transaction — dispatch buffers until commit/abort. */
  beginTransaction(): void
  /** Replay buffered changes through dispatch, return the list. */
  commit(): PendingChange[]
  /** Discard buffered changes without applying. */
  abort(): void
  readonly inTransaction: boolean
}

export interface PendingChange {
  readonly path: Path
  readonly change: ChangeBase
}

// ---------------------------------------------------------------------------
// createWritableContext — factory for the root context
// ---------------------------------------------------------------------------

/**
 * Creates a root WritableContext for a given store.
 *
 * Dispatch applies changes to the store immediately by default.
 * Use `beginTransaction()` / `commit()` to buffer and atomically
 * apply a batch of changes.
 *
 * ```ts
 * const store = { title: "", count: 0, items: [] }
 * const ctx = createWritableContext(store)
 * const doc = interpret(schema, withWritable(withCaching(withReadable(bottomInterpreter))), ctx)
 * ```
 */
export function createWritableContext(store: Store): WritableContext {
  const pending: PendingChange[] = []
  let inTransaction = false
  let replaying = false

  const dispatch = (path: Path, change: ChangeBase): void => {
    if (inTransaction && !replaying) {
      pending.push({ path, change })
    } else {
      applyChangeToStore(store, path, change)
    }
  }

  const beginTransaction = (): void => {
    if (inTransaction) {
      throw new Error("Already in a transaction (nested transactions are not supported)")
    }
    inTransaction = true
  }

  const commit = (): PendingChange[] => {
    if (!inTransaction) {
      throw new Error("No active transaction to commit")
    }
    const flushed = [...pending]
    pending.length = 0
    inTransaction = false

    // Replay through ctx.dispatch (the property on the returned object),
    // NOT the closure-captured `dispatch` function. This is critical:
    // layers like `withChangefeed` replace `ctx.dispatch` with a wrapper
    // that adds notification. If we called the closure `dispatch` directly,
    // we'd bypass those wrappers and subscribers would never fire.
    replaying = true
    try {
      for (const { path, change } of flushed) {
        ctx.dispatch(path, change)
      }
    } finally {
      replaying = false
    }

    return flushed
  }

  const abort = (): void => {
    if (!inTransaction) {
      throw new Error("No active transaction to abort")
    }
    pending.length = 0
    inTransaction = false
  }

  const ctx: WritableContext = {
    store,
    dispatch,
    beginTransaction,
    commit,
    abort,
    get inTransaction() { return inTransaction },
  }

  return ctx
}

// ---------------------------------------------------------------------------
// Ref types — mutation-only interfaces
// ---------------------------------------------------------------------------
// These describe only the mutation surface. Reading is provided by the
// readable interpreter (callable `ref()` + `[Symbol.toPrimitive]`).

export interface ScalarRef<T = unknown> {
  set: (value: T) => void
}

export interface TextRef {
  insert: (index: number, content: string) => void
  delete: (index: number, length: number) => void
  update: (content: string) => void
}

export interface CounterRef {
  increment: (n?: number) => void
  decrement: (n?: number) => void
}

export interface SequenceRef<T = unknown> {
  at: (index: number) => T | undefined
  push: (...items: unknown[]) => void
  insert: (index: number, ...items: unknown[]) => void
  delete: (index: number, count?: number) => void
  readonly length: number
  [Symbol.iterator](): Iterator<T>
}

/**
 * Mutation-only interface for product refs. Added by `withWritable`.
 * Enables atomic replacement of an entire struct subtree in one change.
 */
export interface ProductRef<T = unknown> {
  set(value: T): void
}

/**
 * Mutation-only interface for map refs. Added by `withWritable`.
 * Reading is provided by `ReadableMapRef` from the readable interpreter.
 */
export interface WritableMapRef<V = unknown> {
  set(key: string, value: V): void
  delete(key: string): void
  clear(): void
}

// ---------------------------------------------------------------------------
// Type-level interpretations — schema type → TypeScript type
// ---------------------------------------------------------------------------

// ScalarPlain is re-exported from schema.ts (the canonical definition).
// It maps ScalarKind literals to their corresponding TypeScript types.
export type { ScalarPlain } from "../schema.js"

/**
 * Computes the mutation-only ref type for a given schema type.
 *
 * This maps schema nodes to their mutation interfaces. Reading is
 * provided by the `Readable<S>` type (from the readable interpreter).
 * At runtime, `withWritable(withCaching(withReadable(bottomInterpreter)))` produces refs that
 * satisfy both `Readable<S>` and `Writable<S>`.
 *
 * ```ts
 * const s = Schema.doc({
 *   title: Schema.string(),
 *   count: Schema.number(),
 *   settings: Schema.struct({
 *     darkMode: Schema.boolean(),
 *   }),
 * })
 *
 * type Doc = Writable<typeof s>
 * // Leaf nodes: ScalarRef<string> (just .set()), etc.
 * // Products: { readonly title: ..., readonly count: ..., ... }
 * ```
 */
export type Writable<S extends Schema> =
  // --- Annotated: dispatch on tag ---
  S extends AnnotatedSchema<infer Tag, infer Inner>
    ? Tag extends "text"
      ? TextRef
      : Tag extends "counter"
        ? CounterRef
        : Tag extends "doc"
          ? Inner extends ProductSchema<infer F>
            ? { readonly [K in keyof F]: Writable<F[K]> } & ProductRef<{ [K in keyof F]: Plain<F[K]> }>
            : unknown
          : Tag extends "movable"
            ? Inner extends SequenceSchema<infer I>
              ? SequenceRef<Writable<I>>
              : unknown
            : Tag extends "tree"
              ? Inner extends Schema
                ? Writable<Inner>
                : unknown
              : // Unknown annotation with inner — delegate
                Inner extends Schema
                ? Writable<Inner>
                : unknown
    : // --- Scalar ---
      S extends ScalarSchema<infer _K, infer V>
      ? ScalarRef<V>
      : // --- Product ---
        S extends ProductSchema<infer F>
        ? { readonly [K in keyof F]: Writable<F[K]> } & ProductRef<{ [K in keyof F]: Plain<F[K]> }>
        : // --- Sequence ---
          S extends SequenceSchema<infer I>
          ? SequenceRef<Writable<I>>
          : // --- Map ---
            S extends MapSchema<infer I>
            ? WritableMapRef<Plain<I>>
            : // --- Sum ---
              S extends PositionalSumSchema
              ? unknown
              : S extends DiscriminatedSumSchema
                ? unknown
                : unknown

// ---------------------------------------------------------------------------
// withWritable — interpreter transformer
// ---------------------------------------------------------------------------

/**
 * An interpreter transformer that adds mutation methods to any
 * carrier-producing interpreter. Takes an `Interpreter<RefContext, A>` and
 * returns an `Interpreter<WritableContext, A>`.
 *
 * The base interpreter's cases receive a `WritableContext` (which extends
 * `RefContext`), so they work unchanged. `withWritable` adds mutation
 * methods at leaf and collection cases, and passes through for purely
 * structural cases (product, sum).
 *
 * **Invalidate-before-dispatch:** For nodes that have `[INVALIDATE]`
 * (provided by `withCaching`), `withWritable` calls
 * `result[INVALIDATE](change)` BEFORE `ctx.dispatch(path, change)`.
 * This ensures caches are consistent when subscribers fire during
 * dispatch. When caching is absent (e.g. `withWritable(withReadable(
 * bottomInterpreter))`), the `INVALIDATE in result` guard skips it.
 *
 * ```ts
 * const interp = withWritable(withCaching(withReadable(bottomInterpreter)))
 * const ctx = createWritableContext(store)
 * const doc = interpret(schema, interp, ctx)
 * doc.title.insert(0, "Hello")   // mutation via withWritable
 * doc.title()                    // "Hello" via withReadable
 * ```
 */
export function withWritable<A>(
  base: Interpreter<RefContext, A>,
): Interpreter<WritableContext, A> {
  // Helper: attach [TRANSACT] as a non-enumerable symbol property.
  // Uses Object.defineProperty to bypass Proxy set traps on map refs.
  function attachTransact(result: unknown, ctx: WritableContext): void {
    if (
      result !== null &&
      result !== undefined &&
      (typeof result === "object" || typeof result === "function")
    ) {
      Object.defineProperty(result, TRANSACT, {
        value: ctx,
        enumerable: false,
        configurable: true,
        writable: false,
      })
    }
  }

  return {
    // --- Scalar ---------------------------------------------------------------
    // Add .set() to the base scalar ref.
    // Every node dispatches at its own path — no upward reference.

    scalar(
      ctx: WritableContext,
      path: Path,
      schema: ScalarSchema,
    ): A {
      const result = base.scalar(ctx, path, schema) as any

      result.set = (value: unknown): void => {
        const change = replaceChange(value)
        if (INVALIDATE in result) result[INVALIDATE](change)
        ctx.dispatch(path, change)
      }

      attachTransact(result, ctx)
      return result
    },

    // --- Product --------------------------------------------------------------
    // Add .set(plainObject) for atomic subtree replacement.

    product(
      ctx: WritableContext,
      path: Path,
      schema: ProductSchema,
      fields: Readonly<Record<string, () => A>>,
    ): A {
      const result = base.product(ctx, path, schema, fields) as any

      Object.defineProperty(result, "set", {
        value: (value: unknown): void => {
          const change = replaceChange(value)
          if (INVALIDATE in result) result[INVALIDATE](change)
          ctx.dispatch(path, change)
        },
        enumerable: false,
        configurable: true,
      })

      attachTransact(result, ctx)
      return result
    },

    // --- Sequence -------------------------------------------------------------
    // Add .push(), .insert(), .delete() to the base sequence ref.
    // Invalidate-before-dispatch: cache is updated BEFORE ctx.dispatch
    // so subscribers see consistent state.

    sequence(
      ctx: WritableContext,
      path: Path,
      schema: SequenceSchema,
      item: (index: number) => A,
    ): A {
      const result = base.sequence(ctx, path, schema, item) as any

      result.push = (...items: unknown[]): void => {
        const arr = readByPath(ctx.store, path)
        const length = Array.isArray(arr) ? arr.length : 0
        const change = sequenceChange([{ retain: length }, { insert: items }])
        if (INVALIDATE in result) result[INVALIDATE](change)
        ctx.dispatch(path, change)
      }

      result.insert = (index: number, ...items: unknown[]): void => {
        const change = sequenceChange([
          ...(index > 0 ? [{ retain: index }] : []),
          { insert: items },
        ])
        if (INVALIDATE in result) result[INVALIDATE](change)
        ctx.dispatch(path, change)
      }

      result.delete = (index: number, count: number = 1): void => {
        const change = sequenceChange([
          ...(index > 0 ? [{ retain: index }] : []),
          { delete: count },
        ])
        if (INVALIDATE in result) result[INVALIDATE](change)
        ctx.dispatch(path, change)
      }

      attachTransact(result, ctx)
      return result
    },

    // --- Map ------------------------------------------------------------------
    // Attach .set(), .delete(), .clear() directly to the base map ref.
    // Invalidate-before-dispatch for each mutation.

    map(
      ctx: WritableContext,
      path: Path,
      schema: MapSchema,
      item: (key: string) => A,
    ): A {
      const result = base.map(ctx, path, schema, item) as any

      Object.defineProperty(result, "set", {
        value: (key: string, value: unknown): void => {
          const change = mapChange({ [key]: value })
          if (INVALIDATE in result) result[INVALIDATE](change)
          ctx.dispatch(path, change)
        },
        enumerable: false,
        configurable: true,
      })

      Object.defineProperty(result, "delete", {
        value: (key: string): void => {
          const change = mapChange(undefined, [key])
          if (INVALIDATE in result) result[INVALIDATE](change)
          ctx.dispatch(path, change)
        },
        enumerable: false,
        configurable: true,
      })

      Object.defineProperty(result, "clear", {
        value: (): void => {
          const obj = readByPath(ctx.store, path)
          if (obj !== null && obj !== undefined && typeof obj === "object") {
            const allKeys = Object.keys(obj as Record<string, unknown>)
            if (allKeys.length > 0) {
              const change = mapChange(undefined, allKeys)
              if (INVALIDATE in result) result[INVALIDATE](change)
              ctx.dispatch(path, change)
            }
          }
        },
        enumerable: false,
        configurable: true,
      })

      attachTransact(result, ctx)
      return result
    },

    // --- Sum ------------------------------------------------------------------
    // Pure structural dispatch — pass through.

    sum(
      ctx: WritableContext,
      path: Path,
      schema: SumSchema,
      variants: SumVariants<A>,
    ): A {
      return base.sum(ctx, path, schema, variants)
    },

    // --- Annotated ------------------------------------------------------------
    // Dispatch on tag to add mutation methods to leaf annotation refs.
    // Delegating annotations ("doc", "movable", "tree") pass through.

    annotated(
      ctx: WritableContext,
      path: Path,
      schema: AnnotatedSchema,
      inner: (() => A) | undefined,
    ): A {
      const result = base.annotated(ctx, path, schema, inner) as any

      switch (schema.tag) {
        case "text": {
          result.insert = (index: number, content: string): void => {
            ctx.dispatch(
              path,
              textChange([
                ...(index > 0 ? [{ retain: index }] : []),
                { insert: content },
              ]),
            )
          }

          result.delete = (index: number, length: number): void => {
            ctx.dispatch(
              path,
              textChange([
                ...(index > 0 ? [{ retain: index }] : []),
                { delete: length },
              ]),
            )
          }

          result.update = (content: string): void => {
            // Read current text length via the callable ref
            const current: string = result()
            ctx.dispatch(
              path,
              textChange([
                ...(current.length > 0
                  ? [{ delete: current.length }]
                  : []),
                { insert: content },
              ]),
            )
          }

          attachTransact(result, ctx)
          return result
        }

        case "counter": {
          result.increment = (n: number = 1): void => {
            ctx.dispatch(path, incrementChange(n))
          }

          result.decrement = (n: number = 1): void => {
            ctx.dispatch(path, incrementChange(-n))
          }

          attachTransact(result, ctx)
          return result
        }

        case "doc":
        case "movable":
        case "tree":
          // Delegating annotations — inner was already called by the base
          // interpreter, and the result carries the base's interpretation.
          // withWritable's own cases (product, sequence, etc.) already
          // attached mutation methods to the children during recursion.
          // [TRANSACT] is already attached by the inner case (product,
          // sequence, etc.) — no need to attach again.
          return result

        default:
          // Unknown annotation — if the base delegated to inner or
          // produced a scalar-like ref, add .set() for unannotated scalars.
          if (inner !== undefined) {
            return result
          }
          // Leaf annotation without known semantics — add scalar mutation
          return this.scalar(ctx, path, {
            _kind: "scalar" as const,
            scalarKind: "any" as ScalarKind,
          })
      }
    },
  }
}
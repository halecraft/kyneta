// Writable interpreter layer — mutation methods composed onto readable refs.
//
// This module provides:
// 1. WritableContext (extends RefContext with dispatch + transactions)
// 2. CONTEXT symbol — composability hook for discovering a ref's context
// 3. Mutation-only ref interfaces: ScalarRef, TextRef, CounterRef, SequenceRef
// 4. withMutation(base) — interpreter transformer that adds mutation methods
// 5. Writable<S> type-level interpretation
//
// Shared types used across interpreters (RefContext, Plain<S>) live in
// `../interpreter-types.ts` and are re-exported here for backward compat.
//
// The readable interpreter (`readableInterpreter`) owns reading + structural
// navigation. This module owns mutation. Observation is owned by the
// changefeed layer. The three compose:
//
//   withCompositionalChangefeed(withMutation(readableInterpreter))
//
// See theory §5.4 (capability decomposition) and readable-interpreter.md.

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
} from "./readable.js"
import type { RefContext, Plain } from "../interpreter-types.js"

// Re-export store utilities for backward compatibility
export { type Store, readByPath, writeByPath, applyChangeToStore } from "../store.js"

// Re-export shared types for backward compatibility
export type { RefContext, Plain } from "../interpreter-types.js"

// ---------------------------------------------------------------------------
// CONTEXT symbol — composability hook for discovering a ref's context
// ---------------------------------------------------------------------------

/**
 * Symbol that refs carry to expose their originating `WritableContext`.
 * This enables `change()` and other utilities to discover the context
 * from any ref without a WeakMap or re-interpretation.
 *
 * Follows the same pattern as `INVALIDATE` in `readable.ts` — a
 * composability hook defined in the layer that owns the concept.
 *
 * Uses `Symbol.for` so multiple copies share the same identity.
 */
export const CONTEXT: unique symbol = Symbol.for("kyneta:context") as any

/**
 * An object that carries a `[CONTEXT]` symbol referencing the
 * `WritableContext` used during interpretation.
 */
export interface HasContext {
  readonly [CONTEXT]: WritableContext
}

/**
 * Returns `true` if `value` has a `[CONTEXT]` symbol property.
 */
export function hasContext(value: unknown): value is HasContext {
  return (
    value !== null &&
    value !== undefined &&
    (typeof value === "object" || typeof value === "function") &&
    CONTEXT in (value as object)
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
 * const doc = interpret(schema, withMutation(readableInterpreter), ctx)
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
 * Mutation-only interface for product refs. Added by `withMutation`.
 * Enables atomic replacement of an entire struct subtree in one change.
 */
export interface ProductRef<T = unknown> {
  set(value: T): void
}

/**
 * Mutation-only interface for map refs. Added by `withMutation`.
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
 * At runtime, `withMutation(readableInterpreter)` produces refs that
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
// withMutation — interpreter transformer
// ---------------------------------------------------------------------------

/**
 * An interpreter transformer that adds mutation methods to any
 * ref-producing interpreter. Takes an `Interpreter<RefContext, A>` and
 * returns an `Interpreter<WritableContext, A>`.
 *
 * The base interpreter's cases receive a `WritableContext` (which extends
 * `RefContext`), so they work unchanged. `withMutation` adds mutation
 * methods at leaf and collection cases, and passes through for purely
 * structural cases (product, sum).
 *
 * **Cache invalidation:** After dispatching mutation changes,
 * `withMutation` calls `result[INVALIDATE](key?)` on the base's
 * sequence/map refs to keep child caches consistent.
 *
 * ```ts
 * const interp = withMutation(readableInterpreter)
 * const ctx = createWritableContext(store)
 * const doc = interpret(schema, interp, ctx)
 * doc.title.insert(0, "Hello")   // mutation via withMutation
 * doc.title()                    // "Hello" via readableInterpreter
 * ```
 */
export function withMutation(
  base: Interpreter<RefContext, unknown>,
): Interpreter<WritableContext, unknown> {
  return {
    // --- Scalar ---------------------------------------------------------------
    // Add .set() to the base scalar ref.
    // Every node dispatches at its own path — no upward reference.

    scalar(
      ctx: WritableContext,
      path: Path,
      schema: ScalarSchema,
    ): unknown {
      const result = base.scalar(ctx, path, schema) as any

      result.set = (value: unknown): void => {
        ctx.dispatch(path, replaceChange(value))
      }

      return result
    },

    // --- Product --------------------------------------------------------------
    // Add .set(plainObject) for atomic subtree replacement.

    product(
      ctx: WritableContext,
      path: Path,
      schema: ProductSchema,
      fields: Readonly<Record<string, () => unknown>>,
    ): unknown {
      const result = base.product(ctx, path, schema, fields) as any

      Object.defineProperty(result, "set", {
        value: (value: unknown): void => {
          ctx.dispatch(path, replaceChange(value))
        },
        enumerable: false,
        configurable: true,
      })

      return result
    },

    // --- Sequence -------------------------------------------------------------
    // Add .push(), .insert(), .delete() to the base sequence ref.
    // Call [INVALIDATE] after each mutation to keep caches consistent.

    sequence(
      ctx: WritableContext,
      path: Path,
      schema: SequenceSchema,
      item: (index: number) => unknown,
    ): unknown {
      const result = base.sequence(ctx, path, schema, item) as any

      result.push = (...items: unknown[]): void => {
        const arr = readByPath(ctx.store, path)
        const length = Array.isArray(arr) ? arr.length : 0
        ctx.dispatch(
          path,
          sequenceChange([{ retain: length }, { insert: items }]),
        )
        result[INVALIDATE]()
      }

      result.insert = (index: number, ...items: unknown[]): void => {
        ctx.dispatch(
          path,
          sequenceChange([
            ...(index > 0 ? [{ retain: index }] : []),
            { insert: items },
          ]),
        )
        result[INVALIDATE]()
      }

      result.delete = (index: number, count: number = 1): void => {
        ctx.dispatch(
          path,
          sequenceChange([
            ...(index > 0 ? [{ retain: index }] : []),
            { delete: count },
          ]),
        )
        result[INVALIDATE]()
      }

      return result
    },

    // --- Map ------------------------------------------------------------------
    // Attach .set(), .delete(), .clear() directly to the base map ref.
    // No Proxy, no SET_HANDLER/DELETE_HANDLER — methods are first-class.

    map(
      ctx: WritableContext,
      path: Path,
      schema: MapSchema,
      item: (key: string) => unknown,
    ): unknown {
      const result = base.map(ctx, path, schema, item) as any

      Object.defineProperty(result, "set", {
        value: (key: string, value: unknown): void => {
          ctx.dispatch(path, mapChange({ [key]: value }))
          result[INVALIDATE](key)
        },
        enumerable: false,
        configurable: true,
      })

      Object.defineProperty(result, "delete", {
        value: (key: string): void => {
          ctx.dispatch(path, mapChange(undefined, [key]))
          result[INVALIDATE](key)
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
              ctx.dispatch(path, mapChange(undefined, allKeys))
            }
          }
          result[INVALIDATE]()
        },
        enumerable: false,
        configurable: true,
      })

      return result
    },

    // --- Sum ------------------------------------------------------------------
    // Pure structural dispatch — pass through.

    sum(
      ctx: WritableContext,
      path: Path,
      schema: SumSchema,
      variants: SumVariants<unknown>,
    ): unknown {
      return base.sum(ctx, path, schema, variants)
    },

    // --- Annotated ------------------------------------------------------------
    // Dispatch on tag to add mutation methods to leaf annotation refs.
    // Delegating annotations ("doc", "movable", "tree") pass through.

    annotated(
      ctx: WritableContext,
      path: Path,
      schema: AnnotatedSchema,
      inner: (() => unknown) | undefined,
    ): unknown {
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

          return result
        }

        case "counter": {
          result.increment = (n: number = 1): void => {
            ctx.dispatch(path, incrementChange(n))
          }

          result.decrement = (n: number = 1): void => {
            ctx.dispatch(path, incrementChange(-n))
          }

          return result
        }

        case "doc":
        case "movable":
        case "tree":
          // Delegating annotations — inner was already called by the base
          // interpreter, and the result carries the base's interpretation.
          // withMutation's own cases (product, sequence, etc.) already
          // attached mutation methods to the children during recursion.
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
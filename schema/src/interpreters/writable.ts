// Writable interpreter layer — mutation methods composed onto readable refs.
//
// This module provides:
// 1. Context types: RefContext (read-only), WritableContext (read + write)
// 2. Mutation-only ref interfaces: ScalarRef, TextRef, CounterRef, SequenceRef
// 3. withMutation(base) — interpreter transformer that adds mutation methods
// 4. Plain<S> and Writable<S> type-level interpretations
//
// The readable interpreter (`readableInterpreter`) owns reading + structural
// navigation. This module owns mutation. Observation is owned by
// `withChangefeed`. The three compose:
//
//   enrich(withMutation(readableInterpreter), withChangefeed)
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
  SET_HANDLER,
  DELETE_HANDLER,
} from "./readable.js"

// Re-export store utilities for backward compatibility
export { type Store, readByPath, writeByPath, applyChangeToStore } from "../store.js"

// ---------------------------------------------------------------------------
// RefContext — minimal context for read-only interpretation
// ---------------------------------------------------------------------------

/**
 * The minimal context for read-only interpretation. Contains only a
 * store — enough to read values at any path.
 *
 * This is the base context type. `WritableContext` extends it with
 * dispatch and batching. `ChangefeedContext` extends further with
 * subscriber maps. Each layer adds only what it needs.
 */
export interface RefContext {
  readonly store: Store
}

// ---------------------------------------------------------------------------
// WritableContext — shared state flowing through the tree
// ---------------------------------------------------------------------------

/**
 * The context shared across the entire interpreted tree. Extends
 * `RefContext` with mutation infrastructure.
 *
 * Unlike the catamorphism's `path` parameter (which narrows
 * automatically), the context carries resources that are the *same*
 * at every level:
 *
 * - `store` — the root mutable store object (from `RefContext`)
 * - `dispatch` — sends a change to the store (applies via step)
 * - `autoCommit` — if true, each mutation dispatches immediately;
 *   if false, changes accumulate in `pending` until flushed
 * - `pending` — accumulated changes in batched mode (shared by reference)
 *
 * The "where am I" information comes from the catamorphism's `path`
 * parameter, not from the context. This means the context doesn't need
 * to be re-derived at each level — it's the same object throughout.
 *
 * **No observation infrastructure here.** Subscriber notification is
 * provided by the changefeed layer (`createChangefeedContext`) which wraps
 * `dispatch` to add notification after each change is applied.
 */
export interface WritableContext extends RefContext {
  readonly dispatch: (path: Path, change: ChangeBase) => void
  readonly autoCommit: boolean
  readonly pending: PendingChange[]
}

export interface PendingChange {
  readonly path: Path
  readonly change: ChangeBase
}

// ---------------------------------------------------------------------------
// createWritableContext — factory for the root context
// ---------------------------------------------------------------------------

export interface WritableOptions {
  autoCommit?: boolean
}

/**
 * Creates a root WritableContext for a given store.
 *
 * Dispatch only applies changes to the store — no subscriber
 * notification. For observation, wrap with `createChangefeedContext`.
 *
 * ```ts
 * const store = { title: "", count: 0, items: [] }
 * const ctx = createWritableContext(store)
 * const doc = interpret(schema, withMutation(readableInterpreter), ctx)
 * ```
 */
export function createWritableContext(
  store: Store,
  options: WritableOptions = {},
): WritableContext {
  const autoCommit = options.autoCommit ?? true
  const pending: PendingChange[] = []

  const dispatch = (path: Path, change: ChangeBase): void => {
    if (autoCommit) {
      applyChangeToStore(store, path, change)
    } else {
      pending.push({ path, change })
    }
  }

  return {
    store,
    dispatch,
    autoCommit,
    pending,
  }
}

/**
 * Flushes all pending changes in a batched context.
 * Applies each change to the store but does NOT notify subscribers.
 * For notification, use the feedable context's flush wrapper.
 *
 * Returns the list of changes that were flushed.
 */
export function flush(ctx: WritableContext): PendingChange[] {
  const flushed = [...ctx.pending]
  for (const { path, change } of flushed) {
    applyChangeToStore(ctx.store, path, change)
  }
  ctx.pending.length = 0
  return flushed
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

// ---------------------------------------------------------------------------
// Type-level interpretations — schema type → TypeScript type
// ---------------------------------------------------------------------------

// ScalarPlain is re-exported from schema.ts (the canonical definition).
// It maps ScalarKind literals to their corresponding TypeScript types.
export type { ScalarPlain } from "../schema.js"

// ---------------------------------------------------------------------------
// Plain<S> — type-level interpretation from schema type to plain JS type
// ---------------------------------------------------------------------------

/**
 * Computes the plain JavaScript/JSON type for a given schema type.
 *
 * This is the type-level counterpart to `Writable<S>`: where `Writable`
 * maps schema nodes to ref types (TextRef, CounterRef, etc.), `Plain`
 * maps them to bare JavaScript values (string, number, arrays, objects).
 *
 * Use `Plain<S>` for `toJSON()` return types, serialization boundaries,
 * snapshot types, and anywhere you need the "just data" shape of a schema.
 *
 * ```ts
 * const s = Schema.doc({
 *   title: Schema.string(),
 *   count: Schema.number(),
 *   items: Schema.list(Schema.struct({
 *     name: Schema.string(),
 *     done: Schema.boolean(),
 *   })),
 *   settings: Schema.struct({
 *     darkMode: Schema.boolean(),
 *   }),
 *   metadata: Schema.record(Schema.any()),
 * })
 *
 * type Doc = Plain<typeof s>
 * // = {
 * //     title: string
 * //     count: number
 * //     items: { name: string; done: boolean }[]
 * //     settings: { darkMode: boolean }
 * //     metadata: { [key: string]: unknown }
 * //   }
 * ```
 */
export type Plain<S extends Schema> =
  // --- Annotated: dispatch on tag ---
  S extends AnnotatedSchema<infer Tag, infer Inner>
    ? Tag extends "text"
      ? string
      : Tag extends "counter"
        ? number
        : Tag extends "doc"
          ? Inner extends ProductSchema<infer F>
            ? { [K in keyof F]: Plain<F[K]> }
            : unknown
          : Tag extends "movable"
            ? Inner extends SequenceSchema<infer I>
              ? Plain<I>[]
              : unknown
            : Tag extends "tree"
              ? Inner extends Schema
                ? Plain<Inner>
                : unknown
              : // Unknown annotation with inner — delegate
                Inner extends Schema
                ? Plain<Inner>
                : unknown
    : // --- Scalar ---
      S extends ScalarSchema<infer _K, infer V>
      ? V
      : // --- Product ---
        S extends ProductSchema<infer F>
        ? { [K in keyof F]: Plain<F[K]> }
        : // --- Sequence ---
          S extends SequenceSchema<infer I>
          ? Plain<I>[]
          : // --- Map ---
            S extends MapSchema<infer I>
            ? { [key: string]: Plain<I> }
            : // --- Sum ---
              S extends PositionalSumSchema<infer V>
              ? Plain<V[number]>
              : S extends DiscriminatedSumSchema<infer D, infer M>
                ? { [K in keyof M]: Plain<M[K]> & { [_ in D]: K } }[keyof M]
                : unknown

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
            ? { readonly [K in keyof F]: Writable<F[K]> }
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
        ? { readonly [K in keyof F]: Writable<F[K]> }
        : // --- Sequence ---
          S extends SequenceSchema<infer I>
          ? SequenceRef<Writable<I>>
          : // --- Map ---
            S extends MapSchema<infer I>
            ? { readonly [key: string]: Writable<I> }
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

    scalar(
      ctx: WritableContext,
      path: Path,
      schema: ScalarSchema,
    ): unknown {
      const result = base.scalar(ctx, path, schema) as any

      const parentPath = path.slice(0, -1)
      const lastSeg = path[path.length - 1]
      const key =
        lastSeg !== undefined
          ? lastSeg.type === "key"
            ? lastSeg.key
            : String(lastSeg.index)
          : undefined

      result.set = (value: unknown): void => {
        if (key !== undefined) {
          // Upward reference: dispatch MapChange to parent
          ctx.dispatch(parentPath, mapChange({ [key]: value }))
        } else {
          // Root scalar — use replace
          ctx.dispatch(path, replaceChange(value))
        }
      }

      return result
    },

    // --- Product --------------------------------------------------------------
    // Pure structural — pass through. Products have no mutation methods.

    product(
      ctx: WritableContext,
      path: Path,
      schema: ProductSchema,
      fields: Readonly<Record<string, () => unknown>>,
    ): unknown {
      return base.product(ctx, path, schema, fields)
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
    // Fill [SET_HANDLER] and [DELETE_HANDLER] on the base map Proxy so that
    // `proxy.key = value` and `delete proxy.key` dispatch changes.

    map(
      ctx: WritableContext,
      path: Path,
      schema: MapSchema,
      item: (key: string) => unknown,
    ): unknown {
      const result = base.map(ctx, path, schema, item)

      // Fill mutation handlers via defineProperty (goes through the Proxy's
      // defineProperty trap, which forwards symbol keys to the target).
      Object.defineProperty(result, SET_HANDLER, {
        value: (prop: string, value: unknown): boolean => {
          ctx.dispatch(path, mapChange({ [prop]: value }))
          ;(result as any)[INVALIDATE](prop)
          return true
        },
        configurable: true,
      })

      Object.defineProperty(result, DELETE_HANDLER, {
        value: (prop: string): boolean => {
          ctx.dispatch(path, mapChange(undefined, [prop]))
          ;(result as any)[INVALIDATE](prop)
          return true
        },
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
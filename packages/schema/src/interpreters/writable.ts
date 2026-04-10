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
// Cache invalidation is handled by the prepare pipeline — withCaching
// hooks ctx.prepare to invalidate caches at the target path before store
// mutation. Mutation methods simply construct the change and dispatch.
//
// See .plans/interpreter-decomposition.md §Phase 4.
// See .plans/apply-changes.md §Phase 4.

import type { Op } from "../changefeed.js"
import type { Interpreter, Path, SumVariants } from "../interpret.js"

export type { Op }

import type { ChangeBase } from "../change.js"
import {
  incrementChange,
  mapChange,
  replaceChange,
  sequenceChange,
  textChange,
} from "../change.js"
import type { Plain, RefContext } from "../interpreter-types.js"
import type {
  CounterSchema,
  DiscriminatedSumSchema,
  MapSchema,
  MovableSequenceSchema,
  PositionalSumSchema,
  ProductSchema,
  ScalarSchema,
  Schema,
  SequenceSchema,
  SetSchema,
  SumSchema,
  TextSchema,
  TreeSchema,
} from "../schema.js"
import type { SubstratePrepare } from "../substrate.js"

// ---------------------------------------------------------------------------
// WritableDiscriminantProductRef — hybrid product ref for discriminated unions
// ---------------------------------------------------------------------------

/**
 * Produces a hybrid writable product ref where the discriminant field `D`
 * resolves to its `Plain<S>` value (a raw string literal), while all other
 * fields remain full recursive `Writable<S>` refs.
 *
 * Enables standard TypeScript discriminated union narrowing on writable refs.
 * The discriminant field has no `.set()` — preventing store corruption from
 * mutating the discriminant independently of the variant structure.
 */
type WritableDiscriminantProductRef<
  F extends Record<string, Schema>,
  D extends string,
> = {
  readonly [K in keyof F]: K extends D ? Plain<F[K]> : Writable<F[K]>
} & ProductRef<{ [K in keyof F]: Plain<F[K]> }>

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
 * - `prepare` — apply a single change (invalidate caches + mutate store).
 *   No notification. Must not be called during an active transaction.
 * - `flush` — deliver accumulated notifications as a single Changeset
 *   per subscriber. Must not be called during an active transaction.
 * - `dispatch` — convenience: outside a transaction calls `executeBatch`
 *   with one change; during a transaction buffers the change.
 * - `beginTransaction` / `commit` / `abort` — transaction lifecycle
 *
 * The dispatch pipeline is phase-separated:
 * - `prepare` is called N times (once per change in a batch)
 * - `flush` is called once after all prepares complete
 * - `executeBatch` composes these: prepare × N + flush × 1
 *
 * Layers like `withChangefeed` wrap `prepare` to accumulate notification
 * entries and wrap `flush` to deliver `Changeset` batches. Layers like
 * `withCaching` (future) wrap `prepare` to invalidate caches at the
 * target path before store mutation.
 *
 * The "where am I" information comes from the catamorphism's `path`
 * parameter, not from the context. This means the context doesn't need
 * to be re-derived at each level — it's the same object throughout.
 */
export interface WritableContext extends RefContext {
  /** Apply a single change: invalidate caches + mutate store. No notification.
   *  Mutable — caching and changefeed layers wrap this at interpretation time. */
  prepare: (path: Path, change: ChangeBase) => void
  /** Deliver accumulated notifications as a single Changeset per subscriber.
   *  Mutable — the changefeed layer wraps this at interpretation time. */
  flush: (origin?: string) => void
  /** Convenience: outside a transaction, calls executeBatch with one change.
   *  During a transaction, buffers the change for later commit. */
  readonly dispatch: (path: Path, change: ChangeBase) => void
  /** Enter a transaction — dispatch buffers until commit/abort. */
  beginTransaction(): void
  /** Apply buffered changes via executeBatch, return the list.
   *  Accepts an optional origin for the emitted Changeset. */
  commit(origin?: string): Op[]
  /** Discard buffered changes without applying. */
  abort(): void
  readonly inTransaction: boolean
}

// ---------------------------------------------------------------------------
// executeBatch — the single primitive for phase-separated dispatch
// ---------------------------------------------------------------------------

/**
 * The single primitive that composes `prepare` and `flush`.
 *
 * Calls `ctx.prepare(path, change)` for each change in the batch
 * (invalidate caches + mutate store + accumulate notification entries),
 * then calls `ctx.flush(origin)` once to deliver all accumulated
 * notifications as a single `Changeset` per subscriber.
 *
 * **Invariant:** Must not be called while `ctx.inTransaction` is true.
 * Doing so would mutate the store while the transaction expects it
 * unchanged. This guard prevents `applyChanges` from corrupting a
 * half-built transaction.
 *
 * All entry points collapse to this primitive:
 * - `dispatch(path, change)` = `executeBatch(ctx, [{ path, change }])`
 * - `commit(origin?)` = copy+clear buffer, end transaction, `executeBatch`
 * - `applyChanges(ref, ops, { origin })` = `executeBatch(ctx, ops, origin)`
 */
export function executeBatch(
  ctx: WritableContext,
  changes: readonly Op[],
  origin?: string,
): void {
  if (ctx.inTransaction) {
    throw new Error(
      "executeBatch must not be called during an active transaction. " +
        "Commit or abort the transaction first.",
    )
  }
  for (const { path, change } of changes) {
    ctx.prepare(path, change)
  }
  ctx.flush(origin)
}

// ---------------------------------------------------------------------------
// buildWritableContext — shared builder for substrate factories
// ---------------------------------------------------------------------------

/**
 * Builds a WritableContext around a substrate's mutation primitives.
 *
 * The substrate provides the ground floor of the prepare/flush pipeline:
 * - `substrate.prepare(path, change)` — apply change to backing state
 * - `substrate.onFlush(origin?)` — called after all prepares + notification
 *   delivery (no-op for PlainSubstrate; version tracking in Phase 2)
 *
 * The context adds transaction coordination on top:
 * - `dispatch(path, change)` — auto-commit or buffer
 * - `beginTransaction()` / `commit()` / `abort()` — transaction lifecycle
 * - `executeBatch(ctx, changes, origin?)` — prepare × N + flush × 1
 *
 * Caching and changefeed layers wrap `ctx.prepare` and `ctx.flush` at
 * interpretation time — the substrate never needs to know about them.
 *
 * ```ts
 * const substrate = createPlainSubstrate(store)
 * const ctx = buildWritableContext(substrate)
 * const doc = interpret(schema, ctx).with(readable).with(writable).done()
 * ```
 */
export function buildWritableContext(
  substrate: SubstratePrepare,
): WritableContext {
  const pending: Op[] = []
  let inTransaction = false

  // Base prepare: delegate to the substrate.
  // Layers like withChangefeed wrap this to accumulate notification
  // entries; layers like withCaching wrap this to invalidate
  // caches at the target path.
  const prepare = (path: Path, change: ChangeBase): void => {
    substrate.prepare(path, change)
  }

  // Base flush: delegate to the substrate's onFlush.
  // The changefeed layer wraps this to deliver accumulated Changeset
  // batches to subscribers before calling through to the substrate.
  const flush = (_origin?: string): void => {
    substrate.onFlush(_origin)
  }

  // Dispatch is transaction-aware:
  // - Outside a transaction (auto-commit): calls executeBatch with one
  //   change, which calls prepare + flush. Subscribers see a degenerate
  //   Changeset of one change.
  // - During a transaction: buffers the {path, change} pair. The store
  //   is unchanged; caches are unchanged; subscribers are silent.
  const dispatch = (path: Path, change: ChangeBase): void => {
    if (inTransaction) {
      pending.push({ path, change })
    } else {
      // Auto-commit: use executeBatch via the ctx object so that
      // layers that wrapped prepare/flush are invoked.
      executeBatch(ctx, [{ path, change }])
    }
  }

  const beginTransaction = (): void => {
    if (inTransaction) {
      throw new Error(
        "Already in a transaction (nested transactions are not supported)",
      )
    }
    inTransaction = true
  }

  // Commit: copy+clear the pending buffer, end the transaction,
  // then apply all changes via executeBatch. This ensures:
  // - prepare is called N times (store mutation + notification accumulation)
  // - flush is called once (deliver Changeset batch to subscribers)
  // The transaction must be ended BEFORE executeBatch because
  // executeBatch guards against being called during a transaction.
  const commit = (origin?: string): Op[] => {
    if (!inTransaction) {
      throw new Error("No active transaction to commit")
    }
    const flushed = [...pending]
    pending.length = 0
    inTransaction = false

    executeBatch(ctx, flushed, origin)

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
    reader: substrate.reader,
    prepare,
    flush,
    dispatch,
    beginTransaction,
    commit,
    abort,
    get inTransaction() {
      return inTransaction
    },
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

/**
 * Mutation-only interface for sequence refs. Added by `withWritable`.
 *
 * Navigation (`.at()`, `.length`, `[Symbol.iterator]`) lives in
 * `NavigableSequenceRef` (from the navigation layer). Reading (call
 * signature, `.get()`) lives in `ReadableSequenceRef`. This interface
 * provides only mutation: `.push()`, `.insert()`, `.delete()`.
 *
 * No type parameter — mutation methods take plain values (`unknown`),
 * not child refs. The unified `Ref<S>` type intersects this with
 * `ReadableSequenceRef<Ref<I>, Plain<I>>` to get the full surface.
 */
export interface SequenceRef {
  push: (...items: unknown[]) => void
  insert: (index: number, ...items: unknown[]) => void
  delete: (index: number, count?: number) => void
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
 * const s = Schema.struct({
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
  // --- First-class leaf types ---
  S extends TextSchema
    ? TextRef
    : S extends CounterSchema
      ? CounterRef
      : // --- First-class container types ---
        S extends SetSchema<infer I>
        ? WritableMapRef<Plain<I>>
        : S extends TreeSchema<infer Inner>
          ? Writable<Inner>
          : S extends MovableSequenceSchema<infer _I>
            ? SequenceRef
            : // --- Scalar ---
              S extends ScalarSchema<infer _K, infer V>
              ? ScalarRef<V>
              : // --- Product ---
                S extends ProductSchema<infer F>
                ? { readonly [K in keyof F]: Writable<F[K]> } & ProductRef<{
                    [K in keyof F]: Plain<F[K]>
                  }>
                : // --- Sequence ---
                  S extends SequenceSchema<infer _I>
                  ? SequenceRef
                  : // --- Map ---
                    S extends MapSchema<infer I>
                    ? WritableMapRef<Plain<I>>
                    : // --- Sum ---
                      S extends PositionalSumSchema<infer V>
                      ? V extends readonly [
                          ScalarSchema<"null", any>,
                          infer Inner extends Schema,
                        ]
                        ? ScalarRef<Plain<Inner> | null>
                        : Writable<V[number]>
                      : S extends DiscriminatedSumSchema<infer D, infer V>
                        ? WritableDiscriminantProductRef<V[number]["fields"], D>
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
 * Mutation methods construct the appropriate change and call
 * `ctx.dispatch(path, change)`. Cache invalidation is handled by the
 * `prepare` pipeline — `withCaching` hooks `ctx.prepare` to fire
 * per-path invalidation handlers before store mutation. This means
 * every change source (imperative mutation, `applyChanges`, etc.)
 * gets automatic cache invalidation without manual `[INVALIDATE]` calls.
 *
 * ```ts
 * const interp = withWritable(withCaching(withReadable(bottomInterpreter)))
 * const ctx = createPlainSubstrate(store).context()
 * const doc = interpret(schema, interp, ctx)
 * doc.title.insert(0, "Hello")   // mutation via withWritable
 * doc.title()                    // "Hello" via withReadable
 * ```
 */
export function withWritable<A>(
  base: Interpreter<RefContext, A>,
): Interpreter<WritableContext, A & HasTransact> {
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
    ): A & HasTransact {
      const result = base.scalar(ctx, path, schema) as any

      result.set = (value: unknown): void => {
        const change = replaceChange(value)
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
    ): A & HasTransact {
      const result = base.product(ctx, path, schema, fields) as any

      Object.defineProperty(result, "set", {
        value: (value: unknown): void => {
          const change = replaceChange(value)
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

    sequence(
      ctx: WritableContext,
      path: Path,
      schema: SequenceSchema,
      item: (index: number) => A,
    ): A & HasTransact {
      const result = base.sequence(ctx, path, schema, item) as any

      result.push = (...items: unknown[]): void => {
        const length = ctx.reader.arrayLength(path)
        const change = sequenceChange([{ retain: length }, { insert: items }])
        ctx.dispatch(path, change)
      }

      result.insert = (index: number, ...items: unknown[]): void => {
        const change = sequenceChange([
          ...(index > 0 ? [{ retain: index }] : []),
          { insert: items },
        ])
        ctx.dispatch(path, change)
      }

      result.delete = (index: number, count: number = 1): void => {
        const change = sequenceChange([
          ...(index > 0 ? [{ retain: index }] : []),
          { delete: count },
        ])
        ctx.dispatch(path, change)
      }

      attachTransact(result, ctx)
      return result
    },

    // --- Map ------------------------------------------------------------------
    // Attach .set(), .delete(), .clear() directly to the base map ref.

    map(
      ctx: WritableContext,
      path: Path,
      schema: MapSchema,
      item: (key: string) => A,
    ): A & HasTransact {
      const result = base.map(ctx, path, schema, item) as any

      Object.defineProperty(result, "set", {
        value: (key: string, value: unknown): void => {
          const change = mapChange({ [key]: value })
          ctx.dispatch(path, change)
        },
        enumerable: false,
        configurable: true,
      })

      Object.defineProperty(result, "delete", {
        value: (key: string): void => {
          const change = mapChange(undefined, [key])
          ctx.dispatch(path, change)
        },
        enumerable: false,
        configurable: true,
      })

      Object.defineProperty(result, "clear", {
        value: (): void => {
          const allKeys = ctx.reader.keys(path)
          if (allKeys.length > 0) {
            const change = mapChange(undefined, allKeys)
            ctx.dispatch(path, change)
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
    ): A & HasTransact {
      // Sum nodes are structurally transparent — the catamorphism dispatches
      // variants through the full interpreter, so the resolved variant already
      // has HasTransact attached. The base.sum() return type is A (without
      // HasTransact) because the base interpreter doesn't know about our layer.
      return base.sum(ctx, path, schema, variants) as A & HasTransact
    },

    // --- Text -----------------------------------------------------------------
    // Add insert/delete/update mutation methods.

    text(
      ctx: WritableContext,
      path: Path,
      schema: TextSchema,
    ): A & HasTransact {
      const result = base.text(ctx, path, schema) as any

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
        // Read current text length via store inspection (not carrier call)
        // so navigate+write stacks work without a reading layer.
        const current = ctx.reader.read(path)
        const currentLength = typeof current === "string" ? current.length : 0
        ctx.dispatch(
          path,
          textChange([
            ...(currentLength > 0 ? [{ delete: currentLength }] : []),
            { insert: content },
          ]),
        )
      }

      attachTransact(result, ctx)
      return result
    },

    // --- Counter --------------------------------------------------------------
    // Add increment/decrement mutation methods.

    counter(
      ctx: WritableContext,
      path: Path,
      schema: CounterSchema,
    ): A & HasTransact {
      const result = base.counter(ctx, path, schema) as any

      result.increment = (n: number = 1): void => {
        ctx.dispatch(path, incrementChange(n))
      }

      result.decrement = (n: number = 1): void => {
        ctx.dispatch(path, incrementChange(-n))
      }

      attachTransact(result, ctx)
      return result
    },

    // --- Set ------------------------------------------------------------------
    // Delegate like map — attach .set(), .delete(), .clear().

    set(
      ctx: WritableContext,
      path: Path,
      schema: SetSchema,
      item: (key: string) => A,
    ): A & HasTransact {
      const result = base.set(ctx, path, schema, item) as any

      Object.defineProperty(result, "set", {
        value: (key: string, value: unknown): void => {
          const change = mapChange({ [key]: value })
          ctx.dispatch(path, change)
        },
        enumerable: false,
        configurable: true,
      })

      Object.defineProperty(result, "delete", {
        value: (key: string): void => {
          const change = mapChange(undefined, [key])
          ctx.dispatch(path, change)
        },
        enumerable: false,
        configurable: true,
      })

      Object.defineProperty(result, "clear", {
        value: (): void => {
          const allKeys = ctx.reader.keys(path)
          if (allKeys.length > 0) {
            const change = mapChange(undefined, allKeys)
            ctx.dispatch(path, change)
          }
        },
        enumerable: false,
        configurable: true,
      })

      attachTransact(result, ctx)
      return result
    },

    // --- Tree -----------------------------------------------------------------
    // Delegate via nodeData() — the inner interpretation already has
    // mutation methods attached by recursion through withWritable.

    tree(
      ctx: WritableContext,
      path: Path,
      schema: TreeSchema,
      nodeData: () => A,
    ): A & HasTransact {
      const result = base.tree(ctx, path, schema, nodeData)
      // [TRANSACT] is already attached by the inner case (product, etc.)
      return result as A & HasTransact
    },

    // --- Movable --------------------------------------------------------------
    // Delegate like sequence — add .push(), .insert(), .delete().

    movable(
      ctx: WritableContext,
      path: Path,
      schema: MovableSequenceSchema,
      item: (index: number) => A,
    ): A & HasTransact {
      const result = base.movable(ctx, path, schema, item) as any

      result.push = (...items: unknown[]): void => {
        const length = ctx.reader.arrayLength(path)
        const change = sequenceChange([{ retain: length }, { insert: items }])
        ctx.dispatch(path, change)
      }

      result.insert = (index: number, ...items: unknown[]): void => {
        const change = sequenceChange([
          ...(index > 0 ? [{ retain: index }] : []),
          { insert: items },
        ])
        ctx.dispatch(path, change)
      }

      result.delete = (index: number, count: number = 1): void => {
        const change = sequenceChange([
          ...(index > 0 ? [{ retain: index }] : []),
          { delete: count },
        ])
        ctx.dispatch(path, change)
      }

      attachTransact(result, ctx)
      return result
    },
  }
}

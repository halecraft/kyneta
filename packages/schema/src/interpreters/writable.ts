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

import type { Lease } from "@kyneta/machine"

import type { Op } from "../changefeed.js"
import type {
  FlatTreeNode,
  Interpreter,
  Path,
  SumVariants,
} from "../interpret.js"

export type { Op }

import type { ChangeBase } from "../change.js"
import { incrementChange, replaceChange } from "../change.js"
import type { Plain, RefContext } from "../interpreter-types.js"
import type {
  CounterSchema,
  DiscriminatedSumSchema,
  MapSchema,
  MovableSequenceSchema,
  PositionalSumSchema,
  ProductSchema,
  RichTextSchema,
  ScalarSchema,
  Schema,
  SequenceSchema,
  SetSchema,
  SumSchema,
  TextSchema,
  TreeSchema,
} from "../schema.js"
import type {
  BatchOptions,
  RecordInverseFn,
  SubstratePrepare,
} from "../substrate.js"
import { RECORD_INVERSE } from "../substrate.js"
import { installKeyedWriteOps } from "./keyed-helpers.js"
import {
  installListWriteOps,
  installRichTextWriteOps,
  installTextWriteOps,
} from "./sequence-helpers.js"
import { installSetWriteOps } from "./set-helpers.js"
import { installTreeWriteOps } from "./tree-helpers.js"

// ---------------------------------------------------------------------------
// WritableDiscriminantProductRef — hybrid product ref for discriminated unions
// ---------------------------------------------------------------------------

/**
 * Writable surface for a discriminated union variant.
 *
 * All fields are `Plain<F[K]>` (read-only values); the only write
 * operation is `.set()` for whole-value replacement via `ProductRef`.
 *
 * See `DiscriminantProductRef` in `ref.ts` for the design rationale.
 */
type WritableDiscriminantProductRef<F extends Record<string, Schema>> = {
  readonly [K in keyof F]: Plain<F[K]>
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
// REMOVE — structural self-removal from parent container
// ---------------------------------------------------------------------------

/**
 * Symbol attached to refs that support structural removal from their
 * parent container (sequence element, map entry, set member).
 *
 * Calling `ref[REMOVE]()` dispatches the appropriate delete change
 * at the parent path. Top-level document refs and product field refs
 * do NOT carry this symbol — only "addressable children" of containers.
 *
 * Uses `Symbol.for` so multiple copies share the same identity.
 */
export const REMOVE: unique symbol = Symbol.for("kyneta:remove") as any

/**
 * An object that carries a `[REMOVE]` method for self-removal.
 */
export interface HasRemove {
  [REMOVE](): void
}

/**
 * Returns `true` if `value` has a `[REMOVE]` symbol property.
 */
export function hasRemove(value: unknown): value is HasRemove {
  return (
    value !== null &&
    value !== undefined &&
    (typeof value === "object" || typeof value === "function") &&
    REMOVE in (value as object)
  )
}

// ---------------------------------------------------------------------------
// FORWARD_OPS_* — runWriter / execWriter for the change-Writer monad
// ---------------------------------------------------------------------------

/**
 * Snapshot the current writer-log marker. `change(doc, fn)` calls this
 * before running `fn` to capture a starting position; `FORWARD_OPS_SINCE`
 * with the same marker returns the forward ops added during `fn`.
 *
 * Conceptually `runWriter` for the change-Writer monad: every `prepare`
 * writes one entry to the log (the changefeed accumulator); the marker
 * is just the log length at a moment in time.
 *
 * The accessor is attached to `WritableContext` by the changefeed layer
 * (`with-changefeed.ts`) where the accumulator is in scope. On a
 * read-only stack (no changefeed wrapping), the base implementation
 * returns `0` and `[FORWARD_OPS_SINCE]` returns `[]` — `change()`
 * returns an empty Op[], consistent with "no Changesets are delivered."
 */
export const FORWARD_OPS_MARKER: unique symbol = Symbol.for(
  "kyneta:forward-ops-marker",
) as any

/**
 * Slice the writer log from `marker` to the current length, filtering
 * out entries tagged `compensating: true` (the inverse log). Returns the
 * forward-only Op[].
 *
 * Conceptually `execWriter` (the value side; the result side is `void`
 * for `prepare`). See `FORWARD_OPS_MARKER`.
 */
export const FORWARD_OPS_SINCE: unique symbol = Symbol.for(
  "kyneta:forward-ops-since",
) as any

// ---------------------------------------------------------------------------
// WritableContext — shared state flowing through the tree
// ---------------------------------------------------------------------------

/**
 * The context shared across the entire interpreted tree. Extends
 * `RefContext` with three substrate primitives plus the depth-aware
 * `dispatch` combinator.
 *
 * **The bracket primitive and its three handlers.** `runBatch` is one
 * bracket with three effect handlers (see the plan's "Algebraic framing"
 * subsection — substrate, changefeed-flush, inverse-stack). Inside the
 * bracket, `prepare` is the single effect; the handlers react to it,
 * all keyed off a single depth counter. There are no concentric brackets
 * — there's one, observed three ways.
 *
 * **Three primitives:**
 *
 * - `prepare` — apply a single change to the substrate (advance σ + λ,
 *   record the inverse for compensation). Substrates wrap this at the
 *   bottom; layers like `withCaching` and `withChangefeed` wrap it from
 *   the top to invalidate caches and accumulate notifications. Idempotent
 *   per call.
 * - `flush` — deliver accumulated notifications as a single Changeset
 *   per subscriber. Called exactly once per outermost `runBatch` release
 *   (success path: clean flush; catch path: flush with `aborted: true`).
 *   Replay batches call `flush` directly without entering `runBatch`.
 * - `runBatch` — open a frame; run `work`; on success pop and flush at
 *   depth-0; on throw replay this frame's inverses LIFO, pop, flush
 *   with `aborted: true` at depth-0, rethrow. Inner frames push/pop
 *   without invoking the substrate bracket or flushing — the depth-0
 *   transition is the single delivery point per outermost block.
 *
 * **The `dispatch` combinator.** Helper methods (`scalar.set`,
 * `sequence.push`, etc.) call `ctx.dispatch(path, change)` rather than
 * `ctx.prepare` directly. `dispatch` is depth-aware:
 *
 * - Outside any frame (`frameStarts.length === 0`): opens an implicit
 *   single-op `runBatch` (auto-commit) — subscribers see a degenerate
 *   Changeset of one change.
 * - Inside a frame: forwards to `prepare`. The outer frame owns the
 *   flush boundary, so helpers in a `change()` block collapse into one
 *   Changeset.
 *
 * The "where am I" information comes from the catamorphism's `path`
 * parameter, not from the context. The context doesn't need to be
 * re-derived at each level — it's the same object throughout.
 */
export interface WritableContext extends RefContext {
  /** Apply a single change: substrate-write + inverse-record (under the
   *  normal handler; skipped under the undo-replay handler keyed by
   *  `options.compensating: true`). Mutable — caching and changefeed
   *  layers wrap this at interpretation time. `options` carries batch
   *  metadata (`origin`, `replay`, `compensating`, `aborted`). */
  prepare: (path: Path, change: ChangeBase, options?: BatchOptions) => void
  /** Deliver accumulated notifications as a single Changeset per subscriber.
   *  Called by `runBatch` at the depth-0 release (success or aborted-catch)
   *  and directly by `executeBatch` on replay batches. Mutable — the
   *  changefeed layer wraps this at interpretation time. */
  flush: (options?: BatchOptions) => void
  /**
   * The bracket primitive. Pushes a frame on entry; on `work()` success,
   * pops and (at depth 0) invokes the substrate bracket + `ctx.flush(opts)`;
   * on `work()` throw, replays this frame's recorded inverses LIFO
   * (running the undo-replay handler — `options.compensating: true` on
   * each inverse prepare), pops, and (at depth 0) calls
   * `ctx.flush({ ...opts, aborted: true })`, then rethrows.
   *
   * Inner frames (depth > 0 at entry) push/pop without invoking the
   * substrate bracket and without flushing — the depth-0 transition is
   * the single delivery point per outermost block. This preserves the
   * "one Changeset per outermost `change(doc, fn)` per affected
   * subscriber path" contract.
   */
  readonly runBatch: (work: () => void, options?: BatchOptions) => void
  /** Depth-aware combinator: outside any frame opens an implicit
   *  single-op `runBatch` (auto-commit); inside a frame just calls
   *  `prepare`. Helper methods on refs route through this so multi-helper
   *  blocks collapse into one Changeset. */
  readonly dispatch: (path: Path, change: ChangeBase) => void
  /** `runWriter` for the change-Writer monad — snapshot the current
   *  writer-log marker. Wired by the changefeed layer; base impl returns 0. */
  readonly [FORWARD_OPS_MARKER]: () => number
  /** `execWriter` for the change-Writer monad — slice the writer log
   *  since `marker`, filtering out compensating (inverse) entries.
   *  Wired by the changefeed layer; base impl returns []. */
  readonly [FORWARD_OPS_SINCE]: (marker: number) => Op[]
  /** Optional shared cascade budget. When the changefeed layer wires its
   *  per-context dispatcher in `ensurePrepareWiring`, it threads this lease
   *  through so that cross-doc and tick-induced re-entry across cooperating
   *  dispatchers share one budget. Attached by `createRef({ lease })` before
   *  interpretation runs; absent on standalone substrates, in which case
   *  the dispatcher creates its own private lease. */
  lease?: Lease
}

// ---------------------------------------------------------------------------
// executeBatch — the single primitive for phase-separated dispatch
// ---------------------------------------------------------------------------

/**
 * The single primitive for executing a batch of changes.
 *
 * **Local writes:** opens `ctx.runBatch` around a prepare-loop. The
 * `runBatch` wrapper owns the substrate bracket, the inverse-stack
 * frame, and the depth-0 `ctx.flush` call — `executeBatch` does NOT
 * call `ctx.flush` directly on this path. Nested under an outer
 * `change(doc, fn)` block, this contributes only prepares; the outer
 * frame still owns the flush boundary.
 *
 * **Replay batches** (`options.replay === true`) bypass the substrate
 * bracket AND the `runBatch` wrapper — the native state has already
 * absorbed these ops at the event-bridge call site (Loro: `doc.import`;
 * Yjs: `Y.applyUpdate`), and there is no transaction to nest under.
 * Apply prepares directly and explicitly flush.
 *
 * Entry points:
 * - `dispatch(path, change)` (outside any frame) → opens a single-op `runBatch`
 * - `applyChanges(ref, ops, { origin })` → one `runBatch` for the whole batch
 * - Substrate event bridges → replay-bypass with explicit `flush`
 */
export function executeBatch(
  ctx: WritableContext,
  changes: readonly Op[],
  options?: BatchOptions,
): void {
  if (options?.replay) {
    // Replay-bypass: substrate already absorbed these ops; apply prepares
    // directly and flush. Replay batches are the outermost (and only) frame
    // from the kyneta perspective — never nested under a local-write runBatch.
    for (const { path, change } of changes) {
      ctx.prepare(path, change, options)
    }
    ctx.flush(options)
    return
  }
  // Local write: open ctx.runBatch around the prepare loop. The wrapper
  // owns flush at the outermost depth transition.
  ctx.runBatch(() => {
    for (const { path, change } of changes) {
      ctx.prepare(path, change, options)
    }
  }, options)
}

// ---------------------------------------------------------------------------
// buildWritableContext — shared builder for substrate factories
// ---------------------------------------------------------------------------

/**
 * Builds a WritableContext around a substrate's mutation primitives.
 *
 * The substrate provides the ground floor of the prepare/flush pipeline:
 * - `substrate.prepare(path, change, options?)` — apply change to backing
 *   state; record an inverse on the bracket's frame stack via the
 *   `RECORD_INVERSE` callback threaded through `options`.
 * - `substrate.afterBatch(options?)` — post-batch lifecycle hook (no-op
 *   for PlainSubstrate's local-write path beyond version tracking; CRDT
 *   substrates use it to flush coalescing buffers / rematerialise shadow).
 * - `substrate.runBatch?(body, options?)` — optional transaction-boundary
 *   bracket installed around the prepare-loop for local writes. The ctx
 *   wrapper invokes this **only at the outermost depth transition**;
 *   inner frames manage their own state without re-entering
 *   `substrate.runBatch`. When omitted (PlainSubstrate), the ctx invokes
 *   the body directly.
 *
 * The context wraps these with the bracket primitive and its three
 * handlers (substrate / changefeed-flush / inverse-stack — see the
 * `WritableContext` JSDoc). All three are co-extensive at `frameStarts`
 * depth transitions; `runBatch` is the one wrapper that coordinates them.
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
  // Inverse stack — per-frame ranges of recorded inverses. Each call to
  // ctx.runBatch pushes the current `inverseStack.length` onto frameStarts;
  // every inverse recorded between push and pop belongs to that frame.
  // frameStarts.length IS the canonical depth counter: 0 means "no
  // frame open" (auto-commit territory), 1 means "outermost frame open,"
  // > 1 means "nested re-entry."
  type InverseEntry = { path: Path; inverse: ChangeBase }
  const inverseStack: InverseEntry[] = []
  const frameStarts: number[] = []

  // Writer log for the change-Writer monad. Every `prepare` (under both
  // the normal and undo-replay handlers) appends an entry; `change()`
  // slices the log via FORWARD_OPS_MARKER/SINCE to recover its forward
  // Op[] return value. The log is cleared at the outermost runBatch
  // release (success or aborted) so it doesn't grow without bound.
  //
  // This log is INDEPENDENT of the with-changefeed accumulator (which
  // handles notification grouping). Two concerns, two logs — `change()`'s
  // return value works on any writable stack, with or without observation.
  type WriterLogEntry = { readonly op: Op; readonly compensating: boolean }
  const writerLog: WriterLogEntry[] = []

  // The recordInverse closure is threaded through every prepare()'s
  // options under the RECORD_INVERSE symbol. Substrates call it after
  // computing an inverse; it pushes onto the active frame's stack range.
  const recordInverse = (path: Path, inverse: ChangeBase): void => {
    inverseStack.push({ path, inverse })
  }

  // Base prepare: append to the writer log (tagged with `compensating`
  // so FORWARD_OPS_SINCE can filter inverse entries out of `change()`'s
  // forward-only return value), attach the RECORD_INVERSE callback to
  // options, then delegate to the substrate. Layers like withChangefeed
  // wrap this (replacing `ctx.prepare`) to accumulate notification
  // entries; layers like withCaching wrap it to invalidate caches at
  // the target path.
  //
  // Replay batches do NOT write to the writer log — `change()`'s return
  // value is forward ops authored locally, not state authored elsewhere.
  const prepare = (
    path: Path,
    change: ChangeBase,
    options?: BatchOptions,
  ): void => {
    if (!options?.replay) {
      writerLog.push({
        op: { path, change },
        compensating: !!options?.compensating,
      })
    }
    const opts = {
      ...(options ?? {}),
      [RECORD_INVERSE]: recordInverse,
    } as BatchOptions & { [RECORD_INVERSE]: RecordInverseFn }
    substrate.prepare(path, change, opts)
  }

  // Base flush: delegate to the substrate's afterBatch.
  // The changefeed layer wraps this to deliver accumulated Changeset
  // batches to subscribers before calling through to the substrate.
  const flush = (options?: BatchOptions): void => {
    substrate.afterBatch(options)
  }

  // Bake the substrate-runBatch reference once. Substrates that
  // implement runBatch get their bracket invoked at the outermost
  // depth transition; substrates that don't (Plain) get the trivial
  // path (just invoke the body).
  const substrateRunBatch = substrate.runBatch

  // The bracket primitive. One wrapper, three handlers (substrate,
  // changefeed-flush via `ctx.flush`, inverse-stack via the frameStarts
  // range). Inner frames push/pop without invoking substrate.runBatch
  // or flushing — the depth-0 transition is the single delivery point
  // per outermost block.
  const runBatch: WritableContext["runBatch"] = (work, opts) => {
    const wrappedWork = (): void => {
      const start = inverseStack.length
      frameStarts.push(start)
      try {
        work()
      } catch (e) {
        // Undo-replay handler: pop this frame's start, replay its
        // recorded inverses LIFO via ctx.prepare with `compensating: true`.
        // Routing through ctx.prepare (not substrate.prepare) keeps the
        // changefeed accumulator filling so subscribers see the full op
        // log on the aborted Changeset; the `compensating: true` flag
        // tells substrates to skip recording the inverse-of-the-inverse.
        const frameStart = frameStarts.pop()!
        for (let i = inverseStack.length - 1; i >= frameStart; i--) {
          const { path, inverse } = inverseStack[i]!
          ctx.prepare(path, inverse, { ...opts, compensating: true })
        }
        inverseStack.length = frameStart
        // Only the outermost frame flushes — the inner frame's catch
        // pops + compensates but lets the rethrow propagate to the
        // outer frame's wrappedWork.
        if (frameStarts.length === 0) {
          ctx.flush({ ...opts, aborted: true })
          writerLog.length = 0
        }
        throw e
      }
      frameStarts.pop()
      // Outermost success: deliver one Changeset for the whole block.
      // The forward inverses recorded on this frame stay on the stack
      // if we're an inner frame — they belong to the outer's range.
      // On the outermost frame, frameStarts is empty after the pop,
      // and any remaining inverses on the stack should have been
      // popped by inner frames already; reset defensively.
      if (frameStarts.length === 0) {
        // Outermost success — drop the inverse range and flush.
        // (Inner-frame contributions to the outer's range remain on
        // the stack across inner pops, but the outermost release is
        // where the whole block's range gets discarded.)
        inverseStack.length = 0
        ctx.flush(opts)
        writerLog.length = 0
      }
    }

    // Substrate bracket is invoked only at the outermost depth transition.
    // Inner ctx.runBatch calls just run frame management. Loro's per-
    // substrate depth counter and Yjs's reliance on native transact
    // nesting are both subsumed by this single boundary detection.
    if (frameStarts.length === 0 && substrateRunBatch) {
      substrateRunBatch.call(substrate, wrappedWork, opts)
    } else {
      wrappedWork()
    }
  }

  // Depth-aware dispatch combinator:
  // - frameStarts.length === 0 (outside any runBatch frame): open an
  //   implicit single-op runBatch — auto-commit semantics. Subscribers
  //   see a degenerate Changeset of one change.
  // - frameStarts.length > 0 (inside a frame, e.g. a change(doc, fn)
  //   body): just call prepare. The outer frame owns the flush boundary,
  //   so multi-helper blocks collapse into one Changeset.
  const dispatch = (path: Path, change: ChangeBase): void => {
    if (frameStarts.length === 0) {
      runBatch(() => {
        ctx.prepare(path, change)
      }, undefined)
    } else {
      ctx.prepare(path, change)
    }
  }

  const ctx: WritableContext = {
    reader: substrate.reader,
    prepare,
    flush,
    runBatch,
    dispatch,
    // Writer-log accessors over `writerLog` (the change-Writer monad's
    // log). Always live regardless of stack composition — `change()`
    // works whether or not the observation layer is in play.
    [FORWARD_OPS_MARKER]: () => writerLog.length,
    [FORWARD_OPS_SINCE]: (marker: number) => {
      const out: Op[] = []
      for (let i = marker; i < writerLog.length; i++) {
        const entry = writerLog[i]!
        if (entry.compensating) continue
        out.push(entry.op)
      }
      return out
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

export interface RichTextRef {
  insert: (
    index: number,
    content: string,
    marks?: Record<string, unknown>,
  ) => void
  delete: (index: number, length: number) => void
  update: (content: string) => void
  mark: (start: number, end: number, key: string, value: unknown) => void
  unmark: (start: number, end: number, key: string) => void
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

/**
 * Mutation-only interface for set refs. Added by `withWritable`.
 *
 * Sets are value-addressed — there is no `set(key, value)`. `add` is
 * idempotent (no-op for an existing member, by content equality).
 * `delete` returns the membership-before-delete (matches native
 * `Set.prototype.delete` semantics).
 *
 * Reading is provided by `ReadableSetRef` from the readable interpreter.
 */
export interface WritableSetRef<V = unknown> {
  add(value: V): void
  delete(value: V): boolean
  clear(): void
}

/**
 * Mutation-only interface for tree refs. Added by `withWritable`.
 *
 * `.create({ parent, index, data })` allocates a new node id via the
 * substrate's `[TREE_NODE_ALLOCATE]` hook, returns the id synchronously,
 * and records a `TreeInstruction.create` in the prepare queue. Optional
 * initial `data` is recorded as further per-node writes at `path.node(id)`.
 *
 * `.delete(id)` enumerates the subtree via `subtreeIds` and records one
 * `TreeInstruction.delete` per descendant in a single `TreeChange`.
 *
 * `.move(id, opts)` records a `TreeInstruction.move`. Concurrent-move
 * correctness is the substrate's responsibility (Loro implements
 * Kleppmann-style `tree-move`).
 *
 * Reading is provided by `ReadableTreeRef` from the readable interpreter.
 */
export interface WritableTreeRef<V = unknown> {
  create(opts?: {
    parent?: string | null
    index?: number
    data?: Partial<V>
  }): string
  delete(id: string): void
  move(id: string, opts: { parent: string | null; index: number }): void
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
      : S extends RichTextSchema
        ? RichTextRef
        : // --- First-class container types ---
          S extends SetSchema<infer I>
          ? WritableSetRef<Plain<I>>
          : S extends TreeSchema<infer Inner>
            ? WritableTreeRef<Plain<Inner>>
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
                        : S extends DiscriminatedSumSchema<infer _D, infer V>
                          ? WritableDiscriminantProductRef<V[number]["fields"]>
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

    sequence(
      ctx: WritableContext,
      path: Path,
      schema: SequenceSchema,
      item: (index: number) => A,
    ): A & HasTransact {
      const result = base.sequence(ctx, path, schema, item) as any
      installListWriteOps(result, ctx, path)
      attachTransact(result, ctx)
      return result
    },

    // --- Map ------------------------------------------------------------------

    map(
      ctx: WritableContext,
      path: Path,
      schema: MapSchema,
      item: (key: string) => A,
    ): A & HasTransact {
      const result = base.map(ctx, path, schema, item) as any
      installKeyedWriteOps(result, ctx, path)
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

    text(
      ctx: WritableContext,
      path: Path,
      schema: TextSchema,
    ): A & HasTransact {
      const result = base.text(ctx, path, schema) as any
      installTextWriteOps(result, ctx, path)
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
    // Sets are leaf-shaped: value-addressed `.add` / `.delete` / `.clear`
    // emit `SetChange` via `installSetWriteOps`. Distinct from `map` —
    // sets don't have key-addressed mutation.

    set(
      ctx: WritableContext,
      path: Path,
      schema: SetSchema,
      item: (key: string) => A,
    ): A & HasTransact {
      const result = base.set(ctx, path, schema, item) as any
      installSetWriteOps(result, ctx, path)
      attachTransact(result, ctx)
      return result
    },

    // --- Tree -----------------------------------------------------------------
    // Install `.create / .delete / .move` via `installTreeWriteOps`.
    // [TRANSACT] is attached by the inner recursion through each node's data.

    tree(
      ctx: WritableContext,
      path: Path,
      schema: TreeSchema,
      nodes: () => readonly FlatTreeNode<A>[],
      node: (id: string) => A,
    ): A & HasTransact {
      const result = base.tree(ctx, path, schema, nodes, node) as any
      installTreeWriteOps(result, ctx, path)
      attachTransact(result, ctx)
      return result as A & HasTransact
    },

    // --- Movable --------------------------------------------------------------
    // Delegate like sequence.

    movable(
      ctx: WritableContext,
      path: Path,
      schema: MovableSequenceSchema,
      item: (index: number) => A,
    ): A & HasTransact {
      const result = base.movable(ctx, path, schema, item) as any
      installListWriteOps(result, ctx, path)
      attachTransact(result, ctx)
      return result
    },

    // --- RichText -------------------------------------------------------------

    richtext(
      ctx: WritableContext,
      path: Path,
      schema: RichTextSchema,
    ): A & HasTransact {
      const result = base.richtext(ctx, path, schema) as any
      installRichTextWriteOps(result, ctx, path)
      attachTransact(result, ctx)
      return result
    },
  }
}

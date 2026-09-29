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
// Mutation methods construct the change and dispatch it; whatever other
// layers need to do about a change they do as stages of `ctx.prepare`.

import type { DispatcherHandle, Lease } from "@kyneta/machine"
import { createDispatcher } from "@kyneta/machine"

import type { Op } from "../changefeed.js"
import type {
  FlatTreeNode,
  Interpreter,
  Path,
  SumVariants,
} from "../interpret.js"
import {
  INTERPRETER,
  type Plain,
  type RefContext,
} from "../interpreter-types.js"

export type { Op }

import type { ChangeBase } from "../change.js"
import { incrementChange, own, replaceChange } from "../change.js"
import { AddressedPath, resolveToAddressed } from "../path.js"
import type { PositionCapable } from "../position.js"
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
  AnnounceOptions,
  BatchOptions,
  CommitOptions,
  PrepareOptions,
  SubstratePrepare,
} from "../substrate.js"
import { TREE_NODE_ALLOCATE } from "../substrate.js"
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
 * This enables `batch()` and other utilities to discover the context
 * from any ref without a WeakMap or re-interpretation.
 *
 * Uses `Symbol.for` so multiple copies share the same identity.
 */
export const TRANSACT: unique symbol = Symbol.for("kyneta:transact")
export const PATH: unique symbol = Symbol.for("kyneta:path")

/**
 * An object that carries a `[TRANSACT]` symbol referencing the
 * `WritableContext` used during interpretation.
 */
export interface HasTransact {
  readonly [TRANSACT]: WritableContext
  readonly [PATH]: Path
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
export const REMOVE: unique symbol = Symbol.for("kyneta:remove")

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
// WritableContext — shared state flowing through the tree
// ---------------------------------------------------------------------------

/** A finished batch: its options and every op it prepared, in order. */
export interface SealedBatch {
  readonly options: BatchOptions
  readonly ops: readonly Op[]
}

/**
 * One layer's part in `ctx.prepare`. A layer registers at most one stage per
 * context, with `addPrepareStage`.
 *
 * Both hooks receive the path already resolved: addressed whenever the
 * context has an addressed root, whoever called `prepare` and with whatever
 * path. Neither may call `prepare`.
 */
export interface PrepareStage {
  /** Runs before the substrate applies the change, while σ still holds the
   *  state before it. Stages in this phase must commute. */
  readonly before?: (
    path: Path,
    change: ChangeBase,
    options: PrepareOptions,
  ) => void
  /** Runs after the substrate applied the change and every `before` stage
   *  ran. Stages in this phase must commute. */
  readonly after?: (
    path: Path,
    change: ChangeBase,
    options: PrepareOptions,
  ) => void
}

/**
 * The context shared across the entire interpreted tree. Extends
 * `RefContext` with the write primitives.
 *
 * **The batch lifecycle.** Every op belongs to a batch: an authored block
 * opened by `runBatch`, or an announcement. The context captures each
 * batch's ops in its own trace, seals the batch when it ends, and delivers
 * sealed batches in seal order. An authored block is sealed inside the
 * substrate's native bracket and delivered after the native commit, so a
 * batch sealed while a native commit is open waits for it.
 *
 * **The `dispatch` combinator.** Helper methods (`scalar.set`,
 * `sequence.push`, etc.) call `ctx.dispatch(path, change)` rather than
 * `ctx.prepare` directly. `dispatch` is depth-aware:
 *
 * - Outside any frame: opens an implicit single-op `runBatch`
 *   (auto-commit) — subscribers see a degenerate Changeset of one change.
 * - Inside a frame: forwards to `prepare`. The outer frame owns the
 *   seal, so helpers in a `batch()` block collapse into one Changeset.
 */
export interface WritableContext extends RefContext {
  /**
   * Take one op into the batch being captured; `options.ingress` says how it
   * arrived. Throws outside `runBatch` or `announce`.
   *
   * A fixed pipeline: resolve the path, run every stage's `before`, apply
   * the change to the substrate (for `author` and `compensate`) and add the
   * op to the batch's trace, then run every stage's `after`. Order comes from
   * that shape, never from the order in which layers registered.
   */
  readonly prepare: (
    path: Path,
    change: ChangeBase,
    options: PrepareOptions,
  ) => void
  /** Register a layer's `prepare` stage, once per context: a second call
   *  with the same `layer` is ignored. */
  readonly addPrepareStage: (layer: symbol, stage: PrepareStage) => void
  /** Deliver one sealed batch. The base does nothing; the changefeed layer
   *  wraps it. Called in seal order by the context's delivery dispatcher. */
  deliver: (batch: SealedBatch) => void
  /**
   * Run an authored block in its own frame and return the authored ops the
   * frame captured (what `batch()` returns).
   *
   * The outermost frame is one native commit: it runs inside
   * `substrate.runBatch`, calls `substrate.afterBatch()` and seals before the
   * commit, and is delivered after it. If `work` throws, the frame's recorded
   * inverses are applied LIFO (`ingress: "compensate"`), and at the outermost
   * frame the batch is sealed with `aborted: true` before the error is
   * rethrown. Inner frames only contribute ops to the outermost one.
   */
  readonly runBatch: (work: () => void, options: CommitOptions) => Op[]
  /**
   * Report ops the substrate has already applied, with σ already in
   * agreement with λ. The ops never reach `substrate.prepare` or
   * `afterBatch`; subscribers receive them with `replay: !options.local`. An
   * empty list announces nothing.
   */
  readonly announce: (ops: readonly Op[], options: AnnounceOptions) => void
  /** Depth-aware combinator: outside any frame opens an implicit
   *  single-op `runBatch` (auto-commit); inside a frame just calls
   *  `prepare`. Helper methods on refs route through this so multi-helper
   *  blocks collapse into one Changeset. */
  readonly dispatch: (path: Path, change: ChangeBase) => void
  /** Shared cascade budget, attached by `createRef({ lease })`. It must be
   *  attached before the context's first write: the delivery dispatcher is
   *  created on first use and keeps the lease it finds then. Without one,
   *  the dispatcher creates a private lease. */
  lease?: Lease
}

/**
 * Whether `ctx` carries the prepare/deliver pipeline, i.e. was built by
 * `buildWritableContext`. The addressing and changefeed layers keep their
 * `RefContext` signatures, and register a prepare stage (and, for the
 * changefeed, wrap `deliver`) only on a writable stack.
 */
export function hasPreparePipeline(
  ctx: RefContext,
): ctx is RefContext & Pick<WritableContext, "addPrepareStage" | "deliver"> {
  return (
    "addPrepareStage" in ctx &&
    typeof ctx.addPrepareStage === "function" &&
    "deliver" in ctx &&
    typeof ctx.deliver === "function"
  )
}

// ---------------------------------------------------------------------------
// Traces — the ops of one batch, and the two projections of them
// ---------------------------------------------------------------------------

/** One prepared op. `authored` is false for compensations and announcements. */
export interface TraceEntry {
  readonly op: Op
  readonly authored: boolean
}

/** The authored ops after position `from`: a `runBatch` frame's return value. */
export function authoredSince(
  trace: readonly TraceEntry[],
  from: number,
): Op[] {
  const ops: Op[] = []
  for (let i = from; i < trace.length; i++) {
    const entry = trace[i]
    if (entry.authored) ops.push(entry.op)
  }
  return ops
}

/** A trace as a sealed batch: every op, in order. */
export function seal(
  trace: readonly TraceEntry[],
  options: BatchOptions,
): SealedBatch {
  return { options, ops: trace.map(entry => entry.op) }
}

const AUTHOR: PrepareOptions = { ingress: "author" }
const COMPENSATE: PrepareOptions = { ingress: "compensate" }
const ANNOUNCE: PrepareOptions = { ingress: "announce" }

// ---------------------------------------------------------------------------
// buildWritableContext — shared builder for substrate factories
// ---------------------------------------------------------------------------

export interface SubstrateCapabilities {
  nativeResolver?: (schema: Schema, path: Path) => unknown
  positionResolver?: (
    schema: TextSchema | RichTextSchema,
    path: Path,
  ) => PositionCapable
  treeNodeAllocate?: (
    path: Path,
    parent?: string | null,
    index?: number,
  ) => string
}

type DeliveryMsg = { readonly type: "deliver"; readonly batch: SealedBatch }

/**
 * Builds a WritableContext around a substrate's mutation primitives.
 *
 * The substrate sees only authored ops and their compensations:
 * - `substrate.prepare(path, change, recordInverse)` — apply the change to
 *   σ and λ; for a forward op, record its inverse on the active frame.
 * - `substrate.afterBatch()` — end of an authored batch, inside the bracket
 *   (plain logs the batch; CRDT substrates drain their coalescing buffers).
 * - `substrate.runBatch?(body, options)` — optional native bracket, invoked
 *   around the outermost frame.
 */
export function buildWritableContext(
  substrate: SubstratePrepare,
  capabilities: SubstrateCapabilities = {},
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

  // One trace per open batch. An announcement made while an authored batch
  // is open pushes its own trace, so neither batch captures the other's ops.
  const traces: TraceEntry[][] = []

  // Substrates call this after computing a forward op's inverse; it pushes
  // onto the active frame's stack range.
  const recordInverse = (path: Path, inverse: ChangeBase): void => {
    inverseStack.push({ path, inverse })
  }

  // Delivers sealed batches in seal order. Created on first use so that it
  // picks up the lease `createRef` attaches to the context.
  let deliveries: DispatcherHandle<DeliveryMsg> | undefined
  const delivery = (): DispatcherHandle<DeliveryMsg> => {
    deliveries ??= createDispatcher<DeliveryMsg>(
      msg => ctx.deliver(msg.batch),
      { lease: ctx.lease, label: "changefeed" },
    )
    return deliveries
  }
  const release = (batch: SealedBatch): void => {
    delivery().dispatch({ type: "deliver", batch })
  }

  // Each layer's stage, keyed by the layer so registering twice is a no-op.
  // Stages within a phase commute, so the Map's insertion order carries no
  // meaning.
  const stages = new Map<symbol, PrepareStage>()
  const addPrepareStage: WritableContext["addPrepareStage"] = (
    layer,
    stage,
  ) => {
    if (!stages.has(layer)) stages.set(layer, stage)
  }

  // Resolve once, for every caller. A raw path from `announce` or
  // `applyChanges` becomes the addressed path whose `key` the listeners,
  // address tables and caches are keyed by. Idempotent for addressed paths.
  // `rootPath` is read per call: `withAddressing` installs it on the context
  // after the context is built.
  const resolve = (path: Path): Path => {
    const root = (ctx as { rootPath?: Path }).rootPath
    return root instanceof AddressedPath
      ? resolveToAddressed(path, root.registry)
      : path
  }

  // Resolve, `before` stages, the substrate call for the ingress and the op
  // joining the open batch's trace, then `after` stages.
  const prepare = (
    rawPath: Path,
    change: ChangeBase,
    options: PrepareOptions,
  ): void => {
    const trace = traces.at(-1)
    if (trace === undefined) {
      throw new Error("ctx.prepare called outside runBatch or announce")
    }
    const path = resolve(rawPath)
    for (const stage of stages.values()) stage.before?.(path, change, options)
    switch (options.ingress) {
      case "author":
        substrate.prepare(path, change, recordInverse)
        break
      case "compensate":
        substrate.prepare(path, change, null)
        break
      case "announce":
        break
    }
    trace.push({ op: { path, change }, authored: options.ingress === "author" })
    for (const stage of stages.values()) stage.after?.(path, change, options)
  }

  // Base deliver: nothing to deliver to. The changefeed layer wraps it.
  const deliver = (_batch: SealedBatch): void => {}

  // The native bracket around the outermost frame. Substrates without one
  // (plain, ephemeral) run the frame directly.
  const bracket: (work: () => void, options: CommitOptions) => void =
    substrate.runBatch?.bind(substrate) ?? (work => work())

  // Close a batch's trace: pop it, so a stray prepare after the seal throws
  // instead of joining a batch that is already sealed.
  const closeTrace = (trace: TraceEntry[]): void => {
    if (traces.at(-1) === trace) traces.pop()
  }

  const sealAndRelease = (trace: TraceEntry[], options: BatchOptions): void => {
    closeTrace(trace)
    release(seal(trace, options))
  }

  const runBatch: WritableContext["runBatch"] = (work, opts) => {
    const outermost = frameStarts.length === 0
    if (outermost) traces.push([])
    const trace = traces.at(-1) ?? []
    const from = trace.length
    let captured: Op[] = []

    const wrappedWork = (): void => {
      const start = inverseStack.length
      frameStarts.push(start)
      try {
        work()
      } catch (e) {
        // Undo-replay handler: pop this frame's start, replay its recorded
        // inverses LIFO via `prepare` with `ingress: "compensate"`.
        // Routing through `prepare` (not substrate.prepare) keeps the
        // compensations in the trace, so the aborted Changeset shows the
        // full op log, and runs every stage on them; the substrate receives
        // no recorder, so it does not record the inverse-of-the-inverse.
        // `?? 0` rather than an assertion: the push/pop are paired by
        // construction, so an empty stack cannot happen — and if it ever did,
        // compensating the whole log is the safe reading, not crashing.
        const frameStart = frameStarts.pop() ?? 0
        try {
          for (let i = inverseStack.length - 1; i >= frameStart; i--) {
            const { path, inverse } = inverseStack[i]
            prepare(path, inverse, COMPENSATE)
          }
          inverseStack.length = frameStart
          if (frameStarts.length === 0) {
            substrate.afterBatch()
            sealAndRelease(trace, { ...opts, ingress: "author", aborted: true })
          }
        } catch (compErr: any) {
          const err =
            compErr instanceof Error ? compErr : new Error(String(compErr))
          err.cause = e
          throw err
        }
        throw e
      }
      frameStarts.pop()
      captured = authoredSince(trace, from)
      if (frameStarts.length === 0) {
        // Inner frames' inverses stay on the stack across inner pops; the
        // outermost release is where the whole block's range is discarded.
        inverseStack.length = 0
        substrate.afterBatch()
        sealAndRelease(trace, { ...opts, ingress: "author" })
      }
    }

    if (!outermost) {
      wrappedWork()
      return captured
    }
    // Hold deliveries for the native bracket: this batch is sealed inside
    // it, and anything announced while the native commit runs is sealed
    // after it, so both are delivered in seal order once the commit closes.
    try {
      delivery().hold(() => bracket(wrappedWork, opts))
    } finally {
      closeTrace(trace)
    }
    return captured
  }

  const announce: WritableContext["announce"] = (ops, options) => {
    if (ops.length === 0) return
    const trace: TraceEntry[] = []
    traces.push(trace)
    try {
      for (const { path, change } of ops) {
        prepare(path, change, ANNOUNCE)
      }
    } catch (error) {
      closeTrace(trace)
      throw error
    }
    sealAndRelease(trace, { ingress: "announce", ...options })
  }

  // Depth-aware dispatch combinator:
  // - frameStarts.length === 0 (outside any runBatch frame): open an
  //   implicit single-op runBatch — auto-commit semantics. Subscribers
  //   see a degenerate Changeset of one change.
  // - frameStarts.length > 0 (inside a frame, e.g. a batch(doc, fn)
  //   body): just call prepare. The outer frame owns the seal, so
  //   multi-helper blocks collapse into one Changeset.
  const dispatch = (path: Path, change: ChangeBase): void => {
    if (frameStarts.length === 0) {
      runBatch(() => {
        prepare(path, change, AUTHOR)
      }, {})
    } else {
      prepare(path, change, AUTHOR)
    }
  }

  const ctx: WritableContext = {
    reader: substrate.reader,
    prepare,
    addPrepareStage,
    deliver,
    runBatch,
    announce,
    dispatch,
  }

  if (capabilities.nativeResolver) {
    Object.defineProperty(ctx, "nativeResolver", {
      value: capabilities.nativeResolver,
      enumerable: false,
      writable: false,
      configurable: false,
    })
  }

  if (capabilities.positionResolver) {
    Object.defineProperty(ctx, "positionResolver", {
      value: capabilities.positionResolver,
      enumerable: false,
      writable: false,
      configurable: false,
    })
  }

  if (capabilities.treeNodeAllocate) {
    Object.defineProperty(ctx, TREE_NODE_ALLOCATE, {
      value: capabilities.treeNodeAllocate,
      enumerable: false,
      writable: false,
      configurable: false,
    })
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
 * `ctx.dispatch(path, change)`. Every change source (imperative mutation,
 * `applyChanges`, announcements, compensation) reaches the same
 * `ctx.prepare` pipeline, so the stages other layers register there see
 * all of them.
 *
 * ```ts
 * const interp = withWritable(withCaching(withReadable(bottomInterpreter)))
 * const ctx = plainContext(store)
 * const doc = interpret(schema, interp, ctx)
 * doc.title.insert(0, "Hello")   // mutation via withWritable
 * doc.title()                    // "Hello" via withReadable
 * ```
 */
export function withWritable<A extends object>(
  base: Interpreter<RefContext, A>,
): Interpreter<WritableContext, A & HasTransact> {
  // Attach [TRANSACT] and [PATH] as non-enumerable symbol properties.
  //
  // `Object.defineProperty` rather than assignment, and the reason is
  // `enumerable: false`: an assigned symbol is enumerable, and object spread
  // (`{...ref}`) copies enumerable own symbols, so a copy of a ref would carry
  // a live context and path it has no claim to. Nothing in the suite catches
  // that today, which is exactly why it is written down here.
  //
  // (An earlier version of this comment said the call was here to bypass
  // Proxy `set` traps on map refs. That is not so: map refs are plain
  // carriers, and the package's only Proxy — the sum carrier in
  // `with-navigation.ts` — never reaches this function, because `sum` is a
  // pass-through in every augmenting layer.)
  function attachTransact<T extends object>(
    result: T,
    ctx: WritableContext,
    path: Path,
  ): asserts result is T & HasTransact {
    Object.defineProperty(result, TRANSACT, {
      value: ctx,
      enumerable: false,
      configurable: true,
    })
    Object.defineProperty(result, PATH, {
      value: path,
      enumerable: false,
      configurable: true,
    })
  }

  /**
   * Attach a method that does not show up among a ref's own enumerable keys.
   *
   * A product ref exposes its schema fields as properties, so an enumerable
   * `set` would appear alongside them — in `Object.keys(ref)`, in a spread, in
   * anything that walks the ref's shape. `defineProperty` keeps the two apart.
   *
   * The assertion signature is what lets the caller keep the member in its
   * type afterwards, which a plain `void` helper cannot do.
   */
  function defineMethod<T extends object, K extends string, F>(
    target: T,
    name: K,
    fn: F,
  ): asserts target is T & { readonly [P in K]: F } {
    Object.defineProperty(target, name, {
      value: fn,
      enumerable: false,
      configurable: true,
    })
  }

  return {
    [INTERPRETER]: true,
    // --- Scalar ---------------------------------------------------------------
    // Add .set() to the base scalar ref.
    // Every node dispatches at its own path — no upward reference.

    // ---------------------------------------------------------------------
    // Each case adds members to the carrier the layer below produced.
    // `Object.assign` types that — `<T, U>(target: T, source: U): T & U` — and
    // `defineMethod` does it for members that must stay off a ref's enumerable
    // keys. Assigning to a property of a value typed as the parameter `A` is a
    // type error, which is why these used to open with `as any`.
    //
    // Cases that delegate to an `install…WriteOps` helper get their members
    // from that helper's assertion signature — `installListWriteOps` declares
    // `ListWriteOps` and asserts it onto the carrier, so `.push` and friends
    // are in the type here without being written here.
    // ---------------------------------------------------------------------
    scalar(
      ctx: WritableContext,
      path: Path,
      schema: ScalarSchema,
    ): A & HasTransact {
      const result = Object.assign(base.scalar(ctx, path, schema), {
        set: (value: unknown): void => {
          // `own` copies the caller's object so the op keeps a value rather than a
          // view. Without it, a caller reusing the object it passed would rewrite what
          // subscribers see, with no write recorded and no changeset emitted. The store
          // takes its own copy separately, at `ownedForStore`.
          const change = replaceChange(own(value))
          ctx.dispatch(path, change)
        },
      })

      attachTransact(result, ctx, path)
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
      const result = base.product(ctx, path, schema, fields)

      defineMethod(result, "set", (value: unknown): void => {
        // `own` copies the caller's object so the op keeps a value rather than a
        // view. Without it, a caller reusing the object it passed would rewrite what
        // subscribers see, with no write recorded and no changeset emitted. The store
        // takes its own copy separately, at `ownedForStore`.
        const change = replaceChange(own(value))
        ctx.dispatch(path, change)
      })

      attachTransact(result, ctx, path)
      return result
    },

    // --- Sequence -------------------------------------------------------------

    sequence(
      ctx: WritableContext,
      path: Path,
      schema: SequenceSchema,
      item: (index: number) => A,
    ): A & HasTransact {
      const result = base.sequence(ctx, path, schema, item)
      installListWriteOps(result, ctx, path)
      attachTransact(result, ctx, path)
      return result
    },

    // --- Map ------------------------------------------------------------------

    map(
      ctx: WritableContext,
      path: Path,
      schema: MapSchema,
      item: (key: string) => A,
    ): A & HasTransact {
      const result = base.map(ctx, path, schema, item)
      installKeyedWriteOps(result, ctx, path)
      attachTransact(result, ctx, path)
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
      const result = base.text(ctx, path, schema)
      installTextWriteOps(result, ctx, path)
      attachTransact(result, ctx, path)
      return result
    },

    // --- Counter --------------------------------------------------------------
    // Add increment/decrement mutation methods.

    counter(
      ctx: WritableContext,
      path: Path,
      schema: CounterSchema,
    ): A & HasTransact {
      const result = Object.assign(base.counter(ctx, path, schema), {
        increment: (n: number = 1): void => {
          ctx.dispatch(path, incrementChange(n))
        },
        decrement: (n: number = 1): void => {
          ctx.dispatch(path, incrementChange(-n))
        },
      })

      attachTransact(result, ctx, path)
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
      const result = base.set(ctx, path, schema, item)
      installSetWriteOps(result, ctx, path)
      attachTransact(result, ctx, path)
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
      const result = base.tree(ctx, path, schema, nodes, node)
      installTreeWriteOps(result, ctx, path)
      attachTransact(result, ctx, path)
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
      const result = base.movable(ctx, path, schema, item)
      installListWriteOps(result, ctx, path)
      attachTransact(result, ctx, path)
      return result
    },

    // --- RichText -------------------------------------------------------------

    richtext(
      ctx: WritableContext,
      path: Path,
      schema: RichTextSchema,
    ): A & HasTransact {
      const result = base.richtext(ctx, path, schema)
      installRichTextWriteOps(result, ctx, path)
      attachTransact(result, ctx, path)
      return result
    },
  }
}

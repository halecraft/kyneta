// writable — the types of writing: the writable context, the symbols a ref
// carries to reach it, and the mutation surface of each kind.
//
// This module provides:
// 1. WritableContext, built by `buildWritableContext` (`../writable-context.ts`)
// 2. TRANSACT, PATH and REMOVE, the symbols a ref carries
// 3. Mutation-only ref interfaces: ScalarRef, TextRef, CounterRef, SequenceRef
// 4. Writable<S>, the type-level interpretation
//
// The write operations themselves live on each ref's prototype
// (`../ref/write.ts`).

import type { Lease } from "@kyneta/machine"
import type { ChangeBase } from "../change.js"
import type { Op } from "../changefeed.js"
import type { CoordinateTrie } from "../coordinate-trie.js"
import type { Path } from "../interpret.js"
import type { Plain } from "../interpreter-types.js"
import type { PositionCapable } from "../position.js"
import type { Reader } from "../reader.js"
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
  TextSchema,
  TreeSchema,
} from "../schema.js"
import type {
  AnnounceOptions,
  BatchOptions,
  CommitOptions,
  PrepareOptions,
} from "../substrate.js"
import type { SubscriberTrie } from "./subscriber-trie.js"

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
} & ProductRef<{ readonly [K in keyof F]: Plain<F[K]> }>

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

/**
 * One prepared op: `op` frozen as it was made, and `at` the live path it was
 * prepared at, which delivery walks by identity. `op.path` is `at.toRaw()`,
 * so the two have the same length.
 */
export interface TraceEntry {
  readonly op: Op
  readonly at: Path
}

/** A finished batch: its options and every op it prepared, in order. */
export interface SealedBatch {
  readonly options: BatchOptions
  readonly entries: readonly TraceEntry[]
}

/**
 * The context every ref of a document shares: how to read σ, the write
 * primitives, and the document's coordinate and subscriber tries. Built by
 * `buildWritableContext`.
 *
 * **The batch lifecycle.** Every op belongs to a batch: an authored block
 * opened by `runBatch`, or an announcement. The context captures each
 * batch's ops in its own trace, seals the batch when it ends, and delivers
 * sealed batches in seal order. An authored block is sealed inside the
 * substrate's native bracket and delivered after the native commit, so a
 * batch sealed while a native commit is open waits for it.
 *
 * **The `dispatch` combinator.** A ref's writes (`scalar.set`,
 * `sequence.push`, etc.) call `ctx.dispatch(path, change)` rather than
 * `ctx.prepare` directly. `dispatch` is depth-aware:
 *
 * - Outside any frame: opens an implicit single-op `runBatch`
 *   (auto-commit) — subscribers see a degenerate Changeset of one change.
 * - Inside a frame: forwards to `prepare`. The outer frame owns the
 *   seal, so writes in a `batch()` block collapse into one Changeset.
 */
export interface WritableContext {
  /** Reads σ. */
  readonly reader: Reader
  /** The substrate-native container at a schema position (a `LoroText`, a
   *  `Y.Map`), or `undefined` where there is none: what `[NATIVE]` reads. */
  readonly nativeResolver?: (schema: Schema, path: Path) => unknown
  /** The position capability of a text at a schema position: what
   *  `[POSITION]` reads. */
  readonly positionResolver?: (
    schema: TextSchema | RichTextSchema,
    path: Path,
  ) => PositionCapable
  /** The document's root schema: what an authored change is completed
   *  against, and what addressing derives a coordinate's schema from. */
  readonly schema: Schema
  /** The context's coordinates: one node per coordinate a ref was made
   *  for, or that something still needs. */
  readonly trie: CoordinateTrie
  /** The context's subscribers and population state. */
  readonly subscribers: SubscriberTrie
  /**
   * Take one op into the batch being captured; `options.ingress` says how it
   * arrived. Throws outside `runBatch` or `announce`.
   *
   * A fixed pipeline, in this order: locate the path in the trie, complete
   * an authored change against the schema it lands at (`completeAt`),
   * advance a list's item addresses through a sequence change, apply the
   * change to the substrate (for `author` and `compensate`) and add the op to
   * the batch's trace (and an authored one, with its inverse, to its frame),
   * settle the coordinates the change may have rewritten, and mark what it
   * populated.
   */
  readonly prepare: (
    path: Path,
    change: ChangeBase,
    options: PrepareOptions,
  ) => void
  /**
   * Run an authored block in its own frame and return the authored ops that
   * survived in it (what `batch()` returns): an inner frame that threw and
   * was caught is not among them.
   *
   * The outermost frame is one native commit: it runs inside
   * `substrate.runBatch`, calls `substrate.afterBatch(outcome)` and seals before the
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

// ---------------------------------------------------------------------------
// Ref types — mutation-only interfaces
// ---------------------------------------------------------------------------
// These describe only the mutation surface. Reading is `Readable<S>`
// (`readable.ts`); `Ref<S>` intersects the two.

// Every member declares its `this`: it lives on a prototype shared by every
// ref of its schema node, and reads the ref's state through `this`. So
// calling a member taken off its ref is a type error; passing one as a
// callback is caught when it runs.

export interface ScalarRef<T = unknown> {
  set(this: ScalarRef<T>, value: T): void
}

export interface TextRef {
  insert(this: TextRef, index: number, content: string): void
  delete(this: TextRef, index: number, length: number): void
  update(this: TextRef, content: string): void
}

export interface RichTextRef {
  insert(
    this: RichTextRef,
    index: number,
    content: string,
    marks?: Record<string, unknown>,
  ): void
  delete(this: RichTextRef, index: number, length: number): void
  update(this: RichTextRef, content: string): void
  mark(
    this: RichTextRef,
    start: number,
    end: number,
    key: string,
    value: unknown,
  ): void
  unmark(this: RichTextRef, start: number, end: number, key: string): void
}

export interface CounterRef {
  increment(this: CounterRef, n?: number): void
  decrement(this: CounterRef, n?: number): void
}

/**
 * Mutation-only interface for sequence refs.
 *
 * Navigation (`.at()`, `.length`, `[Symbol.iterator]`) lives in
 * `NavigableSequenceRef`. Reading (call
 * signature, `.get()`) lives in `ReadableSequenceRef`. This interface
 * provides only mutation: `.push()`, `.insert()`, `.delete()`.
 *
 * No type parameter — mutation methods take plain values (`unknown`),
 * not child refs. The unified `Ref<S>` type intersects this with
 * `ReadableSequenceRef<Ref<I>, Plain<I>>` to get the full surface.
 */
export interface SequenceRef {
  push(this: SequenceRef, ...items: unknown[]): void
  insert(this: SequenceRef, index: number, ...items: unknown[]): void
  delete(this: SequenceRef, index: number, count?: number): void
}

/**
 * Mutation-only interface for product refs.
 * Enables atomic replacement of an entire struct subtree in one change.
 */
export interface ProductRef<T = unknown> {
  set(this: ProductRef<T>, value: T): void
}

/**
 * Mutation-only interface for map refs. Reading is `ReadableMapRef`.
 */
export interface WritableMapRef<V = unknown> {
  set(this: WritableMapRef<V>, key: string, value: V): void
  delete(this: WritableMapRef<V>, key: string): void
  clear(this: WritableMapRef<V>): void
}

/**
 * Mutation-only interface for set refs.
 *
 * Sets are value-addressed — there is no `set(key, value)`. `add` is
 * idempotent (no-op for an existing member, by content equality).
 * `delete` returns the membership-before-delete (matches native
 * `Set.prototype.delete` semantics).
 *
 * Reading is `ReadableSetRef`.
 */
export interface WritableSetRef<V = unknown> {
  add(this: WritableSetRef<V>, value: V): void
  delete(this: WritableSetRef<V>, value: V): boolean
  clear(this: WritableSetRef<V>): void
}

/**
 * Mutation-only interface for tree refs.
 *
 * `.create({ parent, index, data })` allocates a new node id via the
 * substrate's `[TREE_NODE_ALLOCATE]` hook, returns the id synchronously,
 * and dispatches a `TreeInstruction.create`. Optional initial `data` is
 * dispatched as a write at the node's path.
 *
 * `.delete(id)` enumerates the subtree via `subtreeIds` and records one
 * `TreeInstruction.delete` per descendant in a single `TreeChange`.
 *
 * `.move(id, opts)` records a `TreeInstruction.move`. Concurrent-move
 * correctness is the substrate's responsibility (Loro implements
 * Kleppmann-style `tree-move`).
 *
 * Reading is `ReadableTreeRef`.
 */
export interface WritableTreeRef<V = unknown> {
  create(
    this: WritableTreeRef<V>,
    opts?: {
      parent?: string | null
      index?: number
      data?: Partial<V>
    },
  ): string
  delete(this: WritableTreeRef<V>, id: string): void
  move(
    this: WritableTreeRef<V>,
    id: string,
    opts: { parent: string | null; index: number },
  ): void
}

// ---------------------------------------------------------------------------
// Type-level interpretations — schema type → TypeScript type
// ---------------------------------------------------------------------------

/**
 * Computes the mutation-only ref type for a given schema type.
 *
 * This maps schema nodes to their mutation interfaces. Reading is
 * `Readable<S>`; every ref satisfies both.
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
                      readonly [K in keyof F]: Plain<F[K]>
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

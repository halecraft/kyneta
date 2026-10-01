// withChangefeed — compositional changefeed interpreter transformer.
//
//
// This module owns the observation concern. It takes a base interpreter
// that produces refs with HasRead (filled [CALL] slot) and attaches
// [CHANGEFEED] to every node:
//
// - Every schema-issued ref (leaves and composites alike) carries a
//   RecursiveChangefeedProtocol — `subscribe` for own-path delivery and
//   `subscribeDescendants` for own-path + descendant delivery with relative
//   paths. For a leaf, `subscribeDescendants` is the trivial own-path lift.
//
// The Changefeed protocol defines a Moore machine: .current (output
// function) + .subscribe (transition observer). A Moore machine with
// no transitions is still valid — it's a constant. This means
// withChangefeed works on both read-write AND read-only stacks:
//
// - Read-write: ctx has prepare/deliver → notifications fire on mutation
// - Read-only: ctx has no prepare/deliver → .subscribe never fires,
//   .current still works. Valid static Moore machine.
//
// Notification flow (read-write only): subscribers live in the context's
// `SubscriberTrie`. The transformer registers a `prepare` stage that marks
// what each op populated, and wraps ctx.deliver to plan and fire
// notifications for one sealed batch: a change reaches the subscribers on its
// path's ancestors and, projected, those inside the part of the tree it
// rewrote. Capturing each batch's ops, sealing, and delivering in seal order
// after the native commit belong to the writable context
// (`buildWritableContext`).
//
// Compose: withChangefeed(withWritable(withCaching(withAddressing(withReadable(withNavigation(bottom))))))
// Or read-only: withChangefeed(withCaching(withAddressing(withReadable(withNavigation(bottom)))))

import type { BatchMetadata, HasChangefeed } from "@kyneta/changefeed"
import { CHANGEFEED } from "@kyneta/changefeed"
import type { ChangeBase } from "../change.js"
import type {
  Changeset,
  Op,
  RecursiveChangefeedProtocol,
} from "../changefeed.js"
import { isPropertyHost } from "../guards.js"
import type {
  FlatTreeNode,
  Interpreter,
  Path,
  SumVariants,
} from "../interpret.js"
import { INTERPRETER, type RefContext } from "../interpreter-types.js"
import { RawPath } from "../path.js"
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
import type { BatchOptions } from "../substrate.js"
import { planSubtreeEffect, projectChange } from "../subtree-effect.js"

import type { HasRead } from "./bottom.js"
import { CALL } from "./bottom.js"
import { type SubscriberNode, SubscriberTrie } from "./subscriber-trie.js"
import {
  hasPreparePipeline,
  type SealedBatch,
  type TraceEntry,
} from "./writable.js"

export const POPULATED: unique symbol = Symbol.for("kyneta:populated")

/**
 * A ref that tracks whether data has arrived at its path.
 *
 * The slot holds a *carrier*: a function returning the boolean, which also
 * carries its own `[CHANGEFEED]` so the transition can be subscribed to.
 * Not every ref has one — a ref produced outside `withChangefeed` will not —
 * which is why reaching it goes through the guard.
 */
export interface HasPopulated {
  readonly [POPULATED]: (() => boolean) & HasChangefeed<boolean>
}

/**
 * Returns `true` if `value` has a `[POPULATED]` property, i.e. it tracks
 * population.
 */
export function hasPopulated(value: unknown): value is HasPopulated {
  return (
    value !== null &&
    value !== undefined &&
    (typeof value === "object" || typeof value === "function") &&
    POPULATED in (value as object)
  )
}

/**
 * Returns true if the ref has been populated: a change — local, remote, or
 * replayed from storage — has reached it, at it, below it, or by rewriting a
 * part of the tree above that contains it. Returns false if none has, or if it
 * is not a ref that tracks population.
 *
 * This is the plain boolean and is safe to put in an `if`. For the observable
 * form, use {@link populatedFeed}.
 */
export function populated(ref: unknown): boolean {
  if (!hasPopulated(ref)) return false
  return ref[POPULATED]() === true
}

/**
 * Returns a callable that implements the `[CHANGEFEED]` protocol for the
 * ref's population state. The callable returns a boolean (true if populated).
 * You can subscribe to it via `subscribeNode(populatedFeed(ref), ...)`.
 * Throws if the ref does not track population.
 *
 * The `Feed` suffix marks this as the *observable carrier* rather than the
 * plain boolean — for a boolean, call `populated(ref)`. Reading "has data
 * arrived?" is the routine case, so it gets the shorter name; subscribing to
 * the transition is the specialist one, so it pays the suffix.
 *
 * A carrier is a callable, which means it is **always truthy**. Never write
 * `if (populatedFeed(ref))` — that reports the opposite of the truth for an
 * empty document. Call it (`populatedFeed(ref)()`) or use `populated(ref)`.
 */
export function populatedFeed(
  ref: unknown,
): (() => boolean) & HasChangefeed<boolean> {
  if (!hasPopulated(ref)) {
    throw new Error(
      "populatedFeed() requires a ref that tracks population (e.g. a ref produced by withChangefeed)",
    )
  }
  return ref[POPULATED]
}

// ---------------------------------------------------------------------------
// Attach [CHANGEFEED] non-enumerably to any object
// ---------------------------------------------------------------------------

/**
 * Attaches a `[CHANGEFEED]` symbol property non-enumerably to `target`.
 *
 * `Object.defineProperty` rather than assignment for the descriptor flags:
 * `enumerable: false` keeps the slot out of object spread (`{...ref}` copies
 * enumerable own symbols, which would hand a copy someone else's changefeed),
 * and `writable: false` stops the slot being replaced after attachment.
 *
 * (An earlier version of this comment said the call was here to bypass Proxy
 * `set` traps on map refs. It is not: map refs are plain carriers, and the
 * package's only Proxy — the sum carrier in `with-navigation.ts` — never
 * reaches this function, because `sum` is a pass-through in every augmenting
 * layer.)
 */
export function attachChangefeed(
  target: object,
  changefeed: RecursiveChangefeedProtocol<unknown, ChangeBase>,
): asserts target is HasChangefeed {
  Object.defineProperty(target, CHANGEFEED, {
    value: changefeed,
    enumerable: false,
    configurable: true,
    writable: false,
  })
}

// ---------------------------------------------------------------------------
// Notification plan — Functional Core (pure, table-testable)
// ---------------------------------------------------------------------------

/**
 * What one sealed batch delivers, to whom, and in what order.
 *
 * Keyed by subscriber-trie node rather than by path key: a key joins segments
 * lossily, and a node is exactly one coordinate.
 *
 * The two channels group differently, and the reason is structural. A node's
 * own path is a single coordinate, so its own-path changes come from one
 * place. A node's *subtree* spans many paths, so a deep subscriber's changeset
 * gathers ops from all of them — which is exactly the merge this type exists
 * to express.
 */
export interface DeliveryPlan {
  /**
   * Own-path channel: node → the changes to that coordinate, in dispatch
   * order: changes made at it, and changes made above it projected onto it.
   * Insertion order is first-touch order, which is the order these callbacks
   * fire in.
   */
  readonly ownPath: ReadonlyMap<SubscriberNode, readonly ChangeBase[]>
  /**
   * Deep channel: node → every op in that node's subtree, already rebased to
   * its relative path, and the projections of ops above it at its relative
   * root, in dispatch order. Each path is the op's frozen one, rebased, so
   * it says where the op wrote when it was made.
   */
  readonly deep: ReadonlyMap<SubscriberNode, readonly Op[]>
  /** Deep subscriber nodes, deepest-first — the order those callbacks fire in. */
  readonly deepOrder: readonly SubscriberNode[]
}

/**
 * Plan one batch's delivery: walk the ops once and answer both channels.
 *
 * A change at P concerns the coordinates whose read it changes: P's
 * ancestors, P itself, and whatever below P it rewrote
 * (`planSubtreeEffect`). So each op is walked up the trie through P's
 * ancestor chain, where deep subscribers receive it rebased to their relative
 * path, and down through the rewritten scope, where every subscriber receives
 * `projectChange(change, relative)`, the change as seen from where it sits.
 * A write gives new objects in σ to the same scope, P, its ancestors and what
 * it rewrote, and to nothing else, so a subscriber hears a batch exactly when
 * its read gets a new identity in it.
 *
 * The single pass is not just an optimisation. The deep channel needs ops in
 * *dispatch* order, and any grouping step destroys that: if an ancestor write
 * lands between two writes to the same descendant, grouping by path floats the
 * ancestor past both of them, and replaying the result reaches a different
 * state than the writes produced.
 *
 * Each entry carries two paths. The walk follows `at`, the live path, because
 * subscribers are keyed by segment identity, and a list item's identity is
 * its address. What a subscriber receives is `op.path`, the path frozen when
 * the op was made, rebased by slicing at the subscriber's depth; the two
 * paths have the same length.
 *
 * @param pending - The sealed batch's entries, in dispatch order.
 * @param trie - The context's subscribers; only read.
 */
export function planDelivery(
  pending: readonly TraceEntry[],
  trie: SubscriberTrie,
): DeliveryPlan {
  const ownPath = new Map<SubscriberNode, ChangeBase[]>()
  const deep = new Map<SubscriberNode, Op[]>()
  // Depth per deep node, recorded on first sight for the ordering sort below.
  const depths = new Map<SubscriberNode, number>()

  const toOwn = (node: SubscriberNode, change: ChangeBase): void => {
    if (!node.own?.size) return
    const at = ownPath.get(node)
    if (at) at.push(change)
    else ownPath.set(node, [change])
  }
  const toDeep = (node: SubscriberNode, op: Op, depth: number): void => {
    if (!node.deep?.size) return
    const at = deep.get(node)
    if (at) at.push(op)
    else {
      deep.set(node, [op])
      depths.set(node, depth)
    }
  }

  for (const { op, at } of pending) {
    const { path, change } = op
    // Up: the ancestor chain, as far as the trie has it. `chain[i]` is the
    // node for the first `i` segments; the chain is built from segment
    // identities, never by cutting a key string, so it cannot invent a level.
    const chain = trie.chain(at)
    const target = chain.length === at.length + 1 ? chain.at(-1) : undefined
    if (target) toOwn(target, change)
    for (let i = chain.length - 1; i >= 0; i--) {
      const node = chain[i]
      // Rebase only where someone is listening. At `i === path.length` the
      // relative path is empty: the own-path case seen from the deep channel.
      if (node?.deep?.size) toDeep(node, { path: path.slice(i), change }, i)
    }

    // Down: the part of the tree the change rewrote.
    if (target === undefined) continue
    for (const [node, relative] of trie.scope(
      target,
      planSubtreeEffect(change),
    )) {
      const projected = projectChange(change, relative)
      toOwn(node, projected)
      toDeep(
        node,
        { path: RawPath.empty, change: projected },
        path.length + relative.length,
      )
    }
  }

  // Deepest-first. `sort` is stable, so nodes at equal depth keep first-touch
  // order.
  const deepOrder = [...deep.keys()].sort(
    (a, b) => (depths.get(b) ?? 0) - (depths.get(a) ?? 0),
  )

  return { ownPath, deep, deepOrder }
}

/**
 * The metadata a sealed batch puts on each `Changeset`. `replay` is true iff
 * no writer on this peer made the ops: false for an authored batch and for a
 * native local write the bridge announces, true for what a merge, reset or
 * tick brought in. Only an authored batch can be `aborted`. `source` comes
 * from an authored batch, or from a local announcement of a write a local
 * caller asked the substrate to make natively (a Loro undo).
 */
export function changesetMetadata(options: BatchOptions): BatchMetadata {
  switch (options.ingress) {
    case "author":
      return {
        origin: options.origin,
        replay: false,
        aborted: options.aborted,
        source: options.source,
      }
    case "announce":
      return {
        origin: options.origin,
        replay: !options.local,
        aborted: undefined,
        // A merge has no local caller, so only a local announcement carries
        // one's token.
        source: options.local ? options.source : undefined,
      }
  }
}

/**
 * Fire a plan's callbacks. Imperative Shell — all the deciding happened in
 * `planDelivery`; this only builds changesets and calls functions.
 *
 * **Ordering.** Every own-path callback fires first, in first-touch order, then
 * every deep callback, deepest-first. Planning before firing is what collapses
 * a subscriber's several changesets into one, and this ordering is the price
 * of that.
 *
 * One `Changeset` is built per node and shared by every callback registered
 * there.
 *
 * @param plan - From `planDelivery`.
 * @param options - The sealed batch's options; `changesetMetadata` turns
 *   them into the metadata every emitted `Changeset` carries.
 */
export function deliverNotifications(
  plan: DeliveryPlan,
  options: BatchOptions,
): void {
  const metadata = changesetMetadata(options)
  for (const [node, changes] of plan.ownPath) {
    if (!node.own?.size) continue
    const changeset: Changeset<ChangeBase> = { changes, ...metadata }
    // Snapshot before calling. A callback is free to unsubscribe — itself or
    // anyone else — and a `Set` being iterated live would then skip a
    // subscriber it had not reached yet, or visit one added mid-delivery.
    for (const callback of [...node.own]) callback(changeset)
  }

  for (const node of plan.deepOrder) {
    const changes = plan.deep.get(node)
    if (!node.deep?.size || !changes) continue
    const changeset: Changeset<Op> = { changes, ...metadata }
    // Snapshot for the same reason as the own-path loop above.
    for (const callback of [...node.deep]) callback(changeset)
  }
}

// ---------------------------------------------------------------------------
// Shape-grammar helpers — pure transforms over Changeset shape
// ---------------------------------------------------------------------------

/**
 * Lift a `Changeset<C>` to `Changeset<Op<C>>` by wrapping each change
 * with a constant path.
 *
 * Used where a leaf-shaped (own-path) changeset has to be delivered on the
 * deep channel: the populated feed's `subscribeDescendants`.
 *
 * Pure, table-testable. Exported for tests; not re-exported from index.
 */
export function liftToOps<C extends ChangeBase>(
  changeset: Changeset<C>,
  path: RawPath,
): Changeset<Op<C>> {
  return {
    changes: changeset.changes.map(change => ({ path, change })),
    origin: changeset.origin,
    replay: changeset.replay,
    aborted: changeset.aborted,
    source: changeset.source,
  }
}

// ---------------------------------------------------------------------------
// Prepare stage and deliver wrapping — per-context, idempotent
// ---------------------------------------------------------------------------

// One subscriber trie per context, shared across all nodes interpreted with it.
const contextState = new WeakMap<RefContext, SubscriberTrie>()

// Read-only contexts: each gets its own trie. Subscribers register but
// nothing feeds into it — a valid static Moore machine.
const readOnlyState = new WeakMap<RefContext, SubscriberTrie>()

/** The key this layer registers its prepare stage under. */
const CHANGEFEED_STAGE: unique symbol = Symbol("kyneta:changefeed-stage")

/**
 * The subscriber trie for `ctx`, wiring the context for notification on first
 * use. On read-only stacks (no pipeline) subscribers are registered but never
 * called: a valid static Moore machine.
 *
 * On read-write stacks:
 * - an `after` stage marks what each op populated (its path, its ancestors,
 *   and what it rewrote below);
 * - `deliver` wrapping plans delivery from the sealed batch's ops
 *   (`planDelivery`, pure) and fires the subscribers (`deliverNotifications`).
 *   This is the only wrapper left on the context, so there is no wrapping
 *   order to depend on.
 */
function subscriberTrieOf(ctx: RefContext): SubscriberTrie {
  if (!hasPreparePipeline(ctx)) {
    let trie = readOnlyState.get(ctx)
    if (!trie) {
      trie = new SubscriberTrie()
      readOnlyState.set(ctx, trie)
    }
    return trie
  }

  const existing = contextState.get(ctx)
  if (existing) return existing

  const trie = new SubscriberTrie()
  const originalDeliver = ctx.deliver

  ctx.addPrepareStage(CHANGEFEED_STAGE, {
    after: (path, change) =>
      trie.markPopulated(path, planSubtreeEffect(change)),
  })

  ctx.deliver = (batch: SealedBatch): void => {
    originalDeliver(batch)
    deliverNotifications(planDelivery(batch.entries, trie), batch.options)
  }

  contextState.set(ctx, trie)
  return trie
}

/**
 * Number of own-path subscribers at `path` for the given context.
 *
 * @internal Not exported from the package barrel.
 *
 * Test-only. A registration that outlives its subscriber costs memory and
 * per-delivery work and nothing else: delivery still calls exactly the
 * callbacks that are subscribed, so a test counting callbacks passes whether
 * or not the registry accretes. Reading the structure is the test that
 * actually holds.
 */
export function __getListenerCountAtPath(ctx: object, path: Path): number {
  return contextState.get(ctx as RefContext)?.find(path)?.own?.size ?? 0
}

// ---------------------------------------------------------------------------
// Populated tracking
// ---------------------------------------------------------------------------

/**
 * Create a `RecursiveChangefeedProtocol<boolean>` for the population state
 * at a path — the protocol behind `populatedFeed(ref)` / `populated(ref)`.
 *
 * "Populated" means a change has reached this coordinate: an op landed at or
 * below it, or an op above it rewrote a part of the tree containing it — the
 * same scope delivery reaches. Monotonic: once true, never false.
 *
 * - `.current` asks the subscriber trie (`isPopulated`).
 * - `.subscribe` fires exactly once when the path transitions from
 *   unpopulated to populated. If already populated at subscribe time,
 *   the callback fires immediately (via microtask for consistency).
 * - `.subscribeDescendants` is the trivial own-path lift: the populated event
 *   has no payload (changes is empty by construction), so the delivered
 *   `Changeset<Op>` has an empty changes array; only `origin` is
 *   load-bearing. Provided so the facade `subscribe` works universally
 *   on `populatedFeed(ref)` carriers without a method-set check.
 */
function createPopulatedChangefeed(
  path: Path,
  trie: SubscriberTrie,
): RecursiveChangefeedProtocol<boolean, ChangeBase> {
  const subscribe = (
    callback: (changeset: Changeset<ChangeBase>) => void,
  ): (() => void) => {
    // Already populated — fire immediately via microtask
    if (trie.isPopulated(path)) {
      Promise.resolve().then(() =>
        callback({ changes: [], origin: "populated" }),
      )
      return () => {}
    }
    return trie.listenPopulated(path, () =>
      callback({ changes: [], origin: "populated" }),
    )
  }

  return {
    get current(): boolean {
      return trie.isPopulated(path)
    },
    subscribe,
    subscribeDescendants(callback) {
      return subscribe(changeset =>
        callback(liftToOps(changeset, RawPath.empty)),
      )
    },
  }
}

/**
 * Attach the population state to a ref under the `[POPULATED]` symbol, as a
 * non-enumerable callable carrying its own `[CHANGEFEED]`.
 *
 * Keyed by `Symbol`, never by the string `"populated"`: refs expose the
 * user's schema fields as properties, so a string key would let framework
 * metadata collide with (and shadow) a field of the same name. Read it via
 * the `populated(ref)` / `populatedFeed(ref)` facades.
 */
function attachIsPopulated(
  target: object,
  path: Path,
  trie: SubscriberTrie,
): void {
  const changefeed = createPopulatedChangefeed(path, trie)
  const callable = function (this: unknown) {
    return changefeed.current
  }
  Object.defineProperty(callable, CHANGEFEED, {
    value: changefeed,
    enumerable: false,
    configurable: false,
    writable: false,
  })
  Object.defineProperty(target, POPULATED, {
    value: callable,
    enumerable: false,
    configurable: false,
    writable: false,
  })
}

// ---------------------------------------------------------------------------
// The changefeed factory
// ---------------------------------------------------------------------------

/**
 * Builds the `RecursiveChangefeedProtocol` for a node — any node, a tree
 * included.
 *
 * A subscriber records the coordinate it sits at in the subscriber trie, and
 * `planDelivery` finds it by walking each change's ancestors and the part of
 * the tree the change rewrote — recomputed per delivery from the change
 * alone, so there is nothing to keep aligned and no reference to a child ref
 * that could go stale. See "Why there are no dynamic-collection changefeed
 * factories" in `packages/schema/TECHNICAL.md` for the machinery this
 * replaced.
 *
 * A leaf is not special: a leaf is a tree of size one, so its own change *is*
 * its whole subtree, and the walk reaches its deep subscribers at relative
 * path `[]`. Nor is a tree: a subscriber at a deleted tree node receives the
 * delete projected onto it, the tree-delete terminal (`projectChange`).
 */
function createNodeChangefeed(
  trie: SubscriberTrie,
  path: Path,
  readCurrent: () => unknown,
): RecursiveChangefeedProtocol<unknown, ChangeBase> {
  return {
    get current() {
      return readCurrent()
    },
    subscribe: callback => trie.listenOwn(path, callback),
    subscribeDescendants: callback => trie.listenDeep(path, callback),
  }
}

// ---------------------------------------------------------------------------
// withChangefeed — the interpreter transformer
// ---------------------------------------------------------------------------

/**
 * An interpreter transformer that attaches `[CHANGEFEED]` to every ref
 * produced by the base interpreter.
 *
 * - **Every schema-issued ref** (leaves and composites alike) gets a
 *   `RecursiveChangefeedProtocol`:
 *   `subscribe` fires only for changes at the node's own path (node-level).
 *   `subscribeDescendants` fires for own-path AND descendant changes with relative
 *   paths (tree-level), making it a strict superset of `subscribe`.
 *
 * A subscriber registers at its own path key; delivery finds it by walking
 * each changed path's ancestors (`planDelivery`), so no node forwards
 * changes to another.
 *
 * **Prepare stage and deliver wrapping:** The transformer registers a
 * `prepare` stage that marks paths populated, and wraps `ctx.deliver` to
 * turn one sealed batch into one `Changeset` per affected subscriber.
 *
 * This means:
 * - Auto-commit (single mutation via `dispatch`): a batch of one op →
 *   subscribers receive a `Changeset` with exactly 1 change.
 * - A `batch()` block, `applyChanges`, or an announcement: a batch of N
 *   ops → subscribers receive a `Changeset` with N changes, and never see
 *   partially-applied state.
 *
 * ```ts
 * // Full stack (read + write + observe):
 * const interp = withChangefeed(withWritable(withCaching(withAddressing(withReadable(withNavigation(bottom))))))
 * const ctx = plainContext(schema, store)
 * const doc = interpret(schema, interp, ctx)
 * doc[CHANGEFEED].subscribe(callback)       // fires on mutation
 *
 * // Read-only stack (observe without mutation):
 * const roInterp = withChangefeed(withCaching(withAddressing(withReadable(withNavigation(bottom)))))
 * const roDoc = interpret(schema, roInterp, { store })
 * roDoc[CHANGEFEED].current           // works — reads via [CALL]
 * roDoc[CHANGEFEED].subscribe(callback)     // valid — never fires
 * ```
 */

// ---------------------------------------------------------------------------
// wireChangefeed — shared boilerplate for all changefeed cases
// ---------------------------------------------------------------------------

/**
 * Wire a changefeed onto a ref: attach `[CHANGEFEED]` and `[POPULATED]`, both
 * over the context's subscriber trie. A carrier that cannot hold properties
 * gets nothing.
 */
function wireChangefeed(
  result: unknown,
  ctx: RefContext,
  path: Path,
  readCurrent: () => unknown,
): void {
  if (!isPropertyHost(result)) return
  const trie = subscriberTrieOf(ctx)
  attachChangefeed(result, createNodeChangefeed(trie, path, readCurrent))
  attachIsPopulated(result, path, trie)
}

export function withChangefeed<A extends HasRead>(
  base: Interpreter<RefContext, A>,
): Interpreter<RefContext, A & HasChangefeed> {
  return {
    [INTERPRETER]: true,
    // --- Scalar ---------------------------------------------------------------
    scalar(
      ctx: RefContext,
      path: Path,
      schema: ScalarSchema,
    ): A & HasChangefeed {
      const result = base.scalar(ctx, path, schema)
      wireChangefeed(result, ctx, path, () => result[CALL]())
      return result as A & HasChangefeed
    },

    // --- Product --------------------------------------------------------------
    product(
      ctx: RefContext,
      path: Path,
      schema: ProductSchema,
      fields: Readonly<Record<string, () => A>>,
    ): A & HasChangefeed {
      const result = base.product(ctx, path, schema, fields)
      wireChangefeed(result, ctx, path, () => result[CALL]())
      return result as A & HasChangefeed
    },

    // --- Sequence -------------------------------------------------------------
    sequence(
      ctx: RefContext,
      path: Path,
      schema: SequenceSchema,
      item: (index: number) => A,
    ): A & HasChangefeed {
      const result = base.sequence(ctx, path, schema, item)
      wireChangefeed(result, ctx, path, () => result[CALL]())
      return result as A & HasChangefeed
    },

    // --- Map ------------------------------------------------------------------
    map(
      ctx: RefContext,
      path: Path,
      schema: MapSchema,
      item: (key: string) => A,
    ): A & HasChangefeed {
      const result = base.map(ctx, path, schema, item)
      wireChangefeed(result, ctx, path, () => result[CALL]())
      return result as A & HasChangefeed
    },

    // --- Sum ------------------------------------------------------------------
    // Pure structural dispatch — pass through. The resolved variant
    // already has [CHANGEFEED] from whichever case handled it.
    sum(
      ctx: RefContext,
      path: Path,
      schema: SumSchema,
      variants: SumVariants<A>,
    ): A & HasChangefeed {
      // Sum nodes are structurally transparent — the catamorphism dispatches
      // variants through the full interpreter, so the resolved variant already
      // has HasChangefeed attached. The base.sum() return type is A (without
      // HasChangefeed) because the base interpreter doesn't know about our layer.
      return base.sum(ctx, path, schema, variants) as A & HasChangefeed
    },

    // --- Text -----------------------------------------------------------------
    // Leaf type — attach a leaf changefeed + populated.
    text(ctx: RefContext, path: Path, schema: TextSchema): A & HasChangefeed {
      const result = base.text(ctx, path, schema)
      wireChangefeed(result, ctx, path, () => result[CALL]())
      return result as A & HasChangefeed
    },

    // --- Counter --------------------------------------------------------------
    // Leaf type — attach a leaf changefeed + populated.
    counter(
      ctx: RefContext,
      path: Path,
      schema: CounterSchema,
    ): A & HasChangefeed {
      const result = base.counter(ctx, path, schema)
      wireChangefeed(result, ctx, path, () => result[CALL]())
      return result as A & HasChangefeed
    },

    // --- Set ------------------------------------------------------------------
    // Sets are leaf-shaped: no per-member child refs, no per-key listener
    // graph. Attach a leaf changefeed (same pattern as text/counter) — any
    // SetChange at the set path invalidates the whole carrier.
    set(
      ctx: RefContext,
      path: Path,
      schema: SetSchema,
      item: (key: string) => A,
    ): A & HasChangefeed {
      const result = base.set(ctx, path, schema, item)
      wireChangefeed(result, ctx, path, () => result[CALL]())
      return result as A & HasChangefeed
    },

    // --- Tree -----------------------------------------------------------------
    // Like every other kind: a subscriber at a deleted node hears the delete
    // projected onto it, the tree-delete terminal.
    tree(
      ctx: RefContext,
      path: Path,
      schema: TreeSchema,
      nodes: () => readonly FlatTreeNode<A>[],
      node: (id: string) => A,
    ): A & HasChangefeed {
      const result = base.tree(ctx, path, schema, nodes, node)
      wireChangefeed(result, ctx, path, () => result[CALL]())
      return result as A & HasChangefeed
    },

    // --- Movable --------------------------------------------------------------
    // Delegate like sequence — attach a tree-observable changefeed.
    movable(
      ctx: RefContext,
      path: Path,
      schema: MovableSequenceSchema,
      item: (index: number) => A,
    ): A & HasChangefeed {
      const result = base.movable(ctx, path, schema, item)
      wireChangefeed(result, ctx, path, () => result[CALL]())
      return result as A & HasChangefeed
    },

    // --- RichText -------------------------------------------------------------
    // Leaf type — attach a leaf changefeed + populated.
    richtext(
      ctx: RefContext,
      path: Path,
      schema: RichTextSchema,
    ): A & HasChangefeed {
      const result = base.richtext(ctx, path, schema)
      wireChangefeed(result, ctx, path, () => result[CALL]())
      return result as A & HasChangefeed
    },
  }
}

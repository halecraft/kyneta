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
// - Read-write: ctx has prepare/flush → notifications fire on mutation
// - Read-only: ctx has no prepare/flush → .subscribe never fires,
//   .current still works. Valid static Moore machine.
//
// Notification flow (read-write only): the transformer wraps ctx.prepare
// to apply changes synchronously (substrate write + populated mark) and
// dispatch an `accumulate` Msg into a per-context dispatcher. It wraps
// ctx.flush to dispatch a `flush` Msg. The dispatcher's drain-to-quiescence
// loop catches re-entrant `batch()` calls from inside subscriber
// callbacks: substrate writes still happen synchronously, and the new
// accumulator entries produce a fresh Changeset in a subsequent sub-tick.
//
// Compose: withChangefeed(withWritable(withCaching(withReadable(withNavigation(bottom)))))
// Or read-only: withChangefeed(withCaching(withReadable(withNavigation(bottom))))

import type { HasChangefeed } from "@kyneta/changefeed"
import { CHANGEFEED } from "@kyneta/changefeed"
import type { DispatcherHandle, Lease } from "@kyneta/machine"
import { createDispatcher } from "@kyneta/machine"
import type { ChangeBase } from "../change.js"
import { isTreeChange, treeChange } from "../change.js"
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
import { AddressedPath, resolveToAddressed } from "../path.js"
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

import type { HasRead } from "./bottom.js"
import { CALL } from "./bottom.js"

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
 * Returns true if the ref has been populated (received at least one mutation —
 * local, remote, or replayed from storage). Returns false if it has not, or if
 * it is not a ref that tracks population.
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
 * A membership test, structurally satisfied by both `Map` and `Set`.
 *
 * The planner only needs to ask "is anyone listening at this key?", so taking
 * this shape lets the shell hand over its live subscriber registries directly
 * — no copying a `Map`'s keys into a `Set` on every flush — while keeping the
 * planner a pure function of plain data for testing.
 */
export interface KeySet {
  has(key: string): boolean
}

/**
 * A path-keyed registry of subscriber callbacks — the shape both channels use.
 *
 * Written out as a type because the two registries are otherwise spelled at
 * length in a dozen places, and the point worth seeing is that they differ in
 * exactly one thing: what a callback is handed.
 */
type Registry<C> = Map<string, Set<C>>

/** Own-path subscribers. They receive the node's own changes, without paths. */
type OwnPathRegistry = Registry<(changeset: Changeset<ChangeBase>) => void>

/**
 * Deep subscribers, keyed by the path they subscribed AT — not by the paths
 * they are interested in. A subscriber says "I am at P" once, and delivery
 * finds it by walking each changed path's ancestors.
 *
 * Kept separate from the own-path registry because the two channels carry
 * different shapes: a deep subscriber gets an `Op` per change, carrying that
 * change's path relative to the subscription point.
 */
type DeepRegistry = Registry<(changeset: Changeset<Op>) => void>

/**
 * What one flush delivers, to whom, and in what order.
 *
 * The two channels group differently, and the reason is structural. A node's
 * own path is a single key, so own-path changes can only ever come from one
 * place. A node's *subtree* spans many paths, so a deep subscriber's changeset
 * has to gather ops from all of them — which is exactly the merge this type
 * exists to express.
 *
 * This is the Functional Core of the notification pipeline, following the same
 * FC/IS pattern as `planCacheUpdate`/`applyCacheOps` in `withCaching`.
 */
export interface DeliveryPlan {
  /**
   * Own-path channel: subscriber key → the changes dispatched at exactly that
   * path, in dispatch order. Insertion order is first-touch order, which is
   * the order these callbacks fire in.
   */
  readonly ownPath: ReadonlyMap<string, readonly ChangeBase[]>
  /**
   * Deep channel: subscriber key → every op in that subscriber's subtree,
   * already rebased to the subscriber's relative path, in dispatch order.
   */
  readonly deep: ReadonlyMap<string, readonly Op[]>
  /** Deep subscriber keys, deepest-first — the order those callbacks fire in. */
  readonly deepOrder: readonly string[]
}

/**
 * Plan one flush: walk the ops once and answer both channels.
 *
 * The single pass is not just an optimisation. The deep channel needs ops in
 * *dispatch* order, and any grouping step destroys that: if an ancestor write
 * lands between two writes to the same descendant, grouping by path floats the
 * ancestor past both of them, and replaying the result reaches a different
 * state than the writes produced.
 *
 * Walking `pending` in order and appending as we go preserves it for free. The
 * two channels also share work — at `i === path.length` the ancestor key *is*
 * the op's own path key — so computing them separately would repeat a lookup.
 *
 * @param pending - Accumulated ops from prepare calls, in dispatch order.
 * @param ownPathKeys - Keys with own-path subscribers.
 * @param deepKeys - Keys with deep (descendant) subscribers.
 */
export function planDelivery(
  pending: readonly Op[],
  ownPathKeys: KeySet,
  deepKeys: KeySet,
): DeliveryPlan {
  const ownPath = new Map<string, ChangeBase[]>()
  const deep = new Map<string, Op[]>()
  // Depth per deep key, recorded on first sight so the ordering sort below
  // does not have to re-derive it from the key string.
  const depths = new Map<string, number>()

  for (const { path, change } of pending) {
    const key = path.key

    if (ownPathKeys.has(key)) {
      const at = ownPath.get(key)
      if (at) at.push(change)
      else ownPath.set(key, [change])
    }

    // A change at `a/b/c` concerns subscribers at `a/b/c`, `a/b`, `a`, and the
    // root. That set is just the path's ancestor chain, so it is derived here
    // from the path itself rather than maintained between flushes.
    for (let i = path.length; i >= 0; i--) {
      // Structural: take the first `i` segments, then compute THAT path's key.
      //
      // A key is its segments joined by a separator, so ancestor keys look like
      // prefixes of the key string, and cutting the string would be cheaper. It
      // is also wrong. Joining is lossy: a segment whose own text contains the
      // separator makes the split invent a level that never existed, and a
      // subscriber at that phantom path would receive changes from an unrelated
      // subtree. Slicing segments cannot produce a level that is not there.
      // `markPopulated` walks structurally for the same reason.
      const ancestorKey = i === path.length ? key : path.slice(0, i).key
      if (!deepKeys.has(ancestorKey)) continue

      // Rebase only where someone is listening, so a deep document with few
      // subscribers pays for lookups but not for allocation. `path.slice(i)` is
      // the changed path relative to this ancestor; at `i === path.length` that
      // is the empty path, which is exactly the own-path case seen from the
      // deep channel.
      const op: Op = { path: path.slice(i), change }
      const buffer = deep.get(ancestorKey)
      if (buffer) buffer.push(op)
      else {
        deep.set(ancestorKey, [op])
        depths.set(ancestorKey, i)
      }
    }
  }

  // Deepest-first. The order is chosen here rather than emerging from the shape
  // of a subscription graph, which is what determined it before — delivery
  // order used to depend on the sequence in which subscribers happened to
  // register.
  //
  // `sort` has been specified stable since ES2019, and this relies on it: keys
  // at equal depth keep the insertion order above, which is first-touch order.
  const deepOrder = [...deep.keys()].sort(
    (a, b) => (depths.get(b) ?? 0) - (depths.get(a) ?? 0),
  )

  return { ownPath, deep, deepOrder }
}

/**
 * Register a subscriber at a path, and hand back the teardown that removes it.
 *
 * **One function serves both channels**, which is the point. They differ only
 * in what a callback receives — own-path subscribers get the node's own
 * changes, deep subscribers get an `Op` per change — so the registration
 * discipline itself is shared, and there is no second copy to drift.
 *
 * There is no wiring here, and nothing to tear down when the document changes
 * shape: a subscriber records where it sits, and `deliverNotifications` finds
 * it by walking each changed path upward. That is the whole reason this is so
 * small. The previous design had each composite subscribe to its children's
 * changefeeds and forward their changes upward, which meant holding references
 * to the child ref objects that existed at wiring time. Those references go
 * stale whenever the document's shape changes — most sharply for a sum, whose
 * carrier is swapped out on a variant shift — and each dynamic composite had
 * grown its own machinery to rebuild them.
 *
 * Registration happens here and nowhere else, so it happens when a *subscriber*
 * arrives rather than when a ref carrier is built. That distinction is load-
 * bearing: carriers are not unique per path (see "Per-ref-instance carrier
 * multiplication" in `packages/schema/TECHNICAL.md`), and registering per
 * carrier left one permanent entry per carrier ever created, with nothing able
 * to remove it. JavaScript offers no destructor, and the changefeed layer holds
 * no reference to a carrier it could weaken.
 *
 * **The membership check in the teardown is doing more work than it looks
 * like.** It makes a doubled teardown harmless, and it also stops a *stale*
 * teardown from evicting a later subscriber. The teardown closes over the set
 * that existed when its subscriber registered, and that set can stop being the
 * registry's: emptying a key deletes it, and subscribing at that path again
 * puts a new set in its place. The old teardown cannot damage the replacement,
 * because a set is only ever orphaned at the moment it becomes empty and
 * nothing can refill it afterwards — registration always looks the key up
 * fresh. An orphaned set is empty forever, so `delete` returns false and the
 * stale teardown stops before the size check it would otherwise get wrong.
 */
function listenIn<C>(
  registry: Registry<C>,
  path: Path,
  callback: C,
): () => void {
  const key = path.key
  let set = registry.get(key)
  if (!set) {
    set = new Set()
    registry.set(key, set)
  }
  const registered = set
  registered.add(callback)
  return () => {
    if (!registered.delete(callback)) return
    if (registered.size === 0) registry.delete(key)
  }
}

/**
 * Fire a plan's callbacks. Imperative Shell — all the deciding happened in
 * `planDelivery`; this only builds changesets and calls functions.
 *
 * **Ordering.** Every own-path callback fires first, in first-touch order, then
 * every deep callback, deepest-first. Before the per-subscriber merge the two
 * channels interleaved per changed path — own(P1), deep(P1→root), own(P2),
 * deep(P2→root) — because delivery happened inside the walk. Planning before
 * firing is what collapses a subscriber's several changesets into one, and this
 * ordering is the price of that. It is a deliberate trade, not a side effect.
 *
 * One `Changeset` is built per *key* and shared by every callback registered
 * there. Several ref carriers can sit at the same path (see "Per-ref-instance
 * carrier multiplication" in TECHNICAL.md), and allocating per callback would
 * multiply garbage for no benefit.
 *
 * @param plan - From `planDelivery`.
 * @param listeners - Own-path subscribers, keyed by path (from `ensurePrepareWiring`).
 * @param descendants - Deep subscribers, keyed by their own path.
 * @param options - `BatchOptions`. All four `BatchMetadata` channels ride
 *   unchanged onto every emitted `Changeset`: `origin` (app label), `replay`
 *   (state authored elsewhere), `aborted` (the block threw and was
 *   compensated), and `source` (echo-suppression token).
 */
export function deliverNotifications(
  plan: DeliveryPlan,
  listeners: ReadonlyMap<
    string,
    ReadonlySet<(cs: Changeset<ChangeBase>) => void>
  >,
  descendants: ReadonlyMap<string, ReadonlySet<(cs: Changeset<Op>) => void>>,
  options?: BatchOptions,
): void {
  for (const [key, changes] of plan.ownPath) {
    const set = listeners.get(key)
    if (!set || set.size === 0) continue
    const changeset: Changeset<ChangeBase> = {
      changes,
      origin: options?.origin,
      replay: options?.replay,
      aborted: options?.aborted,
      source: options?.source,
    }
    // Snapshot before calling. A callback is free to unsubscribe — itself or
    // anyone else — and a `Set` being iterated live would then skip a
    // subscriber it had not reached yet, silencing someone who never asked to
    // leave. The copy costs one small array per key that has subscribers.
    for (const callback of [...set]) callback(changeset)
  }

  for (const key of plan.deepOrder) {
    const subscribersHere = descendants.get(key)
    if (!subscribersHere || subscribersHere.size === 0) continue
    const changes = plan.deep.get(key)
    if (!changes) continue
    const changeset: Changeset<Op> = {
      changes,
      origin: options?.origin,
      replay: options?.replay,
      aborted: options?.aborted,
      source: options?.source,
    }
    // Snapshot for the same reason as the own-path loop above.
    for (const callback of [...subscribersHere]) callback(changeset)
  }
}

// ---------------------------------------------------------------------------
// Shape-grammar helpers — pure transforms over Changeset shape
// ---------------------------------------------------------------------------

/**
 * Lift a `Changeset<C>` to `Changeset<Op<C>>` by wrapping each change
 * with a constant path.
 *
 * Used wherever a leaf-shaped (own-path) changeset needs to be promoted
 * to tree-shaped (addressed Op) delivery: leaf `subscribeDescendants`,
 * composite own-path fan-out into tree subscribers.
 *
 * Pure, table-testable. Exported for tests; not re-exported from index.
 */
export function liftToOps<C extends ChangeBase>(
  changeset: Changeset<C>,
  path: Path,
): Changeset<Op<C>> {
  return {
    changes: changeset.changes.map(change => ({ path, change })),
    origin: changeset.origin,
    replay: changeset.replay,
    aborted: changeset.aborted,
    source: changeset.source,
  }
}

/**
 * Synthetic `Changeset<ChangeBase>` for terminal-event delivery on a
 * deleted tree node. Extracted as a first-class helper so the wire
 * shape lives in one place — `createTreeChangefeed` dispatches it
 * through the path-keyed listener channel; subscribers see the lifted
 * `Changeset<Op>` form indistinguishable from a real own-path delivery.
 *
 * Pure, table-testable; subscribers pattern-match on
 * `changeset.changes[0].type === "tree" && instructions[0].action === "delete"`.
 */
export function synthesizeTreeDeleteTerminal(
  id: string,
): Changeset<ChangeBase> {
  return {
    changes: [treeChange([{ action: "delete", target: id }])],
  }
}

// ---------------------------------------------------------------------------
// Prepare/flush wrapping — per-context, idempotent
// ---------------------------------------------------------------------------

/**
 * Per-context state for the changefeed layer's prepare/flush wrapping.
 *
 * - `listeners` / `descendants`: the two subscriber registries, written into
 *   by `listenIn` when someone subscribes. Together they are the
 *   `ChangefeedChannels` a factory is handed.
 * - `originalPrepare` / `originalFlush`: the unwrapped methods, called
 *   before/after the changefeed layer's logic.
 * - `populated`: monotonic set of path keys that have received at least
 *   one mutation. Once a key enters this set it never leaves (except
 *   on substrate reset). Used by `populated` changefeeds.
 * - `populatedListeners`: callbacks waiting for a specific path key to
 *   become populated. Fired at most once per path key, then removed.
 *
 * The notification accumulator (`Op[]`) is encapsulated inside the
 * dispatcher handler's closure — it is no longer persisted on this state
 * record. Likewise, no `isFlushing` flag: re-entrant `batch()` calls from
 * inside subscriber delivery enqueue an `accumulate` Msg back into the
 * per-context dispatcher and drain in a fresh sub-tick.
 */
interface ContextWiringState {
  readonly listeners: OwnPathRegistry
  readonly descendants: DeepRegistry
  readonly originalPrepare: (
    path: Path,
    change: ChangeBase,
    options?: BatchOptions,
  ) => void
  readonly originalFlush: (options?: BatchOptions) => void
  readonly populated: Set<string>
  readonly populatedListeners: Map<string, Set<() => void>>
  readonly handle: DispatcherHandle<ChangefeedMsg>
}

/**
 * Internal dispatcher message type for the per-context notification
 * pipeline. Not exported — fully encapsulated inside `with-changefeed.ts`.
 *
 * - `accumulate`: a `prepare` call observed a substrate mutation; queue
 *   its `Op` for the next flush. The substrate write happens synchronously
 *   in `wrappedPrepare` *before* this Msg is dispatched, so the accumulate
 *   Msg carries no options — it's a pure notification-side concern.
 * - `flush`: a `flush` call requested commit + notification delivery.
 *   Carries `options` so the resulting `Changeset` surfaces both `origin`
 *   and `replay` to subscribers.
 */
/**
 * Sum-typed writer log entry — the change-Writer monad's log element.
 * `compensating: true` discriminates inverse ops (run under the
 * undo-replay handler) from forward ops.
 */
type AccumulatorEntry = { readonly op: Op; readonly compensating?: boolean }

type ChangefeedMsg =
  | { type: "accumulate"; op: Op; compensating?: boolean }
  | { type: "flush"; options: BatchOptions | undefined }

/**
 * Returns `true` if `ctx` has `prepare` and `flush` methods — i.e. it's
 * a `WritableContext`, not a plain `RefContext`. This duck-type check
 * allows `withChangefeed` to keep its `RefContext` type signature while
 * participating in the prepare pipeline when composed with `withWritable`.
 */
function hasPreparePipeline(ctx: RefContext): ctx is RefContext & {
  prepare: (path: Path, change: ChangeBase, options?: BatchOptions) => void
  flush: (options?: BatchOptions) => void
} {
  return (
    "prepare" in ctx &&
    typeof ctx.prepare === "function" &&
    "flush" in ctx &&
    typeof ctx.flush === "function"
  )
}

// WeakMap ensures a single prepare/flush wrapper per context,
// shared across all nodes interpreted with that context.
const contextState = new WeakMap<RefContext, ContextWiringState>()

/**
 * Ensures the given context has its `prepare` and `flush` wrapped
 * for changefeed notification. Returns the shared listener map, or
 * `null` if the context doesn't have `prepare`/`flush` (read-only
 * stack).
 *
 * On read-only stacks, returns `null` — `.subscribe` callbacks are
 * registered in a local listener map but never fired. This produces
 * valid static Moore machines (.current works, .subscribe is a no-op).
 *
 * On read-write stacks:
 * - `prepare` wrapping: synchronously calls the inner prepare (substrate
 *   write), marks the path populated, then dispatches an `accumulate`
 *   Msg into the per-context dispatcher to queue this Op for notification.
 * - `flush` wrapping: dispatches a `flush` Msg. The dispatcher's handler
 *   snapshots the queued accumulator, calls `planDelivery` (pure),
 *   calls the inner flush (so the substrate's version and log are
 *   up-to-date), then `deliverNotifications` (imperative) to fire
 *   listeners. Re-entrant `batch()` calls from inside a subscriber land
 *   back in `wrappedPrepare`, which dispatches another `accumulate` Msg.
 *   The dispatcher's drain-to-quiescence loop catches it and the next
 *   `flush` dispatch processes it in a fresh sub-tick.
 *
 * The lease — if attached on `ctx.lease` before this function runs — is
 * shared with the Exchange and Synchronizer, so cross-doc cascades and
 * tick-induced re-entry are bounded by one cooperating budget.
 */

// WeakMap for read-only contexts: each gets its own orphaned listener
// map. Subscribers register but nothing feeds into it — valid static
// Moore machine. Separate per-context to avoid cross-contamination.
const readOnlyState = new WeakMap<RefContext, ChangefeedChannels>()

/**
 * The two subscriber registries a changefeed writes into: own-path and
 * descendant. Bundled so `wireChangefeed` can hand both to a factory without
 * every factory growing a second parameter it may not use.
 */
interface ChangefeedChannels {
  readonly listeners: OwnPathRegistry
  readonly descendants: DeepRegistry
}

function ensurePrepareWiring(ctx: RefContext): ChangefeedChannels {
  if (!hasPreparePipeline(ctx)) {
    let channels = readOnlyState.get(ctx)
    if (!channels) {
      channels = { listeners: new Map(), descendants: new Map() }
      readOnlyState.set(ctx, channels)
    }
    return channels
  }

  let state = contextState.get(ctx)
  if (state)
    return { listeners: state.listeners, descendants: state.descendants }

  const listeners: OwnPathRegistry = new Map()
  const descendants: DeepRegistry = new Map()
  // The change-Writer monad's log — sum-typed `Forward Op | Inverse Op`.
  // `batch(doc, fn)` slices this via FORWARD_OPS_MARKER/SINCE to recover
  // its forward-only return value. planDelivery consumes the whole
  // log (both forward and inverse entries) so subscribers see the full
  // op trace on aborted Changesets.
  const accumulator: AccumulatorEntry[] = []
  const populated = new Set<string>()
  const populatedListeners = new Map<string, Set<() => void>>()
  const originalPrepare = ctx.prepare
  const originalFlush = ctx.flush

  // Per-context dispatcher. Re-entrant `batch()` calls from inside
  // subscriber delivery dispatch `accumulate` Msgs back into this same
  // dispatcher; the drain-to-quiescence loop processes them in fresh
  // sub-ticks. A `flush` Msg whose `accumulator.length === 0` (no
  // mutations since the last drain) still calls `originalFlush(options)`
  // — preserving the invariant that substrate-level flush always runs.
  const handle = createDispatcher<ChangefeedMsg>(
    msg => {
      if (msg.type === "accumulate") {
        accumulator.push({ op: msg.op, compensating: msg.compensating })
        return
      }
      // msg.type === "flush"
      if (accumulator.length === 0) {
        originalFlush(msg.options)
        return
      }
      // The planner consumes the whole log — both forward and inverse
      // entries land in the delivered Changeset. Subscribers see the full
      // op log on aborted Changesets (forward+inverse pairs that net to
      // identity), so the `compensating` tag is deliberately not filtered
      // here. It exists for the writer log's own forward-only slicing.
      //
      // `listeners` and `descendants` are passed as membership tests: the
      // planner only asks whether a key has subscribers, so there is no need
      // to snapshot their keys.
      const plan = planDelivery(
        accumulator.map(e => e.op),
        listeners,
        descendants,
      )
      accumulator.length = 0
      // Commit to the substrate first so version() and delta() reflect
      // the just-flushed operations when subscribers read them.
      originalFlush(msg.options)
      deliverNotifications(plan, listeners, descendants, msg.options)
    },
    {
      lease: (ctx as { lease?: Lease }).lease,
      label: "changefeed",
    },
  )

  // Wrapped prepare: apply change to substrate synchronously (forwarding
  // `options` so the substrate sees `replay`/`compensating` at write
  // time), mark populated synchronously, then dispatch the accumulate
  // Msg tagged with `compensating` so the writer log can discriminate
  // forward from inverse entries. Notification-side `origin`/`replay`/
  // `aborted` ride on the subsequent `flush` Msg.
  const wrappedPrepare = (
    path: Path,
    change: ChangeBase,
    options?: BatchOptions,
  ): void => {
    // Resolve raw paths to addressed paths so that path.key matches
    // the identity-stable keys used by changefeed listeners and cache
    // invalidation handlers. Idempotent for already-addressed paths.
    const rootPath = (ctx as { rootPath?: unknown }).rootPath
    const resolved =
      rootPath instanceof AddressedPath
        ? resolveToAddressed(path, rootPath.registry)
        : path
    originalPrepare(resolved, change, options)
    markPopulated(resolved, populated, populatedListeners)
    handle.dispatch({
      type: "accumulate",
      op: { path: resolved, change },
      compensating: options?.compensating,
    })
  }

  // Wrapped flush: dispatch a flush Msg carrying the full options. The
  // handler enforces the order (originalFlush → deliverNotifications)
  // inside the dispatcher's drain.
  const wrappedFlush = (options?: BatchOptions): void => {
    handle.dispatch({ type: "flush", options })
  }

  ctx.prepare = wrappedPrepare
  ctx.flush = wrappedFlush

  // FORWARD_OPS_* accessors are owned by buildWritableContext (it
  // maintains the writer log directly, so `batch()` works on any
  // stack with/without the observation layer). The changefeed
  // accumulator here is a separate concern: notification grouping.

  state = {
    listeners,
    descendants,
    originalPrepare,
    originalFlush,
    populated,
    populatedListeners,
    handle,
  }
  contextState.set(ctx, state)
  return { listeners, descendants }
}

/**
 * Number of own-path listener registrations at `pathKey` for the given context.
 *
 * @internal Not exported from the package barrel.
 *
 * Test-only, and modelled on `__getCacheHandlerCountAtPath` in
 * `with-caching.ts` — the same problem one interpreter over. A registration
 * that outlives its subscriber costs memory and per-flush work and nothing
 * else: delivery still calls exactly the callbacks that are subscribed, so a
 * test counting callbacks passes whether or not the registry accretes. Reading
 * the structure is the test that actually holds.
 */
export function __getListenerCountAtPath(ctx: object, pathKey: string): number {
  const state = contextState.get(ctx as RefContext)
  return state?.listeners.get(pathKey)?.size ?? 0
}

// ---------------------------------------------------------------------------
// Populated tracking
// ---------------------------------------------------------------------------

/**
 * Mark a path and all its ancestors as populated.
 *
 * "Populated" means a mutation has been applied at this path or a
 * descendant. This is a monotonic lattice: once true, never false
 * (except on substrate reset).
 *
 * When a path transitions from unpopulated to populated, any registered
 * listeners for that path key are fired and removed.
 */
function markPopulated(
  path: Path,
  populated: Set<string>,
  populatedListeners: Map<string, Set<() => void>>,
): void {
  // Mark the exact path
  const key = path.key
  if (!populated.has(key)) {
    populated.add(key)
    firePopulatedListeners(key, populatedListeners)
  }

  // Mark all ancestor paths (prefix walk)
  for (let i = path.length - 1; i >= 0; i--) {
    const ancestorKey = path.slice(0, i).key
    if (populated.has(ancestorKey)) break // already marked, ancestors are too
    populated.add(ancestorKey)
    firePopulatedListeners(ancestorKey, populatedListeners)
  }
}

function firePopulatedListeners(
  key: string,
  populatedListeners: Map<string, Set<() => void>>,
): void {
  const set = populatedListeners.get(key)
  if (set) {
    // Fire all listeners, then remove — this fires at most once per path
    for (const callback of set) callback()
    populatedListeners.delete(key)
  }
}

/**
 * Create a `RecursiveChangefeedProtocol<boolean>` for the population state
 * at a path — the protocol behind `populatedFeed(ref)` / `populated(ref)`.
 *
 * - `.current` reads from the populated set (true if this path key is in the set)
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
  populated: Set<string>,
  populatedListeners: Map<string, Set<() => void>>,
): RecursiveChangefeedProtocol<boolean, ChangeBase> {
  const key = path.key

  const subscribe = (
    callback: (changeset: Changeset<ChangeBase>) => void,
  ): (() => void) => {
    // Already populated — fire immediately via microtask
    if (populated.has(key)) {
      Promise.resolve().then(() =>
        callback({ changes: [], origin: "populated" }),
      )
      return () => {}
    }

    // Not yet populated — register a one-shot listener
    let set = populatedListeners.get(key)
    if (!set) {
      set = new Set()
      populatedListeners.set(key, set)
    }
    const handler = () => callback({ changes: [], origin: "populated" })
    set.add(handler)
    return () => {
      set?.delete(handler)
      if (set?.size === 0) populatedListeners.delete(key)
    }
  }

  return {
    get current(): boolean {
      return populated.has(key)
    },
    subscribe,
    subscribeDescendants(callback) {
      return subscribe(changeset => callback(liftToOps(changeset, path.root())))
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
  populated: Set<string>,
  populatedListeners: Map<string, Set<() => void>>,
): void {
  const changefeed = createPopulatedChangefeed(
    path,
    populated,
    populatedListeners,
  )
  const populatedRef = Object.create(null) as Record<symbol, unknown>
  Object.defineProperty(populatedRef, CHANGEFEED, {
    value: changefeed,
    enumerable: false,
    configurable: false,
    writable: false,
  })
  // Also make it callable: populatedRef() returns the boolean
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

/**
 * Get the populated state for a context. Returns the populated set and
 * listeners map. For read-only stacks (no prepare pipeline), returns a
 * static empty set — `populated` will always be false.
 */
function getPopulatedState(ctx: RefContext): {
  populated: Set<string>
  populatedListeners: Map<string, Set<() => void>>
} {
  if (!hasPreparePipeline(ctx)) {
    // Read-only stack — no mutations possible, nothing is ever populated
    return { populated: new Set(), populatedListeners: new Map() }
  }
  const state = contextState.get(ctx)
  if (state) {
    return {
      populated: state.populated,
      populatedListeners: state.populatedListeners,
    }
  }
  // ensurePrepareWiring hasn't been called yet — call it to initialize
  ensurePrepareWiring(ctx)
  const initialized = contextState.get(ctx)
  if (initialized) {
    return {
      populated: initialized.populated,
      populatedListeners: initialized.populatedListeners,
    }
  }
  // Unreachable in practice — `ensurePrepareWiring` populates the map for any
  // context with a prepare pipeline, and the read-only case returned above.
  // Answering with empties rather than asserting keeps that assumption from
  // becoming a crash if a future context shape breaks it.
  return { populated: new Set(), populatedListeners: new Map() }
}

// ---------------------------------------------------------------------------
// Changefeed factories
// ---------------------------------------------------------------------------

/**
 * Builds the `RecursiveChangefeedProtocol` for a node — any node.
 *
 * One factory serves every schema kind except `tree`. That is not a
 * simplification applied on top; it is what the design reduced to. Sequence,
 * map and tree used to each carry a per-key map of forwarder subscriptions
 * plus wire/unwire machinery to rebuild it as entries came and went, and a
 * product used to subscribe to its own fields. All of it existed to keep a
 * derived structure aligned with a document whose shape changes at runtime.
 *
 * Delivery no longer needs that structure. A subscriber records the path it
 * sits at, and `deliverNotifications` finds it by walking each changed path's
 * ancestors — recomputed per flush from the path alone, so there is nothing to
 * keep aligned and no reference to a child ref object that could go stale. See
 * "Why there are no dynamic-collection changefeed factories" in
 * `packages/schema/TECHNICAL.md` for what that machinery was and the bug that
 * forced the question.
 *
 * What remains is the same for a scalar and a record: register own-path
 * subscribers in one registry, deep subscribers in the other. Even the leaf
 * case is not special — a leaf is a tree of size one, so its own change *is*
 * its whole subtree, and the ancestor walk reaches its deep subscribers at
 * relative path `[]`.
 *
 * (Do not confuse this with the *populated* feed further up, whose
 * `subscribeDescendants` really is an own-path → Op lift via `liftToOps`. That
 * feed reports readiness rather than content, and it is the only deep channel
 * in the file that does not go through the ancestor walk.)
 */
function createNodeChangefeed(
  channels: ChangefeedChannels,
  path: Path,
  readCurrent: () => unknown,
): RecursiveChangefeedProtocol<unknown, ChangeBase> {
  return {
    get current() {
      return readCurrent()
    },
    subscribe: callback => listenIn(channels.listeners, path, callback),
    subscribeDescendants: callback =>
      listenIn(channels.descendants, path, callback),
  }
}

/**
 * Creates a RecursiveChangefeedProtocol for a `Schema.tree` node.
 *
 * Routing works like every other composite: subscribers register at their own
 * path and the ancestor walk finds them.
 *
 * The tree does carry one responsibility that is not routing — a **terminal
 * event** when a node is deleted. Its subscribers need to learn that their node
 * is gone, and no ordinary change can tell them: once the node is deleted, no
 * op targets its path again. So the delete instructions are scanned directly.
 *
 * Only trees get this. TreeIDs are CRDT-stable identifiers minted at create
 * time and never reused, so a subscriber at `d.tree.node(id)` holds a
 * meaningful identity reference and deserves a lifecycle-end signal. Map keys
 * are user-chosen strings that can come and go, and sequence items are
 * positional; neither carries that invariant.
 */
function createTreeChangefeed(
  channels: ChangefeedChannels,
  path: Path,
  readCurrent: () => unknown,
): RecursiveChangefeedProtocol<unknown, ChangeBase> {
  function deliverDeleteTerminal(id: string): void {
    // Delivered straight to the deleted node's own key rather than through the
    // notification plan, and deliberately so: it must reach that node only.
    // The tree already reported the deletion via its own-path change, so an
    // ancestor receiving the terminal as well would see the same delete twice.
    //
    // Both channels are fed by hand here. This is the one event in the system
    // that is synthesized rather than derived from an op, so it is the one
    // place the ancestor walk cannot do the routing. The facade `subscribe` is
    // `subscribeDescendants`, so a per-node subscriber sits in the descendant
    // map, while `.subscribe(callback)` on the node sits in the own-path map.
    const nodePath = path.node(id)
    const nodeKey = nodePath.key
    const synthetic = synthesizeTreeDeleteTerminal(id)

    const ownPathSubscribers = channels.listeners.get(nodeKey)
    if (ownPathSubscribers && ownPathSubscribers.size > 0) {
      // Snapshot, for the same reason `deliverNotifications` does: a callback
      // may change this set while it is being walked, and a `Set` visits
      // entries added mid-iteration.
      for (const callback of [...ownPathSubscribers]) callback(synthetic)
    }

    const descendantSubscribers = channels.descendants.get(nodeKey)
    if (descendantSubscribers && descendantSubscribers.size > 0) {
      const lifted = liftToOps(synthetic, nodePath.root())
      for (const callback of [...descendantSubscribers]) callback(lifted)
    }
  }

  // The delete scan is the tree's one job that is not a subscription, so it
  // gets its own registration and keeps it for the life of the carrier. Every
  // other entry in the own-path registry belongs to a subscriber and leaves
  // when that subscriber does; this one has to see every changeset whether or
  // not anyone is listening to the tree, because the node being deleted may
  // have subscribers even when the tree itself has none.
  //
  // Registered here rather than on first subscription, which also fixes the
  // ordering: it is added before any subscriber, and the registry iterates in
  // insertion order, so a node learns it is gone before the tree's own-path
  // subscribers hear about the batch that removed it.
  listenIn(channels.listeners, path, changeset => {
    for (const change of changeset.changes) {
      if (!isTreeChange(change)) continue
      for (const inst of change.instructions) {
        if (inst.action === "delete") deliverDeleteTerminal(inst.target)
      }
    }
  })

  return {
    get current() {
      return readCurrent()
    },
    subscribe: callback => listenIn(channels.listeners, path, callback),
    subscribeDescendants: callback =>
      listenIn(channels.descendants, path, callback),
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
 * Notification flows through the changefeed tree, not flat subscriber maps.
 * Each node's `subscribeDescendants` composes its children's changefeeds.
 *
 * **Prepare/flush wrapping:** The transformer wraps `ctx.prepare` to
 * accumulate `{path, change}` entries after each store mutation (no
 * notification fires). It wraps `ctx.flush` to group accumulated
 * entries by path and deliver one `Changeset` per subscriber.
 *
 * This means:
 * - Auto-commit (single mutation via `dispatch`): `executeBatch` calls
 *   `prepare` once + `flush` once → subscribers receive a `Changeset`
 *   with exactly 1 change.
 * - Transaction commit: `executeBatch` calls `prepare` N times + `flush`
 *   once → subscribers receive a `Changeset` with N changes. Subscribers
 *   never see partially-applied state.
 *
 * **Transaction compatibility:** During a transaction, `dispatch` buffers
 * changes. On `commit()`, `executeBatch` calls `prepare` N times then
 * `flush` once, so subscribers fire at commit time — not during buffering.
 *
 * ```ts
 * // Full stack (read + write + observe):
 * const interp = withChangefeed(withWritable(withCaching(withReadable(withNavigation(bottom)))))
 * const ctx = createPlainSubstrate(store).context()
 * const doc = interpret(schema, interp, ctx)
 * doc[CHANGEFEED].subscribe(callback)       // fires on mutation
 *
 * // Read-only stack (observe without mutation):
 * const roInterp = withChangefeed(withCaching(withReadable(withNavigation(bottom))))
 * const roDoc = interpret(schema, roInterp, { store })
 * roDoc[CHANGEFEED].current           // works — reads via [CALL]
 * roDoc[CHANGEFEED].subscribe(callback)     // valid — never fires
 * ```
 */

// ---------------------------------------------------------------------------
// wireChangefeed — shared boilerplate for all changefeed cases
// ---------------------------------------------------------------------------

/**
 * Wire a changefeed onto a ref. Handles isPropertyHost guard, prepare wiring,
 * changefeed attachment, and populated attachment. The `createCf` closure
 * receives prepare listeners AND path (avoiding double-capture) and returns
 * the kind-specific changefeed protocol.
 *
 * If `result` is not a property host (e.g. a primitive), this is a no-op —
 * the caller still casts the return type, matching existing behavior.
 */
function wireChangefeed(
  result: unknown,
  ctx: RefContext,
  path: Path,
  createCf: (
    channels: ChangefeedChannels,
    path: Path,
  ) => RecursiveChangefeedProtocol<unknown, ChangeBase>,
): void {
  if (isPropertyHost(result)) {
    const channels = ensurePrepareWiring(ctx)
    const changefeed = createCf(channels, path)
    attachChangefeed(result as object, changefeed)
    const populatedState = getPopulatedState(ctx)
    attachIsPopulated(
      result as object,
      path,
      populatedState.populated,
      populatedState.populatedListeners,
    )
  }
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
      wireChangefeed(result, ctx, path, (channels, nodePath) =>
        createNodeChangefeed(channels, nodePath, () => result[CALL]()),
      )
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
      wireChangefeed(result, ctx, path, (channels, nodePath) =>
        createNodeChangefeed(channels, nodePath, () => result[CALL]()),
      )
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
      wireChangefeed(result, ctx, path, (channels, nodePath) =>
        createNodeChangefeed(channels, nodePath, () => result[CALL]()),
      )
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
      wireChangefeed(result, ctx, path, (channels, nodePath) =>
        createNodeChangefeed(channels, nodePath, () => result[CALL]()),
      )
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
      wireChangefeed(result, ctx, path, (channels, nodePath) =>
        createNodeChangefeed(channels, nodePath, () => result[CALL]()),
      )
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
      wireChangefeed(result, ctx, path, (channels, nodePath) =>
        createNodeChangefeed(channels, nodePath, () => result[CALL]()),
      )
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
      wireChangefeed(result, ctx, path, (channels, nodePath) =>
        createNodeChangefeed(channels, nodePath, () => result[CALL]()),
      )
      return result as A & HasChangefeed
    },

    // --- Tree -----------------------------------------------------------------
    // See `createTreeChangefeed` for the per-TreeID fan-out + terminal-on-delete
    // semantics; identical shape to sequence/map's wireChangefeed call.
    tree(
      ctx: RefContext,
      path: Path,
      schema: TreeSchema,
      nodes: () => readonly FlatTreeNode<A>[],
      node: (id: string) => A,
    ): A & HasChangefeed {
      const result = base.tree(ctx, path, schema, nodes, node)
      wireChangefeed(result, ctx, path, (channels, nodePath) =>
        createTreeChangefeed(channels, nodePath, () => result[CALL]()),
      )
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
      wireChangefeed(result, ctx, path, (channels, nodePath) =>
        createNodeChangefeed(channels, nodePath, () => result[CALL]()),
      )
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
      wireChangefeed(result, ctx, path, (channels, nodePath) =>
        createNodeChangefeed(channels, nodePath, () => result[CALL]()),
      )
      return result as A & HasChangefeed
    },
  }
}

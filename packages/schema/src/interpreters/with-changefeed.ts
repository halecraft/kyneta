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
//
// See .plans/navigation-layer.md §Phase 2, Task 2.2b.

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

export const POPULATED: unique symbol = Symbol.for("kyneta:populated") as any

/**
 * Returns true if the ref has been populated (received at least one mutation).
 * Returns false if it has not been populated, or if it is not a ref that tracks
 * population.
 */
export function isPopulated(ref: unknown): boolean {
  if (ref === null || ref === undefined) return false
  const populatedCf = (ref as any)[POPULATED]
  if (!populatedCf) return false
  return populatedCf() === true
}

/**
 * Returns a callable that implements the `[CHANGEFEED]` protocol for the
 * ref's population state. The callable returns a boolean (true if populated).
 * You can subscribe to it via `subscribeNode(populated(ref), ...)`.
 * Throws if the ref does not track population.
 */
export function populated(
  ref: unknown,
): (() => boolean) & HasChangefeed<boolean> {
  if (!ref || !(POPULATED in (ref as object))) {
    throw new Error(
      "populated() requires a ref that tracks population (e.g. a ref produced by withChangefeed)",
    )
  }
  return (ref as any)[POPULATED]
}

// ---------------------------------------------------------------------------
// Attach [CHANGEFEED] non-enumerably to any object
// ---------------------------------------------------------------------------

/**
 * Attaches a `[CHANGEFEED]` symbol property non-enumerably to `target`.
 * Uses `Object.defineProperty` to bypass Proxy `set` traps on map refs.
 */
export function attachChangefeed(
  target: object,
  cf: RecursiveChangefeedProtocol<unknown, ChangeBase>,
): asserts target is HasChangefeed {
  Object.defineProperty(target, CHANGEFEED, {
    value: cf,
    enumerable: false,
    configurable: true,
    writable: false,
  })
}

// ---------------------------------------------------------------------------
// Notification plan — Functional Core (pure, table-testable)
// ---------------------------------------------------------------------------

/**
 * A notification plan groups accumulated `{path, change}` pairs by
 * `pathKey` so that each listener path receives exactly one `Changeset`
 * per flush cycle.
 *
 * This is the Functional Core of the changefeed notification pipeline,
 * following the same FC/IS pattern as `planCacheUpdate`/`applyCacheOps`
 * in `withCaching`.
 */
export interface NotificationPlan {
  /**
   * Per-path grouped changes. Map key is `pathKey(path)`.
   * Each entry is the array of `ChangeBase` objects dispatched at
   * that path during this batch.
   */
  readonly grouped: ReadonlyMap<string, readonly ChangeBase[]>
  /**
   * One representative `Path` per group key.
   *
   * Descendant delivery walks each changed path's ancestors, and that walk has
   * to work on the segments — the key string alone cannot support it. See the
   * note on `deliverNotifications` for why deriving ancestors from the key
   * string is wrong rather than merely inelegant.
   */
  readonly paths: ReadonlyMap<string, Path>
}

/**
 * Given accumulated pending changes, group them by `pathKey`.
 *
 * Pure function — no mutation, no side effects. Returns fresh data.
 *
 * This is table-testable: "given 3 changes at 2 paths, the plan
 * produces 2 entries with the correct grouping."
 *
 * @param pending - Accumulated `{path, change}` pairs from prepare calls.
 * @returns A `NotificationPlan` with changes grouped by pathKey.
 */
export function planNotifications(pending: readonly Op[]): NotificationPlan {
  const grouped = new Map<string, ChangeBase[]>()
  const paths = new Map<string, Path>()
  for (const { path, change } of pending) {
    const key = path.key
    let arr = grouped.get(key)
    if (!arr) {
      arr = []
      grouped.set(key, arr)
      paths.set(key, path)
    }
    arr.push(change)
  }
  return { grouped, paths }
}

/**
 * Deliver notifications from a plan to listeners.
 *
 * Imperative Shell — trivial delivery. Builds one `Changeset` per path
 * that has listeners and fires all registered callbacks.
 *
 * @param plan - The notification plan from `planNotifications`.
 * @param listeners - The path-keyed listener map (from `ensurePrepareWiring`).
 * @param options - Optional `BatchOptions`. `options?.origin` is attached
 *   to each emitted `Changeset` as the app-level label;
 *   `options?.replay` is attached as the structural directive.
 */
/**
 * Register a descendant subscriber at a node's own path.
 *
 * The counterpart to `listenAtPath` for the deep channel. There is no wiring
 * here and nothing to tear down when the document changes shape: a subscriber
 * records where it sits, and `deliverNotifications` finds it by walking each
 * changed path upward.
 *
 * That is the whole reason this exists. The previous design had each composite
 * subscribe to its children's changefeeds and forward their changes upward,
 * which meant holding references to the child ref objects that existed at
 * wiring time. Those references go stale whenever the document's shape changes
 * — most sharply for a sum, whose carrier is swapped out on a variant shift —
 * and each dynamic composite had grown its own machinery to rebuild them.
 */
export function listenDescendants(
  descendants: Map<string, Set<(changeset: Changeset<Op>) => void>>,
  path: Path,
  callback: (changeset: Changeset<Op>) => void,
): () => void {
  const key = path.key
  let set = descendants.get(key)
  if (!set) {
    set = new Set()
    descendants.set(key, set)
  }
  set.add(callback)
  return () => {
    set?.delete(callback)
    if (set?.size === 0) descendants.delete(key)
  }
}

export function deliverNotifications(
  plan: NotificationPlan,
  listeners: ReadonlyMap<
    string,
    Set<(changeset: Changeset<ChangeBase>) => void>
  >,
  descendants: ReadonlyMap<string, Set<(changeset: Changeset<Op>) => void>>,
  options?: BatchOptions,
): void {
  for (const [key, changes] of plan.grouped) {
    // Own-path channel — subscribers watching exactly this node.
    const set = listeners.get(key)
    if (set && set.size > 0) {
      const changeset: Changeset<ChangeBase> = {
        changes,
        origin: options?.origin,
        replay: options?.replay,
        aborted: options?.aborted,
        source: options?.source,
      }
      for (const cb of set) cb(changeset)
    }

    // Descendant channel — every subscriber at this path or above it. The set
    // of ancestors is derivable from the path itself, so nothing has to be
    // maintained between flushes; `markPopulated` below answers the same
    // "tell everyone above me" question the same way.
    if (descendants.size === 0) continue
    const path = plan.paths.get(key)
    if (!path) continue

    // Deepest-first. The order is chosen here rather than emerging from the
    // shape of a subscription graph, which is what determined it before —
    // delivery order used to depend on the sequence in which subscribers
    // happened to register.
    for (let i = path.length; i >= 0; i--) {
      // Structural: take the first `i` segments, then compute THAT path's key.
      //
      // A key is its segments joined by a separator, so ancestor keys look like
      // prefixes of the key string, and cutting the string would be cheaper.
      // It is also wrong. Joining is lossy: a segment whose own text contains
      // the separator makes the split invent a level that never existed, and a
      // subscriber at that phantom path would receive changes from an unrelated
      // subtree. Slicing segments cannot produce a level that is not there.
      const ancestorKey = i === path.length ? key : path.slice(0, i).key
      const subscribersHere = descendants.get(ancestorKey)
      if (!subscribersHere || subscribersHere.size === 0) continue

      // Rebase only where someone is listening, so a deep document with few
      // subscribers pays for lookups but not for allocation. `path.slice(i)`
      // is the changed path relative to this ancestor; at `i === path.length`
      // that is the empty path, which is exactly the own-path case.
      const relative = path.slice(i)
      const rebased: Changeset<Op> = {
        changes: changes.map(change => ({ path: relative, change })),
        origin: options?.origin,
        replay: options?.replay,
        aborted: options?.aborted,
        source: options?.source,
      }
      for (const callback of subscribersHere) callback(rebased)
    }
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
  cs: Changeset<C>,
  path: Path,
): Changeset<Op<C>> {
  return {
    changes: cs.changes.map(change => ({ path, change })),
    origin: cs.origin,
    replay: cs.replay,
    aborted: cs.aborted,
    source: cs.source,
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
 * `cs.changes[0].type === "tree" && instructions[0].action === "delete"`.
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
 * - `listeners`: path-keyed map of subscriber callbacks. Each changefeed
 *   factory registers its own listener here via `listenAtPath`.
 * - `originalPrepare` / `originalFlush`: the unwrapped methods, called
 *   before/after the changefeed layer's logic.
 * - `populated`: monotonic set of path keys that have received at least
 *   one mutation. Once a key enters this set it never leaves (except
 *   on substrate reset). Used by `isPopulated` changefeeds.
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
  readonly listeners: Map<
    string,
    Set<(changeset: Changeset<ChangeBase>) => void>
  >
  /**
   * Descendant subscribers, keyed by the path they subscribed AT — not by the
   * paths they are interested in. A subscriber says "I am at P" once, and
   * delivery finds it by walking each changed path's ancestors.
   *
   * Kept separate from `listeners` because the two channels carry different
   * shapes: own-path subscribers get `Changeset<ChangeBase>`, descendant
   * subscribers get `Changeset<Op>` with a relative path per change.
   */
  readonly descendants: Map<string, Set<(changeset: Changeset<Op>) => void>>
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
    typeof (ctx as any).prepare === "function" &&
    "flush" in ctx &&
    typeof (ctx as any).flush === "function"
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
 *   snapshots the queued accumulator, calls `planNotifications` (pure),
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
  readonly listeners: Map<
    string,
    Set<(changeset: Changeset<ChangeBase>) => void>
  >
  readonly descendants: Map<string, Set<(changeset: Changeset<Op>) => void>>
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

  const listeners = new Map<
    string,
    Set<(changeset: Changeset<ChangeBase>) => void>
  >()
  const descendants = new Map<string, Set<(changeset: Changeset<Op>) => void>>()
  // The change-Writer monad's log — sum-typed `Forward Op | Inverse Op`.
  // `batch(doc, fn)` slices this via FORWARD_OPS_MARKER/SINCE to recover
  // its forward-only return value. planNotifications consumes the whole
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
      // planNotifications consumes the whole log — both forward and
      // inverse entries land in the delivered Changeset. Subscribers
      // see the full op log on aborted Changesets (forward+inverse
      // pairs that net to identity).
      const plan = planNotifications(accumulator.map(e => e.op))
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
 * Registers a listener for changes at a specific path.
 * Returns an unsubscribe function.
 *
 * Listeners receive `Changeset<ChangeBase>` — a batch of one or more
 * changes with optional origin. Auto-commit produces a degenerate
 * changeset of one; transactions and `applyChanges` produce multi-change
 * batches.
 */
function listenAtPath(
  listeners: Map<string, Set<(changeset: Changeset<ChangeBase>) => void>>,
  path: Path,
  callback: (changeset: Changeset<ChangeBase>) => void,
): () => void {
  const key = path.key
  let set = listeners.get(key)
  if (!set) {
    set = new Set()
    listeners.set(key, set)
  }
  set.add(callback)
  return () => {
    set?.delete(callback)
    if (set?.size === 0) {
      listeners.delete(key)
    }
  }
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
    for (const cb of set) cb()
    populatedListeners.delete(key)
  }
}

/**
 * Create a `RecursiveChangefeedProtocol<boolean>` for the `isPopulated`
 * property at a path.
 *
 * - `.current` reads from the populated set (true if this path key is in the set)
 * - `.subscribe` fires exactly once when the path transitions from
 *   unpopulated to populated. If already populated at subscribe time,
 *   the callback fires immediately (via microtask for consistency).
 * - `.subscribeDescendants` is the trivial own-path lift: the populated event
 *   has no payload (changes is empty by construction), so the delivered
 *   `Changeset<Op>` has an empty changes array; only `origin` is
 *   load-bearing. Provided so the facade `subscribe` works universally
 *   on `ref.isPopulated` carriers without a method-set check.
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
    subscribeDescendants(cb) {
      return subscribe(cs => cb(liftToOps(cs, path.root())))
    },
  }
}

/**
 * Attach the `isPopulated` property to a ref as a non-enumerable object
 * carrying its own `[CHANGEFEED]`.
 *
 * The property is an object with `[CHANGEFEED]: ChangefeedProtocol<boolean>`.
 * The compiler detects `[CHANGEFEED]` on the type and emits reactive
 * regions (e.g. `conditionalRegion` for `if (ref.isPopulated)`).
 */
function attachIsPopulated(
  target: object,
  path: Path,
  populated: Set<string>,
  populatedListeners: Map<string, Set<() => void>>,
): void {
  const cf = createPopulatedChangefeed(path, populated, populatedListeners)
  const populatedRef = Object.create(null) as Record<symbol, unknown>
  Object.defineProperty(populatedRef, CHANGEFEED, {
    value: cf,
    enumerable: false,
    configurable: false,
    writable: false,
  })
  // Also make it callable: populatedRef() returns the boolean
  const callable = function (this: unknown) {
    return cf.current
  } as any
  Object.defineProperty(callable, CHANGEFEED, {
    value: cf,
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
 * static empty set — `isPopulated` will always be false.
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
  const state2 = contextState.get(ctx) as any
  return {
    populated: state2.populated,
    populatedListeners: state2.populatedListeners,
  }
}

// ---------------------------------------------------------------------------
// Changefeed factories
// ---------------------------------------------------------------------------

/**
 * Builds the `RecursiveChangefeedProtocol` for a structurally-leaf node.
 *
 * Parallel structure with composite factories: shared `shallowSubs` /
 * `treeSubs` sets, one own-path listener registered via `listenAtPath`
 * that delegates fan-out to `fanOutOwnPath`. The leaf's `subscribeDescendants`
 * is the trivial own-path → Op lift with `path.root()` as the relative
 * path (a leaf is a tree of size 1).
 *
 * The factory name retains "Leaf" because it refers to the *input*
 * (leaf-shaped carrier), not the output protocol.
 */
function createLeafChangefeed(
  channels: ChangefeedChannels,
  path: Path,
  readCurrent: () => unknown,
): RecursiveChangefeedProtocol<unknown, ChangeBase> {
  const shallowSubs = new Set<(cs: Changeset<ChangeBase>) => void>()

  listenAtPath(channels.listeners, path, cs => {
    for (const cb of shallowSubs) cb(cs)
  })

  return {
    get current() {
      return readCurrent()
    },
    subscribe(cb) {
      shallowSubs.add(cb)
      return () => {
        shallowSubs.delete(cb)
      }
    },
    // A leaf is a tree of size one, so its deep channel carries exactly its own
    // change — delivered by the ancestor walk at relative path `[]`.
    subscribeDescendants(cb) {
      return listenDescendants(channels.descendants, path, cb)
    },
  }
}

/**
 * Creates a RecursiveChangefeedProtocol for a product (struct) node.
 *
 * `subscribe` fires only on changes at this node's own path.
 * `subscribeDescendants` fires for any change at or beneath it, each carrying
 * its path relative to this node.
 *
 * A product no longer subscribes to its fields. It used to, forwarding each
 * child's changes upward with the field name prepended — which meant holding a
 * reference to the child ref object that existed when the first descendant
 * subscriber arrived. For a fixed set of struct fields that looks safe, and for
 * a `.nullable()` field it is not: a sum has no changefeed of its own, so the
 * reference captured was the live variant's, and a later variant shift left it
 * pointing at a feed nobody writes to.
 */
function createProductChangefeed(
  channels: ChangefeedChannels,
  path: Path,
  readCurrent: () => unknown,
): RecursiveChangefeedProtocol<unknown, ChangeBase> {
  const shallowSubs = new Set<(changeset: Changeset<ChangeBase>) => void>()

  listenAtPath(channels.listeners, path, cs => {
    for (const cb of shallowSubs) cb(cs)
  })

  return {
    get current() {
      return readCurrent()
    },
    subscribe(
      callback: (changeset: Changeset<ChangeBase>) => void,
    ): () => void {
      shallowSubs.add(callback)
      return () => {
        shallowSubs.delete(callback)
      }
    },
    subscribeDescendants(
      callback: (changeset: Changeset<Op>) => void,
    ): () => void {
      return listenDescendants(channels.descendants, path, callback)
    },
  }
}

function createSequenceChangefeed(
  channels: ChangefeedChannels,
  path: Path,
  readCurrent: () => unknown,
): RecursiveChangefeedProtocol<unknown, ChangeBase> {
  const shallowSubs = new Set<(changeset: Changeset<ChangeBase>) => void>()

  listenAtPath(channels.listeners, path, cs => {
    for (const cb of shallowSubs) cb(cs)
  })

  return {
    get current() {
      return readCurrent()
    },
    subscribe(callback) {
      shallowSubs.add(callback)
      return () => {
        shallowSubs.delete(callback)
      }
    },
    // No child wiring, and nothing to rebuild when this collection changes
    // shape. Delivery locates subscribers by walking each changed path's
    // ancestors, so a subscription is never bound to a child ref object.
    subscribeDescendants(callback) {
      return listenDescendants(channels.descendants, path, callback)
    },
  }
}

/**
 * Creates a RecursiveChangefeedProtocol for a map (record) node.
 *
 * `subscribe` fires on MapChange at this node's own path;
 * `subscribeDescendants` additionally fires for per-entry content changes,
 * with the entry's path relative to this node.
 */
function createMapChangefeed(
  channels: ChangefeedChannels,
  path: Path,
  readCurrent: () => unknown,
): RecursiveChangefeedProtocol<unknown, ChangeBase> {
  const shallowSubs = new Set<(changeset: Changeset<ChangeBase>) => void>()

  listenAtPath(channels.listeners, path, cs => {
    for (const cb of shallowSubs) cb(cs)
  })

  return {
    get current() {
      return readCurrent()
    },
    subscribe(callback) {
      shallowSubs.add(callback)
      return () => {
        shallowSubs.delete(callback)
      }
    },
    // No child wiring, and nothing to rebuild when this collection changes
    // shape. Delivery locates subscribers by walking each changed path's
    // ancestors, so a subscription is never bound to a child ref object.
    subscribeDescendants(callback) {
      return listenDescendants(channels.descendants, path, callback)
    },
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
  const shallowSubs = new Set<(changeset: Changeset<ChangeBase>) => void>()

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
    // map, while `.subscribe(cb)` on the node sits in the own-path map.
    const nodePath = path.node(id)
    const nodeKey = nodePath.key
    const synthetic = synthesizeTreeDeleteTerminal(id)

    const ownPathSubscribers = channels.listeners.get(nodeKey)
    if (ownPathSubscribers && ownPathSubscribers.size > 0) {
      // Snapshot — a subscriber may unsubscribe itself on receiving a terminal.
      for (const callback of [...ownPathSubscribers]) callback(synthetic)
    }

    const descendantSubscribers = channels.descendants.get(nodeKey)
    if (descendantSubscribers && descendantSubscribers.size > 0) {
      const lifted = liftToOps(synthetic, nodePath.root())
      for (const callback of [...descendantSubscribers]) callback(lifted)
    }
  }

  listenAtPath(channels.listeners, path, cs => {
    for (const cb of shallowSubs) cb(cs)

    for (const change of cs.changes) {
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
    subscribe(
      callback: (changeset: Changeset<ChangeBase>) => void,
    ): () => void {
      shallowSubs.add(callback)
      return () => {
        shallowSubs.delete(callback)
      }
    },
    subscribeDescendants(
      callback: (changeset: Changeset<Op>) => void,
    ): () => void {
      return listenDescendants(channels.descendants, path, callback)
    },
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
 * doc[CHANGEFEED].subscribe(cb)       // fires on mutation
 *
 * // Read-only stack (observe without mutation):
 * const roInterp = withChangefeed(withCaching(withReadable(withNavigation(bottom))))
 * const roDoc = interpret(schema, roInterp, { store })
 * roDoc[CHANGEFEED].current           // works — reads via [CALL]
 * roDoc[CHANGEFEED].subscribe(cb)     // valid — never fires
 * ```
 */

// ---------------------------------------------------------------------------
// wireChangefeed — shared boilerplate for all changefeed cases
// ---------------------------------------------------------------------------

/**
 * Wire a changefeed onto a ref. Handles isPropertyHost guard, prepare wiring,
 * changefeed attachment, and isPopulated attachment. The `createCf` closure
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
    const cf = createCf(channels, path)
    attachChangefeed(result as object, cf)
    const ps = getPopulatedState(ctx)
    attachIsPopulated(
      result as object,
      path,
      ps.populated,
      ps.populatedListeners,
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
        createLeafChangefeed(channels, nodePath, () => (result as any)[CALL]()),
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
        createProductChangefeed(channels, nodePath, () =>
          (result as any)[CALL](),
        ),
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
        createSequenceChangefeed(channels, nodePath, () =>
          (result as any)[CALL](),
        ),
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
        createMapChangefeed(channels, nodePath, () => (result as any)[CALL]()),
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
    // Leaf type — attach a leaf changefeed + isPopulated.
    text(ctx: RefContext, path: Path, schema: TextSchema): A & HasChangefeed {
      const result = base.text(ctx, path, schema)
      wireChangefeed(result, ctx, path, (channels, nodePath) =>
        createLeafChangefeed(channels, nodePath, () => (result as any)[CALL]()),
      )
      return result as A & HasChangefeed
    },

    // --- Counter --------------------------------------------------------------
    // Leaf type — attach a leaf changefeed + isPopulated.
    counter(
      ctx: RefContext,
      path: Path,
      schema: CounterSchema,
    ): A & HasChangefeed {
      const result = base.counter(ctx, path, schema)
      wireChangefeed(result, ctx, path, (channels, nodePath) =>
        createLeafChangefeed(channels, nodePath, () => (result as any)[CALL]()),
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
        createLeafChangefeed(channels, nodePath, () => (result as any)[CALL]()),
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
        createTreeChangefeed(channels, nodePath, () => (result as any)[CALL]()),
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
        createSequenceChangefeed(channels, nodePath, () =>
          (result as any)[CALL](),
        ),
      )
      return result as A & HasChangefeed
    },

    // --- RichText -------------------------------------------------------------
    // Leaf type — attach a leaf changefeed + isPopulated.
    richtext(
      ctx: RefContext,
      path: Path,
      schema: RichTextSchema,
    ): A & HasChangefeed {
      const result = base.richtext(ctx, path, schema)
      wireChangefeed(result, ctx, path, (channels, nodePath) =>
        createLeafChangefeed(channels, nodePath, () => (result as any)[CALL]()),
      )
      return result as A & HasChangefeed
    },
  }
}

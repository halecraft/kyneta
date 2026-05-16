// withChangefeed — compositional changefeed interpreter transformer.
//
//
// This module owns the observation concern. It takes a base interpreter
// that produces refs with HasRead (filled [CALL] slot) and attaches
// [CHANGEFEED] to every node:
//
// - Every schema-issued ref (leaves and composites alike) carries a
//   TreeChangefeedProtocol — `subscribe` for own-path delivery and
//   `subscribeTree` for own-path + descendant delivery with relative
//   paths. For a leaf, `subscribeTree` is the trivial own-path lift.
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
// loop catches re-entrant `change()` calls from inside subscriber
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
import { isReplaceChange } from "../change.js"
import type { Changeset, Op, TreeChangefeedProtocol } from "../changefeed.js"
import { hasTreeChangefeed } from "../changefeed.js"
import { isPropertyHost } from "../guards.js"
import type { Interpreter, Path, SumVariants } from "../interpret.js"
import type { RefContext } from "../interpreter-types.js"
import {
  AddressedPath,
  resolveToAddressed,
  type SequenceAddressTable,
} from "../path.js"
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

// ---------------------------------------------------------------------------
// Attach [CHANGEFEED] non-enumerably to any object
// ---------------------------------------------------------------------------

/**
 * Attaches a `[CHANGEFEED]` symbol property non-enumerably to `target`.
 * Uses `Object.defineProperty` to bypass Proxy `set` traps on map refs.
 */
export function attachChangefeed(
  target: object,
  cf: TreeChangefeedProtocol<unknown, ChangeBase>,
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
  for (const { path, change } of pending) {
    const key = path.key
    let arr = grouped.get(key)
    if (!arr) {
      arr = []
      grouped.set(key, arr)
    }
    arr.push(change)
  }
  return { grouped }
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
export function deliverNotifications(
  plan: NotificationPlan,
  listeners: ReadonlyMap<
    string,
    Set<(changeset: Changeset<ChangeBase>) => void>
  >,
  options?: BatchOptions,
): void {
  for (const [key, changes] of plan.grouped) {
    const set = listeners.get(key)
    if (set && set.size > 0) {
      const changeset: Changeset<ChangeBase> = {
        changes,
        origin: options?.origin,
        replay: options?.replay,
      }
      for (const cb of set) cb(changeset)
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
 * to tree-shaped (addressed Op) delivery: leaf `subscribeTree`,
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
  }
}

/**
 * Re-prefix a `Changeset<Op<C>>` by concatenating `prefix` onto each
 * event's existing path.
 *
 * Used at composite child-tree propagation sites: every event from a
 * child's `subscribeTree` carries a relative path; the parent needs to
 * prepend the child's slot (`.field(key)` / `.item(index)`) before
 * forwarding to its own tree subscribers.
 *
 * Pure, table-testable. Exported for tests; not re-exported from index.
 */
export function prefixOps<C extends ChangeBase>(
  cs: Changeset<Op<C>>,
  prefix: Path,
): Changeset<Op<C>> {
  return {
    changes: cs.changes.map(event => ({
      path: prefix.concat(event.path),
      change: event.change,
    })),
    origin: cs.origin,
    replay: cs.replay,
  }
}

/**
 * Fan an own-path `Changeset<ChangeBase>` out to a node's shallow and
 * tree subscriber sets.
 *
 * Tree subscribers receive a single shared `liftToOps` invocation per
 * flush (O(|changes| + N) instead of O(N × |changes|) per-subscriber
 * wrapping). The `.size > 0` checks preserve the micro-optimization of
 * avoiding iterator allocation on empty sets.
 *
 * Used by every factory (leaf + product + sequence + map) to deliver
 * own-path notifications uniformly.
 */
function fanOutOwnPath(
  cs: Changeset<ChangeBase>,
  path: Path,
  shallowSubs: Set<(cs: Changeset<ChangeBase>) => void>,
  treeSubs: Set<(cs: Changeset<Op>) => void>,
): void {
  if (shallowSubs.size > 0) {
    for (const cb of shallowSubs) cb(cs)
  }
  if (treeSubs.size > 0) {
    const lifted = liftToOps(cs, path.root())
    for (const cb of treeSubs) cb(lifted)
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
 * record. Likewise, no `isFlushing` flag: re-entrant `change()` calls from
 * inside subscriber delivery enqueue an `accumulate` Msg back into the
 * per-context dispatcher and drain in a fresh sub-tick.
 */
interface ContextWiringState {
  readonly listeners: Map<
    string,
    Set<(changeset: Changeset<ChangeBase>) => void>
  >
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
type ChangefeedMsg =
  | { type: "accumulate"; op: Op }
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
 *   listeners. Re-entrant `change()` calls from inside a subscriber land
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
const readOnlyState = new WeakMap<
  RefContext,
  Map<string, Set<(changeset: Changeset<ChangeBase>) => void>>
>()

function ensurePrepareWiring(
  ctx: RefContext,
): Map<string, Set<(changeset: Changeset<ChangeBase>) => void>> {
  if (!hasPreparePipeline(ctx)) {
    let listeners = readOnlyState.get(ctx)
    if (!listeners) {
      listeners = new Map()
      readOnlyState.set(ctx, listeners)
    }
    return listeners
  }

  let state = contextState.get(ctx)
  if (state) return state.listeners

  const listeners = new Map<
    string,
    Set<(changeset: Changeset<ChangeBase>) => void>
  >()
  const accumulator: Op[] = []
  const populated = new Set<string>()
  const populatedListeners = new Map<string, Set<() => void>>()
  const originalPrepare = ctx.prepare
  const originalFlush = ctx.flush

  // Per-context dispatcher. Re-entrant `change()` calls from inside
  // subscriber delivery dispatch `accumulate` Msgs back into this same
  // dispatcher; the drain-to-quiescence loop processes them in fresh
  // sub-ticks. A `flush` Msg whose `accumulator.length === 0` (no
  // mutations since the last drain) still calls `originalFlush(options)`
  // — preserving the invariant that substrate-level flush always runs.
  const handle = createDispatcher<ChangefeedMsg>(
    msg => {
      if (msg.type === "accumulate") {
        accumulator.push(msg.op)
        return
      }
      // msg.type === "flush"
      if (accumulator.length === 0) {
        originalFlush(msg.options)
        return
      }
      const plan = planNotifications(accumulator)
      accumulator.length = 0
      // Commit to the substrate first so version() and delta() reflect
      // the just-flushed operations when subscribers read them.
      originalFlush(msg.options)
      deliverNotifications(plan, listeners, msg.options)
    },
    {
      lease: (ctx as { lease?: Lease }).lease,
      label: "changefeed",
    },
  )

  // Wrapped prepare: apply change to substrate synchronously (forwarding
  // `options` so the substrate sees `replay` at write time), mark populated
  // synchronously, then dispatch the accumulate Msg. The accumulate Msg
  // carries no options — notification-side `origin`/`replay` ride on the
  // subsequent `flush` Msg.
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
    handle.dispatch({ type: "accumulate", op: { path: resolved, change } })
  }

  // Wrapped flush: dispatch a flush Msg carrying the full options. The
  // handler enforces the order (originalFlush → deliverNotifications)
  // inside the dispatcher's drain.
  const wrappedFlush = (options?: BatchOptions): void => {
    handle.dispatch({ type: "flush", options })
  }

  ctx.prepare = wrappedPrepare
  ctx.flush = wrappedFlush

  state = {
    listeners,
    originalPrepare,
    originalFlush,
    populated,
    populatedListeners,
    handle,
  }
  contextState.set(ctx, state)
  return listeners
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
 * Create a `TreeChangefeedProtocol<boolean>` for the `isPopulated`
 * property at a path.
 *
 * - `.current` reads from the populated set (true if this path key is in the set)
 * - `.subscribe` fires exactly once when the path transitions from
 *   unpopulated to populated. If already populated at subscribe time,
 *   the callback fires immediately (via microtask for consistency).
 * - `.subscribeTree` is the trivial own-path lift: the populated event
 *   has no payload (changes is empty by construction), so the delivered
 *   `Changeset<Op>` has an empty changes array; only `origin` is
 *   load-bearing. Provided so the facade `subscribe` works universally
 *   on `ref.isPopulated` carriers without a method-set check.
 */
function createPopulatedChangefeed(
  path: Path,
  populated: Set<string>,
  populatedListeners: Map<string, Set<() => void>>,
): TreeChangefeedProtocol<boolean, ChangeBase> {
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
    subscribeTree(cb) {
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
  Object.defineProperty(target, "isPopulated", {
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
  const state2 = contextState.get(ctx)!
  return {
    populated: state2.populated,
    populatedListeners: state2.populatedListeners,
  }
}

// ---------------------------------------------------------------------------
// Changefeed factories
// ---------------------------------------------------------------------------

/**
 * Builds the `TreeChangefeedProtocol` for a structurally-leaf node.
 *
 * Parallel structure with composite factories: shared `shallowSubs` /
 * `treeSubs` sets, one own-path listener registered via `listenAtPath`
 * that delegates fan-out to `fanOutOwnPath`. The leaf's `subscribeTree`
 * is the trivial own-path → Op lift with `path.root()` as the relative
 * path (a leaf is a tree of size 1).
 *
 * The factory name retains "Leaf" because it refers to the *input*
 * (leaf-shaped carrier), not the output protocol.
 */
function createLeafChangefeed(
  listeners: Map<string, Set<(changeset: Changeset<ChangeBase>) => void>>,
  path: Path,
  readCurrent: () => unknown,
): TreeChangefeedProtocol<unknown, ChangeBase> {
  const shallowSubs = new Set<(cs: Changeset<ChangeBase>) => void>()
  const treeSubs = new Set<(cs: Changeset<Op>) => void>()

  listenAtPath(listeners, path, cs => {
    fanOutOwnPath(cs, path, shallowSubs, treeSubs)
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
    subscribeTree(cb) {
      treeSubs.add(cb)
      return () => {
        treeSubs.delete(cb)
      }
    },
  }
}

/**
 * Creates a TreeChangefeedProtocol for a product (struct) node.
 *
 * - `subscribe` fires only on changes at this node's own path.
 * - `subscribeTree` fires for all descendant changes with relative
 *   paths, PLUS own-path changes with `path: []`.
 *
 * Subscribers receive batched `Changeset` objects. A single flush
 * cycle delivers one `Changeset` per affected path. Tree subscribers
 * receive propagated changesets from children via subscription
 * composition.
 *
 * The product forces all child thunks eagerly to obtain their
 * changefeeds, then subscribes to each child for tree propagation.
 */
function createProductChangefeed(
  listeners: Map<string, Set<(changeset: Changeset<ChangeBase>) => void>>,
  path: Path,
  readCurrent: () => unknown,
  productRef: object,
  fieldKeys: readonly string[],
): TreeChangefeedProtocol<unknown, ChangeBase> {
  // Per-node shallow subscribers (node-level) — receive Changeset
  const shallowSubs = new Set<(changeset: Changeset<ChangeBase>) => void>()
  // Per-node tree subscribers — receive Changeset<Op>
  const treeSubs = new Set<(changeset: Changeset<Op>) => void>()

  // Register in the listener map for own-path changes.
  // Receives a Changeset (possibly with multiple changes) from flush.
  listenAtPath(listeners, path, cs => {
    fanOutOwnPath(cs, path, shallowSubs, treeSubs)
  })

  // Subscribe to children lazily on first subscribeTree call
  let childWiringDone = false

  function wireChildren(): void {
    if (childWiringDone) return
    childWiringDone = true

    for (const key of fieldKeys) {
      // Access through the product ref's cached getter (result[key])
      // instead of raw field thunks. Raw thunks create new carriers
      // and fire onRefCreated, overwriting address table entries.
      const child = (productRef as any)[key]
      // Use the schema-extension guard, not `hasChangefeed`: it narrows
      // to `HasTreeChangefeed` statically, so the subscribeTree call below
      // needs no cast. The runtime check still skips non-refs (missing/
      // undefined fields, primitive sub-properties).
      if (!hasTreeChangefeed(child)) continue

      const prefix = path.root().field(key)

      child[CHANGEFEED].subscribeTree((changeset: Changeset<Op>) => {
        if (treeSubs.size === 0) return
        const propagated = prefixOps(changeset, prefix)
        for (const cb of treeSubs) cb(propagated)
      })
    }
  }

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
    subscribeTree(callback: (changeset: Changeset<Op>) => void): () => void {
      wireChildren()
      treeSubs.add(callback)
      return () => {
        treeSubs.delete(callback)
      }
    },
  }
}

/**
 * Creates a TreeChangefeedProtocol for a sequence (list) node.
 *
 * - `subscribe` fires on SequenceChange at this path (structural changes).
 * - `subscribeTree` fires for structural changes (with path []) AND
 *   per-item content changes (with path [{type:"index",index},...]).
 *
 * Dynamic subscription management: when items are inserted or deleted,
 * the transformer tears down old per-item subscriptions and establishes
 * new ones at the correct indices.
 */
function createSequenceChangefeed(
  listeners: Map<string, Set<(changeset: Changeset<ChangeBase>) => void>>,
  path: Path,
  readCurrent: () => unknown,
  getItemRef: (index: number) => unknown,
  getLength: () => number,
): TreeChangefeedProtocol<unknown, ChangeBase> {
  const shallowSubs = new Set<(changeset: Changeset<ChangeBase>) => void>()
  const treeSubs = new Set<(changeset: Changeset<Op>) => void>()

  // Per-item unsubscribe functions, keyed by stable address ID (not
  // positional index). Address IDs never change — they survive structural
  // changes. This means retained/shifted items keep their subscriptions
  // without teardown/rebuild. Only dead items need cleanup.
  //
  // Falls back to index-keyed for non-addressing stacks (no ADDRESS_TABLE).
  const itemUnsubs = new Map<number, () => void>()

  // Symbol.for so we don't need a runtime import from with-addressing.ts
  const _ADDRESS_TABLE_SYM = Symbol.for("kyneta:addressTable")

  /**
   * Get the sequence address table from the parent ref, if available.
   * Returns undefined for non-addressing stacks.
   */
  function getAddressTable(): SequenceAddressTable | undefined {
    // The parent ref is accessible via getItemRef's closure over the
    // result object. We discover the table via the symbol on the
    // sequence ref that createSequenceChangefeed is attached to.
    // The caller (withChangefeed.sequence) passes getItemRef which
    // calls result.at(i), so `result` is in the closure. We can't
    // access it here directly, but the ADDRESS_TABLE is discoverable
    // from any item's parent. Instead, we check the path: if it's
    // addressed, the registry has the table.
    if (path.isAddressed) {
      const addrPath = path as AddressedPath
      return addrPath.registry.getSequenceTable(path.key)
    }
    return undefined
  }

  function subscribeToItem(index: number): void {
    const child = getItemRef(index)
    // `hasTreeChangefeed` narrows for a cast-free subscribeTree call.
    // The leading null-guard handles missing/undefined items (e.g.
    // sparse sequences during reorders) — narrowing alone wouldn't.
    if (!child || !hasTreeChangefeed(child)) return

    // Determine a stable key for this subscription.
    // With addressing: use the address ID (stable across structural changes).
    // Without addressing: use the positional index (falls back to old behavior).
    let subKey = index
    const table = getAddressTable()
    if (table) {
      const addr = table.byIndex.get(index)
      if (addr && addr.kind === "index") {
        subKey = addr.id
      }
    }

    // If already subscribed under this key, skip (idempotent).
    if (itemUnsubs.has(subKey)) return

    // The prefix captures the Address object from the registry (via
    // path.root().item(index)), which is the SAME Address that
    // withAddressing advances. So prefix.resolve() returns the
    // current index after advancement — the prefix is live.
    const prefix = path.root().item(index)

    const unsub = child[CHANGEFEED].subscribeTree(
      (changeset: Changeset<Op>) => {
        if (treeSubs.size === 0) return
        const propagated = prefixOps(changeset, prefix)
        for (const cb of treeSubs) cb(propagated)
      },
    )
    itemUnsubs.set(subKey, unsub)
  }

  function subscribeToAllItems(): void {
    const len = getLength()
    for (let i = 0; i < len; i++) {
      subscribeToItem(i)
    }
  }

  function handleStructuralChange(changeset: Changeset<ChangeBase>): void {
    const table = getAddressTable()

    if (!table) {
      // Non-addressing stack: fall back to O(n) teardown/rebuild
      for (const unsub of itemUnsubs.values()) unsub()
      itemUnsubs.clear()
      if (treeSubs.size > 0) subscribeToAllItems()
      return
    }

    // Addressing stack: only clean up dead items.
    // Retained/shifted items keep their subscriptions — their address
    // IDs are stable, and the prefix path auto-updates because it
    // captures the same Address object that withAddressing advances.

    const hasReplace = changeset.changes.some(c => isReplaceChange(c))
    if (hasReplace) {
      // ReplaceChange: all addresses are dead, tear down everything
      for (const unsub of itemUnsubs.values()) unsub()
      itemUnsubs.clear()
      if (treeSubs.size > 0) subscribeToAllItems()
      return
    }

    // SequenceChange: unsubscribe only dead items
    for (const [addrId, unsub] of itemUnsubs) {
      const entry = table.byId.get(addrId)
      if (entry?.address.dead) {
        unsub()
        itemUnsubs.delete(addrId)
      }
    }

    // Subscribe to any newly inserted items that are already accessed.
    // New items get subscribed lazily when accessed via .at(), but if
    // subscribeToAllItems was already called, we should pick up new
    // items at their current indices.
    if (treeSubs.size > 0) {
      const len = getLength()
      for (let i = 0; i < len; i++) {
        // subscribeToItem is idempotent — skips if already subscribed
        subscribeToItem(i)
      }
    }
  }

  // Register in the listener map for own-path changes.
  // Receives a Changeset (possibly with multiple changes) from flush.
  listenAtPath(listeners, path, cs => {
    fanOutOwnPath(cs, path, shallowSubs, treeSubs)
    // Rebuild item subscriptions after structural change
    handleStructuralChange(cs)
  })

  let initialWiringDone = false

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
    subscribeTree(callback: (changeset: Changeset<Op>) => void): () => void {
      if (!initialWiringDone) {
        initialWiringDone = true
        subscribeToAllItems()
      }
      treeSubs.add(callback)
      return () => {
        treeSubs.delete(callback)
        // If no more tree subscribers, tear down item subscriptions
        if (treeSubs.size === 0) {
          for (const unsub of itemUnsubs.values()) unsub()
          itemUnsubs.clear()
          initialWiringDone = false
        }
      }
    },
  }
}

/**
 * Creates a TreeChangefeedProtocol for a map (record) node.
 *
 * Similar to sequence but keyed by string instead of number.
 * Dynamic subscription management for map entries.
 */
function createMapChangefeed(
  listeners: Map<string, Set<(changeset: Changeset<ChangeBase>) => void>>,
  path: Path,
  readCurrent: () => unknown,
  getEntryRef: (key: string) => unknown,
  getKeys: () => string[],
): TreeChangefeedProtocol<unknown, ChangeBase> {
  const shallowSubs = new Set<(changeset: Changeset<ChangeBase>) => void>()
  const treeSubs = new Set<(changeset: Changeset<Op>) => void>()

  const entryUnsubs = new Map<string, () => void>()

  function subscribeToEntry(key: string): void {
    const existing = entryUnsubs.get(key)
    if (existing) existing()

    const child = getEntryRef(key)
    // `hasTreeChangefeed` narrows for a cast-free subscribeTree call;
    // the null-guard skips missing entries (e.g. just-deleted keys
    // observed mid-rebuild).
    if (!child || !hasTreeChangefeed(child)) {
      entryUnsubs.delete(key)
      return
    }

    const prefix = path.root().field(key)

    const unsub = child[CHANGEFEED].subscribeTree(
      (changeset: Changeset<Op>) => {
        if (treeSubs.size === 0) return
        const propagated = prefixOps(changeset, prefix)
        for (const cb of treeSubs) cb(propagated)
      },
    )
    entryUnsubs.set(key, unsub)
  }

  function subscribeToAllEntries(): void {
    const keys = getKeys()
    for (const key of keys) {
      subscribeToEntry(key)
    }
  }

  function handleStructuralChange(_changeset: Changeset<ChangeBase>): void {
    // Tear down all and rebuild for current keys
    for (const unsub of entryUnsubs.values()) unsub()
    entryUnsubs.clear()
    if (treeSubs.size > 0) subscribeToAllEntries()
  }

  // Register in the listener map for own-path changes.
  // Receives a Changeset (possibly with multiple changes) from flush.
  listenAtPath(listeners, path, cs => {
    fanOutOwnPath(cs, path, shallowSubs, treeSubs)
    handleStructuralChange(cs)
  })

  let initialWiringDone = false

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
    subscribeTree(callback: (changeset: Changeset<Op>) => void): () => void {
      if (!initialWiringDone) {
        initialWiringDone = true
        subscribeToAllEntries()
      }
      treeSubs.add(callback)
      return () => {
        treeSubs.delete(callback)
        if (treeSubs.size === 0) {
          for (const unsub of entryUnsubs.values()) unsub()
          entryUnsubs.clear()
          initialWiringDone = false
        }
      }
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
 *   `TreeChangefeedProtocol`:
 *   `subscribe` fires only for changes at the node's own path (node-level).
 *   `subscribeTree` fires for own-path AND descendant changes with relative
 *   paths (tree-level), making it a strict superset of `subscribe`.
 *
 * Notification flows through the changefeed tree, not flat subscriber maps.
 * Each node's `subscribeTree` composes its children's changefeeds.
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
    listeners: Map<string, Set<(changeset: Changeset<ChangeBase>) => void>>,
    path: Path,
  ) => TreeChangefeedProtocol<unknown, ChangeBase>,
): void {
  if (isPropertyHost(result)) {
    const listeners = ensurePrepareWiring(ctx)
    const cf = createCf(listeners, path)
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
    // --- Scalar ---------------------------------------------------------------
    scalar(
      ctx: RefContext,
      path: Path,
      schema: ScalarSchema,
    ): A & HasChangefeed {
      const result = base.scalar(ctx, path, schema)
      wireChangefeed(result, ctx, path, (listeners, p) =>
        createLeafChangefeed(listeners, p, () => (result as any)[CALL]()),
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
      wireChangefeed(result, ctx, path, (listeners, p) =>
        createProductChangefeed(
          listeners,
          p,
          () => (result as any)[CALL](),
          // Pass the product ref so wireChildren accesses fields through
          // withCaching's memoized getters, not raw thunks. Raw thunks
          // create new carriers that overwrite address table entries.
          result as object,
          Object.keys(fields),
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
      wireChangefeed(result, ctx, path, (listeners, p) => {
        const resultAny = result as any
        return createSequenceChangefeed(
          listeners,
          p,
          () => (result as any)[CALL](),
          (index: number) => {
            if (typeof resultAny.at === "function") {
              return resultAny.at(index)
            }
            throw new Error(
              "withChangefeed: sequence ref missing .at() method. " +
                "Ensure withNavigation is in the interpreter stack.",
            )
          },
          () => ctx.reader.arrayLength(p),
        )
      })
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
      wireChangefeed(result, ctx, path, (listeners, p) => {
        const resultAny = result as any
        return createMapChangefeed(
          listeners,
          p,
          () => (result as any)[CALL](),
          (key: string) => {
            if (typeof resultAny.at === "function") {
              return resultAny.at(key)
            }
            throw new Error(
              "withChangefeed: map ref missing .at() method. " +
                "Ensure withNavigation is in the interpreter stack.",
            )
          },
          () => ctx.reader.keys(p),
        )
      })
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
      wireChangefeed(result, ctx, path, (listeners, p) =>
        createLeafChangefeed(listeners, p, () => (result as any)[CALL]()),
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
      wireChangefeed(result, ctx, path, (listeners, p) =>
        createLeafChangefeed(listeners, p, () => (result as any)[CALL]()),
      )
      return result as A & HasChangefeed
    },

    // --- Set ------------------------------------------------------------------
    // Delegate like map — attach a tree-observable changefeed.
    set(
      ctx: RefContext,
      path: Path,
      schema: SetSchema,
      item: (key: string) => A,
    ): A & HasChangefeed {
      const result = base.set(ctx, path, schema, item)
      wireChangefeed(result, ctx, path, (listeners, p) => {
        const resultAny = result as any
        return createMapChangefeed(
          listeners,
          p,
          () => (result as any)[CALL](),
          (key: string) => {
            if (typeof resultAny.at === "function") {
              return resultAny.at(key)
            }
            throw new Error(
              "withChangefeed: set ref missing .at() method. " +
                "Ensure withNavigation is in the interpreter stack.",
            )
          },
          () => ctx.reader.keys(p),
        )
      })
      return result as A & HasChangefeed
    },

    // --- Tree -----------------------------------------------------------------
    // Delegate via nodeData — the inner interpretation already has
    // [CHANGEFEED] attached during recursion.
    tree(
      ctx: RefContext,
      path: Path,
      schema: TreeSchema,
      nodeData: () => A,
    ): A & HasChangefeed {
      const result = base.tree(ctx, path, schema, nodeData)
      // The inner case (product, etc.) already attached [CHANGEFEED]
      // during recursion through the nodeData thunk.
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
      wireChangefeed(result, ctx, path, (listeners, p) => {
        const resultAny = result as any
        return createSequenceChangefeed(
          listeners,
          p,
          () => (result as any)[CALL](),
          (index: number) => {
            if (typeof resultAny.at === "function") {
              return resultAny.at(index)
            }
            throw new Error(
              "withChangefeed: movable ref missing .at() method. " +
                "Ensure withNavigation is in the interpreter stack.",
            )
          },
          () => ctx.reader.arrayLength(p),
        )
      })
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
      wireChangefeed(result, ctx, path, (listeners, p) =>
        createLeafChangefeed(listeners, p, () => (result as any)[CALL]()),
      )
      return result as A & HasChangefeed
    },
  }
}

// withChangefeed — compositional changefeed interpreter transformer.
//
// This module owns the observation concern. It takes a base interpreter
// that produces refs with HasRead (filled [CALL] slot) and attaches
// [CHANGEFEED] to every node:
//
// - Leaf refs (scalar, text, counter) get a plain Changefeed
// - Composite refs (product, sequence, map) get a ComposedChangefeed
//   with subscribeTree for tree-level observation
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
// to accumulate {path, change} entries without firing subscribers. It
// wraps ctx.flush to group accumulated entries by path and deliver one
// Changeset per subscriber.
//
// Compose: withChangefeed(withWritable(withCaching(withReadable(withNavigation(bottom)))))
// Or read-only: withChangefeed(withCaching(withReadable(withNavigation(bottom))))
//
// See .plans/navigation-layer.md §Phase 2, Task 2.2b.

import type { ChangeBase } from "../change.js"
import { isSequenceChange } from "../change.js"
import type {
  Changefeed,
  Changeset,
  ComposedChangefeed,
  HasChangefeed,
  Op,
} from "../changefeed.js"
import {
  CHANGEFEED,
  hasChangefeed,
  hasComposedChangefeed,
} from "../changefeed.js"
import { isPropertyHost } from "../guards.js"
import type { Interpreter, Path, SumVariants } from "../interpret.js"
import type { RefContext } from "../interpreter-types.js"
import type {
  AnnotatedSchema,
  MapSchema,
  ProductSchema,
  ScalarSchema,
  SequenceSchema,
  SumSchema,
} from "../schema.js"
import { pathKey, readByPath } from "../store.js"
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
  cf: Changefeed<unknown, ChangeBase> | ComposedChangefeed<unknown, ChangeBase>,
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
    const key = pathKey(path)
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
 * @param origin - Optional provenance tag attached to each emitted `Changeset`.
 */
export function deliverNotifications(
  plan: NotificationPlan,
  listeners: ReadonlyMap<
    string,
    Set<(changeset: Changeset<ChangeBase>) => void>
  >,
  origin?: string,
): void {
  for (const [key, changes] of plan.grouped) {
    const set = listeners.get(key)
    if (set && set.size > 0) {
      const changeset: Changeset<ChangeBase> = { changes, origin }
      for (const cb of set) cb(changeset)
    }
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
 * - `pending`: accumulated `Op` entries from `prepare` calls,
 *   drained by `flush`.
 * - `originalPrepare` / `originalFlush`: the unwrapped methods, called
 *   before/after the changefeed layer's logic.
 */
interface ContextWiringState {
  readonly listeners: Map<
    string,
    Set<(changeset: Changeset<ChangeBase>) => void>
  >
  readonly pending: Op[]
  readonly originalPrepare: (path: Path, change: ChangeBase) => void
  readonly originalFlush: (origin?: string) => void
}

/**
 * Returns `true` if `ctx` has `prepare` and `flush` methods — i.e. it's
 * a `WritableContext`, not a plain `RefContext`. This duck-type check
 * allows `withChangefeed` to keep its `RefContext` type signature while
 * participating in the prepare pipeline when composed with `withWritable`.
 */
function hasPreparePipeline(ctx: RefContext): ctx is RefContext & {
  prepare: (path: Path, change: ChangeBase) => void
  flush: (origin?: string) => void
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
 * - `prepare` wrapping: after the inner prepare (store mutation), appends
 *   `{path, change}` to the pending accumulator. No notification fires.
 * - `flush` wrapping: calls `planNotifications` (pure) to group changes
 *   by path, then calls the inner flush (so the substrate's version and
 *   log are up-to-date), then `deliverNotifications` (imperative) to fire
 *   listeners. Clears the accumulator before any side effects for
 *   re-entrancy safety.
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
  const pending: Op[] = []
  const originalPrepare = ctx.prepare
  const originalFlush = ctx.flush

  // Wrapped prepare: apply change to store, then accumulate for flush.
  const wrappedPrepare = (path: Path, change: ChangeBase): void => {
    originalPrepare(path, change)
    pending.push({ path, change })
  }

  // Wrapped flush: plan notifications (pure), commit via inner flush
  // (so substrate version/log are up-to-date), then deliver notifications.
  // Order matters: subscribers may call version(doc) or delta(doc, ...)
  // inside their callbacks, so the substrate must be committed first.
  const wrappedFlush = (origin?: string): void => {
    if (pending.length > 0) {
      const plan = planNotifications(pending)
      // Clear accumulator before any side effects — re-entrancy safety
      pending.length = 0

      // Commit to the substrate first so version() and delta() reflect
      // the just-flushed operations when subscribers read them.
      originalFlush(origin)

      deliverNotifications(plan, listeners, origin)
    } else {
      originalFlush(origin)
    }
  }

  ctx.prepare = wrappedPrepare
  ctx.flush = wrappedFlush

  state = { listeners, pending, originalPrepare, originalFlush }
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
  const key = pathKey(path)
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
// Changefeed factories
// ---------------------------------------------------------------------------

/**
 * Creates a leaf Changefeed (no children, no subscribeTree).
 * `subscribe` fires on any change at this path.
 *
 * Subscribers receive batched `Changeset` objects directly from
 * the flush cycle — no per-change wrapping needed.
 */
function createLeafChangefeed(
  listeners: Map<string, Set<(changeset: Changeset<ChangeBase>) => void>>,
  path: Path,
  readCurrent: () => unknown,
): Changefeed<unknown, ChangeBase> {
  return {
    get current() {
      return readCurrent()
    },
    subscribe(
      callback: (changeset: Changeset<ChangeBase>) => void,
    ): () => void {
      // The listener receives Changeset directly from flush — pass through
      return listenAtPath(listeners, path, callback)
    },
  }
}

/**
 * Creates a ComposedChangefeed for a product (struct) node.
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
  fields: Readonly<Record<string, () => unknown>>,
): ComposedChangefeed<unknown, ChangeBase> {
  // Per-node shallow subscribers (node-level) — receive Changeset
  const shallowSubs = new Set<(changeset: Changeset<ChangeBase>) => void>()
  // Per-node tree subscribers — receive Changeset<Op>
  const treeSubs = new Set<(changeset: Changeset<Op>) => void>()

  // Register in the listener map for own-path changes.
  // Receives a Changeset (possibly with multiple changes) from flush.
  listenAtPath(listeners, path, (changeset: Changeset<ChangeBase>) => {
    if (shallowSubs.size > 0) {
      for (const cb of shallowSubs) cb(changeset)
    }
    // Tree subscribers also see own-path changes with path []
    if (treeSubs.size > 0) {
      const treeChangeset: Changeset<Op> = {
        changes: changeset.changes.map(change => ({ path: [], change })),
        origin: changeset.origin,
      }
      for (const cb of treeSubs) cb(treeChangeset)
    }
  })

  // Subscribe to children lazily on first subscribeTree call
  let childWiringDone = false

  function wireChildren(): void {
    if (childWiringDone) return
    childWiringDone = true

    for (const key of Object.keys(fields)) {
      const child = fields[key]?.()
      if (!hasChangefeed(child)) continue

      const prefix: Path = [{ type: "key" as const, key }]

      if (hasComposedChangefeed(child)) {
        // Composite child — subscribe to its tree, re-prefix events
        child[CHANGEFEED].subscribeTree((changeset: Changeset<Op>) => {
          if (treeSubs.size === 0) return
          const propagated: Changeset<Op> = {
            changes: changeset.changes.map(event => ({
              path: [...prefix, ...event.path],
              change: event.change,
            })),
            origin: changeset.origin,
          }
          for (const cb of treeSubs) cb(propagated)
        })
      } else {
        // Leaf child — subscribe to its shallow stream
        child[CHANGEFEED].subscribe((changeset: Changeset<ChangeBase>) => {
          if (treeSubs.size === 0) return
          const propagated: Changeset<Op> = {
            changes: changeset.changes.map(change => ({
              path: prefix,
              change,
            })),
            origin: changeset.origin,
          }
          for (const cb of treeSubs) cb(propagated)
        })
      }
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
 * Creates a ComposedChangefeed for a sequence (list) node.
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
): ComposedChangefeed<unknown, ChangeBase> {
  const shallowSubs = new Set<(changeset: Changeset<ChangeBase>) => void>()
  const treeSubs = new Set<(changeset: Changeset<Op>) => void>()

  // Per-item unsubscribe functions, keyed by index
  const itemUnsubs = new Map<number, () => void>()

  function subscribeToItem(index: number): void {
    // Unsubscribe from any existing subscription at this index
    const existing = itemUnsubs.get(index)
    if (existing) existing()

    const child = getItemRef(index)
    if (!child || !hasChangefeed(child)) {
      itemUnsubs.delete(index)
      return
    }

    const prefix: Path = [{ type: "index" as const, index }]

    let unsub: () => void
    if (hasComposedChangefeed(child)) {
      unsub = child[CHANGEFEED].subscribeTree((changeset: Changeset<Op>) => {
        if (treeSubs.size === 0) return
        const propagated: Changeset<Op> = {
          changes: changeset.changes.map(event => ({
            path: [...prefix, ...event.path],
            change: event.change,
          })),
          origin: changeset.origin,
        }
        for (const cb of treeSubs) cb(propagated)
      })
    } else {
      unsub = child[CHANGEFEED].subscribe(
        (changeset: Changeset<ChangeBase>) => {
          if (treeSubs.size === 0) return
          const propagated: Changeset<Op> = {
            changes: changeset.changes.map(change => ({
              path: prefix,
              change,
            })),
            origin: changeset.origin,
          }
          for (const cb of treeSubs) cb(propagated)
        },
      )
    }
    itemUnsubs.set(index, unsub)
  }

  function subscribeToAllItems(): void {
    const len = getLength()
    for (let i = 0; i < len; i++) {
      subscribeToItem(i)
    }
  }

  function handleStructuralChange(changeset: Changeset<ChangeBase>): void {
    // Check if any change in the batch is a sequence change
    const hasNonSequence = changeset.changes.some(c => !isSequenceChange(c))
    if (hasNonSequence) {
      // ReplaceChange or unknown — tear down all, rebuild
      for (const unsub of itemUnsubs.values()) unsub()
      itemUnsubs.clear()
      if (treeSubs.size > 0) subscribeToAllItems()
      return
    }

    // Parse the sequence ops to determine what indices changed
    // After the store is updated, we need to rebuild subscriptions
    // at affected indices. The simplest correct approach: tear down
    // all subscriptions and rebuild for the new length.
    //
    // This is O(n) per structural change but correct. A more
    // sophisticated approach would parse retain/insert/delete ops
    // to shift subscriptions, but that optimization can come later.
    for (const unsub of itemUnsubs.values()) unsub()
    itemUnsubs.clear()
    if (treeSubs.size > 0) subscribeToAllItems()
  }

  // Register in the listener map for own-path changes.
  // Receives a Changeset (possibly with multiple changes) from flush.
  listenAtPath(listeners, path, (changeset: Changeset<ChangeBase>) => {
    // Fire shallow subscribers
    if (shallowSubs.size > 0) {
      for (const cb of shallowSubs) cb(changeset)
    }

    // Tree subscribers see own-path structural changes with path []
    if (treeSubs.size > 0) {
      const treeChangeset: Changeset<Op> = {
        changes: changeset.changes.map(change => ({ path: [], change })),
        origin: changeset.origin,
      }
      for (const cb of treeSubs) cb(treeChangeset)
    }

    // Rebuild item subscriptions after structural change
    handleStructuralChange(changeset)
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
 * Creates a ComposedChangefeed for a map (record) node.
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
): ComposedChangefeed<unknown, ChangeBase> {
  const shallowSubs = new Set<(changeset: Changeset<ChangeBase>) => void>()
  const treeSubs = new Set<(changeset: Changeset<Op>) => void>()

  const entryUnsubs = new Map<string, () => void>()

  function subscribeToEntry(key: string): void {
    const existing = entryUnsubs.get(key)
    if (existing) existing()

    const child = getEntryRef(key)
    if (!child || !hasChangefeed(child)) {
      entryUnsubs.delete(key)
      return
    }

    const prefix: Path = [{ type: "key" as const, key }]

    let unsub: () => void
    if (hasComposedChangefeed(child)) {
      unsub = child[CHANGEFEED].subscribeTree((changeset: Changeset<Op>) => {
        if (treeSubs.size === 0) return
        const propagated: Changeset<Op> = {
          changes: changeset.changes.map(event => ({
            path: [...prefix, ...event.path],
            change: event.change,
          })),
          origin: changeset.origin,
        }
        for (const cb of treeSubs) cb(propagated)
      })
    } else {
      unsub = child[CHANGEFEED].subscribe(
        (changeset: Changeset<ChangeBase>) => {
          if (treeSubs.size === 0) return
          const propagated: Changeset<Op> = {
            changes: changeset.changes.map(change => ({
              path: prefix,
              change,
            })),
            origin: changeset.origin,
          }
          for (const cb of treeSubs) cb(propagated)
        },
      )
    }
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
  listenAtPath(listeners, path, (changeset: Changeset<ChangeBase>) => {
    if (shallowSubs.size > 0) {
      for (const cb of shallowSubs) cb(changeset)
    }

    if (treeSubs.size > 0) {
      const treeChangeset: Changeset<Op> = {
        changes: changeset.changes.map(change => ({ path: [], change })),
        origin: changeset.origin,
      }
      for (const cb of treeSubs) cb(treeChangeset)
    }

    handleStructuralChange(changeset)
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
 * - **Leaf refs** (scalar, text, counter) get a plain `Changefeed`:
 *   `subscribe` fires on any change dispatched at that path.
 *
 * - **Composite refs** (product, sequence, map) get a `ComposedChangefeed`:
 *   `subscribe` fires only for changes at the node's own path (node-level).
 *   `subscribeTree` fires for all descendant changes with relative
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

      if (isPropertyHost(result)) {
        const listeners = ensurePrepareWiring(ctx)
        const cf = createLeafChangefeed(listeners, path, () =>
          (result as any)[CALL](),
        )
        attachChangefeed(result as object, cf)
        return result as A & HasChangefeed
      }

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

      if (isPropertyHost(result)) {
        const listeners = ensurePrepareWiring(ctx)
        const cf = createProductChangefeed(
          listeners,
          path,
          () => (result as any)[CALL](),
          // The fields object contains thunks — forcing them yields
          // child refs with [CHANGEFEED] already attached (because
          // the catamorphism interprets children before parents, and
          // the field thunks capture the full interpreter).
          fields as Readonly<Record<string, () => unknown>>,
        )
        attachChangefeed(result as object, cf)
        return result as A & HasChangefeed
      }

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

      if (isPropertyHost(result)) {
        const listeners = ensurePrepareWiring(ctx)
        const resultAny = result as any

        const cf = createSequenceChangefeed(
          listeners,
          path,
          () => (result as any)[CALL](),
          // Use the result's .at() method to get child refs —
          // this goes through the caching layer, so refs have
          // stable identity and [CHANGEFEED] attached.
          (index: number) => {
            if (typeof resultAny.at === "function") {
              return resultAny.at(index)
            }
            return item(index)
          },
          () => {
            const arr = readByPath(ctx.store, path)
            return Array.isArray(arr) ? arr.length : 0
          },
        )
        attachChangefeed(result as object, cf)
        return result as A & HasChangefeed
      }

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

      if (isPropertyHost(result)) {
        const listeners = ensurePrepareWiring(ctx)
        const resultAny = result as any

        const cf = createMapChangefeed(
          listeners,
          path,
          () => (result as any)[CALL](),
          (key: string) => {
            if (typeof resultAny.at === "function") {
              return resultAny.at(key)
            }
            return item(key)
          },
          () => {
            const obj = readByPath(ctx.store, path)
            if (obj !== null && obj !== undefined && typeof obj === "object") {
              return Object.keys(obj as Record<string, unknown>)
            }
            return []
          },
        )
        attachChangefeed(result as object, cf)
        return result as A & HasChangefeed
      }

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

    // --- Annotated ------------------------------------------------------------
    annotated(
      ctx: RefContext,
      path: Path,
      schema: AnnotatedSchema,
      inner: (() => A) | undefined,
    ): A & HasChangefeed {
      const result = base.annotated(ctx, path, schema, inner)

      switch (schema.tag) {
        case "text":
        case "counter": {
          // Leaf annotations — attach a leaf changefeed
          if (isPropertyHost(result)) {
            const listeners = ensurePrepareWiring(ctx)
            const cf = createLeafChangefeed(listeners, path, () =>
              (result as any)[CALL](),
            )
            attachChangefeed(result as object, cf)
            return result as A & HasChangefeed
          }
          return result as A & HasChangefeed
        }

        case "doc":
        case "movable":
        case "tree":
          // Delegating annotations — the inner case (product, sequence,
          // etc.) already attached [CHANGEFEED] during recursion.
          return result as A & HasChangefeed

        default:
          // Unknown annotation — if inner was provided, the inner case
          // handled it. Otherwise treat as a leaf.
          if (inner !== undefined) {
            return result as A & HasChangefeed
          }
          if (isPropertyHost(result)) {
            const listeners = ensurePrepareWiring(ctx)
            const cf = createLeafChangefeed(listeners, path, () =>
              (result as any)[CALL](),
            )
            attachChangefeed(result as object, cf)
            return result as A & HasChangefeed
          }
          return result as A & HasChangefeed
      }
    },
  }
}

// Changefeed decorator — attaches [CHANGEFEED] to interpreted results via `enrich`.
//
// This module owns the observation concern (read + subscribe). It is
// orthogonal to the mutation concern provided by `withMutation`.
// Compose them via `enrich(withMutation(readableInterpreter), withChangefeed)`.
//
// Two subscription modes:
// - Exact (via Changefeed.subscribe): fires only for changes at the exact path
// - Deep (via subscribeDeep): fires for changes at the path or any descendant
//
// See theory §5.4 (capability decomposition) and §7.2 (enrich combinator).

import type { ChangeBase } from "../change.js"
import type { Decorator } from "../combinators.js"
import { CHANGEFEED } from "../changefeed.js"
import type { Changefeed } from "../changefeed.js"
import type { Path } from "../interpret.js"
import type { WritableContext, PendingChange } from "./writable.js"
import { type Store, readByPath, applyChangeToStore } from "../store.js"
import { isPropertyHost } from "../guards.js"

// ---------------------------------------------------------------------------
// Deep event — the envelope for deep subscription callbacks
// ---------------------------------------------------------------------------

/**
 * An event delivered to deep subscribers. Contains the relative path
 * from the subscriber's position to the dispatch origin, plus the change.
 *
 * Example: if you deep-subscribe at `["settings"]` and a change dispatches
 * at `["settings", "darkMode"]`, you receive `{ origin: [{type:"key", key:"darkMode"}], change }`.
 * If the change dispatches at `["settings"]` itself, `origin` is `[]`.
 */
export interface DeepEvent {
  /** Path from the subscriber's position to the dispatch origin. */
  readonly origin: Path
  /** The change that was dispatched. */
  readonly change: ChangeBase
}

// ---------------------------------------------------------------------------
// Subscriber infrastructure
// ---------------------------------------------------------------------------

/**
 * Converts a Path to a stable string key for subscriber map lookup.
 * Key segments use the key directly; index segments use their numeric
 * string representation. NUL separator avoids collisions.
 */
function pathKey(path: Path): string {
  return path
    .map(seg => (seg.type === "key" ? seg.key : String(seg.index)))
    .join("\0")
}

/**
 * Generic "register callback in a keyed Set map with cleanup" helper.
 * Both exact and deep subscribe delegate to this — no duplicate
 * map-management code.
 */
function subscribeToMap<T>(
  map: Map<string, Set<T>>,
  key: string,
  callback: T,
): () => void {
  let subs = map.get(key)
  if (!subs) {
    subs = new Set()
    map.set(key, subs)
  }
  subs.add(callback)
  return () => {
    subs!.delete(callback)
    if (subs!.size === 0) {
      map.delete(key)
    }
  }
}

/**
 * Registers an exact-path subscription. Delegates to `subscribeToMap`.
 */
function subscribeToPath(
  subscribers: Map<string, Set<(change: ChangeBase) => void>>,
  path: Path,
  callback: (change: ChangeBase) => void,
): () => void {
  return subscribeToMap(subscribers, pathKey(path), callback)
}

/**
 * The single notification engine for a dispatch. Handles both exact
 * and deep subscribers in one pass.
 *
 * 1. Exact: look up `pathKey(path)` in `ctx.subscribers`, invoke matches.
 * 2. Deep: walk `i` from `path.length` down to `0`, look up
 *    `pathKey(path.slice(0, i))` in `ctx.deepSubscribers`, invoke matches
 *    with `{ origin: path.slice(i), change }`.
 *
 * When `i === path.length`, this fires deep subscribers at the dispatch
 * path itself with `origin: []` — correct, since "something happened at
 * my own path" is a legitimate event for a subtree subscriber.
 */
function notifyAll(
  ctx: ChangefeedContext,
  path: Path,
  change: ChangeBase,
): void {
  // Exact subscribers
  const key = pathKey(path)
  const exact = ctx.subscribers.get(key)
  if (exact) {
    for (const cb of exact) cb(change)
  }

  // Deep subscribers — walk ancestors from self to root
  for (let i = path.length; i >= 0; i--) {
    const ancestorKey = pathKey(path.slice(0, i))
    const deep = ctx.deepSubscribers.get(ancestorKey)
    if (deep) {
      const origin: Path = path.slice(i)
      const event: DeepEvent = { origin, change }
      for (const cb of deep) cb(event)
    }
  }
}

// ---------------------------------------------------------------------------
// Changefeed creation helper
// ---------------------------------------------------------------------------

function createChangefeedForPath(
  subscribers: Map<string, Set<(change: ChangeBase) => void>>,
  path: Path,
  readCurrent: () => unknown,
): Changefeed<unknown, ChangeBase> {
  return {
    get current() {
      return readCurrent()
    },
    subscribe(callback: (change: ChangeBase) => void): () => void {
      return subscribeToPath(subscribers, path, callback)
    },
  }
}

// ---------------------------------------------------------------------------
// Attach [CHANGEFEED] non-enumerably to any object
// ---------------------------------------------------------------------------

function attachChangefeed(
  target: object,
  cf: Changefeed<unknown, ChangeBase>,
): void {
  Object.defineProperty(target, CHANGEFEED, {
    value: cf,
    enumerable: false,
    configurable: true,
    writable: false,
  })
}

// ---------------------------------------------------------------------------
// ChangefeedContext — extends WritableContext with subscriber notification
// ---------------------------------------------------------------------------

/**
 * A context that extends `WritableContext` with subscriber notification.
 *
 * Created by `createChangefeedContext`, which wraps an existing writable
 * context's `dispatch` to notify subscribers after each change is applied.
 *
 * The `withChangefeed` decorator reads `subscribers` from this context to
 * create changefeed objects. The `subscribeDeep` function reads
 * `deepSubscribers` to register deep subscriptions.
 */
export interface ChangefeedContext extends WritableContext {
  readonly subscribers: Map<string, Set<(change: ChangeBase) => void>>
  readonly deepSubscribers: Map<string, Set<(event: DeepEvent) => void>>
}

/**
 * Wraps a `WritableContext` to add subscriber notification.
 *
 * The returned context has the same store, autoCommit, and pending array,
 * but its `dispatch` function calls the original dispatch AND notifies
 * subscribers (both exact and deep). This is the dispatch-wrapping pattern:
 * the writable interpreter calls `ctx.dispatch` without knowing that
 * notification happens inside.
 *
 * ```ts
 * const store = { title: "", count: 0 }
 * const wCtx = createWritableContext(store)
 * const cfCtx = createChangefeedContext(wCtx)
 * const doc = interpret(schema, enrich(withMutation(readableInterpreter), withChangefeed), cfCtx)
 * ```
 */
export function createChangefeedContext(
  writableCtx: WritableContext,
): ChangefeedContext {
  const subscribers = new Map<string, Set<(change: ChangeBase) => void>>()
  const deepSubscribers = new Map<string, Set<(event: DeepEvent) => void>>()

  // The dispatch closure needs the full ChangefeedContext for notifyAll,
  // but the context object is constructed after the closure. Use a let
  // binding that the closure captures by reference — by the time dispatch
  // is called, `ctx` is populated.
  let ctx: ChangefeedContext

  const wrappedDispatch = (path: Path, change: ChangeBase): void => {
    // Delegate to the original dispatch (applies change to store)
    writableCtx.dispatch(path, change)
    // Then notify all subscribers (observation layer)
    if (writableCtx.autoCommit) {
      notifyAll(ctx, path, change)
    }
    // In batched mode, notification happens at flush time
  }

  ctx = {
    store: writableCtx.store,
    dispatch: wrappedDispatch,
    autoCommit: writableCtx.autoCommit,
    pending: writableCtx.pending,
    subscribers,
    deepSubscribers,
  }

  return ctx
}

/**
 * Flushes pending changes AND notifies all subscribers (exact + deep)
 * for each one.
 *
 * This is the changefeed equivalent of the bare `flush()` from writable.ts.
 * It applies changes to the store and notifies subscribers for each
 * flushed change.
 */
export function changefeedFlush(ctx: ChangefeedContext): PendingChange[] {
  const flushed = [...ctx.pending]
  for (const { path, change } of flushed) {
    // Apply to store directly (not via ctx.dispatch, which would
    // re-accumulate in batched mode).
    applyChangeToStore(ctx.store, path, change)
    notifyAll(ctx, path, change)
  }
  ctx.pending.length = 0
  return flushed
}

// ---------------------------------------------------------------------------
// subscribeDeep — context-level deep subscription
// ---------------------------------------------------------------------------

/**
 * Subscribe to changes at `path` and all descendant paths.
 *
 * The callback receives a `DeepEvent` with:
 * - `origin`: the relative path from the subscriber's position to the
 *   dispatch point (e.g. `[{type:"key", key:"darkMode"}]` if subscribed
 *   at `["settings"]` and dispatch at `["settings", "darkMode"]`).
 *   When the change dispatches at the subscriber's own path, `origin`
 *   is `[]`.
 * - `change`: the `ChangeBase` that was dispatched.
 *
 * Returns an unsubscribe function.
 *
 * ```ts
 * const unsub = subscribeDeep(cfCtx, [], (event) => {
 *   console.log(`Change at ${formatPath(event.origin)}:`, event.change.type)
 * })
 * ```
 */
export function subscribeDeep(
  ctx: ChangefeedContext,
  path: Path,
  callback: (event: DeepEvent) => void,
): () => void {
  return subscribeToMap(ctx.deepSubscribers, pathKey(path), callback)
}

// ---------------------------------------------------------------------------
// withChangefeed decorator
// ---------------------------------------------------------------------------

/**
 * A decorator that attaches `[CHANGEFEED]` to object results produced by
 * any interpreter. Used via `enrich(anyInterpreter, withChangefeed)`.
 *
 * For each object result, attaches a non-enumerable `[CHANGEFEED]` property
 * containing a `Changefeed` whose:
 * - `current` reads the current value from the store at the node's path
 * - `subscribe` registers a callback for changes dispatched to that path
 *
 * For primitive results (strings, numbers, etc.), this is a no-op —
 * you can't attach properties to primitives.
 *
 * The decorator mutates the result directly via `Object.defineProperty`
 * and returns `{}` so that `enrich`'s `Object.assign` is a harmless
 * no-op.
 *
 * ```ts
 * const enriched = enrich(withMutation(readableInterpreter), withChangefeed)
 * const ctx = createChangefeedContext(createWritableContext(store))
 * const doc = interpret(schema, enriched, ctx)
 * // doc[CHANGEFEED].current returns the current store value
 * // doc[CHANGEFEED].subscribe(cb) receives changes
 * ```
 */
export const withChangefeed: Decorator<ChangefeedContext, unknown, {}> = (
  result: unknown,
  ctx: ChangefeedContext,
  path: Path,
): {} => {
  if (!isPropertyHost(result)) {
    // Can't attach symbol properties to primitives — no-op
    return {}
  }

  const cf = createChangefeedForPath(ctx.subscribers, path, () =>
    readByPath(ctx.store, path),
  )

  // Attach directly via Object.defineProperty (non-enumerable).
  attachChangefeed(result, cf)

  // Return empty — enrich's Object.assign({}) is a no-op.
  return {}
}
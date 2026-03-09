// Changefeed decorator — attaches [CHANGEFEED] to interpreted results via `enrich`.
//
// This module owns the observation concern (read + subscribe). It is
// orthogonal to the writable interpreter which owns the mutation concern.
// Compose them via `enrich(writableInterpreter, withChangefeed)`.
//
// See theory §5.4 (capability decomposition) and §7.2 (enrich combinator).

import type { ChangeBase } from "../change.js"
import type { Decorator } from "../combinators.js"
import { CHANGEFEED } from "../changefeed.js"
import type { Changefeed } from "../changefeed.js"
import type { Path } from "../interpret.js"
import type { WritableContext, PendingChange, Store } from "./writable.js"
import { readByPath, applyChangeToStore } from "./writable.js"

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

function notifySubscribers(
  subscribers: Map<string, Set<(action: ChangeBase) => void>>,
  path: Path,
  action: ChangeBase,
): void {
  const key = pathKey(path)
  const subs = subscribers.get(key)
  if (subs) {
    for (const cb of subs) {
      cb(action)
    }
  }
}

function subscribeToPath(
  subscribers: Map<string, Set<(action: ChangeBase) => void>>,
  path: Path,
  callback: (action: ChangeBase) => void,
): () => void {
  const key = pathKey(path)
  let subs = subscribers.get(key)
  if (!subs) {
    subs = new Set()
    subscribers.set(key, subs)
  }
  subs.add(callback)
  return () => {
    subs!.delete(callback)
    if (subs!.size === 0) {
      subscribers.delete(key)
    }
  }
}

// ---------------------------------------------------------------------------
// Feed creation helper
// ---------------------------------------------------------------------------

function createChangefeedForPath(
  subscribers: Map<string, Set<(action: ChangeBase) => void>>,
  path: Path,
  readHead: () => unknown,
): Changefeed<unknown, ChangeBase> {
  return {
    get current() {
      return readHead()
    },
    subscribe(callback: (action: ChangeBase) => void): () => void {
      return subscribeToPath(subscribers, path, callback)
    },
  }
}

// ---------------------------------------------------------------------------
// Attach [CHANGEFEED] non-enumerably to any object
// ---------------------------------------------------------------------------

function attachChangefeed(
  target: object,
  feed: Changefeed<unknown, ChangeBase>,
): void {
  Object.defineProperty(target, CHANGEFEED, {
    value: feed,
    enumerable: false,
    configurable: true,
    writable: false,
  })
}

// ---------------------------------------------------------------------------
// FeedableContext — extends WritableContext with subscriber notification
// ---------------------------------------------------------------------------

/**
 * A context that extends `WritableContext` with subscriber notification.
 *
 * Created by `createChangefeedContext`, which wraps an existing writable
 * context's `dispatch` to notify subscribers after each change is applied.
 *
 * The `withChangefeed` decorator reads `subscribers` from this context to
 * create changefeed objects.
 */
export interface ChangefeedContext extends WritableContext {
  readonly subscribers: Map<string, Set<(action: ChangeBase) => void>>
}

/**
 * Wraps a `WritableContext` to add subscriber notification.
 *
 * The returned context has the same store, autoCommit, and pending array,
 * but its `dispatch` function calls the original dispatch AND notifies
 * subscribers. This is the dispatch-wrapping pattern: the writable
 * interpreter calls `ctx.dispatch` without knowing that notification
 * happens inside.
 *
 * ```ts
 * const store = { title: "", count: 0 }
 * const wCtx = createWritableContext(store)
 * const cfCtx = createChangefeedContext(wCtx)
 * const doc = interpret(schema, enrich(writableInterpreter, withChangefeed), cfCtx)
 * ```
 */
export function createChangefeedContext(
  writableCtx: WritableContext,
): ChangefeedContext {
  const subscribers = new Map<string, Set<(change: ChangeBase) => void>>()

  const wrappedDispatch = (path: Path, change: ChangeBase): void => {
    // Delegate to the original dispatch (applies action to store)
    writableCtx.dispatch(path, change)
    // Then notify subscribers (observation layer)
    if (writableCtx.autoCommit) {
      notifySubscribers(subscribers, path, change)
    }
    // In batched mode, notification happens at flush time
  }

  return {
    store: writableCtx.store,
    dispatch: wrappedDispatch,
    autoCommit: writableCtx.autoCommit,
    pending: writableCtx.pending,
    subscribers,
  }
}

/**
 * Flushes pending changes AND notifies subscribers for each one.
 *
 * This is the changefeed equivalent of the bare `flush()` from writable.ts.
 * It imports and calls the bare flush (which applies changes to the store),
 * then notifies subscribers for each flushed change.
 */
export function changefeedFlush(ctx: ChangefeedContext): PendingChange[] {
  // We need to apply + notify. The bare flush applies but doesn't notify.
  // We replicate the apply + notify loop here rather than importing flush,
  // because we need to notify after each action.
  const flushed = [...ctx.pending]
  for (const { path, change: action } of flushed) {
    // Apply to store via the ORIGINAL dispatch path.
    // We can't use ctx.dispatch because in batched mode it would
    // re-accumulate. Instead, read from store and apply directly.
    applyChangeToStore(ctx.store, path, action)
    notifySubscribers(ctx.subscribers, path, action)
  }
  ctx.pending.length = 0
  return flushed
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
 * (which bypasses Proxy `set` traps) and returns `{}` so that `enrich`'s
 * `Object.assign` is a harmless no-op.
 *
 * ```ts
 * const enriched = enrich(writableInterpreter, withChangefeed)
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
  if (result === null || result === undefined || typeof result !== "object") {
    // Can't attach symbol properties to primitives — no-op
    return {}
  }

  const feed = createChangefeedForPath(ctx.subscribers, path, () =>
    readByPath(ctx.store, path),
  )

  // Attach directly via Object.defineProperty (non-enumerable).
  // This bypasses Proxy set traps — goes through defineProperty trap.
  attachChangefeed(result, feed)

  // Return empty — enrich's Object.assign({}) is a no-op.
  return {}
}

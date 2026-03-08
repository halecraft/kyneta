// Feed decorator — attaches [FEED] to interpreted results via `enrich`.
//
// This module owns the observation concern (read + subscribe). It is
// orthogonal to the writable interpreter which owns the mutation concern.
// Compose them via `enrich(writableInterpreter, withFeed)`.
//
// See theory §5.4 (capability decomposition) and §7.2 (enrich combinator).

import type { ActionBase } from "../action.js"
import type { Decorator } from "../combinators.js"
import { FEED } from "../feed.js"
import type { Feed } from "../feed.js"
import type { Path } from "../interpret.js"
import type {
  WritableContext,
  PendingAction,
  Store,
} from "./writable.js"
import { readByPath, toStorePath, applyActionToStore } from "./writable.js"

// ---------------------------------------------------------------------------
// Subscriber infrastructure (moved from writable.ts)
// ---------------------------------------------------------------------------

function pathKey(path: readonly string[]): string {
  return path.join("\0")
}

function notifySubscribers(
  subscribers: Map<string, Set<(action: ActionBase) => void>>,
  path: readonly string[],
  action: ActionBase,
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
  subscribers: Map<string, Set<(action: ActionBase) => void>>,
  storePath: readonly string[],
  callback: (action: ActionBase) => void,
): () => void {
  const key = pathKey(storePath)
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
// Feed creation helper (moved from writable.ts)
// ---------------------------------------------------------------------------

function createFeedForPath(
  subscribers: Map<string, Set<(action: ActionBase) => void>>,
  storePath: readonly string[],
  readHead: () => unknown,
): Feed<unknown, ActionBase> {
  return {
    get head() {
      return readHead()
    },
    subscribe(callback: (action: ActionBase) => void): () => void {
      return subscribeToPath(subscribers, storePath, callback)
    },
  }
}

// ---------------------------------------------------------------------------
// Attach [FEED] non-enumerably to any object (moved from writable.ts)
// ---------------------------------------------------------------------------

function attachFeed(
  target: object,
  feed: Feed<unknown, ActionBase>,
): void {
  Object.defineProperty(target, FEED, {
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
 * Created by `createFeedableContext`, which wraps an existing writable
 * context's `dispatch` to notify subscribers after each action is applied.
 *
 * The `withFeed` decorator reads `subscribers` from this context to
 * create feed objects.
 */
export interface FeedableContext extends WritableContext {
  readonly subscribers: Map<string, Set<(action: ActionBase) => void>>
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
 * const fCtx = createFeedableContext(wCtx)
 * const doc = interpret(schema, enrich(writableInterpreter, withFeed), fCtx)
 * ```
 */
export function createFeedableContext(
  writableCtx: WritableContext,
): FeedableContext {
  const subscribers = new Map<string, Set<(action: ActionBase) => void>>()

  const wrappedDispatch = (
    storePath: readonly string[],
    action: ActionBase,
  ): void => {
    // Delegate to the original dispatch (applies action to store)
    writableCtx.dispatch(storePath, action)
    // Then notify subscribers (observation layer)
    if (writableCtx.autoCommit) {
      notifySubscribers(subscribers, storePath, action)
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
 * Flushes pending actions AND notifies subscribers for each one.
 *
 * This is the feedable equivalent of the bare `flush()` from writable.ts.
 * It imports and calls the bare flush (which applies actions to the store),
 * then notifies subscribers for each flushed action.
 */
export function feedableFlush(ctx: FeedableContext): PendingAction[] {
  // We need to apply + notify. The bare flush applies but doesn't notify.
  // We replicate the apply + notify loop here rather than importing flush,
  // because we need to notify after each action.
  const flushed = [...ctx.pending]
  for (const { path, action } of flushed) {
    // Apply to store via the ORIGINAL dispatch path.
    // We can't use ctx.dispatch because in batched mode it would
    // re-accumulate. Instead, read from store and apply directly.
    applyActionToStore(ctx.store, path, action)
    notifySubscribers(ctx.subscribers, path, action)
  }
  ctx.pending.length = 0
  return flushed
}



// ---------------------------------------------------------------------------
// withFeed decorator
// ---------------------------------------------------------------------------

/**
 * A decorator that attaches `[FEED]` to object results produced by any
 * interpreter. Used via `enrich(anyInterpreter, withFeed)`.
 *
 * For each object result, attaches a non-enumerable `[FEED]` property
 * containing a `Feed` whose:
 * - `head` reads the current value from the store at the node's path
 * - `subscribe` registers a callback for actions dispatched to that path
 *
 * For primitive results (strings, numbers, etc.), this is a no-op —
 * you can't attach properties to primitives.
 *
 * The decorator mutates the result directly via `Object.defineProperty`
 * (which bypasses Proxy `set` traps) and returns `{}` so that `enrich`'s
 * `Object.assign` is a harmless no-op.
 *
 * ```ts
 * const enriched = enrich(writableInterpreter, withFeed)
 * const ctx = createFeedableContext(createWritableContext(store))
 * const doc = interpret(schema, enriched, ctx)
 * // doc[FEED].head returns the current store value
 * // doc[FEED].subscribe(cb) receives actions
 * ```
 */
export const withFeed: Decorator<FeedableContext, unknown, {}> = (
  result: unknown,
  ctx: FeedableContext,
  path: Path,
): {} => {
  if (
    result === null ||
    result === undefined ||
    typeof result !== "object"
  ) {
    // Can't attach symbol properties to primitives — no-op
    return {}
  }

  const storePath = toStorePath(path)

  const feed = createFeedForPath(
    ctx.subscribers,
    storePath,
    () => readByPath(ctx.store, storePath),
  )

  // Attach directly via Object.defineProperty (non-enumerable).
  // This bypasses Proxy set traps — goes through defineProperty trap.
  attachFeed(result, feed)

  // Return empty — enrich's Object.assign({}) is a no-op.
  return {}
}
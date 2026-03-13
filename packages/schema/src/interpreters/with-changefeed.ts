// Changefeed decorator — attaches [CHANGEFEED] to interpreted results via `enrich`.
//
// This module owns the observation concern (read + subscribe). It is
// orthogonal to the mutation concern provided by `withMutation`.
// Compose them via `enrich(withMutation(readableInterpreter), withChangefeed)`.
//
// This is transitional scaffolding — Phase 5 replaces `withChangefeed`
// with `withCompositionalChangefeed` (an interpreter transformer) and
// deletes this file entirely.
//
// See theory §5.4 (capability decomposition) and §7.2 (enrich combinator).

import type { ChangeBase } from "../change.js"
import type { Decorator } from "../combinators.js"
import { CHANGEFEED } from "../changefeed.js"
import type { Changefeed } from "../changefeed.js"
import type { Path } from "../interpret.js"
import type { WritableContext } from "./writable.js"
import { readByPath } from "../store.js"
import { isPropertyHost } from "../guards.js"

// ---------------------------------------------------------------------------
// Subscriber infrastructure (module-level)
// ---------------------------------------------------------------------------

// Since ChangefeedContext no longer exists, withChangefeed manages its
// own module-level subscriber map keyed by path. Each ref's [CHANGEFEED]
// .subscribe() registers into this map, and the dispatch wrapper fires
// matching callbacks after each change is applied to the store.
//
// This is intentionally simple — it's throwaway scaffolding that Phase 5
// deletes. The compositional changefeed uses per-node subscriber sets
// instead of a flat map.

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
 * Notify exact-path subscribers for a dispatched change.
 */
function notifyExact(
  subscribers: Map<string, Set<(change: ChangeBase) => void>>,
  path: Path,
  change: ChangeBase,
): void {
  const key = pathKey(path)
  const exact = subscribers.get(key)
  if (exact) {
    for (const cb of exact) cb(change)
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

export function attachChangefeed(
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
// Dispatch wrapping — wires notification into a WritableContext
// ---------------------------------------------------------------------------

// WeakMap from WritableContext → { subscribers, wrappedDispatch }.
// This ensures that multiple calls to `withChangefeed` for the same
// context share a single subscriber map and dispatch wrapper.
const contextState = new WeakMap<
  WritableContext,
  {
    subscribers: Map<string, Set<(change: ChangeBase) => void>>
    originalDispatch: (path: Path, change: ChangeBase) => void
  }
>()

/**
 * Ensures the given WritableContext has its dispatch wrapped to fire
 * exact-path notifications. Returns the shared subscriber map.
 *
 * The wrapping is idempotent — calling this multiple times with the
 * same context returns the same state.
 */
function ensureNotificationWiring(
  ctx: WritableContext,
): Map<string, Set<(change: ChangeBase) => void>> {
  let state = contextState.get(ctx)
  if (state) return state.subscribers

  const subscribers = new Map<string, Set<(change: ChangeBase) => void>>()
  const originalDispatch = ctx.dispatch

  // Replace ctx.dispatch with a wrapper that also notifies.
  // WritableContext.dispatch is readonly in the interface but the
  // factory returns a plain object — we can mutate it here.
  const wrappedDispatch = (path: Path, change: ChangeBase): void => {
    originalDispatch(path, change)
    notifyExact(subscribers, path, change)
  }
  ;(ctx as any).dispatch = wrappedDispatch

  state = { subscribers, originalDispatch }
  contextState.set(ctx, state)
  return subscribers
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
 * const ctx = createWritableContext(store)
 * const doc = interpret(schema, enriched, ctx)
 * // doc[CHANGEFEED].current returns the current store value
 * // doc[CHANGEFEED].subscribe(cb) receives changes
 * ```
 */
export const withChangefeed: Decorator<WritableContext, unknown, {}> = (
  result: unknown,
  ctx: WritableContext,
  path: Path,
): {} => {
  if (!isPropertyHost(result)) {
    // Can't attach symbol properties to primitives — no-op
    return {}
  }

  const subscribers = ensureNotificationWiring(ctx)

  const cf = createChangefeedForPath(subscribers, path, () =>
    readByPath(ctx.store, path),
  )

  // Attach directly via Object.defineProperty (non-enumerable).
  attachChangefeed(result, cf)

  // Return empty — enrich's Object.assign({}) is a no-op.
  return {}
}
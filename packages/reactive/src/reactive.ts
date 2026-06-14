// reactive — fine-grained reactive computations over the changefeed.
//
// `reactive(thunk)` runs `thunk` under a tracking scope (jj:vtpxvkyk), captures
// the exact set of nodes it read, subscribes to precisely those (Fork A: handle
// dispatch — no positional matching), and re-runs when any dependency changes.
// A monotonic `version` advances iff a dependency fired, so consumers need no
// value comparison (no shallowEqual). `reactive` IS a `Reactive` is a
// `HasChangefeed`, and its `()` reports a read when a scope is active — so
// reading a reactive inside another reactive's thunk auto-wires it. That makes
// `computed` mechanically identical to `reactive` (it ships as an alias), and
// makes reactives compose with `@kyneta/index` `Collection`s / `ReactiveMap`s
// for free (the plain-`HasChangefeed` `.subscribe` branch).
//
// FC/IS: the pure plan (`diffDeps`, `diff.ts`) is separated from the imperative
// shell (subscribe/unsubscribe via `WatcherTable`, recompute, notify, the
// coalescing scheduler). Mirrors `@kyneta/index`'s `integrate` + wiring.

import type {
  ChangeBase,
  ChangefeedProtocol,
  Changeset,
  HasChangefeed,
} from "@kyneta/changefeed"
import {
  CHANGEFEED,
  createWatcherTable,
  type WatcherTable,
} from "@kyneta/changefeed"
import type { Dependency } from "@kyneta/schema"
import {
  currentScope,
  dependencyKey,
  hasRecursiveChangefeed,
  reportRead,
  subscribe as subscribeDeep,
  subscribeNode,
  withReadScope,
} from "@kyneta/schema"
import { diffDeps } from "./diff.js"

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// Reactive — the public type
// ---------------------------------------------------------------------------

/**
 * A reactive computation. Callable (`r()` returns the current value, pulled
 * fresh if dirty), carries a monotonic `version` (advances iff a dependency
 * fired), and is itself a `HasChangefeed` (so other reactives and React's
 * `useSyncExternalStore` can observe it). Reading `r()` inside a tracking
 * scope reports a dependency on `r`.
 */
export interface Reactive<T> extends HasChangefeed<T> {
  (): T
  /** Monotonic — advances exactly when a recompute occurs (a dependency fired). */
  readonly version: number
  /** The current value, recomputed on read if dirty. */
  readonly current: T
  /** Observe invalidations (post-coalesce). Returns an unsubscribe. */
  subscribe(cb: () => void): () => void
  /**
   * Recompute now with the current thunk and return the value, WITHOUT bumping
   * `version` or notifying. For framework bindings (e.g. `@kyneta/react`'s
   * `useTracked`) that re-run every render to follow closure-captured state
   * (props/filter) with no deps array — re-tracking here never loops with
   * `useSyncExternalStore` because the change token (`version`) is untouched.
   */
  refresh(): T
  /** Tear down all dependency subscriptions and detach from the scheduler. */
  dispose(): void
  /** True after `dispose()`. Lets framework bindings recreate after a teardown (e.g. React StrictMode remount). */
  readonly disposed: boolean
}

// ---------------------------------------------------------------------------
// Internal node state
// ---------------------------------------------------------------------------

interface ReactiveNode<T> {
  readonly thunk: () => T
  value: T
  version: number
  dirty: boolean
  disposed: boolean
  computedEpoch: number
  readonly depKey: string
  subs: WatcherTable<Dependency>
  readonly listeners: Set<(cs: Changeset) => void>
}

let nextReactiveId = 1
const REACTIVE_CHANGES: readonly ChangeBase[] = [{ type: "reactive" }]

// ---------------------------------------------------------------------------
// Coalescing scheduler (imperative shell)
// ---------------------------------------------------------------------------
//
// A dependency firing marks its node dirty and schedules a single microtask
// flush — collapsing a burst of changesets (multiple merges / a replay) into
// one re-run per node. Reads are pull-on-read, so DAG glitch-freedom needs no
// topological order: reading a dirty dependency recomputes it first. A per-
// flush epoch guard caps each node to one recompute per flush.

const pending = new Set<ReactiveNode<any>>()
let scheduled = false
let flushEpoch = 0

function scheduleFlush(): void {
  if (scheduled) return
  scheduled = true
  queueMicrotask(runFlush)
}

function runFlush(): void {
  scheduled = false
  flushEpoch++
  const epoch = flushEpoch
  while (pending.size > 0) {
    const node = pending.values().next().value as ReactiveNode<any>
    pending.delete(node)
    if (node.disposed || !node.dirty) continue
    if (node.computedEpoch === epoch) continue // already recomputed this flush
    recompute(node)
  }
}

function markDirty(node: ReactiveNode<any>): void {
  if (node.disposed) return
  node.dirty = true
  pending.add(node)
  scheduleFlush()
}

// ---------------------------------------------------------------------------
// aspect → subscription primitive (reuses hasRecursiveChangefeed)
// ---------------------------------------------------------------------------

/**
 * Subscribe to a single dependency via the existing changefeed primitive its
 * aspect maps onto. Schema refs (which carry `RecursiveChangefeedProtocol`)
 * use `subscribeNode` (own-path: value/structure) or `subscribe`
 * (`subscribeDescendants`: deep). Plain `HasChangefeed` sources — another
 * `Reactive`, an index `Collection`, a `ReactiveMap` — use `.subscribe`.
 */
function subscribePrimitive(
  dep: Dependency,
  onInvalidate: () => void,
): () => void {
  const ref = dep.ref
  if (hasRecursiveChangefeed(ref)) {
    return dep.aspect === "deep"
      ? subscribeDeep(ref, onInvalidate)
      : subscribeNode(ref, onInvalidate)
  }
  return ref[CHANGEFEED].subscribe(onInvalidate)
}

// ---------------------------------------------------------------------------
// track / recompute / notify
// ---------------------------------------------------------------------------

/** Run the thunk under tracking, diff dependencies, and reconcile subscriptions. */
function trackNode<T>(node: ReactiveNode<T>): void {
  const { value, deps } = withReadScope(() => node.thunk())
  const prevKeys = new Set<string>(node.subs.keys())
  const { add, remove } = diffDeps(prevKeys, deps)
  for (const key of remove) node.subs.remove(key)
  for (const dep of add) node.subs.add(dep.key, dep)
  node.value = value
  node.dirty = false
  node.computedEpoch = flushEpoch
}

function recompute<T>(node: ReactiveNode<T>): void {
  trackNode(node)
  node.version++
  notify(node)
}

function notify(node: ReactiveNode<any>): void {
  if (node.listeners.size === 0) return
  const cs: Changeset = { changes: REACTIVE_CHANGES }
  for (const cb of [...node.listeners]) cb(cs)
}

// ---------------------------------------------------------------------------
// reactive — the factory
// ---------------------------------------------------------------------------

/**
 * Create a reactive computation from a thunk. The thunk should read kyneta
 * refs (or other reactives / collections); whatever it reads becomes its
 * dependency set, captured automatically.
 *
 * ```ts
 * const visible = reactive(() =>
 *   [...doc.todos].filter(t => t.done()),
 * )
 * visible()            // current value
 * visible.version      // bumps when the visible set changes
 * visible.subscribe(() => render())
 * visible.dispose()    // when done
 * ```
 */
export function reactive<T>(thunk: () => T): Reactive<T> {
  const node: ReactiveNode<T> = {
    thunk,
    value: undefined as T,
    version: 0,
    dirty: false,
    disposed: false,
    computedEpoch: 0,
    depKey: dependencyKey(`reactive#${nextReactiveId++}`, "value"),
    subs: undefined as unknown as WatcherTable<Dependency>,
    listeners: new Set(),
  }
  node.subs = createWatcherTable<Dependency>((_key, dep) =>
    subscribePrimitive(dep, () => markDirty(node)),
  )

  const r = ((): T => {
    if (currentScope()) {
      reportRead({ key: node.depKey, aspect: "value", ref: r as HasChangefeed })
    }
    if (node.dirty && !node.disposed) recompute(node)
    return node.value
  }) as Reactive<T>

  const protocol: ChangefeedProtocol<T> = {
    get current(): T {
      if (node.dirty && !node.disposed) recompute(node)
      return node.value
    },
    subscribe(cb: (cs: Changeset) => void): () => void {
      if (node.disposed) {
        node.disposed = false
        trackNode(node)
      }
      node.listeners.add(cb)
      return () => {
        node.listeners.delete(cb)
      }
    },
  }

  Object.defineProperty(r, CHANGEFEED, { value: protocol, enumerable: false })
  Object.defineProperty(r, "version", {
    get: () => node.version,
    enumerable: false,
  })
  Object.defineProperty(r, "current", {
    get: () => protocol.current,
    enumerable: false,
  })
  Object.defineProperty(r, "disposed", {
    get: () => node.disposed,
    enumerable: false,
  })
  r.subscribe = (cb: () => void): (() => void) =>
    protocol.subscribe(cb as (cs: Changeset) => void)
  r.refresh = (): T => {
    if (!node.disposed) trackNode(node)
    return node.value
  }
  r.dispose = (): void => {
    if (node.disposed) return
    node.disposed = true
    node.subs.clear()
    pending.delete(node)
    node.listeners.clear()
  }

  // Initial computation — establishes value + subscriptions; version stays 0.
  trackNode(node)

  return r
}

/**
 * `computed` is `reactive` — a readability alias for a derived node intended
 * to be read by other reactives. Mechanically identical: any `Reactive` is a
 * `HasChangefeed` whose `()` reports a read, so it auto-wires as a dependency.
 */
export const computed = reactive

// ---------------------------------------------------------------------------
// track — depend on a plain changefeed source (Collection / ReactiveMap)
// ---------------------------------------------------------------------------

const trackKeys = new WeakMap<object, string>()
let nextTrackId = 1

/**
 * Read a plain `HasChangefeed` source (a `@kyneta/index` `Collection`, a
 * `ReactiveMap`, …) as a dependency of the enclosing reactive computation, and
 * return its current value.
 *
 * Schema refs self-report when called (they carry `RecursiveChangefeedProtocol`
 * and are read-tracked), so `track` does **not** double-report them — it only
 * reports sources that would otherwise go uncaptured. This is what lets
 * `useValue(exchange.peers)` and `reactive(() => track(collection))` work.
 *
 * @param source - A callable `HasChangefeed` (its `()` returns the value).
 */
export function track<T>(source: (() => T) & HasChangefeed<T>): T {
  if (currentScope() && !hasRecursiveChangefeed(source)) {
    let key = trackKeys.get(source)
    if (key === undefined) {
      key = dependencyKey(`source#${nextTrackId++}`, "value")
      trackKeys.set(source, key)
    }
    reportRead({ key, aspect: "value", ref: source })
  }
  return source()
}

// Changefeed — the universal reactive contract.
//
// A changefeed is a reactive value with a current state and a stream
// of future changes. You read `current` to see what's there now;
// you subscribe to learn what changes next.
//
// The changefeed protocol is expressed through a single symbol: CHANGEFEED.
//
// Changes are delivered as `Changeset<C>` — a batch of one or more
// changes with optional provenance metadata. Auto-commit wraps a
// single change in a degenerate changeset of one; transactions and
// `applyChanges` deliver multi-change batches. The subscriber API
// is uniform regardless of batch size.
//
// This module is the canonical home of the reactive contract. It has
// zero dependencies — no schema, no paths, no interpreters.

import type { ChangeBase } from "./change.js"

// ---------------------------------------------------------------------------
// Symbol
// ---------------------------------------------------------------------------

/**
 * The single symbol that marks a value as a changefeed. Accessing
 * `obj[CHANGEFEED]` yields a `ChangefeedProtocol<S, C>` — the current
 * value and a stream of future changes.
 *
 * Uses `Symbol.for` so that multiple copies of this module (e.g. in
 * different bundle chunks) share the same symbol identity.
 */
export const CHANGEFEED: unique symbol = Symbol.for("kyneta:changefeed") as any

// ---------------------------------------------------------------------------
// Changeset — the unit of batch delivery
// ---------------------------------------------------------------------------

/**
 * A changeset is the unit of delivery through the changefeed protocol.
 * It wraps one or more changes with optional batch-level metadata.
 *
 * - Auto-commit produces a degenerate changeset of one change.
 * - Transactions and `applyChanges` produce multi-change batches.
 * - `origin` carries provenance for the entire batch (e.g. "sync",
 *   "undo", "local"). Individual changes do not carry provenance —
 *   the batch does.
 *
 * The subscriber API always receives a `Changeset`, making it uniform
 * regardless of how the changes were produced.
 */
export interface Changeset<C = ChangeBase> {
  /** The individual changes in this batch. */
  readonly changes: readonly C[]
  /** Provenance of the batch (e.g. "sync", "undo", "local"). */
  readonly origin?: string
}

// ---------------------------------------------------------------------------
// Core interfaces — protocol layer
// ---------------------------------------------------------------------------

/**
 * The protocol object that sits behind the `[CHANGEFEED]` symbol.
 *
 * A coalgebra: `current` gives the live state, `subscribe` gives the
 * stream of future changes. In automata-theory terms this is a Moore
 * machine with a push-based transition stream.
 *
 * Properties:
 * - `current` is a getter — always returns the live current value
 * - `subscribe` returns an unsubscribe function
 * - Subscribers receive a `Changeset<C>` — a batch of changes with
 *   optional provenance. For auto-commit (single mutation), the
 *   changeset contains exactly one change.
 * - Static (non-reactive) sources return a protocol whose tail never emits:
 *   `{ current: value, subscribe: () => () => {} }`
 *
 * This is internal plumbing — developers interact with `Changefeed<S, C>`
 * (the developer-facing type that includes `[CHANGEFEED]`, `.current`,
 * and `.subscribe()` in one interface).
 */
export interface ChangefeedProtocol<S, C extends ChangeBase = ChangeBase> {
  /** The current value, always live (a getter). */
  readonly current: S
  /** Subscribe to future changes. Returns an unsubscribe function. */
  subscribe(callback: (changeset: Changeset<C>) => void): () => void
}

// ---------------------------------------------------------------------------
// Core interfaces — developer-facing type
// ---------------------------------------------------------------------------

/**
 * The developer-facing changefeed type: a reactive value with direct
 * access to `.current`, `.subscribe()`, and the `[CHANGEFEED]` marker.
 *
 * Developers write `readonly peers: Changefeed<PeerMap, PeerChange>` —
 * no `Has` prefix, no separate protocol object, no triple declaration.
 *
 * A `Changefeed<S, C>` is the intersection of:
 * - The `[CHANGEFEED]` marker (for compiler detection and runtime protocol)
 * - Direct `.current` and `.subscribe()` access (for developer ergonomics)
 *
 * Use `changefeed(source)` to project any `HasChangefeed` into a
 * `Changefeed`, or `createChangefeed()` to build one from scratch.
 */
export interface Changefeed<S, C extends ChangeBase = ChangeBase> {
  /** The protocol object behind the symbol. */
  readonly [CHANGEFEED]: ChangefeedProtocol<S, C>
  /** The current value, always live (a getter). */
  readonly current: S
  /** Subscribe to future changes. Returns an unsubscribe function. */
  subscribe(callback: (changeset: Changeset<C>) => void): () => void
}

/**
 * An object that carries a changefeed protocol under the `[CHANGEFEED]`
 * symbol.
 *
 * Any ref, interpreted node, or enriched value can implement this
 * interface to participate in the reactive protocol.
 */
export interface HasChangefeed<S = unknown, A extends ChangeBase = ChangeBase> {
  readonly [CHANGEFEED]: ChangefeedProtocol<S, A>
}

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

/**
 * Returns `true` if `value` has a `[CHANGEFEED]` property, i.e. it
 * implements the `HasChangefeed` interface.
 */
export function hasChangefeed<S = unknown, A extends ChangeBase = ChangeBase>(
  value: unknown,
): value is HasChangefeed<S, A> {
  return (
    value !== null &&
    value !== undefined &&
    (typeof value === "object" || typeof value === "function") &&
    CHANGEFEED in (value as object)
  )
}

// ---------------------------------------------------------------------------
// Static feed helper
// ---------------------------------------------------------------------------

/**
 * Creates a changefeed protocol that never emits changes — useful for
 * static/non-reactive data sources that still need to participate in
 * the changefeed protocol.
 */
export function staticChangefeed<S>(head: S): ChangefeedProtocol<S, never> {
  return {
    get current() {
      return head
    },
    subscribe() {
      return () => {}
    },
  }
}

// ---------------------------------------------------------------------------
// Projector — lift HasChangefeed to Changefeed
// ---------------------------------------------------------------------------

/**
 * Project any object with `[CHANGEFEED]` into a developer-facing
 * `Changefeed<S, C>` — lifting the hidden protocol surface to direct
 * `.current` and `.subscribe()` accessibility.
 *
 * ```ts
 * const feed = changefeed(doc.title)
 * feed.current          // live value
 * feed.subscribe(cb)    // subscribe to changes
 * feed[CHANGEFEED]      // the protocol object (same as doc.title[CHANGEFEED])
 * ```
 */
export function changefeed<S, C extends ChangeBase>(
  source: HasChangefeed<S, C>,
): Changefeed<S, C> {
  const protocol = source[CHANGEFEED]
  return {
    [CHANGEFEED]: protocol,
    get current(): S {
      return protocol.current
    },
    subscribe(callback: (changeset: Changeset<C>) => void): () => void {
      return protocol.subscribe(callback)
    },
  }
}

// ---------------------------------------------------------------------------
// Factory — create standalone Changefeed values
// ---------------------------------------------------------------------------

/**
 * Create a standalone `Changefeed<S, C>` with push semantics.
 *
 * Returns a tuple of the feed and an emit function. The feed's
 * `[CHANGEFEED]` returns the protocol view of itself. Manages its
 * own subscriber set internally.
 *
 * ```ts
 * const [feed, emit] = createChangefeed(() => count)
 * feed.current                       // read live value
 * feed.subscribe(cs => { ... })      // subscribe
 * hasChangefeed(feed)                 // true
 * emit({ changes: [{ type: "replace", value: 42 }] })  // push
 * ```
 */
export function createChangefeed<S, C extends ChangeBase = ChangeBase>(
  getCurrent: () => S,
): [feed: Changefeed<S, C>, emit: (changeset: Changeset<C>) => void] {
  const subscribers = new Set<(changeset: Changeset<C>) => void>()

  const protocol: ChangefeedProtocol<S, C> = {
    get current(): S {
      return getCurrent()
    },
    subscribe(callback: (changeset: Changeset<C>) => void): () => void {
      subscribers.add(callback)
      return () => {
        subscribers.delete(callback)
      }
    },
  }

  const feed: Changefeed<S, C> = {
    [CHANGEFEED]: protocol,
    get current(): S {
      return getCurrent()
    },
    subscribe(callback: (changeset: Changeset<C>) => void): () => void {
      return protocol.subscribe(callback)
    },
  }

  const emit = (changeset: Changeset<C>): void => {
    for (const cb of subscribers) {
      cb(changeset)
    }
  }

  return [feed, emit]
}

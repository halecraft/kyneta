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
export const CHANGEFEED: unique symbol = Symbol.for("kyneta:changefeed")

// ---------------------------------------------------------------------------
// BatchMetadata — the four orthogonal channels riding on every batch
// ---------------------------------------------------------------------------

/**
 * Batch-level metadata that rides on each Changeset. The four fields sit on
 * a two-axis classification:
 *
 *                | provenance       | outcome
 *     -----------|------------------|----------
 *     app-set    | origin           | (none)
 *     subscr-set | source           | (none)
 *     kyneta-set | replay           | aborted
 *
 * - **Provenance** answers "where did this come from?" — `origin` is the
 *   app-level label, `source` is the originating caller's identity token,
 *   `replay` says the ops were not written on this peer.
 * - **Outcome** answers "what happened?" — only kyneta sets it, and only
 *   to signal the abort-compensation case.
 *
 * The fields are *orthogonal* — none subsumes another. (For example,
 * a tagged local write that throws produces `{ source: T, aborted: true }`
 * simultaneously.) Each field has its own consumer with its own typed
 * read; no string-convention discrimination is required.
 *
 * `Changeset<C>` extends this with `changes`. `@kyneta/schema` derives
 * these fields from its upstream `BatchOptions`, whose required `ingress`
 * says whether a local writer authored the batch.
 *
 * Context: jj:qpultxsw (origin/replay), jj:ryquprut (aborted),
 * jj:wpvtoxmw (source).
 */
export interface BatchMetadata {
  /**
   * App-level provenance label. Subscribers MAY read this for routing
   * or display, but kyneta itself never branches on its value. For
   * kyneta-internal echo suppression use `source` instead.
   *
   * Example values: `"sync"`, `"undo"`, `"migration"`.
   */
  readonly origin?: string
  /**
   * True iff no writer on this peer made these ops: they came from a
   * `merge`, a reset, or a decay tick. A write on the native document that
   * a substrate's event bridge reports (an editor binding's, say) was made
   * here, so it is not a replay, and neither is a `batch` or
   * `applyChanges`. It is for readers, such as the exchange's observation
   * bus; what leaves the process does not depend on it.
   */
  readonly replay?: boolean
  /**
   * Kyneta-internal structural directive — true iff the outermost
   * `batch(doc, fn)` block threw and was wholly compensated via inverse
   * replay. The op list contains forward + inverse pairs that net to
   * identity at every path. Inner `batch()`s that threw and were caught
   * by an outer `batch()`'s try/catch produce a NON-aborted outermost
   * Changeset; the absorbed forward + inverse pair sits in the op list
   * alongside surviving outer ops. Default `undefined` (== falsy) for
   * successful batches and for batches with `replay: true`.
   */
  readonly aborted?: boolean
  /**
   * Identity-typed token supplied by the originating `batch()` call.
   * Compared with `===` only — never inspected or serialized.
   *
   * Subscribers that issued the change set this token on their own
   * `batch()` call and compare against `cs.source` to suppress echoes
   * (the changefeed will deliver the changeset back to the subscriber
   * that produced it; without the token, the subscriber cannot tell
   * its own writes from someone else's).
   *
   * A batch with `replay: true` never carries `source` — any value reaching
   * a subscriber is therefore from a local caller on this peer: a `batch()`,
   * or an undo the substrate applied natively for one.
   *
   * @example
   * const mySource = Symbol("my-binding")
   * batch(ref, fn, { source: mySource })
   * cf.subscribe(cs => { if (cs.source === mySource) return; / apply / })
   */
  readonly source?: unknown
}

// ---------------------------------------------------------------------------
// Changeset — the unit of batch delivery
// ---------------------------------------------------------------------------

/**
 * A changeset is the unit of delivery through the changefeed protocol.
 * It wraps one or more changes with optional batch-level metadata.
 *
 * - Auto-commit produces a degenerate changeset of one change.
 * - `batch(doc, fn)` and `applyChanges` produce multi-change batches.
 * - The four metadata fields (`origin`, `replay`, `aborted`, `source`)
 *   come from {@link BatchMetadata}; see that type for the orthogonal
 *   two-axis classification.
 *
 * The subscriber API always receives a `Changeset`, making it uniform
 * regardless of how the changes were produced.
 */
export interface Changeset<C = ChangeBase> extends BatchMetadata {
  /** The individual changes in this batch. */
  readonly changes: readonly C[]
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
 * - `current` is a getter, and obeys the identity rule: it returns the same
 *   value until the state changes, and a new one once it has. So a consumer
 *   can tell whether anything changed by comparing identities alone, as
 *   `useSyncExternalStore` and `React.memo` do.
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
  /** The current value: the same value until the state changes, a new one
   *  once it has. */
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
  /** The current value: the same value until the state changes, a new one
   *  once it has. */
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
 * `current` returns whatever `getCurrent` returns, so the identity rule is
 * the producer's to keep: `getCurrent` must return the same value until the
 * state changes. A producer over mutable state keeps one snapshot with
 * `cachedSnapshot`.
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

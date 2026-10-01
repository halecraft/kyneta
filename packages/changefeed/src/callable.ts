// callable — changefeeds you can call: `feed()` reads the current value.
//
// `Feed<S, C>` is the minimal callable carrier: a function that reads a value
// and carries its `[CHANGEFEED]`. `CallableChangefeed<S, C>` is a `Feed` that
// is also a `Changefeed`, with `.current` and `.subscribe` as properties.

import type { ChangeBase } from "./change.js"
import type {
  Changefeed,
  ChangefeedProtocol,
  Changeset,
  HasChangefeed,
} from "./changefeed.js"
import { CHANGEFEED } from "./changefeed.js"

// ---------------------------------------------------------------------------
// Feed — the callable carrier
// ---------------------------------------------------------------------------

/**
 * A function that reads a value and carries its `[CHANGEFEED]`: calling it
 * reads, and the protocol under the symbol observes. `populatedFeed(ref)` in
 * `@kyneta/schema` and a settle term in `@kyneta/exchange` are each a
 * `Feed<boolean>`.
 */
export type Feed<S, C extends ChangeBase = ChangeBase> = (() => S) &
  HasChangefeed<S, C>

/**
 * `read` as a feed over `protocol`: calling it calls `read`, and its
 * `[CHANGEFEED]` is `protocol`, non-enumerable and fixed. `read` and
 * `protocol.current` should agree; they are separate so a call can do what
 * reading `current` does not (a schema feed reports a tracked read).
 *
 * ```ts
 * const feed = createFeed(() => count, { get current() { return count }, subscribe })
 * feed()              // read
 * hasChangefeed(feed) // true
 * ```
 */
export function createFeed<S, C extends ChangeBase>(
  read: () => S,
  protocol: ChangefeedProtocol<S, C>,
): Feed<S, C> {
  const feed = (): S => read()
  Object.defineProperty(feed, CHANGEFEED, {
    value: protocol,
    enumerable: false,
    configurable: false,
    writable: false,
  })
  return feed as Feed<S, C>
}

// ---------------------------------------------------------------------------
// CallableChangefeed — a Feed that is also a Changefeed
// ---------------------------------------------------------------------------

/**
 * A changefeed that is also callable — `feed()` returns `feed.current`.
 *
 * A `Feed<S, C>` with the `Changefeed<S, C>` surface, `.current` and
 * `.subscribe`, as properties.
 */
export type CallableChangefeed<
  S,
  C extends ChangeBase = ChangeBase,
> = Changefeed<S, C> & Feed<S, C>

/**
 * Wrap a `Changefeed<S, C>` in a callable function-object: a `Feed` over the
 * wrapped feed's protocol, with `.current` and `.subscribe` delegating to it.
 *
 * ```ts
 * const [source, emit] = createChangefeed(() => count)
 * const feed = createCallable(source)
 * feed()              // read current value
 * feed.current        // same as feed()
 * feed.subscribe(cb)  // subscribe to changes
 * ```
 */
export function createCallable<S, C extends ChangeBase>(
  source: Changefeed<S, C>,
): CallableChangefeed<S, C> {
  const feed = createFeed(() => source.current, source[CHANGEFEED])
  Object.defineProperty(feed, "current", {
    get(): S {
      return source.current
    },
    enumerable: true,
    configurable: false,
  })
  Object.defineProperty(feed, "subscribe", {
    value: (callback: (changeset: Changeset<C>) => void): (() => void) =>
      source.subscribe(callback),
    enumerable: true,
    configurable: false,
    writable: false,
  })
  return feed as CallableChangefeed<S, C>
}

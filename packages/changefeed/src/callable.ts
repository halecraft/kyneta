// callable — the createCallable combinator.
//
// Wraps a Changefeed<S, C> in a callable function-object so that
// `feed()` returns `feed.current`. The callable preserves the full
// changefeed contract: [CHANGEFEED], .current, .subscribe().
//
// This is the same function-object pattern used by LocalRef in
// @kyneta/cast — a function with properties attached.

import type { ChangeBase } from "./change.js"
import type { Changefeed, ChangefeedProtocol, Changeset } from "./changefeed.js"
import { CHANGEFEED } from "./changefeed.js"

// ---------------------------------------------------------------------------
// Type
// ---------------------------------------------------------------------------

/**
 * A changefeed that is also callable — `feed()` returns `feed.current`.
 *
 * This is the intersection of `Changefeed<S, C>` and `() => S`.
 * The call signature provides ergonomic read access without `.current`.
 */
export type CallableChangefeed<
  S,
  C extends ChangeBase = ChangeBase,
> = Changefeed<S, C> & (() => S)

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Wrap a `Changefeed<S, C>` in a callable function-object.
 *
 * The returned object:
 * - `feed()` → `feed.current` (callable)
 * - `feed.current` → delegated getter
 * - `feed.subscribe(cb)` → delegated
 * - `feed[CHANGEFEED]` → delegated protocol
 * - `hasChangefeed(feed)` → `true`
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
  feed: Changefeed<S, C>,
): CallableChangefeed<S, C> {
  const callable: any = () => feed.current

  // [CHANGEFEED] — non-enumerable getter delegating to source
  Object.defineProperty(callable, CHANGEFEED, {
    get(): ChangefeedProtocol<S, C> {
      return feed[CHANGEFEED]
    },
    enumerable: false,
    configurable: false,
  })

  // .current — getter delegating to source
  Object.defineProperty(callable, "current", {
    get(): S {
      return feed.current
    },
    enumerable: true,
    configurable: false,
  })

  // .subscribe — delegating to source
  callable.subscribe = (
    callback: (changeset: Changeset<C>) => void,
  ): (() => void) => {
    return feed.subscribe(callback)
  }

  return callable as CallableChangefeed<S, C>
}

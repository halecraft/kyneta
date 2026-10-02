// combinators — feeds built from a getter, from other feeds, or set later.
//
// Each is a signal feed: a subscriber hears that the value may have moved,
// with an empty changeset, and reads it by calling the feed. That is the
// shape of a flag or an answer, where the value is small and what changed is
// the whole of it.

import type { Feed } from "./callable.js"
import { createFeed } from "./callable.js"
import type { Changeset } from "./changefeed.js"
import { CHANGEFEED, hasChangefeed } from "./changefeed.js"

const MOVED: Changeset<never> = { changes: [] }

/**
 * A feed over a getter and a change signal: calling it calls `read`, and a
 * subscriber hears every `onChange` as an empty changeset.
 */
export function signalFeed<T>(
  read: () => T,
  subscribe: (onChange: () => void) => () => void,
): Feed<T> {
  return createFeed(read, {
    get current(): T {
      return read()
    },
    subscribe(callback: (changeset: Changeset<never>) => void): () => void {
      return subscribe(() => callback(MOVED))
    },
  })
}

/**
 * The answer of the first feed that has one (is not `undefined`). A
 * subscriber hears every change of every feed, since any of them can move the
 * answer.
 */
export function firstDefined<T>(
  ...feeds: readonly Feed<T | undefined>[]
): Feed<T | undefined> {
  return signalFeed(
    () => {
      for (const feed of feeds) {
        const answer = feed()
        if (answer !== undefined) return answer
      }
      return undefined
    },
    onChange => {
      const stops = feeds.map(feed =>
        feed[CHANGEFEED].subscribe(() => onChange()),
      )
      return () => {
        for (const stop of stops) stop()
      }
    },
  )
}

/** A feed whose source is set later: a value, or another feed it follows. */
export type Settable<T> = Feed<T> & {
  /** Hold `next` from now on, and tell every subscriber. */
  set(next: T | Feed<T>): void
}

/**
 * A feed holding a value, or following another feed, until the next `set`.
 *
 * Every `set` notifies, and lets go of what it held: a feed set aside is
 * unsubscribed from and no longer referenced, so whatever it closed over can
 * be collected while this feed lives on.
 */
export function settableFeed<T>(initial: T | Feed<T>): Settable<T> {
  let source: { readonly value: T } | { readonly feed: Feed<T> } =
    sourceOf(initial)
  const listeners = new Set<() => void>()
  let stopInner: (() => void) | undefined

  const read = (): T => ("feed" in source ? source.feed() : source.value)
  const follow = (): void => {
    stopInner?.()
    stopInner =
      "feed" in source && listeners.size > 0
        ? source.feed[CHANGEFEED].subscribe(() => {
            for (const listener of [...listeners]) listener()
          })
        : undefined
  }

  const feed = signalFeed(read, onChange => {
    listeners.add(onChange)
    if (listeners.size === 1) follow()
    return () => {
      listeners.delete(onChange)
      if (listeners.size === 0) follow()
    }
  })
  return Object.assign(feed, {
    set(next: T | Feed<T>): void {
      source = sourceOf(next)
      follow()
      for (const listener of [...listeners]) listener()
    },
  })
}

function sourceOf<T>(
  value: T | Feed<T>,
): { readonly value: T } | { readonly feed: Feed<T> } {
  return typeof value === "function" && hasChangefeed(value)
    ? { feed: value as Feed<T> }
    : { value: value as T }
}

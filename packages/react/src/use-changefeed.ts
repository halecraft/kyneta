// use-changefeed — subscribe a React component to any [CHANGEFEED] source.
//
// `.current` is the snapshot and a subscription is the change signal, which
// is the useSyncExternalStore contract once two things hold. `current` must
// keep its identity until the source changes — the changefeed identity rule,
// which every kyneta source keeps. And the subscription must cover everything
// `current` reads: a schema composite's `current` is its whole subtree, so it
// is subscribed with `subscribeDescendants`, not the own-path `subscribe`.

import type { Changefeed } from "@kyneta/changefeed"
import { CHANGEFEED } from "@kyneta/changefeed"
import { hasRecursiveChangefeed } from "@kyneta/schema"
import { useMemo, useSyncExternalStore } from "react"

/**
 * Subscribe to a {@link Changefeed} and return its current value, re-rendering
 * exactly when it changes.
 *
 * The general-purpose hook for any `[CHANGEFEED]` source — schema refs,
 * `exchange.peers`, `exchange.documents`, standalone feeds. A source that
 * supports descendant subscriptions (a schema ref) is subscribed with them, so
 * an edit anywhere below it re-renders, as its `current` reads it.
 *
 * ```tsx
 * // exchange.peers — a ReactiveMap
 * const peers = useChangefeed(exchange.peers)
 * // peers: ReadonlyMap<PeerId, PeerIdentityDetails>
 *
 * // exchange.documents
 * const docs = useChangefeed(exchange.documents)
 *
 * // Any schema ref via the changefeed() projector
 * import { changefeed } from "@kyneta/changefeed"
 * const todos = useChangefeed(changefeed(doc.todos))
 * ```
 *
 * @param feed - Any `Changefeed<T, any>` source.
 * @returns The current value `T`, updated reactively.
 */
export function useChangefeed<T>(feed: Changefeed<T, any>): T {
  const store = useMemo(
    () => ({
      subscribe: (onStoreChange: () => void) =>
        hasRecursiveChangefeed(feed)
          ? feed[CHANGEFEED].subscribeDescendants(() => onStoreChange())
          : feed.subscribe(() => onStoreChange()),
      getSnapshot: () => feed.current,
    }),
    [feed],
  )
  return useSyncExternalStore(store.subscribe, store.getSnapshot)
}

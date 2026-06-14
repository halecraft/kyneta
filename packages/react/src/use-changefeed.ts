// use-changefeed — subscribe a React component to any [CHANGEFEED] source.
//
// The [CHANGEFEED] protocol is already the useSyncExternalStore contract:
// .current (snapshot) and .subscribe() (returns unsubscribe). useChangefeed
// is the one-liner that bridges them: no intermediate store factory needed.

import type { Changefeed } from "@kyneta/changefeed"
import { useMemo, useSyncExternalStore } from "react"

/**
 * Subscribe to a {@link Changefeed} and return its current value, re-rendering
 * on each new changeset.
 *
 * This is the general-purpose hook for any `[CHANGEFEED]` source — schema refs,
 * `exchange.peers`, `exchange.documents`, standalone feeds.
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
 * const title = useChangefeed(changefeed(doc.title))
 * ```
 *
 * @param feed - Any `Changefeed<T, any>` source.
 * @returns The current value `T`, updated reactively.
 */
export function useChangefeed<T>(feed: Changefeed<T, any>): T {
  const store = useMemo(
    () => ({
      subscribe: (onStoreChange: () => void) =>
        feed.subscribe(() => onStoreChange()),
      getSnapshot: () => feed.current,
    }),
    [feed],
  )
  return useSyncExternalStore(store.subscribe, store.getSnapshot)
}

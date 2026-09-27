// when-peer — find a peer's seat by what it says it is.

import type { PeerIdentityDetails } from "@kyneta/transport"
import type { Exchange } from "./exchange.js"

/**
 * The identity of the first connected peer matching `predicate`: at once if
 * one is connected, otherwise when one establishes.
 *
 * `exchange.peers` lists a peer until it departs, including through the grace
 * period after its last channel closes, so a peer that is briefly
 * disconnected matches too. That is what a `Line` wants: it addresses the
 * seat, and resumes when the seat reconnects.
 *
 * There is no timeout; race the promise against one if the peer may never
 * come.
 *
 * ```ts
 * const server = await whenPeer(exchange, p => p.principal === "server")
 * const chat = Chat.sender(exchange, server.peerId)
 * ```
 */
export function whenPeer(
  exchange: Exchange,
  predicate: (peer: PeerIdentityDetails) => boolean,
): Promise<PeerIdentityDetails> {
  const find = (): PeerIdentityDetails | undefined => {
    for (const [, peer] of exchange.peers) if (predicate(peer)) return peer
    return undefined
  }
  const present = find()
  if (present) return Promise.resolve(present)
  return new Promise(resolve => {
    const unsubscribe = exchange.peers.subscribe(() => {
      const found = find()
      if (!found) return
      unsubscribe()
      resolve(found)
    })
  })
}

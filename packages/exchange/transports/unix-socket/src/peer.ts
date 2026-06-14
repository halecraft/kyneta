// peer — public factory for the leaderless unix socket peer.
//
// `createUnixSocketPeer(options)` returns a `UnixSocketPeerHandle` (augmented with
// live `role` observation), consumed like any other transport via
// `new Exchange({ transports: [peer] })`. The peer never receives or touches
// the Exchange — it is a self-healing `Transport` (see peer-transport.ts).

import type { AnyTransport } from "@kyneta/transport"
import type { PeerRole } from "./peer-program.js"
import {
  type UnixSocketPeerOptions,
  UnixSocketPeerTransport,
} from "./peer-transport.js"

export type { UnixSocketPeerOptions } from "./peer-transport.js"

/**
 * A `TransportFactory` for a leaderless peer, augmented with live role
 * observation. Pass directly to `new Exchange({ transports: [peer] })`, then
 * read `peer.role` / `peer.subscribe(...)` for the negotiated role.
 */
export type UnixSocketPeerHandle = AnyTransport & {
  /** The current negotiated role (`"negotiating"` until the Exchange starts it). */
  readonly role: PeerRole
  /** Observe role transitions; returns an unsubscribe function. */
  subscribe(fn: (role: PeerRole) => void): () => void
}

/**
 * Create a leaderless unix socket peer.
 *
 * The first peer to start becomes the listener (binds the socket); later peers
 * connect. If the listener dies, a connector re-negotiates and may become the
 * new listener — all in place, with documents and CRDT state preserved.
 *
 * @example
 * ```typescript
 * import { Exchange } from "@kyneta/exchange"
 * import { createUnixSocketPeer } from "@kyneta/unix-socket-transport"
 *
 * const peer = createUnixSocketPeer({ path: "/tmp/kyneta.sock" })
 * const exchange = new Exchange({ id: "alice", transports: [peer] })
 * // later: peer.role, peer.subscribe(role => render(role))
 * ```
 */
export function createUnixSocketPeer(
  options: UnixSocketPeerOptions,
): UnixSocketPeerHandle {
  return new UnixSocketPeerTransport(options)
}

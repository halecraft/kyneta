// types — transport identity types for @kyneta/transport.
//
// These are the foundational identity types used across all transports.
// They are substrate-agnostic — no Loro, no plain-specific concepts.

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/** Peer identifier — a string unique within the exchange network. */
export type PeerId = string

/** Document identifier — a string unique within an exchange. */
export type DocId = string

/** Channel identifier — a monotonic integer assigned by the adapter. */
export type ChannelId = number

/** Adapter type identifier — e.g. "bridge", "websocket", "indexeddb". */
export type TransportType = string

/**
 * Peer identity details — the full identity of a peer in the network.
 *
 * `peerId` is the globally unique, stable identifier. `name` is an
 * optional human-readable label. `type` classifies the peer's role.
 */
export type PeerIdentityDetails = {
  peerId: PeerId
  name?: string
  type: "user" | "bot" | "service"
}

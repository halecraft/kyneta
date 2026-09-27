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

// ---------------------------------------------------------------------------
// Protocol version
// ---------------------------------------------------------------------------

/**
 * Sync wire-contract revision a peer implements. Distinct from
 * `WIRE_VERSION` (frame encoding) and `SyncMode` (per-doc sync policy):
 * this names the revision of the message vocabulary + handshake
 * choreography itself.
 *
 * Compatibility is a rule, not a negotiation (additive evolution rides
 * `WireFeatures`): differing `major` ⇒ incompatible (error); differing
 * `minor` within a major ⇒ backward-compatible refinement (warning).
 *
 * **Establish negotiation-core invariant:** the part of `establish`
 * carrying `id`, `y`, and `protocolVersion` is a permanent meta-contract,
 * invariant across all protocol revisions. Future revisions may extend
 * `establish` or change other messages but may never break a peer's
 * ability to parse another peer's identity + `protocolVersion`.
 *
 * Context: jj:yukrpnwm
 */
export type ProtocolVersion = { major: number; minor: number }

/**
 * The sync wire-contract revision this build implements.
 *
 * 2.0 added `accept` and removed `offer.reciprocate`. A peer on 1.x neither
 * acknowledges what it applies nor understands being told, so the two cannot
 * converge; the major says so at `establish`.
 */
export const PROTOCOL_VERSION: ProtocolVersion = { major: 2, minor: 0 }

/**
 * What an `establish` without `pv` means: the revision before the field
 * existed. Fixed forever, as part of the negotiation-core invariant: were it
 * "the current revision", every older peer that omits the field would be
 * read as current, and a major mismatch would go unreported.
 */
export const BASELINE_PROTOCOL_VERSION: ProtocolVersion = {
  major: 1,
  minor: 0,
}

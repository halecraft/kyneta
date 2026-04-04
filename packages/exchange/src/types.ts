// types — core identity and state types for @kyneta/exchange.
//
// These are the foundational types used across the exchange package.
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
// Ready state — per-doc sync status
// ---------------------------------------------------------------------------

/**
 * Sync status for a document with a specific peer.
 */
export type ReadyState = {
  docId: DocId
  identity: PeerIdentityDetails
  status: "pending" | "synced" | "absent"
}

// ---------------------------------------------------------------------------
// Peer document sync tracking
// ---------------------------------------------------------------------------

/**
 * Discriminated union for peer document awareness.
 * - "unknown": We don't know if the peer has this document
 * - "absent": Peer explicitly doesn't have this document
 * - "pending": Peer has this document but we haven't synced yet
 * - "synced": Peer has this document with a known version
 */
export type PeerDocSyncState =
  | { status: "unknown"; lastUpdated: Date }
  | { status: "absent"; lastUpdated: Date }
  | { status: "pending"; lastUpdated: Date }
  | { status: "synced"; lastKnownVersion: string; lastUpdated: Date }

/**
 * Tracked state for a single peer.
 */
export type PeerState = {
  identity: PeerIdentityDetails
  docSyncStates: Map<DocId, PeerDocSyncState>
  subscriptions: Set<DocId>
  channels: Set<ChannelId>
}

// ---------------------------------------------------------------------------
// Peer lifecycle changes
// ---------------------------------------------------------------------------

import type { ChangeBase } from "@kyneta/changefeed"

/**
 * A change in the peer lifecycle — a peer joining or leaving the
 * sync graph. Delivered through `exchange.peers.subscribe()` as
 * part of a `Changeset<PeerChange>`.
 *
 * - `peer-joined`: a remote peer's first channel completed the
 *   establish handshake.
 * - `peer-left`: a remote peer's last channel was removed (graceful
 *   departure, crash, transport stop, or exchange shutdown).
 */
export interface PeerChange extends ChangeBase {
  readonly type: "peer-joined" | "peer-left"
  readonly peer: PeerIdentityDetails
}

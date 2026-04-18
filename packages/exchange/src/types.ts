// types — sync-specific types for @kyneta/exchange.
//
// Transport identity types (PeerId, DocId, ChannelId, TransportType,
// PeerIdentityDetails) are defined in @kyneta/transport.
// This file defines sync-specific types that depend on them.

import type { ChangeBase } from "@kyneta/changefeed"
import type { ChannelId, DocId, PeerIdentityDetails } from "@kyneta/transport"

// Re-export transport identity types so existing `from "./types.js"` imports
// within exchange (e.g. sync.ts) continue to resolve.
export type {
  ChannelId,
  DocId,
  PeerId,
  PeerIdentityDetails,
  TransportType,
} from "@kyneta/transport"

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
// Document info — metadata for the reactive document collection
// ---------------------------------------------------------------------------

/**
 * Metadata about a document's sync participation — the value type for
 * `exchange.documents: ReactiveMap<DocId, DocInfo, DocChange>`.
 *
 * Deliberately minimal: this is sync-level metadata, not application
 * content. The application-level ref is obtained via `exchange.get()`.
 * Mirrors `PeerIdentityDetails` (metadata about the peer, not the
 * peer's full connection state).
 */
export type DocInfo = {
  mode: "interpret" | "replicate" | "deferred"
}

// ---------------------------------------------------------------------------
// Document lifecycle changes
// ---------------------------------------------------------------------------

/**
 * A change in the document lifecycle — delivered through
 * `exchange.documents.subscribe()` as part of a `Changeset<DocChange>`.
 *
 * - `doc-created`: a document was registered for interpret or replicate
 *   mode (local `get()`/`replicate()`, or remote auto-resolve).
 * - `doc-removed`: a document was dismissed or deleted from the sync graph.
 * - `doc-deferred`: a document was tracked in deferred mode (routing
 *   participation only, no local replica).
 * - `doc-promoted`: a deferred document was promoted to interpret or
 *   replicate mode (e.g. via `exchange.get()` on a deferred doc).
 */
export interface DocChange extends ChangeBase {
  readonly type: "doc-created" | "doc-removed" | "doc-deferred" | "doc-promoted"
  readonly docId: DocId
}

// ---------------------------------------------------------------------------
// Peer lifecycle changes
// ---------------------------------------------------------------------------

/**
 * A change in the peer lifecycle — delivered through
 * `exchange.peers.subscribe()` as part of a `Changeset<PeerChange>`.
 *
 * - `peer-established`: a remote peer's first channel completed the
 *   establish handshake.
 * - `peer-disconnected`: all channels for a peer were removed, but the
 *   peer may reconnect within the departure timeout window.
 * - `peer-reconnected`: a previously disconnected peer re-established
 *   a channel before the departure timer expired.
 * - `peer-departed`: the peer is definitively gone — either a `depart`
 *   message was received, the departure timer expired, or the exchange
 *   was shut down / reset.
 */
export interface PeerChange extends ChangeBase {
  readonly type:
    | "peer-established"
    | "peer-disconnected"
    | "peer-reconnected"
    | "peer-departed"
  readonly peer: PeerIdentityDetails
}

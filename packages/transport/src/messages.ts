// messages — substrate-agnostic message types for the sync protocol.
//
// Four sync messages form the document-exchange vocabulary:
// - `present` — "I have these documents, here are their properties."
// - `interest` — "I want document X. Here's my version."
// - `offer` — "Here is state for document X."
// - `dismiss` — "I'm leaving the sync graph for this document."
//
// Two lifecycle messages manage channel presence:
// - `establish` — symmetric handshake; both peers send on connect
// - `depart` — intentional departure; peer is leaving the channel
//
// These are uniform across all merge strategies. The sync algorithm
// determines *when* and *how* they are sent, not their shape.

import type {
  MergeStrategy,
  ReplicaType,
  SubstratePayload,
} from "@kyneta/schema"
import type { DocId, PeerIdentityDetails } from "./types.js"

// ---------------------------------------------------------------------------
// Lifecycle messages — channel presence
// ---------------------------------------------------------------------------

/**
 * Symmetric handshake. Both peers send this upon connecting.
 */
export type EstablishMsg = {
  type: "establish"
  identity: PeerIdentityDetails
}

/**
 * Intentional departure. Sent by a peer that is leaving the channel.
 */
export type DepartMsg = {
  type: "depart"
}

// ---------------------------------------------------------------------------
// Sync messages — the four-message document-exchange vocabulary
// ---------------------------------------------------------------------------

/**
 * Document presentation — assertion of document ownership with metadata.
 *
 * "I have these docs, here are their properties." Sent by a peer to
 * announce documents it holds. The receiver checks its own state and
 * decides whether to send `interest`. No response expected.
 *
 * Each entry carries per-document metadata (replicaType, mergeStrategy)
 * so the receiver can validate compatibility before any binary exchange.
 */
export type PresentMsg = {
  type: "present"
  docs: Array<{
    docId: DocId
    replicaType: ReplicaType
    mergeStrategy: MergeStrategy
    schemaHash: string
  }>
}

/**
 * Declare sync interest in a document.
 *
 * Carries the sender's current version (if any) so the receiver can
 * compute a delta. For LWW substrates, `version` may be absent on
 * initial connection (meaning "I have nothing, push to me").
 *
 * `reciprocate` asks the receiver to send a reciprocal `interest`
 * back. Used by causal merge to initiate bidirectional exchange.
 * Set to `false` on reciprocal interests to prevent infinite loops.
 */
export type InterestMsg = {
  type: "interest"
  docId: DocId
  /** Serialized Version string, absent for LWW initial sync. */
  version?: string
  /** Whether the receiver should send a reciprocal interest. */
  reciprocate?: boolean
}

/**
 * State transfer — "here is state for document X."
 *
 * Carries an opaque `SubstratePayload` (the exchange never inspects
 * it — only the substrate knows how to produce and consume these).
 * The payload's `kind` discriminant (`"entirety"` or `"since"`)
 * tells the receiver how it was produced — the receiver calls
 * `replica.merge(payload)` which dispatches internally.
 *
 * `reciprocate` asks the receiver to send an `interest` back so that
 * the offerer can receive the receiver's state in turn. Used by causal
 * merge for bidirectional exchange.
 */
export type OfferMsg = {
  type: "offer"
  docId: DocId
  /** Opaque substrate payload — carries its own `kind` discriminant. */
  payload: SubstratePayload
  /** Serialized Version string of the sender's state. */
  version: string
  /** Whether the receiver should send an interest back. */
  reciprocate?: boolean
}

/**
 * Document dismissal — "I'm leaving the sync graph for this document."
 *
 * The dual of `present`: present announces presence, dismiss announces
 * departure. One-way announcement with no response needed. The receiving
 * exchange reflects the change in `exchange.documents` (changefeed) and
 * `exchange.peers` (per-peer document sets) for observation.
 */
export type DismissMsg = {
  type: "dismiss"
  docId: DocId
}

// ---------------------------------------------------------------------------
// Message unions
// ---------------------------------------------------------------------------

/** Lifecycle messages — channel presence management. */
export type LifecycleMsg = EstablishMsg | DepartMsg

/** Sync messages — document-exchange vocabulary. */
export type SyncMsg = PresentMsg | InterestMsg | OfferMsg | DismissMsg

/** All channel messages. */
export type ChannelMsg = LifecycleMsg | SyncMsg

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

/** Type predicate for lifecycle messages. */
export function isLifecycleMsg(msg: ChannelMsg): msg is LifecycleMsg {
  return msg.type === "establish" || msg.type === "depart"
}

/** Type predicate for sync messages. */
export function isSyncMsg(msg: ChannelMsg): msg is SyncMsg {
  return !isLifecycleMsg(msg)
}

// ---------------------------------------------------------------------------
// Envelopes — addressed messages for routing
// ---------------------------------------------------------------------------

/** A message addressed to specific channels (outbound). */
export type AddressedEnvelope = {
  toChannelIds: number[]
  message: ChannelMsg
}

/** A message received from a specific channel (inbound). */
export type ReturnEnvelope = {
  fromChannelId: number
  message: ChannelMsg
}

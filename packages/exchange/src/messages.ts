// messages — substrate-agnostic message types for the exchange protocol.
//
// Three core message types form the sync vocabulary:
// - `discover` — "What documents exist?" / "I have these documents."
// - `interest` — "I want document X. Here's my version."
// - `offer` — "Here is state for document X."
//
// Plus two establishment messages for channel handshake:
// - `establish-request` — initiate channel establishment
// - `establish-response` — acknowledge channel establishment
//
// These are uniform across all merge strategies. The sync algorithm
// determines *when* and *how* they are sent, not their shape.

import type { SubstratePayload } from "@kyneta/schema"
import type { DocId, PeerIdentityDetails } from "./types.js"

// ---------------------------------------------------------------------------
// Establishment messages — channel handshake
// ---------------------------------------------------------------------------

/**
 * Initiate channel establishment. Sent by the connecting peer.
 */
export type EstablishRequestMsg = {
  type: "establish-request"
  identity: PeerIdentityDetails
}

/**
 * Acknowledge channel establishment. Sent by the receiving peer.
 */
export type EstablishResponseMsg = {
  type: "establish-response"
  identity: PeerIdentityDetails
}

// ---------------------------------------------------------------------------
// Exchange messages — the three-message sync vocabulary
// ---------------------------------------------------------------------------

/**
 * Document discovery.
 *
 * Bidirectional — both asking and answering are discovery. "What do you
 * have?" and "I have these" collapse into the same message type. The
 * direction is implicit in the content.
 *
 * Future work: `docIds` may be replaced or augmented with query
 * predicates (e.g. glob patterns, schema-based filters).
 */
export type DiscoverMsg = {
  type: "discover"
  docIds: DocId[]
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
 * The dual of `discover`: discover announces presence, dismiss announces
 * departure. One-way announcement with no response needed. The receiving
 * exchange fires `onDocDismissed` if configured.
 */
export type DismissMsg = {
  type: "dismiss"
  docId: DocId
}

// ---------------------------------------------------------------------------
// Message unions
// ---------------------------------------------------------------------------

/** Messages valid during the establishment phase. */
export type EstablishmentMsg = EstablishRequestMsg | EstablishResponseMsg

/** Messages valid after establishment is complete. */
export type ExchangeMsg = DiscoverMsg | InterestMsg | OfferMsg | DismissMsg

/** All channel messages. */
export type ChannelMsg = EstablishmentMsg | ExchangeMsg

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

/** Type predicate for establishment-phase messages. */
export function isEstablishmentMsg(msg: ChannelMsg): msg is EstablishmentMsg {
  return msg.type === "establish-request" || msg.type === "establish-response"
}

/** Type predicate for post-establishment exchange messages. */
export function isExchangeMsg(msg: ChannelMsg): msg is ExchangeMsg {
  return !isEstablishmentMsg(msg)
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

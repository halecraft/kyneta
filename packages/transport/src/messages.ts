// messages — substrate-agnostic message types for the sync protocol.
//
// Five sync messages form the document-exchange vocabulary:
// - `present` — "I have these documents, here are their properties."
// - `interest` — "I want document X. Here's my version."
// - `offer` — "Here is state for document X."
// - `dismiss` — "I'm leaving the sync graph for this document."
// - `vacant` — "You want document X, but I don't have it and won't serve it."
//
// Two lifecycle messages manage channel presence:
// - `establish` — symmetric handshake; both peers send on connect
// - `depart` — intentional departure; peer is leaving the channel
//
// These are uniform across all sync protocols. The sync algorithm
// determines *when* and *how* they are sent, not their shape.

import type { DocMetadata, SubstratePayload } from "@kyneta/schema"
import type { DocId, PeerIdentityDetails, ProtocolVersion } from "./types.js"

// ---------------------------------------------------------------------------
// Wire-feature negotiation (v1)
// ---------------------------------------------------------------------------

/**
 * Optional wire-format features advertised by a peer in `establish`.
 *
 * Distinct from `Capabilities` in `@kyneta/exchange` (which describes
 * substrate/schema bindings — `ReplicaType × SyncMode` pairs the peer
 * speaks). `WireFeatures` describes what *wire-format* extensions a peer
 * understands — independent of any substrate.
 *
 * Backward compatibility: a peer that omits `features` (or omits any
 * field) is treated as not supporting that feature. Absent ⇒ `false`.
 *
 * `streamed` and `datagram` are reserved for future QUIC modes and are
 * implementation-deferred in v1.
 */
export type WireFeatures = {
  /** Peer understands `a`/`dx`/`sa`/`shx` alias fields. */
  alias?: boolean
  /** Peer can receive over QUIC streams. Reserved for future. */
  streamed?: boolean
  /** Peer can receive over QUIC datagrams. Reserved for future. */
  datagram?: boolean
}

// ---------------------------------------------------------------------------
// Lifecycle messages — channel presence
// ---------------------------------------------------------------------------

/**
 * Symmetric handshake. Both peers send this upon connecting.
 *
 * `features` is optional; absent means the peer advertises no
 * wire-format features (treat as all-`false`).
 */
export type EstablishMsg = {
  type: "establish"
  identity: PeerIdentityDetails
  features?: WireFeatures
  /**
   * Sync wire-contract revision this peer implements (see `ProtocolVersion`).
   * Required here, but optional on the wire (`pv`): the codec omits the
   * default and re-defaults it on decode, so downstream code never handles
   * an absent version while a baseline-`(1,0)` peer's bytes stay identical
   * to a pre-protocolVersion peer's. ("complete in memory, sparse on the wire.")
   */
  protocolVersion: ProtocolVersion
}

/**
 * Intentional departure. Sent by a peer that is leaving the channel.
 */
export type DepartMsg = {
  type: "depart"
}

// ---------------------------------------------------------------------------
// Sync messages — the five-message document-exchange vocabulary
// ---------------------------------------------------------------------------

/**
 * Document presentation — assertion of document ownership with metadata.
 *
 * "I have these docs, here are their properties." Sent by a peer to
 * announce documents it holds. The receiver checks its own state and
 * decides whether to send `interest`. No response expected.
 *
 * Each entry carries per-document metadata (replicaType, syncMode)
 * so the receiver can validate compatibility before any binary exchange.
 *
 * It also carries `supportedHashes` — but that is the *sender's* declaration
 * of which shapes it can read, not a property of the document, which has
 * exactly one shape. `DocMetadata` deliberately does not model it (see
 * `ReadCapability` in `@kyneta/schema`), so this message declares it here,
 * where the sparseness belongs: the field is omitted on the wire whenever it
 * would say nothing beyond `schemaHash`, so it is optional in a way a local
 * read capability never is.
 */
export type PresentMsg = {
  type: "present"
  docs: Array<
    { docId: DocId } & DocMetadata & {
        readonly supportedHashes?: readonly string[]
      }
  >
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

/**
 * Terminal negative acknowledgement — "you expressed interest in document
 * X, but I do not have it and will not serve it."
 *
 * The semantic opposite of `dismiss`: dismiss means "I am leaving a doc I
 * *had*" (and its receiver tears down the local replica link), whereas
 * `vacant` means "I never had it / won't serve it." Point-to-point, one-way,
 * carries only `docId`. The receiver records the sender as `vacant` for
 * this doc — reconciliation reached a terminal answer — *without* tearing
 * down its own replica.
 */
export type VacantMsg = {
  type: "vacant"
  docId: DocId
}

// ---------------------------------------------------------------------------
// Message unions
// ---------------------------------------------------------------------------

/** Lifecycle messages — channel presence management. */
export type LifecycleMsg = EstablishMsg | DepartMsg

/** Sync messages — document-exchange vocabulary. */
export type SyncMsg =
  | PresentMsg
  | InterestMsg
  | OfferMsg
  | DismissMsg
  | VacantMsg

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

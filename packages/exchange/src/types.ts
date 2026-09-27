// types — sync-specific types for @kyneta/exchange.
//
// Transport identity types (PeerId, DocId, ChannelId, TransportType,
// PeerIdentityDetails) are defined in @kyneta/transport.
// This file defines sync-specific types that depend on them.

import type { ChangeBase } from "@kyneta/changefeed"
import type {
  ChannelId,
  DocId,
  PeerId,
  PeerIdentityDetails,
} from "@kyneta/transport"

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
// Peer sync state — the raw per-peer, per-doc projection
// ---------------------------------------------------------------------------

/**
 * Sync state for a document with a specific peer — the volatile per-peer
 * fact surfaced by `sync(doc).peerStates`. Can regress (e.g. `synced →
 * pending` on a reconnect re-handshake); use `sync(doc).ready` for a
 * monotonic doc-level latch.
 */
export type PeerSyncState = {
  docId: DocId
  peer: PeerIdentityDetails
  state: "pending" | "synced" | "vacant"
}

/**
 * Coarse connection lifecycle for a document's sync, independent of any
 * single transport's socket state:
 * - "online": at least one established peer (a live channel)
 * - "connecting": transports configured, but no established peer yet
 * - "offline": no transports configured (local-only)
 *
 * The time dimension ("proceed offline after N ms") lives in
 * `sync(doc).settled({ offlineAfter })`, not here.
 */
export type Connectivity = "online" | "connecting" | "offline"

// ---------------------------------------------------------------------------
// Diagnostics — structured silent-failure signals
// ---------------------------------------------------------------------------

/**
 * Machine-readable diagnostic kind — the single discriminant of `Diagnostic`.
 * Future deferred causes (`store-error`, `wire-reassembly`) become new
 * variants with their own exact fields, never new optionals on the existing
 * ones. `code` is the programmatic `kind` the planned structured
 * `onProtocolWarning` callback (jj:wkwskqsy) would expose. Context: jj:nztkqwpm.
 */
export type DiagnosticCode =
  | "self-connection"
  | "duplicate-peer"
  | "protocol-skew"
  | "protocol-mismatch"
  | "replica-type-mismatch"
  | "schema-hash-mismatch"
  | "sync-mode-mismatch"

interface DiagnosticCore {
  readonly severity: "error" | "warning"
  /** Human-readable line — also what the shell logs to the console. */
  readonly message: string
}
/** The remote counterparty the diagnostic concerns. */
interface PeerScoped {
  readonly peer: PeerId
}
/** The two compared values of a mismatch — symmetric, not directional. */
interface Comparison {
  readonly local: string
  readonly remote: string
}

/**
 * A structured diagnostic — a discriminated union keyed on `code`, so each
 * cause carries exactly its fields (no optionals; illegal states cannot be
 * represented). Produced by the session/sync programs as a `diagnostic`
 * effect and surfaced through the observation bus as a `DiagnosticBody`
 * (jj:qpmkoryn). Context: jj:nztkqwpm.
 */
export type Diagnostic =
  | (DiagnosticCore &
      PeerScoped & { readonly code: "self-connection" | "duplicate-peer" })
  | (DiagnosticCore &
      PeerScoped &
      Comparison & { readonly code: "protocol-skew" | "protocol-mismatch" })
  | (DiagnosticCore &
      PeerScoped &
      Comparison & {
        readonly code:
          | "replica-type-mismatch"
          | "schema-hash-mismatch"
          | "sync-mode-mismatch"
        readonly docId: DocId
      })

// ---------------------------------------------------------------------------
// Peer document sync tracking
// ---------------------------------------------------------------------------

/**
 * What we know about one peer and one document.
 *
 * `status` says whether we still have anything to receive from the peer:
 * - "pending": it may hold something we lack;
 * - "synced": nothing left to receive from it;
 * - "vacant": it confirmed it doesn't have, and won't serve, this document.
 *
 * The two versions are facts in opposite directions, independent of the
 * status, so they survive it changing.
 */
export type PeerDocSyncState = {
  readonly status: "pending" | "synced" | "vacant"
  /**
   * The latest of our versions this peer holds: from its `accept`, or the
   * version its interest stated. Compaction never trims past it.
   */
  readonly ourVersionTheyHold?: string
  /**
   * The latest of this peer's versions we have applied: the version of the
   * last offer we imported from it, or the version it stated when we already
   * held it. Quoted back to it as an interest's `since`.
   */
  readonly theirVersionWeHold?: string
  readonly lastUpdated: Date
}

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
  suspended: boolean
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
 * - `doc-suspended`: a document left the sync graph but its runtime
 *   was preserved for later resumption.
 * - `doc-resumed`: a previously suspended document re-entered the
 *   sync graph with its surviving runtime.
 */
export interface DocChange extends ChangeBase {
  readonly type:
    | "doc-created"
    | "doc-removed"
    | "doc-deferred"
    | "doc-promoted"
    | "doc-suspended"
    | "doc-resumed"
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

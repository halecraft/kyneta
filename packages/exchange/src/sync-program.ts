// sync-program — TEA state machine for document convergence.
//
// The sync program handles the document-exchange vocabulary: present,
// interest, offer, dismiss. It tracks per-peer document sync states
// and manages sync protocol dispatch.
//
// Key invariant: the sync program never sees channels, transports, or
// connection state. It speaks only in terms of peers and documents.
// The shell resolves PeerId → ChannelId when interpreting effects.

import type { Program } from "@kyneta/machine"
import type {
  MetadataAxis,
  MetadataMismatch,
  ReadCapability,
  ReplicaType,
  SubstratePayload,
  SyncMode,
} from "@kyneta/schema"
import { mismatchForSync, requiresBidirectionalSync } from "@kyneta/schema"
import type {
  AcceptMsg,
  DismissMsg,
  DocId,
  InterestMsg,
  OfferMsg,
  PeerId,
  PeerIdentityDetails,
  PresentMsg,
  SyncMsg,
  VacantMsg,
} from "@kyneta/transport"
import type { Diagnostic, DocChange, PeerDocSyncState } from "./types.js"

// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
// STATE
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

/**
 * Per-document state in the sync model.
 *
 * Substrate-agnostic: holds serialized version strings and factory
 * references instead of concrete replica instances. The actual
 * Substrate<V> and Ref<S> are held by the Exchange class — the sync
 * program only needs version info and factory metadata for sync
 * decisions.
 */
export type DocEntry = {
  docId: DocId

  /** Document participation mode — interpret (full stack), replicate (headless), or deferred (routing only). */
  mode: "interpret" | "replicate" | "deferred"

  /** Serialized version from replica.version().serialize() */
  version: string

  /** Identifies the binary format of this document's replica */
  replicaType: ReplicaType

  /** The sync protocol for this document's substrate */
  syncMode: SyncMode

  /** A deterministic hash representing the document's schema */
  schemaHash: string

  /** All schema hashes this peer supports for this doc (enables heterogeneous-version sync). */
  supportedHashes?: readonly string[]

  /**
   * Whether the document's format keeps no history to trim
   * (`ReplicaFactoryLike.historyFree`), which decides whether an imported
   * offer is answered with `accept`. Absent for a deferred document, which
   * holds no replica and imports nothing.
   */
  historyFree?: boolean
}

export type SyncPeerState = {
  identity: PeerIdentityDetails
  docSyncStates: Map<DocId, PeerDocSyncState>
}

/**
 * The sync program's complete state model.
 *
 * Note the absence of channels — the sync program operates exclusively
 * on peers. The shell maps PeerId → ChannelId when executing effects.
 */
export type SyncModel = {
  /** Our own peer identity */
  identity: PeerIdentityDetails

  /** All documents we know about (local and synced from peers) */
  documents: Map<DocId, DocEntry>

  /** Peer state tracking for sync optimization */
  peers: Map<PeerId, SyncPeerState>

  /** Doc lifecycle events queued for emission at quiescence. */
  pendingDocEvents: readonly DocChange[]

  /**
   * Doc-ids whose peer sync state changed. Dedup-by-presence — listeners
   * must receive at most one peer-sync change per docId per cycle even
   * if multiple peers' states flipped (consumers rebuild the full state
   * from `getPeerStates(docId)` on receipt).
   */
  pendingPeerSyncDocIds: readonly DocId[]

  /**
   * Doc-ids whose state a remote import advanced. Local changes are not
   * here: the Runtime persists them before it reports them.
   * Dedup-by-presence — `onStateAdvanced` fires at most once per docId
   * per cycle. The persistence layer reads the full delta from the
   * replica on receipt, so duplicate firings would re-export the same
   * delta wastefully.
   */
  pendingStateAdvancedDocIds: readonly DocId[]

  /**
   * Monotonic, grow-only per-doc accumulator of reconciled peer identities
   * — the doc-level readiness latch. The monotonic complement to the
   * volatile `docSyncStates`: both are folds of the same peer-sync
   * transition, advanced at the single `setPeerDocState` fold point when a
   * peer reaches `synced` or `vacant`. Never pulled down by the
   * `synced→pending` reconnect flip. Stores the **identity** (not just the
   * `PeerId`) so the `readyFor` predicate works and the fact survives the
   * peer leaving `model.peers`. Mirrors `@kyneta/schema`'s
   * `populated`/`populated` set, lifted to the sync layer.
   *
   * Cleared only on *our* doc removal (`handleDocDelete`, true-removal
   * `handleDocDismiss`) and `initSync` — never by an inbound `dismiss`.
   */
  reconciledIdentities: Map<DocId, Map<PeerId, PeerIdentityDetails>>
}

// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
// INPUTS (messages into the update function)
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

/**
 * Inputs that drive the sync state machine. All prefixed `sync/`.
 */
export type SyncInput =
  | {
      type: "sync/peer-available"
      peerId: PeerId
      identity: PeerIdentityDetails
    }
  | { type: "sync/peer-unavailable"; peerId: PeerId }
  | { type: "sync/peer-departed"; peerId: PeerId }
  | { type: "sync/message-received"; from: PeerId; message: SyncMsg }
  | {
      type: "sync/doc-ensure"
      docId: DocId
      mode: "interpret" | "replicate"
      version: string
      replicaType: ReplicaType
      /** From the replica factory: see {@link DocEntry.historyFree}. */
      historyFree: boolean
      syncMode: SyncMode
      schemaHash: string
      supportedHashes?: readonly string[]
      /**
       * Optional shell-detected doc-event to append to pendingDocEvents
       * atomically with this input. Used by the synchronizer to fold the
       * doc-event queue and the sync-model update into a single drain
       * cycle — so emit-doc-events at quiescence sees the final state.
       */
      event?: DocChange
    }
  | {
      type: "sync/doc-defer"
      docId: DocId
      replicaType: ReplicaType
      syncMode: SyncMode
      schemaHash: string
      supportedHashes?: readonly string[]
      event?: DocChange
    }
  | { type: "sync/local-doc-change"; docId: DocId; version: string }
  | { type: "sync/doc-delete"; docId: DocId; event?: DocChange }
  | { type: "sync/doc-dismiss"; docId: DocId; event?: DocChange }
  | {
      type: "sync/doc-imported"
      docId: DocId
      /** Our version after the import: the document's new version. */
      version: string
      /** The offer's version, in the offering peer's terms: what we now hold of theirs. */
      offered: string
      fromPeerId: PeerId
      /**
       * Whether the import moved this replica's state. A payload a peer
       * already held is still an import — the sender learns we are synced —
       * but it is not news to relay, and saying otherwise circulates it
       * forever in a mesh of three or more.
       */
      changed: boolean
      /**
       * Whether our version now reaches `offered`. An offer that leaves us
       * short (a plain delta that did not continue our log, CRDT ops held
       * back for a missing dependency, or ops of a third peer the sender held
       * and we lack) is not held: we ask its sender for the rest.
       */
      held: boolean
      /**
       * What the sender will hold of ours, now that it has told us its
       * version: its `ourVersionTheyWillHold` joined with `offered`, computed
       * by the shell. Absent for a history-free document, whose versions do
       * not join across replicas.
       */
      senderWillHold?: string
    }
  | {
      type: "sync/peer-synced"
      docId: DocId
      /** The version the peer stated, which the check found we already hold. */
      version: string
      peerId: PeerId
    }
  | { type: "sync/declare-vacant"; docId: DocId; to: PeerId }
  | { type: "sync/queue-doc-event"; event: DocChange }
  | { type: "sync/tick-quiescent" }
  | { type: "sync/synthetic-doc-removed-all"; docIds: readonly DocId[] }

// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
// EFFECTS (what needs to happen in the world)
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

/**
 * Effects are side effects produced by the update function.
 * The shell executes them, resolving PeerId → ChannelId as needed.
 */
/** The diagnostics the sync program can emit (per-doc mismatches). */
type SyncDiagnostic = Extract<
  Diagnostic,
  {
    code:
      | "replica-type-mismatch"
      | "schema-hash-mismatch"
      | "sync-mode-mismatch"
  }
>

/**
 * Translate a compatibility axis into the diagnostic code we report it under.
 *
 * The layer boundary made explicit: `@kyneta/schema` names the three axes a
 * document can disagree on, and knows nothing about diagnostics; the exchange
 * names what it reports to users, and `@kyneta/devtools` depends on those code
 * strings independently of either. `satisfies` turns "added an axis, forgot
 * the code" into a compile error rather than a runtime `undefined`.
 */
const MISMATCH_CODE = {
  replicaType: "replica-type-mismatch",
  schemaHash: "schema-hash-mismatch",
  syncMode: "sync-mode-mismatch",
} as const satisfies Record<MetadataAxis, SyncDiagnostic["code"]>

/** The human-readable half of a mismatch diagnostic. */
function describeMismatch(docId: DocId, m: MetadataMismatch): string {
  const subject =
    m.axis === "replicaType"
      ? "replica type"
      : m.axis === "schemaHash"
        ? "schema hash"
        : "syncMode"
  const quote = m.axis === "schemaHash" ? "'" : ""
  return (
    `[exchange] ${subject} mismatch for doc '${docId}': ` +
    `local ${quote}${m.local}${quote} vs remote ${quote}${m.remote}${quote} — skipping sync`
  )
}

export type SyncEffect =
  | { type: "send-to-peer"; to: PeerId; message: SyncMsg }
  | { type: "send-to-peers"; to: PeerId[]; message: SyncMsg }
  | {
      type: "send-offers"
      docId: DocId
      /** Each recipient, and the version its offer starts from; absent sends the whole document. */
      to: ReadonlyArray<{
        readonly peerId: PeerId
        readonly sinceVersion?: string
      }>
    }
  | {
      type: "import-doc-data"
      docId: DocId
      payload: SubstratePayload
      version: string
      fromPeerId: PeerId
      /**
       * Whether the sender is owed an `accept` once the offer is held
       * (imported, already held, or taken by a reset). Decided here: a
       * history-free document is never compacted, so its sender has no use
       * for one, and a peer `canShare` vetoes is sent nothing about the
       * document at all. Sent by the shell as soon as the offer is held,
       * ahead of anything the import makes this peer send.
       */
      accept: boolean
      /**
       * The sender's `Replica.digest()`, when its version cannot answer
       * equality on its own. Compared before anything is applied, to decide
       * whether there is anything to take in.
       */
      digest?: string
      /**
       * The sender's `ourVersionTheyWillHold`, carried so the shell can join
       * it with the offered version without reading this program's state.
       */
      ourVersionTheyWillHold?: string
    }
  | {
      /**
       * Compare a peer's version against ours and mark it `synced` if there
       * is nothing left to receive from it. Emitted on an inbound `interest`.
       *
       * Versions are opaque strings to this program — parsing one needs the
       * substrate's replica factory — so the comparison is the shell's job.
       * The offer path already works this way (`import-doc-data` → the shell
       * classifies → `sync/peer-synced` or `sync/doc-imported` comes back);
       * this is the same question asked when a peer *asks* for our state
       * rather than when it *offers* its own.
       */
      type: "classify-peer-version"
      docId: DocId
      peerId: PeerId
      /** The sender's serialized version, or `undefined` when the interest carried none. */
      version: string | undefined
      /**
       * The sender's `Replica.digest()`, when its version cannot answer
       * equality on its own. Absent means "compare my version".
       */
      digest?: string
    }
  | {
      type: "ensure-doc"
      docId: DocId
      peer: PeerIdentityDetails
      replicaType: ReplicaType
      syncMode: SyncMode
      schemaHash: string
      supportedHashes?: readonly string[]
    }
  | {
      type: "ensure-doc-dismissed"
      docId: DocId
      peer: PeerIdentityDetails
    }
  | { type: "emit-doc-events"; events: readonly DocChange[] }
  | { type: "emit-ready-state-changes"; docIds: readonly DocId[] }
  | { type: "emit-state-advanced"; docIds: readonly DocId[] }
  | ({ type: "diagnostic" } & SyncDiagnostic)

// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
// UPDATE SIGNATURE
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

export type SyncUpdate = (
  input: SyncInput,
  model: SyncModel,
) => [SyncModel, ...SyncEffect[]]

export type SyncProgram = Program<SyncInput, SyncModel, SyncEffect>

// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
// HELPERS — pending-list mutation with dedup-by-presence
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

function appendUniqueDocId(
  list: readonly DocId[],
  docId: DocId,
): readonly DocId[] {
  if (list.includes(docId)) return list
  return [...list, docId]
}

function appendUniqueDocIds(
  list: readonly DocId[],
  docIds: Iterable<DocId>,
): readonly DocId[] {
  let result = list
  for (const id of docIds) {
    if (!result.includes(id)) {
      if (result === list) result = [...list]
      ;(result as DocId[]).push(id)
    }
  }
  return result
}

// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
// HELPER — single fold point for a peer's per-doc sync transition
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

/**
 * Apply a per-peer, per-doc sync-state transition immutably and queue the
 * doc for a peer-sync change notification at quiescence.
 *
 * This is the **single fold point** for the volatile `docSyncStates` map:
 * `handlePeerSynced`, `handleInterestForKnownDoc`, `handleDocImported`,
 * `handleAccept` and `handleVacant` all route through it, so "a peer's state
 * changed" is recorded in exactly one place.
 *
 * `patch` updates only the fields it names, so a new status keeps what we
 * know of the peer's versions, and a new version keeps the status. A patch
 * without a `status` for a document we hold no state for is dropped: there
 * is nothing to attach the version to.
 *
 * No-op (returns `model` unchanged) when we don't track the peer.
 */
function setPeerDocState(
  model: SyncModel,
  peerId: PeerId,
  docId: DocId,
  patch: PeerDocSyncPatch,
): SyncModel {
  const peerState = model.peers.get(peerId)
  if (!peerState) return model
  const current = peerState.docSyncStates.get(docId)
  const status = patch.status ?? current?.status
  if (status === undefined) return model
  const next: PeerDocSyncState = {
    ...current,
    ...patch,
    status,
    lastUpdated: new Date(),
  }

  const peers = new Map(model.peers)
  const docSyncStates = new Map(peerState.docSyncStates)
  docSyncStates.set(docId, next)
  peers.set(peerId, { ...peerState, docSyncStates })

  // A version alone is bookkeeping: nobody observing peer sync state needs
  // to hear about it.
  if (patch.status === undefined) return { ...model, peers }

  // Second fold: when this transition reaches a terminal reconciled state
  // (`synced` or `vacant`), record the peer's identity in the monotonic
  // readiness accumulator. `pending` does NOT touch it — that is what makes
  // `ready` survive the `synced→pending` reconnect flip. Recording exactly
  // here makes "reconciliation is captured at synced/vacant" a single-site,
  // by-construction invariant.
  let reconciledIdentities = model.reconciledIdentities
  if (next.status === "synced" || next.status === "vacant") {
    reconciledIdentities = new Map(reconciledIdentities)
    const inner = new Map(reconciledIdentities.get(docId) ?? [])
    inner.set(peerId, peerState.identity)
    reconciledIdentities.set(docId, inner)
  }

  return {
    ...model,
    peers,
    pendingPeerSyncDocIds: appendUniqueDocId(
      model.pendingPeerSyncDocIds,
      docId,
    ),
    reconciledIdentities,
  }
}

/** The fields of a {@link PeerDocSyncState} a transition sets. */
type PeerDocSyncPatch = {
  readonly status?: PeerDocSyncState["status"]
  readonly ourVersionTheyHold?: string
  readonly ourVersionTheyWillHold?: string
  readonly theirVersionWeHold?: string
}

/**
 * Remove a doc's readiness accumulator entry (our doc removed). Returns the
 * same map reference when the doc is absent so callers avoid a needless copy.
 */
function clearReconciled(
  map: Map<DocId, Map<PeerId, PeerIdentityDetails>>,
  docId: DocId,
): Map<DocId, Map<PeerId, PeerIdentityDetails>> {
  if (!map.has(docId)) return map
  const next = new Map(map)
  next.delete(docId)
  return next
}

/**
 * Pure projection: has this doc reconciled with ≥1 peer (ever)? The
 * connection-independent monotonic latch behind `sync(doc).ready`.
 */
export function hasReconciled(model: SyncModel, docId: DocId): boolean {
  const inner = model.reconciledIdentities.get(docId)
  return inner !== undefined && inner.size > 0
}

/**
 * Pure projection: has this doc reconciled with a peer matching `pred`?
 * Resolves the predicate against the stored identities, so it works even
 * after the matching peer has left `model.peers`.
 */
export function reconciledMatching(
  model: SyncModel,
  docId: DocId,
  pred: (peer: PeerIdentityDetails) => boolean,
): boolean {
  const inner = model.reconciledIdentities.get(docId)
  if (!inner) return false
  for (const identity of inner.values()) {
    if (pred(identity)) return true
  }
  return false
}

// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
// HELPERS — peer queries & routing
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

/**
 * "I will not serve you this document." The reply to a peer's `interest`
 * that we are not going to answer with data.
 *
 * There are two reasons we might not, and **both send exactly this** — which
 * is the whole reason this is one function rather than two literals:
 *
 * - We do not have the document (the `resolve` callback declined it, via
 *   `declareVacant`).
 * - We have it, but `canShare` says this peer may not.
 *
 * Keeping the two replies identical is deliberate. If a denied peer got a
 * `vacant` for documents we hold and silence for ones we do not, the
 * difference would tell it which document ids exist — an "existence oracle",
 * i.e. a way to ask yes/no questions about our data without being allowed to
 * read any of it. Same reply, no question answered.
 *
 * And it is a reply rather than silence because silence is not free either:
 * the requester's `whenSettled` would stay pending until its `offlineAfter`
 * elapsed (forever, by default), and *how long* a peer waits before giving up
 * is itself a signal. `vacant` is terminal — the requester settles
 * immediately, reads the document as empty, and keeps its own replica.
 */
function vacantReply(to: PeerId, docId: DocId): SyncEffect {
  return { type: "send-to-peer", to, message: { type: "vacant", docId } }
}

/**
 * Filter peer IDs by the share predicate. Peers whose identity cannot
 * be resolved are dropped.
 */
function filterPeersByShare(
  model: SyncModel,
  peerIds: PeerId[],
  docId: DocId,
  canShare: SyncPredicate,
): PeerId[] {
  return peerIds.filter(id => {
    const peer = model.peers.get(id)
    if (!peer) return false
    return canShare(docId, peer.identity)
  })
}

/**
 * Get all available peer IDs, optionally excluding one.
 * Replaces `getEstablishedChannelIds` — in the sync program, all peers
 * in the model are considered available (the shell only adds peers after
 * establishment).
 */
function getAvailablePeers(model: SyncModel, excludePeerId?: PeerId): PeerId[] {
  const ids: PeerId[] = []
  for (const [peerId] of model.peers) {
    if (excludePeerId && peerId === excludePeerId) continue
    ids.push(peerId)
  }
  return ids
}

/**
 * Get peer IDs that have previously synced (or are pending sync for) a
 * specific doc. Used for causal and authoritative push-on-change.
 */
function getSyncedPeers(
  model: SyncModel,
  docId: DocId,
  excludePeerId?: PeerId,
): PeerId[] {
  const ids: PeerId[] = []
  for (const [peerId, peerState] of model.peers) {
    if (excludePeerId && peerId === excludePeerId) continue
    const docSync = peerState.docSyncStates.get(docId)
    if (
      docSync &&
      (docSync.status === "synced" || docSync.status === "pending")
    ) {
      ids.push(peerId)
    }
  }
  return ids
}

/**
 * The last version we applied *from* this peer for this document.
 *
 * Quoted back in an interest so the peer can answer "what have you missed?"
 * precisely. Absent before the first exchange, which simply means the peer
 * falls back to sending everything — the correct answer when we have nothing.
 */
function cursorFor(
  model: SyncModel,
  peerId: PeerId,
  docId: DocId,
): string | undefined {
  return model.peers.get(peerId)?.docSyncStates.get(docId)?.theirVersionWeHold
}

/**
 * Which of our versions a peer holds, from an interest it sent: the cursor it
 * quoted back when there is one, which names a version we minted, else its
 * own stated version. Its own version is stated in its terms, which for a
 * private counter we cannot interpret at all. Both what we record of the
 * peer and what we send it in answer start from this.
 */
function versionTheyHold(message: InterestMsg): string | undefined {
  return message.since ?? message.version
}

/**
 * Push a document's change to every peer we push to, each from what it will
 * hold, and move each one's baseline to `version`, the version after the
 * change. Used for local changes and to relay an import to the peers that did
 * not send it (`excludePeerId`).
 *
 * The baseline is per peer because peers hold different things: after an
 * import, its sender holds what it offered and every other peer does not.
 * It moves when we send, not when the peer acknowledges: a baseline that
 * waited for the acknowledgement would lag every offer in flight, and each
 * push would resend them (an earlier per-peer attempt corrupted plain replay
 * this way, jj:5e9e3185). A peer whose baseline we do not know, one that has
 * just come back, is not pushed to; the answer to its interest catches it up.
 * A peer that no longer holds its baseline, one that restarted without its
 * state, takes the push short of the offered version and asks for the rest.
 */
function buildPush(
  docId: DocId,
  model: SyncModel,
  canShare: SyncPredicate,
  version: string,
  excludePeerId?: PeerId,
): [SyncModel, ...SyncEffect[]] {
  // Interest-based routing for all protocols — only peers who have
  // expressed interest (via announce → interest → offer) receive pushes.
  const raw = getSyncedPeers(model, docId, excludePeerId)
  const peerIds = filterPeersByShare(model, raw, docId, canShare)
  const to: { peerId: PeerId; sinceVersion: string }[] = []
  let pushed = model
  for (const peerId of peerIds) {
    const since = model.peers
      .get(peerId)
      ?.docSyncStates.get(docId)?.ourVersionTheyWillHold
    if (since === undefined) continue
    to.push({ peerId, sinceVersion: since })
    pushed = setPeerDocState(pushed, peerId, docId, {
      ourVersionTheyWillHold: version,
    })
  }
  if (to.length === 0) return [model]
  return [pushed, { type: "send-offers", docId, to }]
}

/**
 * Compute routed peer IDs and build a present effect for a document.
 * Extracted so handleDocEnsure and handleDocDefer can share the logic.
 */
function announceDoc(
  docId: DocId,
  replicaType: ReplicaType,
  syncMode: SyncMode,
  schemaHash: string,
  model: SyncModel,
  canShare: SyncPredicate,
  supportedHashes?: readonly string[],
): { peerIds: PeerId[]; present: SyncEffect | undefined } {
  const allPeers = getAvailablePeers(model)
  const peerIds = filterPeersByShare(model, allPeers, docId, canShare)
  if (peerIds.length === 0) return { peerIds, present: undefined }
  const docs: PresentMsg["docs"] = [
    {
      docId,
      replicaType,
      syncMode,
      schemaHash,
      // Only include supportedHashes if it carries more info than the primary hash alone
      ...(supportedHashes && supportedHashes.length > 1
        ? { supportedHashes }
        : undefined),
    },
  ]
  const present: SyncEffect = {
    type: "send-to-peers",
    to: peerIds,
    message: { type: "present", docs },
  }
  return { peerIds, present }
}

/**
 * Build a present effect for a set of doc IDs to a single peer.
 * Used by handlePeerAvailable to announce all docs to a newly
 * available peer.
 */
function buildPresent(
  docIds: DocId[],
  peerId: PeerId,
  model: SyncModel,
): SyncEffect | undefined {
  if (docIds.length === 0) return undefined
  const docs: PresentMsg["docs"] = docIds
    .map(docId => {
      const entry = model.documents.get(docId)
      if (!entry) return null
      return {
        docId,
        replicaType: entry.replicaType,
        syncMode: entry.syncMode,
        schemaHash: entry.schemaHash,
        // Only include supportedHashes if it carries more info than the primary hash alone
        ...(entry.supportedHashes && entry.supportedHashes.length > 1
          ? { supportedHashes: entry.supportedHashes }
          : undefined),
      }
    })
    .filter((d): d is NonNullable<typeof d> => d !== null)
  if (docs.length === 0) return undefined
  return {
    type: "send-to-peer",
    to: peerId,
    message: { type: "present", docs },
  }
}

/**
 * Build the commands to respond to an interest message for a known doc.
 * Pure logic, shared by handleInterestForKnownDoc.
 */
function buildInterestResponse(
  fromPeerId: PeerId,
  message: InterestMsg,
  docEntry: DocEntry,
  model: SyncModel,
): SyncEffect[] {
  const effects: SyncEffect[] = []

  effects.push({
    type: "send-offers",
    docId: message.docId,
    to: [{ peerId: fromPeerId, sinceVersion: versionTheyHold(message) }],
  })

  // Concurrent writers need to hear each other, so ask for the peer's state
  // in turn. `reciprocate: false` on the way back stops the loop.
  if (requiresBidirectionalSync(docEntry.syncMode) && message.reciprocate) {
    effects.push(interestTo(model, fromPeerId, message.docId, docEntry, false))
  }

  return effects
}

/**
 * The interest this peer sends `peerId` for a document: our version, and the
 * cursor of theirs we hold, so they can answer with exactly what we lack.
 */
function interestTo(
  model: SyncModel,
  peerId: PeerId,
  docId: DocId,
  docEntry: DocEntry,
  reciprocate: boolean,
): SyncEffect {
  return {
    type: "send-to-peer",
    to: peerId,
    message: {
      type: "interest",
      docId,
      version: docEntry.version,
      reciprocate,
      since: cursorFor(model, peerId, docId),
    },
  }
}

// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
// INIT
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

/**
 * Initialize the sync program with a peer identity.
 *
 * @returns Initial model state with no documents or peers.
 */
export function initSync(identity: PeerIdentityDetails): SyncModel {
  return {
    identity,
    documents: new Map(),
    peers: new Map(),
    pendingDocEvents: [],
    pendingPeerSyncDocIds: [],
    pendingStateAdvancedDocIds: [],
    reconciledIdentities: new Map(),
  }
}

// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
// FACTORY
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

type SyncPredicate = (docId: DocId, peer: PeerIdentityDetails) => boolean

type CreateSyncUpdateParams = {
  canShare: SyncPredicate
  canAccept: SyncPredicate
}

const defaultParams: CreateSyncUpdateParams = {
  canShare: () => true,
  canAccept: () => true,
}

/**
 * Creates the sync update function.
 *
 * The returned function is the pure TEA update: (input, model) → [model, ...effects].
 * The `canShare` and `canAccept` predicates control information flow:
 * - `canShare`: gates all outbound messages (present, push, relay)
 * - `canAccept`: gates inbound data import (offers)
 */
export function createSyncUpdate(
  params: Partial<CreateSyncUpdateParams> = {},
): SyncUpdate {
  const { canShare, canAccept } = { ...defaultParams, ...params }

  return function update(
    input: SyncInput,
    model: SyncModel,
  ): [SyncModel, ...SyncEffect[]] {
    switch (input.type) {
      case "sync/peer-available":
        return handlePeerAvailable(
          input.peerId,
          input.identity,
          model,
          canShare,
        )
      case "sync/peer-unavailable":
        return handlePeerUnavailable(input.peerId, model)
      case "sync/peer-departed":
        return handlePeerDeparted(input.peerId, model)
      case "sync/message-received":
        return handleMessageReceived(
          input.from,
          input.message,
          model,
          canShare,
          canAccept,
        )
      case "sync/doc-ensure":
        return handleDocEnsure(input, model, canShare)
      case "sync/doc-defer":
        return handleDocDefer(input, model, canShare)
      case "sync/local-doc-change":
        return handleLocalDocChange(input, model, canShare)
      case "sync/doc-delete":
        return handleDocDelete(input, model)
      case "sync/doc-dismiss":
        return handleDocDismiss(input, model, canShare)
      case "sync/doc-imported":
        return handleDocImported(input, model, canShare)
      case "sync/peer-synced":
        return handlePeerSynced(input, model)
      case "sync/declare-vacant":
        return handleDeclareVacant(input, model)
      case "sync/queue-doc-event":
        return [
          {
            ...model,
            pendingDocEvents: [...model.pendingDocEvents, input.event],
          },
        ]
      case "sync/tick-quiescent":
        return handleTickQuiescent(model)
      case "sync/synthetic-doc-removed-all":
        return handleSyntheticDocRemovedAll(input, model)
    }
  }
}

// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
// HANDLER: Message demux
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

function handleMessageReceived(
  from: PeerId,
  message: SyncMsg,
  model: SyncModel,
  canShare: SyncPredicate,
  canAccept: SyncPredicate,
): [SyncModel, ...SyncEffect[]] {
  switch (message.type) {
    case "present":
      return handlePresent(from, message, model, canShare)
    case "interest":
      return handleInterest(from, message, model, canShare)
    case "offer":
      return handleOffer(from, message, model, canShare, canAccept)
    case "accept":
      return handleAccept(from, message, model)
    case "dismiss":
      return handleDismiss(from, message, model)
    case "vacant":
      return handleVacant(from, message, model)
  }
}

// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
// HANDLER: Peer lifecycle
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

/**
 * A peer has become available (establish handshake completed in the
 * session program). Add the peer to the model and announce all routed
 * documents to it.
 */
function handlePeerAvailable(
  peerId: PeerId,
  identity: PeerIdentityDetails,
  model: SyncModel,
  canShare: SyncPredicate,
): [SyncModel, ...SyncEffect[]] {
  const peers = new Map(model.peers)
  const existingPeer = peers.get(peerId)

  // Preserve existing docSyncStates for reconnecting peers, except what we
  // knew of their holding: a peer that comes back may have lost its state,
  // and its interest will say what it holds now.
  peers.set(peerId, {
    identity,
    docSyncStates: forgetWhatTheyHold(existingPeer?.docSyncStates),
  })

  const updatedModel: SyncModel = { ...model, peers }

  // Filter docs by canShare — only announce docs this peer is allowed to see
  const docIds = Array.from(model.documents.keys()).filter(id =>
    canShare(id, identity),
  )

  const present = buildPresent(docIds, peerId, updatedModel)

  return present ? [updatedModel, present] : [updatedModel]
}

/**
 * The same sync states, with no record of which of our versions the peer
 * holds or will hold: a peer that comes back may have lost its state.
 */
function forgetWhatTheyHold(
  states: ReadonlyMap<DocId, PeerDocSyncState> | undefined,
): Map<DocId, PeerDocSyncState> {
  const forgotten = new Map<DocId, PeerDocSyncState>()
  for (const [
    docId,
    { ourVersionTheyHold: _held, ourVersionTheyWillHold: _willHold, ...rest },
  ] of states ?? []) {
    forgotten.set(docId, rest)
  }
  return forgotten
}

/**
 * A peer has become unavailable (last channel removed, no depart).
 * Preserve docSyncStates for reconnection. Mark ready-state dirty for
 * all docs this peer had sync state for.
 */
function handlePeerUnavailable(
  peerId: PeerId,
  model: SyncModel,
): [SyncModel, ...SyncEffect[]] {
  const peerState = model.peers.get(peerId)
  if (!peerState) return [model]

  // Do NOT delete peer from model — preserve docSyncStates for reconnection
  if (peerState.docSyncStates.size > 0) {
    return [
      {
        ...model,
        pendingPeerSyncDocIds: appendUniqueDocIds(
          model.pendingPeerSyncDocIds,
          peerState.docSyncStates.keys(),
        ),
      },
    ]
  }
  return [model]
}

/**
 * A peer is gone (depart received, or departure timer expired).
 * Delete peer from model entirely. Mark ready-state dirty for all
 * docs this peer had sync state for.
 */
function handlePeerDeparted(
  peerId: PeerId,
  model: SyncModel,
): [SyncModel, ...SyncEffect[]] {
  const peerState = model.peers.get(peerId)
  if (!peerState) return [model]

  const peers = new Map(model.peers)
  peers.delete(peerId)

  if (peerState.docSyncStates.size > 0) {
    return [
      {
        ...model,
        peers,
        pendingPeerSyncDocIds: appendUniqueDocIds(
          model.pendingPeerSyncDocIds,
          peerState.docSyncStates.keys(),
        ),
      },
    ]
  }
  return [{ ...model, peers }]
}

// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
// HANDLER: Document lifecycle
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

function handleDocEnsure(
  msg: Extract<SyncInput, { type: "sync/doc-ensure" }>,
  model: SyncModel,
  canShare: SyncPredicate,
): [SyncModel, ...SyncEffect[]] {
  const existing = model.documents.get(msg.docId)
  // Idempotent for an unchanged document: ensuring the same one twice at the
  // same mode must not re-announce it. Any genuine mode change — `deferred →
  // X`, or `replicate → interpret` — falls through to the path below, which
  // rewrites the entry and sends `present` + `interest`.
  //
  // Re-announcing after a promotion is correct rather than noise. The
  // document's triple does not change, since compatibility was the
  // precondition, but an interpreted document advertises `supportedHashes`
  // and a replicate one has none. Peers that could not previously match this
  // document against a migrated schema of their own can once they hear the
  // fuller range.
  if (existing && existing.mode === msg.mode) return [model]

  const entry: DocEntry = {
    docId: msg.docId,
    mode: msg.mode,
    version: msg.version,
    replicaType: msg.replicaType,
    historyFree: msg.historyFree,
    syncMode: msg.syncMode,
    schemaHash: msg.schemaHash,
  }
  if (msg.supportedHashes) entry.supportedHashes = msg.supportedHashes

  const documents = new Map(model.documents)
  documents.set(msg.docId, entry)

  // Announce new doc and request sync from all available peers.
  // We send both present (so peers learn we have the doc) and interest
  // (so peers send us their state). This is essential for docs created
  // via onDocDiscovered — the local doc is empty and needs to pull data.
  const updatedModel: SyncModel = {
    ...model,
    documents,
    pendingDocEvents: msg.event
      ? [...model.pendingDocEvents, msg.event]
      : model.pendingDocEvents,
  }
  const { peerIds, present } = announceDoc(
    msg.docId,
    msg.replicaType,
    msg.syncMode,
    msg.schemaHash,
    updatedModel,
    canShare,
    msg.supportedHashes,
  )
  if (peerIds.length === 0) {
    return [updatedModel]
  }

  const reciprocate = requiresBidirectionalSync(msg.syncMode)
  const interests = peerIds.map(peerId =>
    interestTo(updatedModel, peerId, msg.docId, entry, reciprocate),
  )

  if (present) return [updatedModel, present, ...interests]
  return [updatedModel, ...interests]
}

function handleDocDefer(
  msg: Extract<SyncInput, { type: "sync/doc-defer" }>,
  model: SyncModel,
  canShare: SyncPredicate,
): [SyncModel, ...SyncEffect[]] {
  if (model.documents.has(msg.docId)) return [model]

  const entry: DocEntry = {
    docId: msg.docId,
    mode: "deferred",
    version: "",
    replicaType: msg.replicaType,
    syncMode: msg.syncMode,
    schemaHash: msg.schemaHash,
  }
  if (msg.supportedHashes) entry.supportedHashes = msg.supportedHashes

  const documents = new Map(model.documents)
  documents.set(msg.docId, entry)

  const updatedModel: SyncModel = {
    ...model,
    documents,
    pendingDocEvents: msg.event
      ? [...model.pendingDocEvents, msg.event]
      : model.pendingDocEvents,
  }
  const { present } = announceDoc(
    msg.docId,
    msg.replicaType,
    msg.syncMode,
    msg.schemaHash,
    updatedModel,
    canShare,
    msg.supportedHashes,
  )

  return present ? [updatedModel, present] : [updatedModel]
}

function handleLocalDocChange(
  msg: Extract<SyncInput, { type: "sync/local-doc-change" }>,
  model: SyncModel,
  canShare: SyncPredicate,
): [SyncModel, ...SyncEffect[]] {
  const docEntry = model.documents.get(msg.docId)
  if (!docEntry) return [model]

  const documents = new Map(model.documents)
  documents.set(msg.docId, { ...docEntry, version: msg.version })
  // No state-advanced: the Runtime requested persistence for this change
  // before it told us about it. State-advanced reports what the network
  // moved.
  return buildPush(msg.docId, { ...model, documents }, canShare, msg.version)
}

function handleDocDelete(
  msg: Extract<SyncInput, { type: "sync/doc-delete" }>,
  model: SyncModel,
): [SyncModel, ...SyncEffect[]] {
  const documents = new Map(model.documents)
  documents.delete(msg.docId)
  return [
    {
      ...model,
      documents,
      // Our doc is gone — clear its readiness latch so a destroyed-then-
      // recreated doc doesn't report a stale `ready`.
      reconciledIdentities: clearReconciled(
        model.reconciledIdentities,
        msg.docId,
      ),
      pendingDocEvents: msg.event
        ? [...model.pendingDocEvents, msg.event]
        : model.pendingDocEvents,
    },
  ]
}

function handleDocDismiss(
  msg: Extract<SyncInput, { type: "sync/doc-dismiss" }>,
  model: SyncModel,
  canShare: SyncPredicate,
): [SyncModel, ...SyncEffect[]] {
  const documents = new Map(model.documents)
  documents.delete(msg.docId)

  // Broadcast dismiss to all available peers (filtered by canShare)
  const allPeers = getAvailablePeers(model)
  const peerIds = filterPeersByShare(model, allPeers, msg.docId, canShare)

  // `suspendDocument` and `dismissDocument` BOTH dispatch this input,
  // differing only in `event` (`doc-suspended` vs `doc-removed`). Clear the
  // readiness latch only on a true removal: suspend keeps the runtime/data
  // alive (the latch must survive resume), whereas dismiss deletes it.
  const reconciledIdentities =
    msg.event?.type === "doc-suspended"
      ? model.reconciledIdentities
      : clearReconciled(model.reconciledIdentities, msg.docId)

  const nextModel: SyncModel = {
    ...model,
    documents,
    reconciledIdentities,
    pendingDocEvents: msg.event
      ? [...model.pendingDocEvents, msg.event]
      : model.pendingDocEvents,
  }

  if (peerIds.length === 0) return [nextModel]

  return [
    nextModel,
    {
      type: "send-to-peers",
      to: peerIds,
      message: { type: "dismiss", docId: msg.docId },
    },
  ]
}

function handleDocImported(
  msg: Extract<SyncInput, { type: "sync/doc-imported" }>,
  model: SyncModel,
  canShare: SyncPredicate,
): [SyncModel, ...SyncEffect[]] {
  const docEntry = model.documents.get(msg.docId)
  if (!docEntry) return [model]

  // Bump version + record state-advanced (regardless of peer presence). An
  // import that changed nothing advanced nothing, so subscribers hear nothing.
  const bumpedEntry: DocEntry = { ...docEntry, version: msg.version }
  const documents = new Map(model.documents)
  documents.set(msg.docId, bumpedEntry)
  const bumped: SyncModel = {
    ...model,
    documents,
    pendingStateAdvancedDocIds: msg.changed
      ? appendUniqueDocId(model.pendingStateAdvancedDocIds, msg.docId)
      : model.pendingStateAdvancedDocIds,
  }

  // Relay to the other peers, each from what it will hold, but only for an
  // import that moved us. Re-broadcasting state a peer already held is what
  // turns a three-peer mesh into a cycle: every peer relays to everyone but
  // the sender, so there is always somewhere left to forward to.
  const [relayed, ...relay] = msg.changed
    ? buildPush(msg.docId, bumped, canShare, msg.version, msg.fromPeerId)
    : [bumped]

  // The sender told us its version, which it holds: its baseline joins it.
  const willHold =
    msg.senderWillHold === undefined
      ? {}
      : { ourVersionTheyWillHold: msg.senderWillHold }

  // Held: nothing left to receive from this peer, and what we now hold of
  // theirs is the version they offered, in their terms.
  if (msg.held) {
    return [
      setPeerDocState(relayed, msg.fromPeerId, msg.docId, {
        status: "synced",
        theirVersionWeHold: msg.offered,
        ...willHold,
      }),
      ...relay,
    ]
  }

  // Not held: we still lack something the sender holds. Ask it for the rest,
  // quoting our version and the cursor of theirs we do hold; its answer is the
  // catch-up.
  const pending = setPeerDocState(relayed, msg.fromPeerId, msg.docId, {
    status: "pending",
    ...willHold,
  })
  return [
    pending,
    ...relay,
    interestTo(pending, msg.fromPeerId, msg.docId, bumpedEntry, false),
  ]
}

function handlePeerSynced(
  msg: Extract<SyncInput, { type: "sync/peer-synced" }>,
  model: SyncModel,
): [SyncModel, ...SyncEffect[]] {
  const docEntry = model.documents.get(msg.docId)
  if (!docEntry) return [model]

  return [
    setPeerDocState(model, msg.peerId, msg.docId, {
      status: "synced",
      // No gap: we already hold the version the peer stated.
      theirVersionWeHold: msg.version,
    }),
  ]
}

// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
// HANDLER: Tick / synthetic
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

function handleTickQuiescent(model: SyncModel): [SyncModel, ...SyncEffect[]] {
  const effects: SyncEffect[] = []

  // Order: ready-state → state-advanced → doc-events.
  // (peer-events emit lives in the session program's tick.)
  if (model.pendingPeerSyncDocIds.length > 0) {
    effects.push({
      type: "emit-ready-state-changes",
      docIds: model.pendingPeerSyncDocIds,
    })
  }
  if (model.pendingStateAdvancedDocIds.length > 0) {
    effects.push({
      type: "emit-state-advanced",
      docIds: model.pendingStateAdvancedDocIds,
    })
  }
  if (model.pendingDocEvents.length > 0) {
    effects.push({
      type: "emit-doc-events",
      events: model.pendingDocEvents,
    })
  }

  if (effects.length === 0) return [model]

  return [
    {
      ...model,
      pendingPeerSyncDocIds: [],
      pendingStateAdvancedDocIds: [],
      pendingDocEvents: [],
    },
    ...effects,
  ]
}

function handleSyntheticDocRemovedAll(
  msg: Extract<SyncInput, { type: "sync/synthetic-doc-removed-all" }>,
  model: SyncModel,
): [SyncModel, ...SyncEffect[]] {
  if (msg.docIds.length === 0) return [model]
  const synthetic: DocChange[] = msg.docIds.map(docId => ({
    type: "doc-removed",
    docId,
  }))
  // Clear the documents map; the synthetic events describe the full
  // set of removals about to be visible.
  return [
    {
      ...model,
      documents: new Map(),
      pendingDocEvents: [...model.pendingDocEvents, ...synthetic],
    },
  ]
}

// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
// HANDLER: Present — assertion handling with mismatch detection
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

function handlePresent(
  from: PeerId,
  message: PresentMsg,
  model: SyncModel,
  canShare: SyncPredicate,
): [SyncModel, ...SyncEffect[]] {
  const peerState = model.peers.get(from)
  if (!peerState) return [model]

  const effects: SyncEffect[] = []

  for (const {
    docId,
    replicaType,
    syncMode,
    schemaHash,
    supportedHashes: remoteSupportedHashes,
  } of message.docs) {
    const docEntry = model.documents.get(docId)
    if (docEntry) {
      // Known doc — but first, may this peer have it from us at all? Replying
      // `interest` would tell a peer we refuse to share with both that we hold
      // the document and what version we are at. The unknown-doc branch below
      // already makes this check before `ensure-doc`; the two now agree.
      if (!canShare(docId, peerState.identity)) continue

      // Can the two of us sync it at all?
      //
      // Both operands are read capabilities: sync compares two *peers*, each
      // with its own range of shapes, rather than a peer against a document.
      // The remote one has to be assembled because `present` is sparse — a
      // sender omits `supportedHashes` whenever it would say nothing beyond
      // the primary hash. Resolving that here, where the wire meets the
      // domain, is what keeps the law itself free of optional fields; it is
      // the same treatment `establish`'s protocolVersion already gets.
      const local: ReadCapability = {
        replicaType: docEntry.replicaType,
        syncMode: docEntry.syncMode,
        schemaHash: docEntry.schemaHash,
        supportedHashes: docEntry.supportedHashes ?? [docEntry.schemaHash],
      }
      const remote: ReadCapability = {
        replicaType,
        syncMode,
        schemaHash,
        supportedHashes: remoteSupportedHashes ?? [schemaHash],
      }
      const mismatch = mismatchForSync(local, remote)
      if (mismatch) {
        effects.push({
          type: "diagnostic",
          code: MISMATCH_CODE[mismatch.axis],
          severity: "error",
          peer: from,
          docId,
          local: mismatch.local,
          remote: mismatch.remote,
          message: describeMismatch(docId, mismatch),
        })
        continue
      }
      // Deferred docs participate in routing but don't request data
      if (docEntry.mode === "deferred") continue

      // Compatible — send interest with our version. Concurrent writers
      // need to hear each other, so ask for the reciprocal interest.
      effects.push(
        interestTo(
          model,
          from,
          docId,
          docEntry,
          requiresBidirectionalSync(docEntry.syncMode),
        ),
      )
    } else {
      // Unknown doc — check canShare before requesting creation
      if (!canShare(docId, peerState.identity)) continue
      effects.push({
        type: "ensure-doc",
        docId,
        peer: peerState.identity,
        replicaType,
        syncMode,
        schemaHash,
        supportedHashes: remoteSupportedHashes,
      })
    }
  }

  return [model, ...effects]
}

// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
// HANDLER: Interest — sync-mode dispatch
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

function handleInterest(
  from: PeerId,
  message: InterestMsg,
  model: SyncModel,
  canShare: SyncPredicate,
): [SyncModel, ...SyncEffect[]] {
  const peerState = model.peers.get(from)
  if (!peerState) return [model]

  // A document can leave this peer by four paths, and all four consult
  // `canShare`: announcing it (`handlePeerAvailable`, `announceDoc`), pushing
  // a local change (`handleLocalDocChange`), relaying an imported one
  // (`handleDocImported`) — and this one, answering a peer that asked for it
  // by name. If you add a fifth, gate it here too; the invariant test in
  // `sync-program.test.ts` ("no outbound effect reaches a vetoed peer") is
  // what will fail if you forget.
  //
  // This path shipped ungated through 3.0.0, which meant `canShare` decided
  // only whether a peer was *told* about a document, not whether it could
  // *have* one: any peer that knew or guessed a document id could pull its
  // full state simply by asking.
  //
  // The check sits above the document lookup on purpose — "who is asking?"
  // before "what are they asking for?" — so that a denied peer gets the same
  // reply whether or not we hold the document. See `vacantReply` for why that
  // matters.
  if (!canShare(message.docId, peerState.identity)) {
    return [model, vacantReply(from, message.docId)]
  }

  const docEntry = model.documents.get(message.docId)
  if (!docEntry) return [model]
  if (docEntry.mode === "deferred") return [model]

  // Known doc — respond based on sync protocol and update peer sync state
  return handleInterestForKnownDoc(from, message, docEntry, model)
}

/**
 * Handle a normal interest for a doc that exists. Responds based on
 * sync protocol, marks the peer `pending`, and asks the shell whether the
 * peer's version leaves us anything to receive.
 */
function handleInterestForKnownDoc(
  fromPeerId: PeerId,
  message: InterestMsg,
  docEntry: DocEntry,
  model: SyncModel,
): [SyncModel, ...SyncEffect[]] {
  const peerState = model.peers.get(fromPeerId)
  if (!peerState) return [model]

  const effects = buildInterestResponse(fromPeerId, message, docEntry, model)

  // An interest tells us the sender *wants our state*, and which of ours it
  // holds. It says nothing about whether we want theirs — that depends on
  // their version, which only the shell can read. So the peer is `pending`
  // here, and `synced` follows from the classification below or from the
  // offer they send us.
  //
  // `synced` means "nothing left to receive from this peer". It used to be
  // inferred from `reciprocate: false`, a flag that exists to stop two peers
  // exchanging interests forever and carries no other meaning. On a document
  // whose sync mode is not bidirectional, every interest is
  // `reciprocate: false` in both directions — so a client marked its
  // authority `synced` on receiving the authority's *request*, the
  // reconciliation latch recorded it, and `whenSettled` resolved before the
  // authority's state had arrived.
  return [
    setPeerDocState(model, fromPeerId, message.docId, {
      status: "pending",
      ourVersionTheyHold: versionTheyHold(message),
      // The answer above brings the peer to our version.
      ourVersionTheyWillHold: docEntry.version,
    }),
    ...effects,
    {
      type: "classify-peer-version",
      docId: message.docId,
      peerId: fromPeerId,
      version: message.version,
      digest: message.digest,
    },
  ]
}

// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
// HANDLER: Offer — version compare at receiver, import if accepted
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

function handleOffer(
  from: PeerId,
  message: OfferMsg,
  model: SyncModel,
  canShare: SyncPredicate,
  canAccept: SyncPredicate,
): [SyncModel, ...SyncEffect[]] {
  const peerState = model.peers.get(from)
  if (!peerState) return [model]

  const docEntry = model.documents.get(message.docId)
  if (!docEntry) return [model]
  if (docEntry.mode === "deferred") return [model]

  // Check canAccept — reject silently if the peer isn't allowed. A refused
  // offer is not imported, so it is not accepted either: the sender's record
  // of what we hold stays where it was.
  if (!canAccept(message.docId, peerState.identity)) return [model]

  // Import the payload — the shell calls replica.merge(payload) and reports
  // back with `sync/doc-imported` or `sync/peer-synced`.
  return [
    model,
    {
      type: "import-doc-data",
      docId: message.docId,
      payload: message.payload,
      version: message.version,
      fromPeerId: from,
      digest: message.digest,
      accept:
        docEntry.historyFree === false &&
        canShare(message.docId, peerState.identity),
      ourVersionTheyWillHold: peerState.docSyncStates.get(message.docId)
        ?.ourVersionTheyWillHold,
    },
  ]
}

// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
// HANDLER: Accept
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

/**
 * A peer applied one of our offers. Record the version it now holds, which
 * compaction never trims past. Nothing else changes: no reply, and no status
 * change, since the status says what we still have to receive from it.
 */
function handleAccept(
  from: PeerId,
  message: AcceptMsg,
  model: SyncModel,
): [SyncModel, ...SyncEffect[]] {
  return [
    setPeerDocState(model, from, message.docId, {
      ourVersionTheyHold: message.version,
    }),
  ]
}

// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
// HANDLER: Dismiss
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

function handleDismiss(
  from: PeerId,
  message: DismissMsg,
  model: SyncModel,
): [SyncModel, ...SyncEffect[]] {
  const peerState = model.peers.get(from)
  if (!peerState) return [model]

  // Clean up peer sync state for this doc
  const peers = new Map(model.peers)
  const docSyncStates = new Map(peerState.docSyncStates)
  docSyncStates.delete(message.docId)
  peers.set(from, { ...peerState, docSyncStates })

  return [
    {
      ...model,
      peers,
      pendingPeerSyncDocIds: appendUniqueDocId(
        model.pendingPeerSyncDocIds,
        message.docId,
      ),
    },
    {
      type: "ensure-doc-dismissed",
      docId: message.docId,
      peer: peerState.identity,
    },
  ]
}

// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
// HANDLER: Vacant — terminal negative ack ("I won't serve this doc")
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

/**
 * A peer told us it does not have — and will not serve — a doc we asked
 * for. Record the peer's per-doc state as terminal (`vacant`) so
 * readiness can settle.
 *
 * Critically, this emits **no** `ensure-doc-dismissed`: the *peer* lacks
 * the doc, but our own replica must survive (unlike `dismiss`, where the
 * peer is leaving a doc it had). Early-returns if we don't track the doc.
 */
function handleVacant(
  from: PeerId,
  message: VacantMsg,
  model: SyncModel,
): [SyncModel, ...SyncEffect[]] {
  if (!model.peers.has(from)) return [model]
  // Early-return if we don't track the doc — there is nothing to reconcile.
  if (!model.documents.has(message.docId)) return [model]

  // Fold the terminal state through the single fold point. Emits NO
  // `ensure-doc-dismissed`: the *peer* lacks the doc, but our replica
  // must survive (the opposite of `dismiss`).
  return [
    setPeerDocState(model, from, message.docId, {
      status: "vacant",
    }),
  ]
}

// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
// HANDLER: Declare-vacant — producer trigger (we won't serve a doc)
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

/**
 * Send a `vacant` to a peer that asked us for a doc we will not serve.
 * Pure: emits a single `send-to-peer` effect (no new effect type). Guarded
 * on the peer still being tracked — `send-to-peer` is itself a no-op in the
 * shell if the peer has no channel.
 */
function handleDeclareVacant(
  msg: Extract<SyncInput, { type: "sync/declare-vacant" }>,
  model: SyncModel,
): [SyncModel, ...SyncEffect[]] {
  if (!model.peers.has(msg.to)) return [model]
  return [model, vacantReply(msg.to, msg.docId)]
}

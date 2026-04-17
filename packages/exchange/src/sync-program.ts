// sync-program — TEA state machine for document convergence.
//
// The sync program handles the document-exchange vocabulary: present,
// interest, offer, dismiss. It tracks per-peer document sync states
// and manages merge strategy dispatch.
//
// Key invariant: the sync program never sees channels, transports, or
// connection state. It speaks only in terms of peers and documents.
// The shell resolves PeerId → ChannelId when interpreting effects.

import type {
  MergeStrategy,
  ReplicaType,
  SubstratePayload,
} from "@kyneta/schema"
import { replicaTypesCompatible } from "@kyneta/schema"
import type {
  DocId,
  PeerId,
  PeerIdentityDetails,
  SyncMsg,
} from "@kyneta/transport"
import type { AuthorizePredicate, RoutePredicate } from "./exchange.js"
import { collapse, type Transition } from "./program-types.js"
import type { PeerDocSyncState } from "./types.js"

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

  /** The merge strategy for this document's substrate */
  mergeStrategy: MergeStrategy

  /** A deterministic hash representing the document's schema */
  schemaHash: string
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
      mergeStrategy: MergeStrategy
      schemaHash: string
    }
  | {
      type: "sync/doc-defer"
      docId: DocId
      replicaType: ReplicaType
      mergeStrategy: MergeStrategy
      schemaHash: string
    }
  | { type: "sync/local-doc-change"; docId: DocId; version: string }
  | { type: "sync/doc-delete"; docId: DocId }
  | { type: "sync/doc-dismiss"; docId: DocId }
  | {
      type: "sync/doc-imported"
      docId: DocId
      version: string
      fromPeerId: PeerId
    }

// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
// EFFECTS (what needs to happen in the world)
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

/**
 * Effects are side effects produced by the update function.
 * The shell executes them, resolving PeerId → ChannelId as needed.
 */
export type SyncEffect =
  | { type: "send-to-peer"; to: PeerId; message: SyncMsg }
  | { type: "send-to-peers"; to: PeerId[]; message: SyncMsg }
  | {
      type: "send-offer"
      to: PeerId
      docId: DocId
      sinceVersion?: string
      reciprocate?: boolean
    }
  | {
      type: "send-offers"
      to: PeerId[]
      docId: DocId
      sinceVersion?: string
      reciprocate?: boolean
    }
  | {
      type: "import-doc-data"
      docId: DocId
      payload: SubstratePayload
      version: string
      fromPeerId: PeerId
    }
  | {
      type: "ensure-doc"
      docId: DocId
      peer: PeerIdentityDetails
      replicaType: ReplicaType
      mergeStrategy: MergeStrategy
      schemaHash: string
    }
  | {
      type: "ensure-doc-dismissed"
      docId: DocId
      peer: PeerIdentityDetails
    }
  | { type: "batch"; effects: SyncEffect[] }

// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
// NOTIFICATIONS (observations about what changed)
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

/**
 * Notifications are observations about model transitions. Unlike effects,
 * they do not change the world — they declare what changed so the shell
 * can inform external listeners without diffing the model.
 */
export type SyncNotification =
  | { type: "notify/ready-state-changed"; docIds: ReadonlySet<DocId> }
  | { type: "notify/state-advanced"; docIds: ReadonlySet<DocId> }
  | { type: "notify/warning"; message: string }
  | { type: "notify/batch"; notifications: SyncNotification[] }

// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
// UPDATE SIGNATURE
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

export type SyncTransition = Transition<SyncModel, SyncEffect, SyncNotification>

export type SyncUpdate = (input: SyncInput, model: SyncModel) => SyncTransition

// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
// UTILITIES — batching & notifications
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

const batchEffects = (...fx: (SyncEffect | undefined)[]) =>
  collapse<SyncEffect>(fx, effects => ({ type: "batch", effects }))

const batchNotifications = (...ns: (SyncNotification | undefined)[]) =>
  collapse<SyncNotification>(ns, notifications => ({
    type: "notify/batch",
    notifications,
  }))

/**
 * Convenience: construct a ready-state-changed notification for one or
 * more docIds.
 */
function readyStateChanged(...docIds: DocId[]): SyncNotification {
  return { type: "notify/ready-state-changed", docIds: new Set(docIds) }
}

/**
 * Convenience: construct a state-advanced notification for one or more
 * docIds. Emitted when a document's state advances — either from a
 * local mutation or a network import.
 */
function stateAdvanced(...docIds: DocId[]): SyncNotification {
  return { type: "notify/state-advanced", docIds: new Set(docIds) }
}

// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
// HELPERS — peer queries & routing
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

/**
 * Filter peer IDs by the route predicate. Peers whose identity cannot
 * be resolved are dropped.
 */
function filterPeersByRoute(
  model: SyncModel,
  peerIds: PeerId[],
  docId: DocId,
  route: RoutePredicate,
): PeerId[] {
  return peerIds.filter(id => {
    const peer = model.peers.get(id)
    if (!peer) return false
    return route(docId, peer.identity)
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
 * Build a push effect for document changes — used for both local changes
 * and relay (imported changes forwarded to other peers).
 *
 * When `excludePeerId` is provided, that peer is excluded from the push
 * (relay case: don't echo back to the sender).
 */
function buildPush(
  docId: DocId,
  docEntry: DocEntry,
  model: SyncModel,
  route: RoutePredicate,
  excludePeerId?: PeerId,
): SyncEffect | undefined {
  switch (docEntry.mergeStrategy) {
    case "collaborative":
    case "authoritative": {
      const raw = getSyncedPeers(model, docId, excludePeerId)
      const peerIds = filterPeersByRoute(model, raw, docId, route)
      if (peerIds.length === 0) return undefined
      return {
        type: "send-offers",
        to: peerIds,
        docId,
        sinceVersion: docEntry.version,
      }
    }

    case "ephemeral": {
      const raw = getAvailablePeers(model, excludePeerId)
      const peerIds = filterPeersByRoute(model, raw, docId, route)
      if (peerIds.length === 0) return undefined
      return { type: "send-offers", to: peerIds, docId }
    }
  }
}

/**
 * Compute routed peer IDs and build a present effect for a document.
 * Extracted so handleDocEnsure and handleDocDefer can share the logic.
 */
function announceDoc(
  docId: DocId,
  replicaType: ReplicaType,
  mergeStrategy: MergeStrategy,
  schemaHash: string,
  model: SyncModel,
  route: RoutePredicate,
): { peerIds: PeerId[]; present: SyncEffect | undefined } {
  const allPeers = getAvailablePeers(model)
  const peerIds = filterPeersByRoute(model, allPeers, docId, route)
  if (peerIds.length === 0) return { peerIds, present: undefined }
  const present: SyncEffect = {
    type: "send-to-peers",
    to: peerIds,
    message: {
      type: "present",
      docs: [{ docId, replicaType, mergeStrategy, schemaHash }],
    },
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
  const docs = docIds
    .map(docId => {
      const entry = model.documents.get(docId)
      if (!entry) return null
      return {
        docId,
        replicaType: entry.replicaType,
        mergeStrategy: entry.mergeStrategy,
        schemaHash: entry.schemaHash,
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
  message: {
    type: "interest"
    docId: DocId
    version?: string
    reciprocate?: boolean
  },
  docEntry: DocEntry,
): SyncEffect[] {
  const effects: SyncEffect[] = []

  switch (docEntry.mergeStrategy) {
    case "collaborative":
      // Collaborative: always send our state (the CRDT handles merge).
      // Use exportSince if the peer provided a version, otherwise snapshot.
      effects.push({
        type: "send-offer",
        to: fromPeerId,
        docId: message.docId,
        sinceVersion: message.version,
        reciprocate: false,
      })

      // If the peer asked for reciprocation, send our own interest
      if (message.reciprocate) {
        effects.push({
          type: "send-to-peer",
          to: fromPeerId,
          message: {
            type: "interest",
            docId: message.docId,
            version: docEntry.version,
            reciprocate: false, // prevent infinite loop
          },
        })
      }
      break

    case "authoritative":
      // Authoritative: we always send an offer and let the runtime/receiver
      // decide based on version comparison.
      effects.push({
        type: "send-offer",
        to: fromPeerId,
        docId: message.docId,
        sinceVersion: message.version,
        reciprocate: false,
      })
      break

    case "ephemeral":
      // Ephemeral: always respond with snapshot (no delta computation)
      effects.push({
        type: "send-offer",
        to: fromPeerId,
        docId: message.docId,
        // No sinceVersion — always entirety for LWW
        reciprocate: false,
      })
      break
  }

  return effects
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
  }
}

// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
// FACTORY
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

type CreateSyncUpdateParams = {
  route: RoutePredicate
  authorize: AuthorizePredicate
}

const defaultParams: CreateSyncUpdateParams = {
  route: () => true,
  authorize: () => true,
}

/**
 * Creates the sync update function.
 *
 * The returned function is the pure TEA update: (input, model) → [model, effect?, notification?].
 * The `route` and `authorize` predicates control information flow:
 * - `route`: gates all outbound messages (present, push, relay)
 * - `authorize`: gates inbound data import (offers)
 */
export function createSyncUpdate(
  params: Partial<CreateSyncUpdateParams> = {},
): SyncUpdate {
  const { route, authorize } = { ...defaultParams, ...params }

  return function update(input: SyncInput, model: SyncModel): SyncTransition {
    switch (input.type) {
      case "sync/peer-available":
        return handlePeerAvailable(input.peerId, input.identity, model, route)
      case "sync/peer-unavailable":
        return handlePeerUnavailable(input.peerId, model)
      case "sync/peer-departed":
        return handlePeerDeparted(input.peerId, model)
      case "sync/message-received":
        return handleMessageReceived(
          input.from,
          input.message,
          model,
          route,
          authorize,
        )
      case "sync/doc-ensure":
        return handleDocEnsure(input, model, route)
      case "sync/doc-defer":
        return handleDocDefer(input, model, route)
      case "sync/local-doc-change":
        return handleLocalDocChange(input, model, route)
      case "sync/doc-delete":
        return handleDocDelete(input, model)
      case "sync/doc-dismiss":
        return handleDocDismiss(input, model, route)
      case "sync/doc-imported":
        return handleDocImported(input, model, route)
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
  route: RoutePredicate,
  authorize: AuthorizePredicate,
): SyncTransition {
  switch (message.type) {
    case "present":
      return handlePresent(from, message, model, route)
    case "interest":
      return handleInterest(from, message, model)
    case "offer":
      return handleOffer(from, message, model, authorize)
    case "dismiss":
      return handleDismiss(from, message, model)
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
  route: RoutePredicate,
): SyncTransition {
  const peers = new Map(model.peers)
  const existingPeer = peers.get(peerId)

  // Preserve existing docSyncStates for reconnecting peers
  peers.set(peerId, {
    identity,
    docSyncStates: existingPeer?.docSyncStates ?? new Map(),
  })

  const updatedModel: SyncModel = { ...model, peers }

  // Filter docs by route — only announce docs this peer is allowed to see
  const docIds = Array.from(model.documents.keys()).filter(id =>
    route(id, identity),
  )

  const present = buildPresent(docIds, peerId, updatedModel)

  return [updatedModel, present]
}

/**
 * A peer has become unavailable (last channel removed, no depart).
 * Preserve docSyncStates for reconnection. Emit readyStateChanged
 * for all docs this peer had sync state for.
 */
function handlePeerUnavailable(
  peerId: PeerId,
  model: SyncModel,
): SyncTransition {
  const peerState = model.peers.get(peerId)
  if (!peerState) return [model]

  // Do NOT delete peer from model — preserve docSyncStates for reconnection
  let notification: SyncNotification | undefined
  if (peerState.docSyncStates.size > 0) {
    notification = readyStateChanged(...peerState.docSyncStates.keys())
  }

  return [model, undefined, notification]
}

/**
 * A peer is gone (depart received, or departure timer expired).
 * Delete peer from model entirely. Emit readyStateChanged for all
 * docs this peer had sync state for.
 */
function handlePeerDeparted(peerId: PeerId, model: SyncModel): SyncTransition {
  const peerState = model.peers.get(peerId)
  if (!peerState) return [model]

  const peers = new Map(model.peers)
  peers.delete(peerId)

  let notification: SyncNotification | undefined
  if (peerState.docSyncStates.size > 0) {
    notification = readyStateChanged(...peerState.docSyncStates.keys())
  }

  return [{ ...model, peers }, undefined, notification]
}

// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
// HANDLER: Document lifecycle
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

function handleDocEnsure(
  msg: {
    type: "sync/doc-ensure"
    docId: DocId
    mode: "interpret" | "replicate"
    version: string
    replicaType: ReplicaType
    mergeStrategy: MergeStrategy
    schemaHash: string
  },
  model: SyncModel,
  route: RoutePredicate,
): SyncTransition {
  const existing = model.documents.get(msg.docId)
  if (existing) {
    if (existing.mode !== "deferred") return [model]
    // Promote deferred → the new mode
    // Fall through to the normal doc-ensure logic below,
    // which will overwrite the entry with the new mode/version
  }

  const documents = new Map(model.documents)
  documents.set(msg.docId, {
    docId: msg.docId,
    mode: msg.mode,
    version: msg.version,
    replicaType: msg.replicaType,
    mergeStrategy: msg.mergeStrategy,
    schemaHash: msg.schemaHash,
  })

  // Announce new doc and request sync from all available peers.
  // We send both present (so peers learn we have the doc) and interest
  // (so peers send us their state). This is essential for docs created
  // via onDocDiscovered — the local doc is empty and needs to pull data.
  const updatedModel: SyncModel = { ...model, documents }
  const { peerIds, present } = announceDoc(
    msg.docId,
    msg.replicaType,
    msg.mergeStrategy,
    msg.schemaHash,
    updatedModel,
    route,
  )
  if (peerIds.length === 0) {
    return [updatedModel]
  }

  const isCausal = msg.mergeStrategy === "collaborative"
  const interest: SyncEffect = {
    type: "send-to-peers",
    to: peerIds,
    message: {
      type: "interest",
      docId: msg.docId,
      version: msg.version,
      reciprocate: isCausal,
    },
  }

  return [updatedModel, batchEffects(present, interest)]
}

function handleDocDefer(
  msg: {
    type: "sync/doc-defer"
    docId: DocId
    replicaType: ReplicaType
    mergeStrategy: MergeStrategy
    schemaHash: string
  },
  model: SyncModel,
  route: RoutePredicate,
): SyncTransition {
  if (model.documents.has(msg.docId)) return [model]

  const documents = new Map(model.documents)
  documents.set(msg.docId, {
    docId: msg.docId,
    mode: "deferred",
    version: "",
    replicaType: msg.replicaType,
    mergeStrategy: msg.mergeStrategy,
    schemaHash: msg.schemaHash,
  })

  const updatedModel: SyncModel = { ...model, documents }
  const { present } = announceDoc(
    msg.docId,
    msg.replicaType,
    msg.mergeStrategy,
    msg.schemaHash,
    updatedModel,
    route,
  )

  return [updatedModel, present]
}

function handleLocalDocChange(
  msg: { type: "sync/local-doc-change"; docId: DocId; version: string },
  model: SyncModel,
  route: RoutePredicate,
): SyncTransition {
  const docEntry = model.documents.get(msg.docId)
  if (!docEntry) return [model]

  // Update version
  const documents = new Map(model.documents)
  documents.set(msg.docId, { ...docEntry, version: msg.version })

  // Push to synced peers based on merge strategy
  const effect = buildPush(msg.docId, docEntry, model, route)

  return [{ ...model, documents }, effect, stateAdvanced(msg.docId)]
}

function handleDocDelete(
  msg: { type: "sync/doc-delete"; docId: DocId },
  model: SyncModel,
): SyncTransition {
  const documents = new Map(model.documents)
  documents.delete(msg.docId)
  return [{ ...model, documents }]
}

function handleDocDismiss(
  msg: { type: "sync/doc-dismiss"; docId: DocId },
  model: SyncModel,
  route: RoutePredicate,
): SyncTransition {
  const documents = new Map(model.documents)
  documents.delete(msg.docId)

  // Broadcast dismiss to all available peers (filtered by route)
  const allPeers = getAvailablePeers(model)
  const peerIds = filterPeersByRoute(model, allPeers, msg.docId, route)

  const effect: SyncEffect | undefined =
    peerIds.length > 0
      ? {
          type: "send-to-peers",
          to: peerIds,
          message: { type: "dismiss", docId: msg.docId },
        }
      : undefined

  return [{ ...model, documents }, effect]
}

function handleDocImported(
  msg: {
    type: "sync/doc-imported"
    docId: DocId
    version: string
    fromPeerId: PeerId
  },
  model: SyncModel,
  route: RoutePredicate,
): SyncTransition {
  const docEntry = model.documents.get(msg.docId)
  if (!docEntry) return [model]

  // Relay to other peers (multi-hop propagation).
  // Must read docEntry.version BEFORE updating — this is the "since" version
  // for delta export, so peers receive exactly the imported ops.
  const effect = buildPush(msg.docId, docEntry, model, route, msg.fromPeerId)

  // Update version
  const documents = new Map(model.documents)
  documents.set(msg.docId, { ...docEntry, version: msg.version })

  // Update peer sync state
  const peers = new Map(model.peers)
  const peerState = peers.get(msg.fromPeerId)
  let notification: SyncNotification | undefined
  if (peerState) {
    const docSyncStates = new Map(peerState.docSyncStates)
    docSyncStates.set(msg.docId, {
      status: "synced",
      lastKnownVersion: msg.version,
      lastUpdated: new Date(),
    })
    peers.set(msg.fromPeerId, { ...peerState, docSyncStates })
    notification = batchNotifications(
      readyStateChanged(msg.docId),
      stateAdvanced(msg.docId),
    )
  } else {
    notification = stateAdvanced(msg.docId)
  }

  return [{ ...model, documents, peers }, effect, notification]
}

// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
// HANDLER: Present — assertion handling with mismatch detection
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

function handlePresent(
  from: PeerId,
  message: {
    type: "present"
    docs: Array<{
      docId: DocId
      replicaType: ReplicaType
      mergeStrategy: MergeStrategy
      schemaHash: string
    }>
  },
  model: SyncModel,
  route: RoutePredicate,
): SyncTransition {
  const peerState = model.peers.get(from)
  if (!peerState) return [model]

  const effects: SyncEffect[] = []
  const warnings: SyncNotification[] = []

  for (const {
    docId,
    replicaType,
    mergeStrategy,
    schemaHash,
  } of message.docs) {
    const docEntry = model.documents.get(docId)
    if (docEntry) {
      // Known doc — validate replicaType compatibility
      if (!replicaTypesCompatible(docEntry.replicaType, replicaType)) {
        warnings.push({
          type: "notify/warning",
          message:
            `[exchange] replica type mismatch for doc '${docId}': ` +
            `local [${docEntry.replicaType}] vs remote [${replicaType}] — skipping sync`,
        })
        continue
      }
      // Check schema hash compatibility
      if (docEntry.schemaHash !== schemaHash) {
        warnings.push({
          type: "notify/warning",
          message:
            `[exchange] schema hash mismatch for doc '${docId}': ` +
            `local '${docEntry.schemaHash}' vs remote '${schemaHash}' — skipping sync`,
        })
        continue
      }
      // Check mergeStrategy compatibility
      if (docEntry.mergeStrategy !== mergeStrategy) {
        warnings.push({
          type: "notify/warning",
          message:
            `[exchange] mergeStrategy mismatch for doc '${docId}': ` +
            `local '${docEntry.mergeStrategy}' vs remote '${mergeStrategy}' — skipping sync`,
        })
        continue
      }
      // Deferred docs participate in routing but don't request data
      if (docEntry.mode === "deferred") continue

      // Compatible — send interest with our version
      const isCausal = docEntry.mergeStrategy === "collaborative"
      effects.push({
        type: "send-to-peer",
        to: from,
        message: {
          type: "interest",
          docId,
          version: docEntry.version,
          // Causal merge needs bidirectional exchange
          reciprocate: isCausal,
        },
      })
    } else {
      // Unknown doc — check route before requesting creation
      if (!route(docId, peerState.identity)) continue
      effects.push({
        type: "ensure-doc",
        docId,
        peer: peerState.identity,
        replicaType,
        mergeStrategy,
        schemaHash,
      })
    }
  }

  return [model, batchEffects(...effects), batchNotifications(...warnings)]
}

// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
// HANDLER: Interest — merge-strategy dispatch
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

function handleInterest(
  from: PeerId,
  message: {
    type: "interest"
    docId: DocId
    version?: string
    reciprocate?: boolean
  },
  model: SyncModel,
): SyncTransition {
  const peerState = model.peers.get(from)
  if (!peerState) return [model]

  const docEntry = model.documents.get(message.docId)
  if (!docEntry) return [model]
  if (docEntry.mode === "deferred") return [model]

  // Known doc — respond based on merge strategy and update peer sync state
  return handleInterestForKnownDoc(from, message, docEntry, model)
}

/**
 * Handle a normal interest for a doc that exists. Responds based on
 * merge strategy and updates peer sync state to "pending".
 */
function handleInterestForKnownDoc(
  fromPeerId: PeerId,
  message: {
    type: "interest"
    docId: DocId
    version?: string
    reciprocate?: boolean
  },
  docEntry: DocEntry,
  model: SyncModel,
): SyncTransition {
  const peerState = model.peers.get(fromPeerId)
  if (!peerState) return [model]

  const effects = buildInterestResponse(fromPeerId, message, docEntry)

  // Update peer sync state to "pending"
  const peers = new Map(model.peers)
  const docSyncStates = new Map(peerState.docSyncStates)
  docSyncStates.set(message.docId, {
    status: "pending",
    lastUpdated: new Date(),
  })
  peers.set(fromPeerId, { ...peerState, docSyncStates })

  const notification: SyncNotification | undefined = readyStateChanged(
    message.docId,
  )

  return [{ ...model, peers }, batchEffects(...effects), notification]
}

// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
// HANDLER: Offer — version compare at receiver, import if accepted
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

function handleOffer(
  from: PeerId,
  message: {
    type: "offer"
    docId: DocId
    payload: SubstratePayload
    version: string
    reciprocate?: boolean
  },
  model: SyncModel,
  authorize: AuthorizePredicate,
): SyncTransition {
  const peerState = model.peers.get(from)
  if (!peerState) return [model]

  const docEntry = model.documents.get(message.docId)
  if (!docEntry) return [model]
  if (docEntry.mode === "deferred") return [model]

  const effects: SyncEffect[] = []

  // Check authorize — reject silently if the peer isn't allowed.
  // Even when rejected, we still process reciprocation and update peer
  // state so we don't re-request from this peer.
  const authorized = authorize(message.docId, peerState.identity)

  if (authorized) {
    // Import the payload — the runtime calls replica.merge(payload)
    // which dispatches internally based on payload.kind.
    effects.push({
      type: "import-doc-data",
      docId: message.docId,
      payload: message.payload,
      version: message.version,
      fromPeerId: from,
    })
  }

  // If the offerer asked for reciprocation, send an interest back
  if (message.reciprocate) {
    effects.push({
      type: "send-to-peer",
      to: from,
      message: {
        type: "interest",
        docId: message.docId,
        version: docEntry.version,
        reciprocate: false,
      },
    })
  }

  return [model, batchEffects(...effects)]
}

// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
// HANDLER: Dismiss
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

function handleDismiss(
  from: PeerId,
  message: { type: "dismiss"; docId: DocId },
  model: SyncModel,
): SyncTransition {
  const peerState = model.peers.get(from)
  if (!peerState) return [model]

  // Clean up peer sync state for this doc
  const peers = new Map(model.peers)
  const docSyncStates = new Map(peerState.docSyncStates)
  docSyncStates.delete(message.docId)
  peers.set(from, { ...peerState, docSyncStates })

  const effect: SyncEffect = {
    type: "ensure-doc-dismissed",
    docId: message.docId,
    peer: peerState.identity,
  }

  return [{ ...model, peers }, effect, readyStateChanged(message.docId)]
}

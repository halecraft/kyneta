// synchronizer-program — TEA state machine for the exchange sync protocol.
//
// Follows The Elm Architecture (TEA) pattern: immutable model, message
// inputs, command outputs. The synchronizer is pure — it doesn't perform
// side effects directly. Instead, it returns commands that the runtime
// executes.
//
// Three sync algorithms are dispatched by the factory's mergeStrategy:
// - Causal: bidirectional exchange, concurrent versions possible
// - Sequential: request/response, total order
// - LWW: unidirectional push/broadcast, timestamp-based
//
// Ported from @loro-extended/repo's synchronizer-program.ts with
// Loro-specific types replaced by substrate-agnostic equivalents.

import type {
  MergeStrategy,
  ReplicaType,
  SubstratePayload,
} from "@kyneta/schema"
import { replicaTypesCompatible } from "@kyneta/schema"
import type { Channel, ConnectedChannel } from "./channel.js"
import type { AuthorizePredicate, RoutePredicate } from "./exchange.js"
import type { AddressedEnvelope, ReturnEnvelope } from "./messages.js"
import type {
  ChannelId,
  DocId,
  PeerId,
  PeerIdentityDetails,
  PeerState,
} from "./types.js"

// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
// STATE
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

/**
 * Per-document state in the synchronizer model.
 *
 * Substrate-agnostic: holds serialized version strings and factory
 * references instead of LoroDoc instances. The actual Substrate<V>
 * and Ref<S> are held by the Exchange class — the synchronizer only
 * needs version info and factory metadata for sync decisions.
 */
export type DocEntry = {
  docId: DocId
  /** Document participation mode — interpret (full stack) or replicate (headless). */
  mode: "interpret" | "replicate"
  /** Serialized version from replica.version().serialize() */
  version: string
  /** Identifies the binary format of this document's replica */
  replicaType: ReplicaType
  /** The merge strategy for this document's substrate */
  mergeStrategy: MergeStrategy
  schemaHash: string
}

/**
 * The synchronizer's complete state model.
 *
 * All state updates are immutable (via mutative library).
 */
export type SynchronizerModel = {
  /** Our own peer identity */
  identity: PeerIdentityDetails

  /** All documents we know about (local and synced from peers) */
  documents: Map<DocId, DocEntry>

  /** All active channels (storage adapters, network peers) */
  channels: Map<ChannelId, Channel>

  /** Peer state tracking for sync optimization */
  peers: Map<PeerId, PeerState>
}

// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
// MESSAGES (inputs to the update function)
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

/**
 * Messages that drive the synchronizer state machine.
 */
export type SynchronizerMessage =
  // Channel lifecycle messages
  | { type: "synchronizer/channel-added"; channel: ConnectedChannel }
  | { type: "synchronizer/establish-channel"; channelId: ChannelId }
  | { type: "synchronizer/channel-removed"; channel: Channel }

  // Document lifecycle messages
  | {
      type: "synchronizer/doc-ensure"
      docId: DocId
      mode: "interpret" | "replicate"
      version: string
      replicaType: ReplicaType
      mergeStrategy: MergeStrategy
      schemaHash: string
    }
  | { type: "synchronizer/local-doc-change"; docId: DocId; version: string }
  | { type: "synchronizer/doc-delete"; docId: DocId }
  | { type: "synchronizer/doc-dismiss"; docId: DocId }
  | {
      type: "synchronizer/doc-imported"
      docId: DocId
      version: string
      fromPeerId: PeerId
    }

  // Channel message received (from network or storage)
  | { type: "synchronizer/channel-receive-message"; envelope: ReturnEnvelope }

// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
// UTILITIES — routing & batching
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

/**
 * Filter channel IDs by the route predicate.
 *
 * For each channel: resolve peer identity and call `route(docId, peer)`.
 * Channels with unresolvable peer identity are dropped.
 */
function filterChannelsByRoute(
  model: SynchronizerModel,
  channelIds: ChannelId[],
  docId: DocId,
  route: RoutePredicate,
): ChannelId[] {
  return channelIds.filter(id => {
    const channel = model.channels.get(id)
    if (!channel || channel.type !== "established") return false
    const peerState = model.peers.get(channel.peerId)
    if (!peerState) return false
    return route(docId, peerState.identity)
  })
}

/**
 * Collapse an array of commands (possibly with undefined entries) into
 * a single Command or undefined. Filters out undefined, returns undefined
 * for empty, the single command for length 1, or a batch for multiple.
 */
function batchAsNeeded(
  ...commands: (Command | undefined)[]
): Command | undefined {
  const filtered = commands.filter((c): c is Command => c !== undefined)
  if (filtered.length === 0) return undefined
  if (filtered.length === 1) return filtered[0]
  return { type: "cmd/batch", commands: filtered }
}

// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
// COMMANDS (outputs of the update function — effects on the world)
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

/**
 * Commands are side effects produced by the update function.
 * The synchronizer runtime executes them.
 *
 * Commands change the world: send messages, import data, stop channels,
 * fire callbacks that may trigger reentrant dispatch. They are the
 * effectful co-product of the state transition.
 */
export type Command =
  // Channel operations
  | { type: "cmd/stop-channel"; channel: Channel }
  | { type: "cmd/send-message"; envelope: AddressedEnvelope }

  // Offer construction — the runtime builds the offer from the substrate
  | {
      type: "cmd/send-offer"
      docId: DocId
      toChannelIds: ChannelId[]
      /** If set, export since this version. Otherwise, export entirety. */
      sinceVersion?: string
      reciprocate?: boolean
    }

  // Document operations
  | { type: "cmd/subscribe-doc"; docId: DocId }
  | {
      type: "cmd/request-doc-creation"
      docId: DocId
      peer: PeerIdentityDetails
      replicaType: ReplicaType
      mergeStrategy: MergeStrategy
      schemaHash: string
    }
  | {
      type: "cmd/import-doc-data"
      docId: DocId
      payload: SubstratePayload
      version: string
      fromPeerId: PeerId
    }

  // Lifecycle notifications
  | {
      type: "cmd/notify-doc-dismissed"
      docId: DocId
      peer: PeerIdentityDetails
    }

  // Utilities
  | { type: "cmd/dispatch"; dispatch: SynchronizerMessage }
  | { type: "cmd/batch"; commands: Command[] }

// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
// NOTIFICATIONS (outputs of the update function — observations about the model)
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

/**
 * Notifications are observations about model transitions produced by the
 * update function. Unlike commands, they do not change the world — they
 * declare what changed so the imperative shell can inform external
 * listeners.
 *
 * This is the invalidation co-product of the state transition, parallel
 * to commands (the effectful co-product). The pure program knows exactly
 * which model data was touched; notifications carry that knowledge to
 * the shell without the shell needing to diff the model.
 *
 * Analogous to Op[] in the schema changefeed: the changefeed declares
 * what changed so subscribers don't poll; notifications declare what
 * model state was invalidated so the shell doesn't brute-force.
 */
export type Notification =
  | { type: "notify/ready-state-changed"; docIds: ReadonlySet<DocId> }
  | { type: "notify/state-advanced"; docIds: ReadonlySet<DocId> }
  | { type: "notify/warning"; message: string }
  | { type: "notify/batch"; notifications: Notification[] }

/**
 * Collapse an array of notifications (possibly with undefined entries)
 * into a single Notification or undefined. Mirrors `batchAsNeeded` for
 * commands.
 */
function notifyAsNeeded(
  ...notifications: (Notification | undefined)[]
): Notification | undefined {
  const filtered = notifications.filter(
    (n): n is Notification => n !== undefined,
  )
  if (filtered.length === 0) return undefined
  if (filtered.length === 1) return filtered[0]
  return { type: "notify/batch", notifications: filtered }
}

/**
 * Convenience: construct a ready-state-changed notification for one or
 * more docIds.
 */
function readyStateChanged(...docIds: DocId[]): Notification {
  return { type: "notify/ready-state-changed", docIds: new Set(docIds) }
}

/**
 * Convenience: construct a state-advanced notification for one or
 * more docIds. Emitted when a document's state advances — either
 * from a local mutation or a network import.
 *
 * Context: jj:smmulzkm (unified persistence via notify/state-advanced)
 */
function stateAdvanced(...docIds: DocId[]): Notification {
  return { type: "notify/state-advanced", docIds: new Set(docIds) }
}

// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
// PROGRAM DEFINITION
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

/**
 * Initialize the synchronizer with a peer identity.
 *
 * @returns Initial model state with no documents, channels, or peers.
 */
export function init(
  identity: PeerIdentityDetails,
): [SynchronizerModel, Command?] {
  return [
    {
      identity,
      documents: new Map(),
      channels: new Map(),
      peers: new Map(),
    },
  ]
}

/**
 * The update function signature — takes a message and current model,
 * returns the new model, an optional command, and an optional notification.
 *
 * The triple `[Model, Command?, Notification?]` is the complete
 * co-product of a state transition:
 * - **Model**: the new state
 * - **Command**: effects to execute (send messages, import data, etc.)
 * - **Notification**: observations to broadcast (ready state invalidation)
 */
export type SynchronizerUpdate = (
  msg: SynchronizerMessage,
  model: SynchronizerModel,
) => [SynchronizerModel, Command?, Notification?]

// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
// UPDATE LOGIC
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

type CreateSynchronizerUpdateParams = {
  route: RoutePredicate
  authorize: AuthorizePredicate
}

const defaultParams: CreateSynchronizerUpdateParams = {
  route: () => true,
  authorize: () => true,
}

/**
 * Creates the main synchronizer update function.
 *
 * The returned function is the pure TEA update: (msg, model) → [model, cmd?].
 * The `route` and `authorize` predicates control information flow:
 * - `route`: gates all outbound messages (present, push, relay)
 * - `authorize`: gates inbound data import (offers)
 */
export function createSynchronizerUpdate(
  params: Partial<CreateSynchronizerUpdateParams> = {},
): SynchronizerUpdate {
  const { route, authorize } = { ...defaultParams, ...params }
  return function update(
    msg: SynchronizerMessage,
    model: SynchronizerModel,
  ): [SynchronizerModel, Command?, Notification?] {
    switch (msg.type) {
      case "synchronizer/channel-added":
        return handleChannelAdded(msg, model)

      case "synchronizer/establish-channel":
        return handleEstablishChannel(msg, model)

      case "synchronizer/channel-removed":
        return handleChannelRemoved(msg, model)

      case "synchronizer/doc-ensure":
        return handleDocEnsure(msg, model, route)

      case "synchronizer/local-doc-change":
        return handleLocalDocChange(msg, model, route)

      case "synchronizer/doc-delete":
        return handleDocDelete(msg, model)

      case "synchronizer/doc-dismiss":
        return handleDocDismiss(msg, model, route)

      case "synchronizer/doc-imported":
        return handleDocImported(msg, model, route)

      case "synchronizer/channel-receive-message":
        return handleChannelReceiveMessage(msg, model, route, authorize)
    }
  }
}

// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
// HANDLER: Channel lifecycle
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

function handleChannelAdded(
  msg: { type: "synchronizer/channel-added"; channel: ConnectedChannel },
  model: SynchronizerModel,
): [SynchronizerModel, Command?, Notification?] {
  const channels = new Map(model.channels)
  channels.set(msg.channel.channelId, msg.channel)
  return [{ ...model, channels }]
}

function handleEstablishChannel(
  msg: { type: "synchronizer/establish-channel"; channelId: ChannelId },
  model: SynchronizerModel,
): [SynchronizerModel, Command?, Notification?] {
  const channel = model.channels.get(msg.channelId)
  if (!channel || channel.type !== "connected") {
    return [model]
  }

  // Send establish-request
  const cmd: Command = {
    type: "cmd/send-message",
    envelope: {
      toChannelIds: [msg.channelId],
      message: {
        type: "establish-request",
        identity: model.identity,
      },
    },
  }

  return [model, cmd]
}

function handleChannelRemoved(
  msg: { type: "synchronizer/channel-removed"; channel: Channel },
  model: SynchronizerModel,
): [SynchronizerModel, Command?, Notification?] {
  const channels = new Map(model.channels)
  channels.delete(msg.channel.channelId)

  // Clean up peer state if this was an established channel
  let peers = model.peers
  let notification: Notification | undefined
  if (msg.channel.type === "established") {
    peers = new Map(peers)
    const peerState = peers.get(msg.channel.peerId)
    if (peerState) {
      const newChannels = new Set(peerState.channels)
      newChannels.delete(msg.channel.channelId)
      if (newChannels.size === 0) {
        // Peer fully removed — all docs it had sync state for are affected
        if (peerState.docSyncStates.size > 0) {
          notification = readyStateChanged(...peerState.docSyncStates.keys())
        }
        peers.delete(msg.channel.peerId)
      } else {
        // Channel count changed — affects ready state for docs this peer
        // has synced, since #isReady checks channels.size > 0
        if (peerState.docSyncStates.size > 0) {
          notification = readyStateChanged(...peerState.docSyncStates.keys())
        }
        peers.set(msg.channel.peerId, { ...peerState, channels: newChannels })
      }
    }
  }

  return [{ ...model, channels, peers }, undefined, notification]
}

// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
// HANDLER: Document lifecycle
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

function handleDocEnsure(
  msg: {
    type: "synchronizer/doc-ensure"
    docId: DocId
    mode: "interpret" | "replicate"
    version: string
    replicaType: ReplicaType
    mergeStrategy: MergeStrategy
    schemaHash: string
  },
  model: SynchronizerModel,
  route: RoutePredicate,
): [SynchronizerModel, Command?, Notification?] {
  const existing = model.documents.get(msg.docId)
  if (existing) {
    return [model]
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

  // Announce new doc and request sync from all established channels.
  // We send both present (so peers learn we have the doc) and interest
  // (so peers send us their state). This is essential for docs created
  // via onDocDiscovered — the local doc is empty and needs to pull data.
  const allEstablished = getEstablishedChannelIds(model)
  const updatedModel = { ...model, documents }
  const establishedChannelIds = filterChannelsByRoute(
    updatedModel,
    allEstablished,
    msg.docId,
    route,
  )
  if (establishedChannelIds.length === 0) {
    return [updatedModel]
  }

  const isCausal = msg.mergeStrategy === "causal"
  const cmd = batchAsNeeded(
    {
      type: "cmd/send-message",
      envelope: {
        toChannelIds: establishedChannelIds,
        message: {
          type: "present",
          docs: [
            {
              docId: msg.docId,
              replicaType: msg.replicaType,
              mergeStrategy: msg.mergeStrategy,
              schemaHash: msg.schemaHash,
            },
          ],
        },
      },
    },
    {
      type: "cmd/send-message",
      envelope: {
        toChannelIds: establishedChannelIds,
        message: {
          type: "interest",
          docId: msg.docId,
          version: msg.version,
          reciprocate: isCausal,
        },
      },
    },
  )

  return [updatedModel, cmd]
}

function handleLocalDocChange(
  msg: { type: "synchronizer/local-doc-change"; docId: DocId; version: string },
  model: SynchronizerModel,
  route: RoutePredicate,
): [SynchronizerModel, Command?, Notification?] {
  const docEntry = model.documents.get(msg.docId)
  if (!docEntry) return [model]

  // Update version
  const documents = new Map(model.documents)
  documents.set(msg.docId, { ...docEntry, version: msg.version })

  // Push to synced peers based on merge strategy
  const cmd = buildPush(msg.docId, docEntry, model, route)

  return [{ ...model, documents }, cmd, stateAdvanced(msg.docId)]
}

function handleDocDelete(
  msg: { type: "synchronizer/doc-delete"; docId: DocId },
  model: SynchronizerModel,
): [SynchronizerModel, Command?, Notification?] {
  const documents = new Map(model.documents)
  documents.delete(msg.docId)
  return [{ ...model, documents }]
}

function handleDocDismiss(
  msg: { type: "synchronizer/doc-dismiss"; docId: DocId },
  model: SynchronizerModel,
  route: RoutePredicate,
): [SynchronizerModel, Command?, Notification?] {
  const documents = new Map(model.documents)
  documents.delete(msg.docId)

  // Broadcast dismiss to all established channels (filtered by route)
  const allEstablished = getEstablishedChannelIds(model)
  const channelIds = filterChannelsByRoute(
    model,
    allEstablished,
    msg.docId,
    route,
  )

  const cmd: Command | undefined =
    channelIds.length > 0
      ? {
          type: "cmd/send-message",
          envelope: {
            toChannelIds: channelIds,
            message: {
              type: "dismiss",
              docId: msg.docId,
            },
          },
        }
      : undefined

  return [{ ...model, documents }, cmd]
}

function handleDocImported(
  msg: {
    type: "synchronizer/doc-imported"
    docId: DocId
    version: string
    fromPeerId: PeerId
  },
  model: SynchronizerModel,
  route: RoutePredicate,
): [SynchronizerModel, Command?, Notification?] {
  const docEntry = model.documents.get(msg.docId)
  if (!docEntry) return [model]

  // Relay to other peers (multi-hop propagation).
  // Must read docEntry.version BEFORE updating — this is the "since" version
  // for delta export, so peers receive exactly the imported ops.
  const cmd = buildPush(msg.docId, docEntry, model, route, msg.fromPeerId)

  // Update version
  const documents = new Map(model.documents)
  documents.set(msg.docId, { ...docEntry, version: msg.version })

  // Update peer sync state
  const peers = new Map(model.peers)
  const peerState = peers.get(msg.fromPeerId)
  let notification: Notification | undefined
  if (peerState) {
    const docSyncStates = new Map(peerState.docSyncStates)
    docSyncStates.set(msg.docId, {
      status: "synced",
      lastKnownVersion: msg.version,
      lastUpdated: new Date(),
    })
    peers.set(msg.fromPeerId, { ...peerState, docSyncStates })
    notification = notifyAsNeeded(
      readyStateChanged(msg.docId),
      stateAdvanced(msg.docId),
    )
  } else {
    notification = stateAdvanced(msg.docId)
  }

  return [{ ...model, documents, peers }, cmd, notification]
}

// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
// HANDLER: Channel message received
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

function handleChannelReceiveMessage(
  msg: {
    type: "synchronizer/channel-receive-message"
    envelope: ReturnEnvelope
  },
  model: SynchronizerModel,
  route: RoutePredicate,
  authorize: AuthorizePredicate,
): [SynchronizerModel, Command?, Notification?] {
  const { fromChannelId, message } = msg.envelope

  switch (message.type) {
    case "establish-request":
      return handleEstablishRequest(fromChannelId, message, model, route)

    case "establish-response":
      return handleEstablishResponse(fromChannelId, message, model, route)

    case "present":
      return handlePresent(fromChannelId, message, model, route)

    case "interest":
      return handleInterest(fromChannelId, message, model, route)

    case "offer":
      return handleOffer(fromChannelId, message, model, authorize)

    case "dismiss":
      return handleDismiss(fromChannelId, message, model)
  }
}

// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
// HANDLER: Establishment
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

/**
 * Upgrade a connected channel to established and track peer state.
 * Shared by handleEstablishRequest and handleEstablishResponse.
 */
function upgradeChannel(
  model: SynchronizerModel,
  channelId: ChannelId,
  peerIdentity: PeerIdentityDetails,
): SynchronizerModel {
  const channel = model.channels.get(channelId)
  if (!channel) return model

  const channels = new Map(model.channels)
  channels.set(channelId, {
    ...channel,
    type: "established" as const,
    peerId: peerIdentity.peerId,
  })

  const peers = new Map(model.peers)
  const existingPeer = peers.get(peerIdentity.peerId)
  const peerChannels = new Set(existingPeer?.channels ?? [])
  peerChannels.add(channelId)
  peers.set(peerIdentity.peerId, {
    identity: peerIdentity,
    docSyncStates: existingPeer?.docSyncStates ?? new Map(),
    subscriptions: existingPeer?.subscriptions ?? new Set(),
    channels: peerChannels,
  })

  return { ...model, channels, peers }
}

/**
 * Build a present command for a set of doc IDs to a single channel.
 * Returns undefined if there are no docs to announce.
 */
function buildPresent(
  docIds: DocId[],
  toChannelId: ChannelId,
  model: SynchronizerModel,
): Command | undefined {
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
    type: "cmd/send-message",
    envelope: {
      toChannelIds: [toChannelId],
      message: {
        type: "present",
        docs,
      },
    },
  }
}

/**
 * Detect peer identity issues at channel establishment time.
 * Returns a `notify/warning` notification if a problem is found, or undefined.
 *
 * Two checks:
 * 1. **Self-connection:** remote peerId matches our own identity.
 * 2. **Duplicate peerId:** remote peerId already has active channels
 *    that are not the channel being upgraded (genuinely new connection).
 */
function detectPeerIdentityWarning(
  model: SynchronizerModel,
  fromChannelId: ChannelId,
  remotePeerId: string,
): Notification | undefined {
  // Self-connection: peer connecting to itself
  if (remotePeerId === model.identity.peerId) {
    return {
      type: "notify/warning",
      message:
        `[exchange] self-connection detected — remote peer "${remotePeerId}" has the same peerId as this exchange. ` +
        `This will cause sync failures. Ensure server and client have different peerIds.`,
    }
  }

  // Duplicate peerId: another connection already established with this identity
  const existingPeer = model.peers.get(remotePeerId)
  if (existingPeer) {
    const otherChannels = new Set(existingPeer.channels)
    otherChannels.delete(fromChannelId)
    if (otherChannels.size > 0) {
      return {
        type: "notify/warning",
        message:
          `[exchange] duplicate peerId "${remotePeerId}" — peer already has ${otherChannels.size} active channel(s). ` +
          `Two participants sharing the same peerId will corrupt CRDT state. ` +
          `Ensure each browser tab / client has a unique peerId.`,
      }
    }
  }

  return undefined
}

function handleEstablishRequest(
  fromChannelId: ChannelId,
  message: { type: "establish-request"; identity: PeerIdentityDetails },
  model: SynchronizerModel,
  route: RoutePredicate,
): [SynchronizerModel, Command?, Notification?] {
  const channel = model.channels.get(fromChannelId)
  if (!channel) return [model]

  const warning = detectPeerIdentityWarning(model, fromChannelId, message.identity.peerId)
  const upgraded = upgradeChannel(model, fromChannelId, message.identity)

  // Filter docs by route — only announce docs this peer is allowed to see
  const docIds = Array.from(model.documents.keys()).filter(id =>
    route(id, message.identity),
  )

  const cmd = batchAsNeeded(
    {
      type: "cmd/send-message",
      envelope: {
        toChannelIds: [fromChannelId],
        message: {
          type: "establish-response",
          identity: model.identity,
        },
      },
    },
    buildPresent(docIds, fromChannelId, upgraded),
  )

  return [upgraded, cmd, warning]
}

function handleEstablishResponse(
  fromChannelId: ChannelId,
  message: { type: "establish-response"; identity: PeerIdentityDetails },
  model: SynchronizerModel,
  route: RoutePredicate,
): [SynchronizerModel, Command?, Notification?] {
  const channel = model.channels.get(fromChannelId)
  if (!channel) return [model]

  const warning = detectPeerIdentityWarning(model, fromChannelId, message.identity.peerId)
  const upgraded = upgradeChannel(model, fromChannelId, message.identity)

  // Filter docs by route — only announce docs this peer is allowed to see
  const docIds = Array.from(model.documents.keys()).filter(id =>
    route(id, message.identity),
  )
  const cmd = buildPresent(docIds, fromChannelId, upgraded)

  return [upgraded, cmd, warning]
}

// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
// HANDLER: Dismiss
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

function handleDismiss(
  fromChannelId: ChannelId,
  message: { type: "dismiss"; docId: DocId },
  model: SynchronizerModel,
): [SynchronizerModel, Command?, Notification?] {
  const channel = model.channels.get(fromChannelId)
  if (!channel || channel.type !== "established") return [model]

  const peerState = model.peers.get(channel.peerId)
  if (!peerState) return [model]

  // Clean up peer sync state for this doc
  const peers = new Map(model.peers)
  const docSyncStates = new Map(peerState.docSyncStates)
  docSyncStates.delete(message.docId)
  const subscriptions = new Set(peerState.subscriptions)
  subscriptions.delete(message.docId)
  peers.set(channel.peerId, { ...peerState, docSyncStates, subscriptions })

  const cmd: Command = {
    type: "cmd/notify-doc-dismissed",
    docId: message.docId,
    peer: peerState.identity,
  }

  return [{ ...model, peers }, cmd, readyStateChanged(message.docId)]
}

// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
// HANDLER: Present — assertion handling with mismatch detection
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

function handlePresent(
  fromChannelId: ChannelId,
  message: {
    type: "present"
    docs: Array<{
      docId: DocId
      replicaType: ReplicaType
      mergeStrategy: MergeStrategy
      schemaHash: string
    }>
  },
  model: SynchronizerModel,
  route: RoutePredicate,
): [SynchronizerModel, Command?, Notification?] {
  const channel = model.channels.get(fromChannelId)
  if (!channel || channel.type !== "established") return [model]

  const commands: Command[] = []
  const warnings: Notification[] = []
  const peerState = model.peers.get(channel.peerId)

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
      // Compatible — send interest with our version
      const isCausal = docEntry.mergeStrategy === "causal"
      commands.push({
        type: "cmd/send-message",
        envelope: {
          toChannelIds: [fromChannelId],
          message: {
            type: "interest",
            docId,
            version: docEntry.version,
            // Causal merge needs bidirectional exchange
            reciprocate: isCausal,
          },
        },
      })
    } else if (peerState) {
      // Unknown doc — check route before requesting creation
      if (!route(docId, peerState.identity)) continue
      commands.push({
        type: "cmd/request-doc-creation",
        docId,
        peer: peerState.identity,
        replicaType,
        mergeStrategy,
        schemaHash,
      })
    }
  }

  return [
    model,
    batchAsNeeded(...commands),
    notifyAsNeeded(...warnings),
  ]
}

// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
// HANDLER: Interest — merge-strategy dispatch + storage-first sync
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

function handleInterest(
  fromChannelId: ChannelId,
  message: {
    type: "interest"
    docId: DocId
    version?: string
    reciprocate?: boolean
  },
  model: SynchronizerModel,
  route: RoutePredicate,
): [SynchronizerModel, Command?, Notification?] {
  const channel = model.channels.get(fromChannelId)
  if (!channel || channel.type !== "established") return [model]

  const docEntry = model.documents.get(message.docId)

  if (!docEntry) {
    // Unknown doc — nothing to offer, drop silently.
    // Storage hydration is handled by the Exchange directly, not here.
    return [model]
  }

  // Known doc — respond based on merge strategy
  return handleInterestForKnownDoc(fromChannelId, message, docEntry, model)
}

/**
 * Build commands to respond to an interest for a known doc.
 * Shared by handleInterestForKnownDoc and processQueuedInterests.
 */
function buildInterestResponse(
  fromChannelId: ChannelId,
  message: {
    type: "interest"
    docId: DocId
    version?: string
    reciprocate?: boolean
  },
  docEntry: DocEntry,
  model: SynchronizerModel,
): Command[] {
  const channel = model.channels.get(fromChannelId)
  if (!channel || channel.type !== "established") return []

  const commands: Command[] = []

  switch (docEntry.mergeStrategy) {
    case "causal":
      // Causal: always send our state (the CRDT handles merge)
      // Use exportSince if the peer provided a version, otherwise snapshot
      commands.push({
        type: "cmd/send-offer",
        docId: message.docId,
        toChannelIds: [fromChannelId],
        sinceVersion: message.version,
        reciprocate: false,
      })

      // If the peer asked for reciprocation, send our own interest
      if (message.reciprocate) {
        commands.push({
          type: "cmd/send-message",
          envelope: {
            toChannelIds: [fromChannelId],
            message: {
              type: "interest",
              docId: message.docId,
              version: docEntry.version,
              reciprocate: false, // prevent infinite loop
            },
          },
        })
      }
      break

    case "sequential":
      // Sequential: compare versions. If we're ahead, send offer.
      // If we're behind, send our own interest.
      // We can't compare versions in the pure model (that requires
      // the runtime to parse versions), so we always send an offer
      // and let the runtime/receiver decide based on version comparison.
      commands.push({
        type: "cmd/send-offer",
        docId: message.docId,
        toChannelIds: [fromChannelId],
        sinceVersion: message.version,
        reciprocate: false,
      })
      break

    case "lww":
      // LWW: always respond with snapshot (no delta computation)
      commands.push({
        type: "cmd/send-offer",
        docId: message.docId,
        toChannelIds: [fromChannelId],
        // No sinceVersion — always entirety for LWW
        reciprocate: false,
      })
      break
  }

  return commands
}

/**
 * Handle a normal interest for a doc that exists (no pending storage).
 * Responds based on merge strategy and updates peer sync state.
 */
function handleInterestForKnownDoc(
  fromChannelId: ChannelId,
  message: {
    type: "interest"
    docId: DocId
    version?: string
    reciprocate?: boolean
  },
  docEntry: DocEntry,
  model: SynchronizerModel,
): [SynchronizerModel, Command?, Notification?] {
  const channel = model.channels.get(fromChannelId)
  if (!channel || channel.type !== "established") return [model]

  const commands = buildInterestResponse(
    fromChannelId,
    message,
    docEntry,
    model,
  )

  // Update peer sync state to "pending"
  const peers = new Map(model.peers)
  const peerState = peers.get(channel.peerId)
  let notification: Notification | undefined
  if (peerState) {
    const docSyncStates = new Map(peerState.docSyncStates)
    docSyncStates.set(message.docId, {
      status: "pending",
      lastUpdated: new Date(),
    })
    peers.set(channel.peerId, { ...peerState, docSyncStates })
    notification = readyStateChanged(message.docId)
  }

  return [{ ...model, peers }, batchAsNeeded(...commands), notification]
}

// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
// HANDLER: Offer — version compare at receiver, import if accepted
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

function handleOffer(
  fromChannelId: ChannelId,
  message: {
    type: "offer"
    docId: DocId
    payload: SubstratePayload
    version: string
    reciprocate?: boolean
  },
  model: SynchronizerModel,
  authorize: AuthorizePredicate,
): [SynchronizerModel, Command?, Notification?] {
  const channel = model.channels.get(fromChannelId)
  if (!channel || channel.type !== "established") return [model]

  const docEntry = model.documents.get(message.docId)
  if (!docEntry) {
    // We don't have this doc — ignore the offer
    return [model]
  }

  const commands: Command[] = []

  // Check authorize — reject silently if the peer isn't allowed.
  // Even when rejected, we still process reciprocation and update peer
  // state so we don't re-request from this peer.
  const peerState = model.peers.get(channel.peerId)
  const authorized =
    peerState != null && authorize(message.docId, peerState.identity)

  if (authorized) {
    // Import the payload — the runtime calls replica.merge(payload)
    // which dispatches internally based on payload.kind.
    commands.push({
      type: "cmd/import-doc-data",
      docId: message.docId,
      payload: message.payload,
      version: message.version,
      fromPeerId: channel.peerId,
    })
  }

  // If the offerer asked for reciprocation, send an interest back
  if (message.reciprocate) {
    commands.push({
      type: "cmd/send-message",
      envelope: {
        toChannelIds: [fromChannelId],
        message: {
          type: "interest",
          docId: message.docId,
          version: docEntry.version,
          reciprocate: false,
        },
      },
    })
  }

  return [model, batchAsNeeded(...commands)]
}

// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
// Push — merge-strategy dispatch for outbound changes
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

/**
 * Build a push command for document changes — used for both local changes
 * and relay (imported changes forwarded to other peers).
 *
 * When `excludePeerId` is provided, that peer is excluded from the push
 * (relay case: don't echo back to the sender).
 */
function buildPush(
  docId: DocId,
  docEntry: DocEntry,
  model: SynchronizerModel,
  route: RoutePredicate,
  excludePeerId?: PeerId,
): Command | undefined {
  switch (docEntry.mergeStrategy) {
    case "causal":
    case "sequential": {
      // Push delta offer to synced peers, filtered by route
      const raw = getSyncedPeerChannels(model, docId, excludePeerId)
      const channelIds = filterChannelsByRoute(model, raw, docId, route)
      if (channelIds.length === 0) return undefined

      return {
        type: "cmd/send-offer",
        docId,
        toChannelIds: channelIds,
        sinceVersion: docEntry.version,
      }
    }

    case "lww": {
      // Broadcast snapshot to ALL established peers, filtered by route
      const raw = getEstablishedChannelIds(model, excludePeerId)
      const channelIds = filterChannelsByRoute(model, raw, docId, route)
      if (channelIds.length === 0) return undefined

      return {
        type: "cmd/send-offer",
        docId,
        toChannelIds: channelIds,
      }
    }
  }
}

// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
// Helpers
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

function getEstablishedChannelIds(
  model: SynchronizerModel,
  excludePeerId?: PeerId,
): ChannelId[] {
  const ids: ChannelId[] = []
  for (const [id, channel] of model.channels) {
    if (channel.type === "established") {
      if (excludePeerId && channel.peerId === excludePeerId) continue
      ids.push(id)
    }
  }
  return ids
}

/**
 * Get channel IDs of peers that have previously synced a specific doc.
 * Used for causal and sequential push-on-change.
 */
function getSyncedPeerChannels(
  model: SynchronizerModel,
  docId: DocId,
  excludePeerId?: PeerId,
): ChannelId[] {
  const ids: ChannelId[] = []
  for (const [peerId, peerState] of model.peers) {
    if (excludePeerId && peerId === excludePeerId) continue
    const docSync = peerState.docSyncStates.get(docId)
    if (
      docSync &&
      (docSync.status === "synced" || docSync.status === "pending")
    ) {
      // Send to all channels for this peer
      for (const channelId of peerState.channels) {
        const channel = model.channels.get(channelId)
        if (channel && channel.type === "established") {
          ids.push(channelId)
        }
      }
    }
  }
  return ids
}

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

import type { MergeStrategy, SubstratePayload } from "@kyneta/schema"
import type { Channel, ConnectedChannel } from "./channel.js"
import type { AuthorizePredicate, RoutePredicate } from "./exchange.js"
import type { AddressedEnvelope, ReturnEnvelope } from "./messages.js"
import type {
  ChannelId,
  DocId,
  PeerId,
  PeerIdentityDetails,
  PeerState,
  PendingInterest,
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
  /** The merge strategy for this document's substrate */
  mergeStrategy: MergeStrategy
  /**
   * Storage channels we're waiting to hear from before responding
   * to network interests. When empty, we process pendingInterests.
   */
  pendingStorageChannels?: Set<ChannelId>
  /**
   * Network interest messages waiting for storage to be consulted.
   */
  pendingInterests?: PendingInterest[]
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
      mergeStrategy: MergeStrategy
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
 * Filter channel IDs by the route predicate, bypassing storage channels.
 *
 * For each channel: if `kind === "storage"`, keep unconditionally.
 * Otherwise, resolve peer identity and call `route(docId, peer)`.
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
    // Storage channels bypass route checks
    if (channel.kind === "storage") return true
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
// COMMANDS (outputs of the update function)
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

/**
 * Commands are side effects produced by the update function.
 * The synchronizer runtime executes them.
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
 * returns the new model and an optional command.
 */
export type SynchronizerUpdate = (
  msg: SynchronizerMessage,
  model: SynchronizerModel,
) => [SynchronizerModel, Command?]

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
 * - `route`: gates all outbound messages (discover, push, relay)
 * - `authorize`: gates inbound data import (offers)
 */
export function createSynchronizerUpdate(
  params: Partial<CreateSynchronizerUpdateParams> = {},
): SynchronizerUpdate {
  const { route, authorize } = { ...defaultParams, ...params }
  return function update(
    msg: SynchronizerMessage,
    model: SynchronizerModel,
  ): [SynchronizerModel, Command?] {
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
): [SynchronizerModel, Command?] {
  const channels = new Map(model.channels)
  channels.set(msg.channel.channelId, msg.channel)
  return [{ ...model, channels }]
}

function handleEstablishChannel(
  msg: { type: "synchronizer/establish-channel"; channelId: ChannelId },
  model: SynchronizerModel,
): [SynchronizerModel, Command?] {
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
): [SynchronizerModel, Command?] {
  const channels = new Map(model.channels)
  channels.delete(msg.channel.channelId)

  // Clean up peer state if this was an established channel
  let peers = model.peers
  if (msg.channel.type === "established") {
    peers = new Map(peers)
    const peerState = peers.get(msg.channel.peerId)
    if (peerState) {
      const newChannels = new Set(peerState.channels)
      newChannels.delete(msg.channel.channelId)
      if (newChannels.size === 0) {
        peers.delete(msg.channel.peerId)
      } else {
        peers.set(msg.channel.peerId, { ...peerState, channels: newChannels })
      }
    }
  }

  // Storage-first sync cleanup: if this channel was in any document's
  // pendingStorageChannels, remove it. If that empties the pending set,
  // process the queued network interests.
  const removedId = msg.channel.channelId
  let documents = model.documents
  const commands: Command[] = []

  for (const [docId, docEntry] of documents) {
    if (docEntry.pendingStorageChannels?.has(removedId)) {
      if (documents === model.documents) {
        documents = new Map(documents)
      }
      const newPending = new Set(docEntry.pendingStorageChannels)
      newPending.delete(removedId)

      if (newPending.size === 0) {
        // All storage channels responded (or were removed) — process queued interests
        const released = processQueuedInterests(docEntry, {
          ...model,
          documents,
          channels,
          peers,
        })
        commands.push(...released)
        documents.set(docId, {
          ...docEntry,
          pendingStorageChannels: undefined,
          pendingInterests: undefined,
        })
      } else {
        documents.set(docId, {
          ...docEntry,
          pendingStorageChannels: newPending,
        })
      }
    }
  }

  return [
    { ...model, channels, peers, documents },
    batchAsNeeded(...commands),
  ]
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
    mergeStrategy: MergeStrategy
  },
  model: SynchronizerModel,
  route: RoutePredicate,
): [SynchronizerModel, Command?] {
  const existing = model.documents.get(msg.docId)
  // A placeholder entry (created by handleStorageFirstProbe) has
  // pendingStorageChannels — it should be upgraded, not skipped.
  const isPlaceholder =
    existing?.pendingStorageChannels != null &&
    existing.pendingStorageChannels.size > 0
  if (existing && !isPlaceholder) {
    return [model]
  }

  const documents = new Map(model.documents)
  documents.set(msg.docId, {
    docId: msg.docId,
    mode: msg.mode,
    version: msg.version,
    mergeStrategy: msg.mergeStrategy,
    // Preserve pending storage-first sync state from the placeholder
    pendingStorageChannels: existing?.pendingStorageChannels,
    pendingInterests: existing?.pendingInterests,
  })

  // Announce new doc and request sync from all established channels.
  // We send both discover (so peers learn we have the doc) and interest
  // (so peers send us their state). This is essential for docs created
  // via onDocDiscovered — the local doc is empty and needs to pull data.
  const allEstablished = getEstablishedChannelIds(model)
  const establishedChannelIds = filterChannelsByRoute(
    model,
    allEstablished,
    msg.docId,
    route,
  )
  if (establishedChannelIds.length === 0) {
    return [{ ...model, documents }]
  }

  const isCausal = msg.mergeStrategy === "causal"
  const cmd = batchAsNeeded(
    {
      type: "cmd/send-message",
      envelope: {
        toChannelIds: establishedChannelIds,
        message: {
          type: "discover",
          docIds: [msg.docId],
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

  return [{ ...model, documents }, cmd]
}

function handleLocalDocChange(
  msg: { type: "synchronizer/local-doc-change"; docId: DocId; version: string },
  model: SynchronizerModel,
  route: RoutePredicate,
): [SynchronizerModel, Command?] {
  const docEntry = model.documents.get(msg.docId)
  if (!docEntry) return [model]

  // Update version
  const documents = new Map(model.documents)
  documents.set(msg.docId, { ...docEntry, version: msg.version })

  // Push to synced peers based on merge strategy
  const cmd = buildPush(msg.docId, docEntry, model, route)

  return [{ ...model, documents }, cmd]
}

function handleDocDelete(
  msg: { type: "synchronizer/doc-delete"; docId: DocId },
  model: SynchronizerModel,
): [SynchronizerModel, Command?] {
  const documents = new Map(model.documents)
  documents.delete(msg.docId)
  return [{ ...model, documents }]
}

function handleDocDismiss(
  msg: { type: "synchronizer/doc-dismiss"; docId: DocId },
  model: SynchronizerModel,
  route: RoutePredicate,
): [SynchronizerModel, Command?] {
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
): [SynchronizerModel, Command?] {
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
  if (peerState) {
    const docSyncStates = new Map(peerState.docSyncStates)
    docSyncStates.set(msg.docId, {
      status: "synced",
      lastKnownVersion: msg.version,
      lastUpdated: new Date(),
    })
    peers.set(msg.fromPeerId, { ...peerState, docSyncStates })
  }

  return [{ ...model, documents, peers }, cmd]
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
): [SynchronizerModel, Command?] {
  const { fromChannelId, message } = msg.envelope

  switch (message.type) {
    case "establish-request":
      return handleEstablishRequest(fromChannelId, message, model, route)

    case "establish-response":
      return handleEstablishResponse(fromChannelId, message, model, route)

    case "discover":
      return handleDiscover(fromChannelId, message, model, route)

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
 * Build a discover command for a set of doc IDs to a single channel.
 * Returns undefined if there are no docs to announce.
 */
function buildDiscover(
  docIds: DocId[],
  toChannelId: ChannelId,
): Command | undefined {
  if (docIds.length === 0) return undefined
  return {
    type: "cmd/send-message",
    envelope: {
      toChannelIds: [toChannelId],
      message: {
        type: "discover",
        docIds,
      },
    },
  }
}

function handleEstablishRequest(
  fromChannelId: ChannelId,
  message: { type: "establish-request"; identity: PeerIdentityDetails },
  model: SynchronizerModel,
  route: RoutePredicate,
): [SynchronizerModel, Command?] {
  const channel = model.channels.get(fromChannelId)
  if (!channel) return [model]

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
    buildDiscover(docIds, fromChannelId),
  )

  return [upgraded, cmd]
}

function handleEstablishResponse(
  fromChannelId: ChannelId,
  message: { type: "establish-response"; identity: PeerIdentityDetails },
  model: SynchronizerModel,
  route: RoutePredicate,
): [SynchronizerModel, Command?] {
  const channel = model.channels.get(fromChannelId)
  if (!channel) return [model]

  const upgraded = upgradeChannel(model, fromChannelId, message.identity)

  // Filter docs by route — only announce docs this peer is allowed to see
  const docIds = Array.from(model.documents.keys()).filter(id =>
    route(id, message.identity),
  )
  const cmd = buildDiscover(docIds, fromChannelId)

  return [upgraded, cmd]
}

// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
// HANDLER: Dismiss
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

function handleDismiss(
  fromChannelId: ChannelId,
  message: { type: "dismiss"; docId: DocId },
  model: SynchronizerModel,
): [SynchronizerModel, Command?] {
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

  return [{ ...model, peers }, cmd]
}

// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
// HANDLER: Discover
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

function handleDiscover(
  fromChannelId: ChannelId,
  message: { type: "discover"; docIds: DocId[] },
  model: SynchronizerModel,
  route: RoutePredicate,
): [SynchronizerModel, Command?] {
  const channel = model.channels.get(fromChannelId)
  if (!channel || channel.type !== "established") return [model]

  const commands: Command[] = []
  const peerState = model.peers.get(channel.peerId)

  for (const docId of message.docIds) {
    const docEntry = model.documents.get(docId)
    // A doc entry with pendingStorageChannels is a placeholder created by
    // handleStorageFirstProbe — treat it as unknown for discovery purposes
    // so that cmd/request-doc-creation fires and the Exchange creates the
    // real substrate via onDocDiscovered → exchange.get().
    const isPlaceholder =
      docEntry?.pendingStorageChannels != null &&
      docEntry.pendingStorageChannels.size > 0
    if (docEntry && !isPlaceholder) {
      // We have this doc — send interest with our version
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
      })
    }
  }

  return [model, batchAsNeeded(...commands)]
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
): [SynchronizerModel, Command?] {
  const channel = model.channels.get(fromChannelId)
  if (!channel || channel.type !== "established") return [model]

  const docEntry = model.documents.get(message.docId)

  if (!docEntry) {
    // We don't have this doc. Two paths:
    //
    // 1. Network interest + storage channels exist → storage-first sync:
    //    queue the interest, probe storage channels with discover.
    //
    // 2. Otherwise → nothing to offer, drop the interest.
    //
    // Storage-originated interests for unknown docs are never queued
    // (storage doesn't wait for itself).
    if (channel.kind === "network") {
      const storageChannelIds = getChannelIdsByKind(model, "storage")
      if (storageChannelIds.length > 0) {
        return handleStorageFirstProbe(
          message.docId,
          fromChannelId,
          message,
          storageChannelIds,
          model,
        )
      }
    }
    return [model]
  }

  // If this doc has pendingStorageChannels, storage-first sync is in progress.
  // Two sub-cases:
  //
  // 1. Storage channel sending interest → completion signal ("I'm done").
  // 2. Network channel sending interest → queue it alongside existing pending interests.
  if (
    docEntry.pendingStorageChannels &&
    docEntry.pendingStorageChannels.size > 0
  ) {
    if (
      channel.kind === "storage" &&
      docEntry.pendingStorageChannels.has(fromChannelId)
    ) {
      return handleStorageCompletionSignal(
        fromChannelId,
        message.docId,
        docEntry,
        model,
      )
    }

    if (channel.kind === "network") {
      // Queue this additional network interest
      const pendingInterests = [...(docEntry.pendingInterests ?? [])]
      pendingInterests.push({
        channelId: fromChannelId,
        version: message.version,
        reciprocate: message.reciprocate ?? false,
      })
      const documents = new Map(model.documents)
      documents.set(message.docId, { ...docEntry, pendingInterests })
      return [{ ...model, documents }]
    }
  }

  // Normal interest for a known doc — respond based on merge strategy
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
): [SynchronizerModel, Command?] {
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
  if (peerState) {
    const docSyncStates = new Map(peerState.docSyncStates)
    docSyncStates.set(message.docId, {
      status: "pending",
      lastUpdated: new Date(),
    })
    peers.set(channel.peerId, { ...peerState, docSyncStates })
  }

  return [{ ...model, peers }, batchAsNeeded(...commands)]
}

// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
// Storage-first sync helpers
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

/**
 * Storage-first probe: a network peer sent interest for an unknown doc,
 * and we have storage channels. Create a pending doc entry, queue the
 * network interest, and send discover to all storage channels.
 */
function handleStorageFirstProbe(
  docId: DocId,
  networkChannelId: ChannelId,
  message: { version?: string; reciprocate?: boolean },
  storageChannelIds: ChannelId[],
  model: SynchronizerModel,
): [SynchronizerModel, Command?] {
  // Check if there's already a pending entry for this doc
  // (another network peer may have already triggered the probe)
  const existing = model.documents.get(docId)
  const pendingStorageChannels = existing?.pendingStorageChannels
    ? new Set(existing.pendingStorageChannels)
    : new Set(storageChannelIds)
  const pendingInterests = [...(existing?.pendingInterests ?? [])]

  // Queue this network interest
  pendingInterests.push({
    channelId: networkChannelId,
    version: message.version,
    reciprocate: message.reciprocate ?? false,
  })

  const documents = new Map(model.documents)
  documents.set(docId, {
    ...(existing ?? {
      docId,
      mode: "replicate" as const,
      version: "",
      mergeStrategy: "causal" as MergeStrategy,
    }),
    pendingStorageChannels,
    pendingInterests,
  })

  // Send discover to all storage channels: "do you have this doc?"
  // Only send the probe on the first interest (when we create the entry),
  // not on subsequent interests that piggyback on the existing probe.
  const cmd: Command | undefined = !existing
    ? {
        type: "cmd/send-message",
        envelope: {
          toChannelIds: storageChannelIds,
          message: {
            type: "discover",
            docIds: [docId],
          },
        },
      }
    : undefined

  return [{ ...model, documents }, cmd]
}

/**
 * Handle the completion signal from a storage channel: an interest message
 * from a storage channel for a doc that has pendingStorageChannels.
 *
 * Removes the storage channel from the pending set. If all storage channels
 * have responded, processes the queued network interests.
 */
function handleStorageCompletionSignal(
  storageChannelId: ChannelId,
  docId: DocId,
  docEntry: DocEntry,
  model: SynchronizerModel,
): [SynchronizerModel, Command?] {
  const newPending = new Set(docEntry.pendingStorageChannels!)
  newPending.delete(storageChannelId)

  const documents = new Map(model.documents)

  if (newPending.size > 0) {
    // Still waiting for other storage channels
    documents.set(docId, {
      ...docEntry,
      pendingStorageChannels: newPending,
    })
    return [{ ...model, documents }]
  }

  // All storage channels have responded — process queued interests
  const commands = processQueuedInterests(docEntry, model)

  documents.set(docId, {
    ...docEntry,
    pendingStorageChannels: undefined,
    pendingInterests: undefined,
  })

  return [{ ...model, documents }, batchAsNeeded(...commands)]
}

/**
 * Process queued network interests that were waiting for storage.
 *
 * For each queued interest, dispatch the same logic as a normal interest
 * for a known doc. If the doc was never created (storage had nothing,
 * onDocDiscovered never fired), the interests are silently dropped.
 */
function processQueuedInterests(
  docEntry: DocEntry,
  model: SynchronizerModel,
): Command[] {
  const pending = docEntry.pendingInterests ?? []
  if (pending.length === 0) return []

  // Check whether the doc was actually created via doc-ensure, or is
  // still the placeholder from handleStorageFirstProbe. Placeholders
  // use version "" — doc-ensure sets the real substrate version (e.g.
  // "0" for plain, a base64 VersionVector for Loro). If the entry is
  // gone or still at "", there's nothing to offer.
  const currentDoc = model.documents.get(docEntry.docId)
  if (!currentDoc || currentDoc.version === "") {
    return []
  }

  const commands: Command[] = []
  for (const interest of pending) {
    const interestCommands = buildInterestResponse(
      interest.channelId,
      {
        type: "interest",
        docId: docEntry.docId,
        version: interest.version,
        reciprocate: interest.reciprocate,
      },
      currentDoc,
      model,
    )
    commands.push(...interestCommands)
  }
  return commands
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
): [SynchronizerModel, Command?] {
  const channel = model.channels.get(fromChannelId)
  if (!channel || channel.type !== "established") return [model]

  const docEntry = model.documents.get(message.docId)
  if (!docEntry) {
    // We don't have this doc — ignore the offer
    return [model]
  }

  const commands: Command[] = []

  // Check authorize for network channels — storage channels bypass.
  // Even when rejected, we still process reciprocation and update peer
  // state so we don't re-request from this peer.
  const peerState = model.peers.get(channel.peerId)
  const authorized =
    channel.kind === "storage" ||
    (peerState != null && authorize(message.docId, peerState.identity))

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

function getChannelIdsByKind(
  model: SynchronizerModel,
  kind: "storage" | "network" | "other",
): ChannelId[] {
  const ids: ChannelId[] = []
  for (const [id, channel] of model.channels) {
    if (channel.kind === kind && channel.type === "established") {
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

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

import type { SubstratePayload, MergeStrategy } from "@kyneta/schema"
import type { Channel, ConnectedChannel } from "./channel.js"
import type { AddressedEnvelope, ReturnEnvelope } from "./messages.js"
import type {
  ChannelId,
  DocId,
  PeerId,
  PeerIdentityDetails,
  PeerState,
  PendingInterest,
} from "./types.js"
import type { Permissions } from "./permissions.js"

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
  /** Serialized version from substrate.version().serialize() */
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
      version: string
      mergeStrategy: MergeStrategy
    }
  | { type: "synchronizer/local-doc-change"; docId: DocId; version: string }
  | { type: "synchronizer/doc-delete"; docId: DocId }
  | {
      type: "synchronizer/doc-imported"
      docId: DocId
      version: string
      fromPeerId: PeerId
    }

  // Channel message received (from network or storage)
  | { type: "synchronizer/channel-receive-message"; envelope: ReturnEnvelope }

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
      /** If set, export delta since this version. Otherwise, export snapshot. */
      sinceVersion?: string
      reciprocate?: boolean
      /** Whether to force snapshot (ignoring sinceVersion). Used by LWW. */
      forceSnapshot?: boolean
    }

  // Document operations
  | { type: "cmd/subscribe-doc"; docId: DocId }
  | {
      type: "cmd/import-doc-data"
      docId: DocId
      payload: SubstratePayload
      /** Whether this is a full snapshot or an incremental delta. */
      offerType: "snapshot" | "delta"
      version: string
      fromPeerId: PeerId
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
  permissions: Permissions
}

/**
 * Creates the main synchronizer update function.
 *
 * The returned function is the pure TEA update: (msg, model) → [model, cmd?].
 * It uses mutative internally for ergonomic immutable updates.
 */
export function createSynchronizerUpdate({
  permissions,
}: CreateSynchronizerUpdateParams): SynchronizerUpdate {
  return function update(
    msg: SynchronizerMessage,
    model: SynchronizerModel,
  ): [SynchronizerModel, Command?] {
    // We create a shallow clone for top-level mutations.
    // For deep mutations (maps), we clone the map.
    // This is simpler than pulling in mutative for the initial scaffold.
    switch (msg.type) {
      case "synchronizer/channel-added":
        return handleChannelAdded(msg, model)

      case "synchronizer/establish-channel":
        return handleEstablishChannel(msg, model)

      case "synchronizer/channel-removed":
        return handleChannelRemoved(msg, model)

      case "synchronizer/doc-ensure":
        return handleDocEnsure(msg, model)

      case "synchronizer/local-doc-change":
        return handleLocalDocChange(msg, model, permissions)

      case "synchronizer/doc-delete":
        return handleDocDelete(msg, model)

      case "synchronizer/doc-imported":
        return handleDocImported(msg, model)

      case "synchronizer/channel-receive-message":
        return handleChannelReceiveMessage(msg, model, permissions)
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

  return [{ ...model, channels, peers }]
}

// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
// HANDLER: Document lifecycle
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

function handleDocEnsure(
  msg: {
    type: "synchronizer/doc-ensure"
    docId: DocId
    version: string
    mergeStrategy: MergeStrategy
  },
  model: SynchronizerModel,
): [SynchronizerModel, Command?] {
  if (model.documents.has(msg.docId)) {
    return [model]
  }

  const documents = new Map(model.documents)
  documents.set(msg.docId, {
    docId: msg.docId,
    version: msg.version,
    mergeStrategy: msg.mergeStrategy,
  })

  // Announce new doc to all established channels
  const commands: Command[] = []

  const establishedChannelIds = getEstablishedChannelIds(model)
  if (establishedChannelIds.length > 0) {
    commands.push({
      type: "cmd/send-message",
      envelope: {
        toChannelIds: establishedChannelIds,
        message: {
          type: "discover",
          docIds: [msg.docId],
        },
      },
    })
  }

  // Also send interest to storage channels
  const storageChannelIds = getChannelIdsByKind(model, "storage")
  if (storageChannelIds.length > 0) {
    commands.push({
      type: "cmd/send-message",
      envelope: {
        toChannelIds: storageChannelIds,
        message: {
          type: "interest",
          docId: msg.docId,
          version: msg.version,
          reciprocate: true,
        },
      },
    })
  }

  const cmd: Command | undefined =
    commands.length === 0
      ? undefined
      : commands.length === 1
        ? commands[0]
        : { type: "cmd/batch", commands }

  return [{ ...model, documents }, cmd]
}

function handleLocalDocChange(
  msg: { type: "synchronizer/local-doc-change"; docId: DocId; version: string },
  model: SynchronizerModel,
  permissions: Permissions,
): [SynchronizerModel, Command?] {
  const docEntry = model.documents.get(msg.docId)
  if (!docEntry) return [model]

  // Update version
  const documents = new Map(model.documents)
  documents.set(msg.docId, { ...docEntry, version: msg.version })

  // Push to synced peers based on merge strategy
  const cmd = buildLocalChangePush(
    msg.docId,
    docEntry,
    msg.version,
    model,
    permissions,
  )

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

function handleDocImported(
  msg: {
    type: "synchronizer/doc-imported"
    docId: DocId
    version: string
    fromPeerId: PeerId
  },
  model: SynchronizerModel,
): [SynchronizerModel, Command?] {
  const docEntry = model.documents.get(msg.docId)
  if (!docEntry) return [model]

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

  return [{ ...model, documents, peers }]
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
  permissions: Permissions,
): [SynchronizerModel, Command?] {
  const { fromChannelId, message } = msg.envelope

  switch (message.type) {
    case "establish-request":
      return handleEstablishRequest(fromChannelId, message, model)

    case "establish-response":
      return handleEstablishResponse(fromChannelId, message, model)

    case "discover":
      return handleDiscover(fromChannelId, message, model, permissions)

    case "interest":
      return handleInterest(fromChannelId, message, model, permissions)

    case "offer":
      return handleOffer(fromChannelId, message, model, permissions)
  }
}

// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
// HANDLER: Establishment
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

function handleEstablishRequest(
  fromChannelId: ChannelId,
  message: { type: "establish-request"; identity: PeerIdentityDetails },
  model: SynchronizerModel,
): [SynchronizerModel, Command?] {
  const channel = model.channels.get(fromChannelId)
  if (!channel) return [model]

  // Upgrade channel to established
  const channels = new Map(model.channels)
  const established = {
    ...channel,
    type: "established" as const,
    peerId: message.identity.peerId,
  }
  channels.set(fromChannelId, established)

  // Track peer state
  const peers = new Map(model.peers)
  const existingPeer = peers.get(message.identity.peerId)
  const peerChannels = new Set(existingPeer?.channels ?? [])
  peerChannels.add(fromChannelId)
  peers.set(message.identity.peerId, {
    identity: message.identity,
    docSyncStates: existingPeer?.docSyncStates ?? new Map(),
    subscriptions: existingPeer?.subscriptions ?? new Set(),
    channels: peerChannels,
  })

  // Send establish-response + discover our docs
  const commands: Command[] = [
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
  ]

  // Send discover with all our doc IDs
  const docIds = Array.from(model.documents.keys())
  if (docIds.length > 0) {
    commands.push({
      type: "cmd/send-message",
      envelope: {
        toChannelIds: [fromChannelId],
        message: {
          type: "discover",
          docIds,
        },
      },
    })
  }

  return [
    { ...model, channels, peers },
    { type: "cmd/batch", commands },
  ]
}

function handleEstablishResponse(
  fromChannelId: ChannelId,
  message: { type: "establish-response"; identity: PeerIdentityDetails },
  model: SynchronizerModel,
): [SynchronizerModel, Command?] {
  const channel = model.channels.get(fromChannelId)
  if (!channel) return [model]

  // Upgrade channel to established
  const channels = new Map(model.channels)
  const established = {
    ...channel,
    type: "established" as const,
    peerId: message.identity.peerId,
  }
  channels.set(fromChannelId, established)

  // Track peer state
  const peers = new Map(model.peers)
  const existingPeer = peers.get(message.identity.peerId)
  const peerChannels = new Set(existingPeer?.channels ?? [])
  peerChannels.add(fromChannelId)
  peers.set(message.identity.peerId, {
    identity: message.identity,
    docSyncStates: existingPeer?.docSyncStates ?? new Map(),
    subscriptions: existingPeer?.subscriptions ?? new Set(),
    channels: peerChannels,
  })

  // Send discover with all our doc IDs
  const docIds = Array.from(model.documents.keys())
  const cmd: Command | undefined =
    docIds.length > 0
      ? {
          type: "cmd/send-message",
          envelope: {
            toChannelIds: [fromChannelId],
            message: {
              type: "discover",
              docIds,
            },
          },
        }
      : undefined

  return [{ ...model, channels, peers }, cmd]
}

// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
// HANDLER: Discover
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

function handleDiscover(
  fromChannelId: ChannelId,
  message: { type: "discover"; docIds: DocId[] },
  model: SynchronizerModel,
  _permissions: Permissions,
): [SynchronizerModel, Command?] {
  const channel = model.channels.get(fromChannelId)
  if (!channel || channel.type !== "established") return [model]

  // For each doc that the remote peer has that we also have,
  // send an interest to initiate sync
  const commands: Command[] = []

  for (const docId of message.docIds) {
    const docEntry = model.documents.get(docId)
    if (docEntry) {
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
    }
  }

  // For docs we DON'T have, we could create them (future: auto-subscribe)
  // For now, we only sync docs that both sides already have.

  const cmd: Command | undefined =
    commands.length === 0
      ? undefined
      : commands.length === 1
        ? commands[0]
        : { type: "cmd/batch", commands }

  return [model, cmd]
}

// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
// HANDLER: Interest — merge-strategy dispatch
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
  _permissions: Permissions,
): [SynchronizerModel, Command?] {
  const channel = model.channels.get(fromChannelId)
  if (!channel || channel.type !== "established") return [model]

  const docEntry = model.documents.get(message.docId)
  if (!docEntry) {
    // We don't have this doc — nothing to offer
    return [model]
  }

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
        forceSnapshot: false,
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
        forceSnapshot: false,
      })
      break

    case "lww":
      // LWW: always respond with snapshot (no delta computation)
      commands.push({
        type: "cmd/send-offer",
        docId: message.docId,
        toChannelIds: [fromChannelId],
        // No sinceVersion — always snapshot for LWW
        reciprocate: false,
        forceSnapshot: true,
      })
      break
  }

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

  const cmd: Command | undefined =
    commands.length === 0
      ? undefined
      : commands.length === 1
        ? commands[0]
        : { type: "cmd/batch", commands }

  return [{ ...model, peers }, cmd]
}

// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
// HANDLER: Offer — version compare at receiver, import if accepted
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

function handleOffer(
  fromChannelId: ChannelId,
  message: {
    type: "offer"
    docId: DocId
    offerType: "snapshot" | "delta"
    payload: SubstratePayload
    version: string
    reciprocate?: boolean
  },
  model: SynchronizerModel,
  _permissions: Permissions,
): [SynchronizerModel, Command?] {
  const channel = model.channels.get(fromChannelId)
  if (!channel || channel.type !== "established") return [model]

  const docEntry = model.documents.get(message.docId)
  if (!docEntry) {
    // We don't have this doc — ignore the offer
    // (Future: auto-create if the doc was discovered)
    return [model]
  }

  const commands: Command[] = []

  // Import the payload — the runtime will handle version comparison
  // and call substrate.importDelta() or factory.fromSnapshot() depending
  // on the offerType. For LWW, the runtime compares timestamps. For
  // causal, the CRDT handles merge. For sequential, the runtime checks ordering.
  commands.push({
    type: "cmd/import-doc-data",
    docId: message.docId,
    payload: message.payload,
    offerType: message.offerType,
    version: message.version,
    fromPeerId: channel.peerId,
  })

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

  const cmd: Command | undefined =
    commands.length === 0
      ? undefined
      : commands.length === 1
        ? commands[0]
        : { type: "cmd/batch", commands }

  return [model, cmd]
}

// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
// Local change push — merge-strategy dispatch
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

function buildLocalChangePush(
  docId: DocId,
  docEntry: DocEntry,
  newVersion: string,
  model: SynchronizerModel,
  _permissions: Permissions,
): Command | undefined {
  switch (docEntry.mergeStrategy) {
    case "causal":
    case "sequential": {
      // Push delta offer to peers that have synced this doc
      const channelIds = getSyncedPeerChannels(model, docId)
      if (channelIds.length === 0) return undefined

      return {
        type: "cmd/send-offer",
        docId,
        toChannelIds: channelIds,
        sinceVersion: docEntry.version, // delta since previous version
        forceSnapshot: false,
      }
    }

    case "lww": {
      // Broadcast snapshot to ALL established peers
      const channelIds = getEstablishedChannelIds(model)
      if (channelIds.length === 0) return undefined

      return {
        type: "cmd/send-offer",
        docId,
        toChannelIds: channelIds,
        // No sinceVersion — always snapshot for LWW
        forceSnapshot: true,
      }
    }
  }
}

// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
// Helpers
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

function getEstablishedChannelIds(model: SynchronizerModel): ChannelId[] {
  const ids: ChannelId[] = []
  for (const [id, channel] of model.channels) {
    if (channel.type === "established") {
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
): ChannelId[] {
  const ids: ChannelId[] = []
  for (const [_peerId, peerState] of model.peers) {
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

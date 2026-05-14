// session-program — TEA state machine for peer lifecycle management.
//
// The session program manages channel topology, establish handshake,
// peer identity, and the connection/disconnection/departure lifecycle.
//
// Key invariant: the session program never sees documents or sync state.
// It emits `sync-event` effects that the shell forwards to the sync
// program. Neither program calls the other — the shell orchestrates.
//
// Peer presence model:
//   - In map with channels.size > 0  →  connected
//   - In map with channels.size === 0  →  disconnected (preserved)
//   - Absent from map  →  departed (deleted)

import type { Program } from "@kyneta/machine"
import type {
  ChannelId,
  LifecycleMsg,
  PeerId,
  PeerIdentityDetails,
  TransportType,
  WireFeatures,
} from "@kyneta/transport"
import type { SyncInput } from "./sync-program.js"
import type { PeerChange } from "./types.js"

// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
// STATE
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

/** Per-channel state — pure data, no Channel objects. */
export type ChannelEntry = {
  channelId: ChannelId
  localEstablishSent: boolean
  remoteIdentity?: PeerIdentityDetails
  transportType: TransportType
  /**
   * Wire features advertised by the remote peer in `establish`.
   * `undefined` until the remote `establish` arrives (or if the peer
   * advertises no features).
   */
  peerFeatures?: WireFeatures
}

/** Per-peer state. */
export type SessionPeer = {
  identity: PeerIdentityDetails
  channels: Set<ChannelId>
  departing: boolean // true if we received a `depart` from this peer
}

export type SessionModel = {
  identity: PeerIdentityDetails
  /** Wire features this peer advertises in its outbound `establish`. */
  selfFeatures: WireFeatures
  channels: Map<ChannelId, ChannelEntry>
  peers: Map<PeerId, SessionPeer>
  departureTimeout: number // ms, 0 = immediate departure
  /**
   * Accumulated peer lifecycle events awaiting drain at quiescence.
   * Populated by handlers, drained by `sess/tick-quiescent` into an
   * `emit-peer-events` effect. Replaces the shell's old
   * `#pendingPeerEvents` accumulator.
   */
  pendingPeerEvents: readonly PeerChange[]
}

// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
// INPUTS (messages into the update function)
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

/** Inputs that drive the session state machine. All prefixed `sess/`. */
export type SessionInput =
  | {
      type: "sess/channel-added"
      channelId: ChannelId
      transportType: TransportType
    }
  | { type: "sess/channel-establish"; channelId: ChannelId }
  | { type: "sess/channel-removed"; channelId: ChannelId }
  | {
      type: "sess/message-received"
      fromChannelId: ChannelId
      message: LifecycleMsg
    }
  | { type: "sess/departure-timer-expired"; peerId: PeerId }
  | { type: "sess/tick-quiescent" }
  | { type: "sess/synthetic-depart-all" }

// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
// EFFECTS
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

export type SessionEffect =
  | { type: "send"; to: ChannelId; message: LifecycleMsg }
  | { type: "reject-channel"; channelId: ChannelId }
  | { type: "start-departure-timer"; peerId: PeerId; delayMs: number }
  | { type: "cancel-departure-timer"; peerId: PeerId }
  | { type: "sync-event"; event: SyncInput }
  | { type: "emit-peer-events"; events: readonly PeerChange[] }
  | { type: "warning"; message: string }

// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
// UPDATE SIGNATURE
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

export type SessionUpdate = (
  input: SessionInput,
  model: SessionModel,
) => [SessionModel, ...SessionEffect[]]

export type SessionProgram = Program<SessionInput, SessionModel, SessionEffect>

// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
// INIT
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

export function initSession(
  identity: PeerIdentityDetails,
  departureTimeout: number = 30_000,
  selfFeatures: WireFeatures = { alias: true },
): SessionModel {
  return {
    identity,
    selfFeatures,
    channels: new Map(),
    peers: new Map(),
    departureTimeout,
    pendingPeerEvents: [],
  }
}

// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
// PEER TRANSITION — structural pairing of sync-event + peer-change
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

type PeerTransitionKind =
  | "established"
  | "disconnected"
  | "reconnected"
  | "departed"

/**
 * Build the sync-event effect and PeerChange that always co-occur
 * when a peer transitions.
 *
 * Every peer lifecycle change produces exactly one sync-event (for the
 * sync program) and one peer-change appended to `pendingPeerEvents`.
 * This combinator encodes that structural invariant — callers cannot
 * accidentally omit one half of the pair.
 */
function peerTransition(
  kind: PeerTransitionKind,
  peer: PeerIdentityDetails,
): { syncEffect: SessionEffect; change: PeerChange } {
  const peerId = peer.peerId

  const syncEvent: SyncInput =
    kind === "established" || kind === "reconnected"
      ? { type: "sync/peer-available", peerId, identity: peer }
      : kind === "disconnected"
        ? { type: "sync/peer-unavailable", peerId }
        : { type: "sync/peer-departed", peerId }

  return {
    syncEffect: { type: "sync-event", event: syncEvent },
    change: { type: `peer-${kind}`, peer },
  }
}

// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
// PEER IDENTITY WARNING
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

function detectPeerIdentityWarning(
  model: SessionModel,
  fromChannelId: ChannelId,
  remotePeerId: PeerId,
): SessionEffect | undefined {
  if (remotePeerId === model.identity.peerId) {
    return {
      type: "warning",
      message: `[exchange] self-connection detected — remote peer "${remotePeerId}" has the same peerId as this exchange. This will cause sync failures. Ensure server and client have different peerIds.`,
    }
  }
  const existingPeer = model.peers.get(remotePeerId)
  if (existingPeer) {
    const otherChannels = new Set(existingPeer.channels)
    otherChannels.delete(fromChannelId)
    if (otherChannels.size > 0) {
      return {
        type: "warning",
        message: `[exchange] duplicate peerId "${remotePeerId}" — peer already has ${otherChannels.size} active channel(s). Two participants sharing the same peerId will corrupt CRDT state. Ensure each browser tab / client has a unique peerId.`,
      }
    }
  }
  return undefined
}

// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
// COMPLETE ESTABLISH — shared helper
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

/**
 * Called when a channel becomes fully established (both sides have
 * exchanged `establish` messages). Determines the peer lifecycle
 * transition and emits appropriate effects.
 */
function completeEstablish(
  channelId: ChannelId,
  channelEntry: ChannelEntry,
  model: SessionModel,
): [SessionModel, ...SessionEffect[]] {
  const remoteIdentity = channelEntry.remoteIdentity
  if (!remoteIdentity) return [model]
  const remotePeerId = remoteIdentity.peerId

  const existingPeer = model.peers.get(remotePeerId)
  const peers = new Map(model.peers)

  const effects: SessionEffect[] = []
  let nextModel: SessionModel = model

  if (!existingPeer) {
    // New peer — first time we've seen this peerId
    const newPeer: SessionPeer = {
      identity: remoteIdentity,
      channels: new Set([channelId]),
      departing: false,
    }
    peers.set(remotePeerId, newPeer)

    const { syncEffect, change } = peerTransition("established", remoteIdentity)
    nextModel = {
      ...model,
      peers,
      pendingPeerEvents: [...model.pendingPeerEvents, change],
    }
    effects.push(syncEffect)
  } else if (existingPeer.channels.size === 0) {
    // Reconnecting peer — was disconnected, now has a channel again
    const channels = new Set(existingPeer.channels)
    channels.add(channelId)
    peers.set(remotePeerId, {
      ...existingPeer,
      identity: remoteIdentity,
      channels,
      departing: false, // clear departing flag on reconnect
    })

    const { syncEffect, change } = peerTransition("reconnected", remoteIdentity)
    nextModel = {
      ...model,
      peers,
      pendingPeerEvents: [...model.pendingPeerEvents, change],
    }
    effects.push(
      { type: "cancel-departure-timer", peerId: remotePeerId },
      syncEffect,
    )
  } else {
    // Additional channel for an already-connected peer — no lifecycle change
    const channels = new Set(existingPeer.channels)
    channels.add(channelId)
    peers.set(remotePeerId, {
      ...existingPeer,
      channels,
    })
    nextModel = { ...model, peers }
  }

  const warning = detectPeerIdentityWarning(model, channelId, remotePeerId)
  if (warning) effects.push(warning)

  return [nextModel, ...effects]
}

// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
// HANDLERS
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

function handleChannelAdded(
  input: {
    type: "sess/channel-added"
    channelId: ChannelId
    transportType: TransportType
  },
  model: SessionModel,
): [SessionModel, ...SessionEffect[]] {
  const channels = new Map(model.channels)
  channels.set(input.channelId, {
    channelId: input.channelId,
    localEstablishSent: false,
    remoteIdentity: undefined,
    transportType: input.transportType,
  })
  return [{ ...model, channels }]
}

function handleChannelEstablish(
  input: { type: "sess/channel-establish"; channelId: ChannelId },
  model: SessionModel,
): [SessionModel, ...SessionEffect[]] {
  const entry = model.channels.get(input.channelId)
  if (!entry || entry.localEstablishSent) return [model]

  const updatedEntry: ChannelEntry = { ...entry, localEstablishSent: true }
  const channels = new Map(model.channels)
  channels.set(input.channelId, updatedEntry)
  const updatedModel: SessionModel = { ...model, channels }

  const sendEffect: SessionEffect = {
    type: "send",
    to: input.channelId,
    message: {
      type: "establish",
      identity: model.identity,
      features: model.selfFeatures,
    },
  }

  // Check if channel is now fully established
  if (updatedEntry.localEstablishSent && updatedEntry.remoteIdentity) {
    const [finalModel, ...establishEffects] = completeEstablish(
      input.channelId,
      updatedEntry,
      updatedModel,
    )
    return [finalModel, sendEffect, ...establishEffects]
  }

  return [updatedModel, sendEffect]
}

function handleEstablishReceived(
  fromChannelId: ChannelId,
  message: {
    type: "establish"
    identity: PeerIdentityDetails
    features?: WireFeatures
  },
  model: SessionModel,
  canConnect?: (peer: PeerIdentityDetails) => boolean,
): [SessionModel, ...SessionEffect[]] {
  const entry = model.channels.get(fromChannelId)
  if (!entry) return [model]

  // Gate: reject connection if canConnect returns false.
  // Check BEFORE echoing establish — do not leak our identity to rejected peers.
  if (canConnect && !canConnect(message.identity)) {
    return [model, { type: "reject-channel", channelId: fromChannelId }]
  }

  // Guard: if channel is already fully established, return unchanged
  // (prevents infinite ping-pong)
  if (entry.localEstablishSent && entry.remoteIdentity) return [model]

  // Set remoteIdentity, peerFeatures, and mark localEstablishSent = true
  // (echoing establish back counts as our local send)
  const updatedEntry: ChannelEntry = {
    ...entry,
    remoteIdentity: message.identity,
    peerFeatures: message.features,
    localEstablishSent: true,
  }
  const channels = new Map(model.channels)
  channels.set(fromChannelId, updatedEntry)
  const updatedModel: SessionModel = { ...model, channels }

  // Echo establish back to remote
  const echoEffect: SessionEffect = {
    type: "send",
    to: fromChannelId,
    message: {
      type: "establish",
      identity: model.identity,
      features: model.selfFeatures,
    },
  }

  // Channel is now fully established (both flags set)
  if (updatedEntry.localEstablishSent && updatedEntry.remoteIdentity) {
    const [finalModel, ...establishEffects] = completeEstablish(
      fromChannelId,
      updatedEntry,
      updatedModel,
    )
    return [finalModel, echoEffect, ...establishEffects]
  }

  // This branch is unreachable given the assignments above, but
  // included for clarity — if somehow only one flag is set, we wait.
  return [updatedModel, echoEffect]
}

function handleDepartReceived(
  fromChannelId: ChannelId,
  model: SessionModel,
): [SessionModel, ...SessionEffect[]] {
  const entry = model.channels.get(fromChannelId)
  if (!entry) return [model]

  const remoteIdentity = entry.remoteIdentity
  if (!remoteIdentity) return [model]

  const remotePeerId = remoteIdentity.peerId
  const existingPeer = model.peers.get(remotePeerId)
  if (!existingPeer) return [model]

  const peers = new Map(model.peers)

  // If peer currently has 0 channels (already disconnected), delete immediately
  if (existingPeer.channels.size === 0) {
    peers.delete(remotePeerId)
    const { syncEffect, change } = peerTransition("departed", remoteIdentity)
    return [
      {
        ...model,
        peers,
        pendingPeerEvents: [...model.pendingPeerEvents, change],
      },
      syncEffect,
    ]
  }

  // Otherwise just mark the peer as departing — cleanup on channel-removed
  peers.set(remotePeerId, { ...existingPeer, departing: true })
  return [{ ...model, peers }]
}

function handleChannelRemoved(
  input: { type: "sess/channel-removed"; channelId: ChannelId },
  model: SessionModel,
): [SessionModel, ...SessionEffect[]] {
  const entry = model.channels.get(input.channelId)
  if (!entry) return [model]

  const channels = new Map(model.channels)
  channels.delete(input.channelId)

  // If channel was not established, just remove it
  if (!entry.remoteIdentity) {
    return [{ ...model, channels }]
  }

  const remotePeerId = entry.remoteIdentity.peerId
  const existingPeer = model.peers.get(remotePeerId)
  if (!existingPeer) {
    return [{ ...model, channels }]
  }

  const peerChannels = new Set(existingPeer.channels)
  peerChannels.delete(input.channelId)
  const peers = new Map(model.peers)

  if (peerChannels.size === 0) {
    // Last channel for this peer is gone
    if (existingPeer.departing || model.departureTimeout === 0) {
      // Peer sent depart, or immediate departure mode — remove now
      peers.delete(remotePeerId)
      const { syncEffect, change } = peerTransition(
        "departed",
        existingPeer.identity,
      )
      return [
        {
          ...model,
          channels,
          peers,
          pendingPeerEvents: [...model.pendingPeerEvents, change],
        },
        syncEffect,
      ]
    }

    // Grace period — keep peer in model with empty channels
    peers.set(remotePeerId, { ...existingPeer, channels: peerChannels })
    const { syncEffect, change } = peerTransition(
      "disconnected",
      existingPeer.identity,
    )
    return [
      {
        ...model,
        channels,
        peers,
        pendingPeerEvents: [...model.pendingPeerEvents, change],
      },
      syncEffect,
      {
        type: "start-departure-timer",
        peerId: remotePeerId,
        delayMs: model.departureTimeout,
      },
    ]
  }

  // Peer still has other channels — just update the set
  peers.set(remotePeerId, { ...existingPeer, channels: peerChannels })
  return [{ ...model, channels, peers }]
}

function handleDepartureTimerExpired(
  input: { type: "sess/departure-timer-expired"; peerId: PeerId },
  model: SessionModel,
): [SessionModel, ...SessionEffect[]] {
  const existingPeer = model.peers.get(input.peerId)
  if (!existingPeer) return [model]

  // Peer reconnected — timer is stale
  if (existingPeer.channels.size > 0) return [model]

  // Delete the peer
  const peers = new Map(model.peers)
  peers.delete(input.peerId)
  const { syncEffect, change } = peerTransition(
    "departed",
    existingPeer.identity,
  )
  return [
    {
      ...model,
      peers,
      pendingPeerEvents: [...model.pendingPeerEvents, change],
    },
    syncEffect,
  ]
}

function handleTickQuiescent(
  model: SessionModel,
): [SessionModel, ...SessionEffect[]] {
  if (model.pendingPeerEvents.length === 0) return [model]
  const effect: SessionEffect = {
    type: "emit-peer-events",
    events: model.pendingPeerEvents,
  }
  return [{ ...model, pendingPeerEvents: [] }, effect]
}

function handleSyntheticDepartAll(
  model: SessionModel,
): [SessionModel, ...SessionEffect[]] {
  if (model.peers.size === 0) {
    return [model]
  }
  // Synthesize peer-departed events for every peer in the model and
  // append them to pendingPeerEvents. The tick handler (fired by the
  // outer coordinator after this input) drains them into an emit-effect.
  const synthetic: PeerChange[] = []
  for (const peer of model.peers.values()) {
    synthetic.push({ type: "peer-departed", peer: peer.identity })
  }
  return [
    {
      ...model,
      peers: new Map(),
      pendingPeerEvents: [...model.pendingPeerEvents, ...synthetic],
    },
  ]
}

// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
// MESSAGE DEMUX
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

function handleMessageReceived(
  input: {
    type: "sess/message-received"
    fromChannelId: ChannelId
    message: LifecycleMsg
  },
  model: SessionModel,
  canConnect?: (peer: PeerIdentityDetails) => boolean,
): [SessionModel, ...SessionEffect[]] {
  switch (input.message.type) {
    case "establish":
      return handleEstablishReceived(
        input.fromChannelId,
        input.message,
        model,
        canConnect,
      )
    case "depart":
      return handleDepartReceived(input.fromChannelId, model)
  }
}

// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
// FACTORY
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

type CreateSessionUpdateParams = {
  canConnect?: (peer: PeerIdentityDetails) => boolean
}

export function createSessionUpdate(
  params: CreateSessionUpdateParams = {},
): SessionUpdate {
  const { canConnect } = params

  return function update(
    input: SessionInput,
    model: SessionModel,
  ): [SessionModel, ...SessionEffect[]] {
    switch (input.type) {
      case "sess/channel-added":
        return handleChannelAdded(input, model)
      case "sess/channel-establish":
        return handleChannelEstablish(input, model)
      case "sess/channel-removed":
        return handleChannelRemoved(input, model)
      case "sess/message-received":
        return handleMessageReceived(input, model, canConnect)
      case "sess/departure-timer-expired":
        return handleDepartureTimerExpired(input, model)
      case "sess/tick-quiescent":
        return handleTickQuiescent(model)
      case "sess/synthetic-depart-all":
        return handleSyntheticDepartAll(model)
    }
  }
}

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

import type {
  ChannelId,
  LifecycleMsg,
  PeerId,
  PeerIdentityDetails,
  TransportType,
  WireFeatures,
} from "@kyneta/transport"
import { collapse, type Transition } from "./program-types.js"
import type { SyncInput } from "./sync-program.js"

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

// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
// EFFECTS
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

export type SessionEffect =
  | { type: "send"; to: ChannelId; message: LifecycleMsg }
  | { type: "reject-channel"; channelId: ChannelId }
  | { type: "start-departure-timer"; peerId: PeerId; delayMs: number }
  | { type: "cancel-departure-timer"; peerId: PeerId }
  | { type: "sync-event"; event: SyncInput }
  | { type: "batch"; effects: SessionEffect[] }

// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
// NOTIFICATIONS
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

export type SessionNotification =
  | { type: "notify/peer-established"; peer: PeerIdentityDetails }
  | { type: "notify/peer-disconnected"; peer: PeerIdentityDetails }
  | { type: "notify/peer-reconnected"; peer: PeerIdentityDetails }
  | { type: "notify/peer-departed"; peer: PeerIdentityDetails }
  | { type: "notify/warning"; message: string }
  | { type: "notify/batch"; notifications: SessionNotification[] }

// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
// UPDATE SIGNATURE
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

export type SessionTransition = Transition<
  SessionModel,
  SessionEffect,
  SessionNotification
>

export type SessionUpdate = (
  input: SessionInput,
  model: SessionModel,
) => SessionTransition

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
  }
}

// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
// BATCH HELPERS
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

const batchEffects = (...fx: (SessionEffect | undefined)[]) =>
  collapse<SessionEffect>(fx, effects => ({ type: "batch", effects }))

const batchNotifications = (...ns: (SessionNotification | undefined)[]) =>
  collapse<SessionNotification>(ns, notifications => ({
    type: "notify/batch",
    notifications,
  }))

// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
// PEER TRANSITION — structural pairing of sync-event + notification
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

type PeerTransitionKind =
  | "established"
  | "disconnected"
  | "reconnected"
  | "departed"

/**
 * Build the sync-event effect and notification that always co-occur
 * when a peer transitions.
 *
 * Every peer lifecycle change in the session program produces exactly
 * one sync-event (for the sync program) and one notification (for
 * external subscribers). This combinator encodes that structural
 * invariant — callers cannot accidentally omit one half of the pair.
 */
function peerTransition(
  kind: PeerTransitionKind,
  peer: PeerIdentityDetails,
): { effect: SessionEffect; notification: SessionNotification } {
  const peerId = peer.peerId

  const syncEvent: SyncInput =
    kind === "established" || kind === "reconnected"
      ? { type: "sync/peer-available", peerId, identity: peer }
      : kind === "disconnected"
        ? { type: "sync/peer-unavailable", peerId }
        : { type: "sync/peer-departed", peerId }

  return {
    effect: { type: "sync-event", event: syncEvent },
    notification: { type: `notify/peer-${kind}`, peer },
  }
}

// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
// PEER IDENTITY WARNING
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

function detectPeerIdentityWarning(
  model: SessionModel,
  fromChannelId: ChannelId,
  remotePeerId: PeerId,
): SessionNotification | undefined {
  if (remotePeerId === model.identity.peerId) {
    return {
      type: "notify/warning",
      message: `[exchange] self-connection detected — remote peer "${remotePeerId}" has the same peerId as this exchange. This will cause sync failures. Ensure server and client have different peerIds.`,
    }
  }
  const existingPeer = model.peers.get(remotePeerId)
  if (existingPeer) {
    const otherChannels = new Set(existingPeer.channels)
    otherChannels.delete(fromChannelId)
    if (otherChannels.size > 0) {
      return {
        type: "notify/warning",
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
 * transition and emits appropriate effects/notifications.
 */
function completeEstablish(
  channelId: ChannelId,
  channelEntry: ChannelEntry,
  model: SessionModel,
): SessionTransition {
  const remoteIdentity = channelEntry.remoteIdentity
  if (!remoteIdentity) return [model]
  const remotePeerId = remoteIdentity.peerId

  const existingPeer = model.peers.get(remotePeerId)
  const peers = new Map(model.peers)

  let effect: SessionEffect | undefined
  let notification: SessionNotification | undefined

  if (!existingPeer) {
    // New peer — first time we've seen this peerId
    const newPeer: SessionPeer = {
      identity: remoteIdentity,
      channels: new Set([channelId]),
      departing: false,
    }
    peers.set(remotePeerId, newPeer)

    const transition = peerTransition("established", remoteIdentity)
    effect = transition.effect
    notification = transition.notification
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

    const transition = peerTransition("reconnected", remoteIdentity)
    effect = batchEffects(
      { type: "cancel-departure-timer", peerId: remotePeerId },
      transition.effect,
    )
    notification = transition.notification
  } else {
    // Additional channel for an already-connected peer — no lifecycle change
    const channels = new Set(existingPeer.channels)
    channels.add(channelId)
    peers.set(remotePeerId, {
      ...existingPeer,
      channels,
    })
  }

  const warning = detectPeerIdentityWarning(model, channelId, remotePeerId)
  const finalNotification = batchNotifications(notification, warning)

  return [{ ...model, peers }, effect, finalNotification]
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
): SessionTransition {
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
): SessionTransition {
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
    const [finalModel, establishEffect, notification] = completeEstablish(
      input.channelId,
      updatedEntry,
      updatedModel,
    )
    return [finalModel, batchEffects(sendEffect, establishEffect), notification]
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
): SessionTransition {
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
    const [finalModel, establishEffect, notification] = completeEstablish(
      fromChannelId,
      updatedEntry,
      updatedModel,
    )
    return [finalModel, batchEffects(echoEffect, establishEffect), notification]
  }

  // This branch is unreachable given the assignments above, but
  // included for clarity — if somehow only one flag is set, we wait.
  return [updatedModel, echoEffect]
}

function handleDepartReceived(
  fromChannelId: ChannelId,
  model: SessionModel,
): SessionTransition {
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
    const { effect, notification } = peerTransition("departed", remoteIdentity)
    return [{ ...model, peers }, effect, notification]
  }

  // Otherwise just mark the peer as departing — cleanup on channel-removed
  peers.set(remotePeerId, { ...existingPeer, departing: true })
  return [{ ...model, peers }]
}

function handleChannelRemoved(
  input: { type: "sess/channel-removed"; channelId: ChannelId },
  model: SessionModel,
): SessionTransition {
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
      const { effect, notification } = peerTransition(
        "departed",
        existingPeer.identity,
      )
      return [{ ...model, channels, peers }, effect, notification]
    }

    // Grace period — keep peer in model with empty channels
    peers.set(remotePeerId, { ...existingPeer, channels: peerChannels })
    const { effect, notification } = peerTransition(
      "disconnected",
      existingPeer.identity,
    )
    return [
      { ...model, channels, peers },
      batchEffects(effect, {
        type: "start-departure-timer",
        peerId: remotePeerId,
        delayMs: model.departureTimeout,
      }),
      notification,
    ]
  }

  // Peer still has other channels — just update the set
  peers.set(remotePeerId, { ...existingPeer, channels: peerChannels })
  return [{ ...model, channels, peers }]
}

function handleDepartureTimerExpired(
  input: { type: "sess/departure-timer-expired"; peerId: PeerId },
  model: SessionModel,
): SessionTransition {
  const existingPeer = model.peers.get(input.peerId)
  if (!existingPeer) return [model]

  // Peer reconnected — timer is stale
  if (existingPeer.channels.size > 0) return [model]

  // Delete the peer
  const peers = new Map(model.peers)
  peers.delete(input.peerId)
  const { effect, notification } = peerTransition(
    "departed",
    existingPeer.identity,
  )
  return [{ ...model, peers }, effect, notification]
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
): SessionTransition {
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
  ): SessionTransition {
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
    }
  }
}

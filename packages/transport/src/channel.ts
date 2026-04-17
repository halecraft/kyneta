// channel — channel types and lifecycle for @kyneta/exchange.
//
// Ports the channel abstraction from @loro-extended/repo with
// Loro-specific types replaced by the substrate-agnostic message
// vocabulary (present, interest, offer, dismiss).
//
// Channel lifecycle: GeneratedChannel → ConnectedChannel → EstablishedChannel
//
// GeneratedChannel: created by an adapter's generate() method.
// ConnectedChannel: registered with the synchronizer, has a channelId.
// EstablishedChannel: completed the establish handshake, knows the remote peer.

import type { ChannelMsg, LifecycleMsg, SyncMsg } from "./messages.js"
import type { ChannelId, PeerId, TransportType } from "./types.js"

export type { ChannelId } from "./types.js"

// ---------------------------------------------------------------------------
// Channel metadata
// ---------------------------------------------------------------------------

export type ChannelMeta = {
  transportType: TransportType
}

export type ChannelActions = {
  /**
   * Send a message through this channel.
   *
   * The type safety of which messages can be sent depends on the
   * channel state (connected vs established). The adapter base class
   * handles this narrowing.
   */
  send: (msg: ChannelMsg) => void
  stop: () => void
}

// ---------------------------------------------------------------------------
// Channel lifecycle types
// ---------------------------------------------------------------------------

/**
 * A `GeneratedChannel` is created by an adapter's generate() method.
 * It has metadata and actions but no connection to the synchronizer yet.
 */
export type GeneratedChannel = ChannelMeta & ChannelActions

/**
 * A `ConnectedChannel` is registered with the synchronizer and can
 * send/receive messages. It has a channelId and an onReceive handler.
 *
 * Only lifecycle messages can be sent before the channel is established.
 */
export type ConnectedChannel = GeneratedChannel & {
  type: "connected"
  channelId: ChannelId

  /**
   * Receive handler for incoming messages.
   * Set by the Synchronizer when the channel is added.
   */
  onReceive: (msg: ChannelMsg) => void

  /**
   * Type-safe send for lifecycle messages.
   */
  send: (msg: LifecycleMsg) => void
}

/**
 * An `EstablishedChannel` has completed the establish handshake and
 * knows which peer it's connected to.
 *
 * Only sync messages (present, interest, offer, dismiss) can be sent
 * after establishment.
 */
export type EstablishedChannel = GeneratedChannel & {
  type: "established"
  channelId: ChannelId
  peerId: PeerId

  /**
   * Receive handler for incoming messages.
   */
  onReceive: (msg: ChannelMsg) => void

  /**
   * Type-safe send for sync messages.
   */
  send: (msg: SyncMsg) => void
}

/**
 * A Channel is either connected (pre-handshake) or established (post-handshake).
 */
export type Channel = ConnectedChannel | EstablishedChannel

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

/**
 * Type guard to check if a Channel has been established with a peer.
 */
export function isEstablished(channel: Channel): channel is EstablishedChannel {
  return channel.type === "established"
}

// ---------------------------------------------------------------------------
// Channel generation
// ---------------------------------------------------------------------------

export type ReceiveFn = (msg: ChannelMsg) => void

export type GenerateFn<G> = (context: G) => GeneratedChannel

// @kyneta/transport — transport infrastructure for @kyneta/exchange.
//
// Base class, channel types, message vocabulary, identity types,
// reconnection utilities, and bridge transport.

// ---------------------------------------------------------------------------
// Identity types
// ---------------------------------------------------------------------------

export type {
  ChannelId,
  DocId,
  PeerId,
  PeerIdentityDetails,
  TransportType,
} from "./types.js"

// ---------------------------------------------------------------------------
// Message types — the protocol vocabulary
// ---------------------------------------------------------------------------

export type {
  AddressedEnvelope,
  ChannelMsg,
  DismissMsg,
  EstablishmentMsg,
  EstablishRequestMsg,
  EstablishResponseMsg,
  ExchangeMsg,
  InterestMsg,
  OfferMsg,
  PresentMsg,
  ReturnEnvelope,
} from "./messages.js"
export { isEstablishmentMsg, isExchangeMsg } from "./messages.js"

// ---------------------------------------------------------------------------
// Channel types and lifecycle
// ---------------------------------------------------------------------------

export type {
  Channel,
  ChannelActions,
  ChannelMeta,
  ConnectedChannel,
  EstablishedChannel,
  GeneratedChannel,
  GenerateFn,
  ReceiveFn,
} from "./channel.js"
export { isEstablished } from "./channel.js"

// ---------------------------------------------------------------------------
// Channel directory
// ---------------------------------------------------------------------------

export { ChannelDirectory } from "./channel-directory.js"

// ---------------------------------------------------------------------------
// Transport base class
// ---------------------------------------------------------------------------

export type {
  AnyTransport,
  TransportContext,
  TransportFactory,
} from "./transport.js"
export { Transport } from "./transport.js"

// ---------------------------------------------------------------------------
// State machine types — re-exported from @kyneta/machine
// ---------------------------------------------------------------------------

export type { StateTransition, TransitionListener } from "@kyneta/machine"

// ---------------------------------------------------------------------------
// Reconnection utilities
// ---------------------------------------------------------------------------

export {
  computeBackoffDelay,
  DEFAULT_RECONNECT,
  type ReconnectOptions,
} from "./reconnect.js"

// ---------------------------------------------------------------------------
// Bridge transport — in-process testing
// ---------------------------------------------------------------------------

export type { BridgeTransportParams } from "./bridge.js"
export { Bridge, BridgeTransport, createBridgeTransport } from "./bridge.js"

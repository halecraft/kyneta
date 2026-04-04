// @kyneta/exchange — substrate-agnostic state exchange.
//
// Provides sync infrastructure for any @kyneta/schema substrate.
// Three merge strategies (causal, sequential, lww) are dispatched
// by factory declaration over a uniform four-message protocol
// (present, interest, offer, dismiss).

// ---------------------------------------------------------------------------
// Core types — sync-specific (defined here)
// ---------------------------------------------------------------------------

export type {
  PeerChange,
  PeerDocSyncState,
  PeerState,
  ReadyState,
} from "./types.js"

// ---------------------------------------------------------------------------
// Core types — transport identity (re-exported from @kyneta/transport)
// ---------------------------------------------------------------------------

export type {
  ChannelId,
  DocId,
  PeerId,
  PeerIdentityDetails,
  TransportType,
} from "@kyneta/transport"

// ---------------------------------------------------------------------------
// Bind — re-exported from @kyneta/schema for convenience
// ---------------------------------------------------------------------------

export type { BoundSchema, FactoryBuilder, MergeStrategy } from "@kyneta/schema"
export { bind, bindEphemeral, bindPlain, isBoundSchema } from "@kyneta/schema"

// ---------------------------------------------------------------------------
// Unwrap — re-exported from @kyneta/schema for convenience
// ---------------------------------------------------------------------------

export { registerSubstrate, unwrap } from "@kyneta/schema"

// ---------------------------------------------------------------------------
// TimestampVersion — LWW version implementation (re-exported from @kyneta/schema)
// ---------------------------------------------------------------------------

export { TimestampVersion } from "@kyneta/schema"

// ---------------------------------------------------------------------------
// Messages — re-exported from @kyneta/transport
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
} from "@kyneta/transport"
export { isEstablishmentMsg, isExchangeMsg } from "@kyneta/transport"

// ---------------------------------------------------------------------------
// Channel — re-exported from @kyneta/transport
// ---------------------------------------------------------------------------

export type {
  Channel,
  ChannelActions,
  ChannelMeta,
  ConnectedChannel,
  EstablishedChannel,
  GeneratedChannel,
} from "@kyneta/transport"
export { ChannelDirectory, isEstablished } from "@kyneta/transport"

// ---------------------------------------------------------------------------
// Transport — base class (re-exported from @kyneta/transport) and manager
// ---------------------------------------------------------------------------

export type {
  AnyTransport,
  TransportContext,
  TransportFactory,
} from "@kyneta/transport"
export {
  computeBackoffDelay,
  DEFAULT_RECONNECT,
  type ReconnectOptions,
  type StateTransition,
  type TransitionListener,
  Transport,
} from "@kyneta/transport"
export { TransportManager } from "./transport/transport-manager.js"

// ---------------------------------------------------------------------------
// Bridge — re-exported from @kyneta/transport
// ---------------------------------------------------------------------------

export type { BridgeTransportParams } from "@kyneta/transport"
export {
  Bridge,
  BridgeTransport,
  createBridgeTransport,
} from "@kyneta/transport"

// ---------------------------------------------------------------------------
// Synchronizer — TEA state machine
// ---------------------------------------------------------------------------

export type {
  Command,
  Notification,
  SynchronizerMessage,
  SynchronizerModel,
} from "./synchronizer-program.js"
export { createSynchronizerUpdate, init } from "./synchronizer-program.js"

// ---------------------------------------------------------------------------
// Synchronizer runtime
// ---------------------------------------------------------------------------

export { Synchronizer } from "./synchronizer.js"

// ---------------------------------------------------------------------------
// Exchange — the public API
// ---------------------------------------------------------------------------

export type {
  AuthorizePredicate,
  ExchangeParams,
  OnDocDiscovered,
  OnDocDismissed,
  RoutePredicate,
} from "./exchange.js"
export { Exchange } from "./exchange.js"

// ---------------------------------------------------------------------------
// Sync — sync capabilities access
// ---------------------------------------------------------------------------

export type { SyncRef, WaitForSyncOptions } from "./sync.js"
export { hasSync, sync } from "./sync.js"

// ---------------------------------------------------------------------------
// Storage — persistent storage adapters
// ---------------------------------------------------------------------------

export type { Store, StoreEntry } from "./store/index.js"
export {
  createInMemoryStore,
  InMemoryStore,
  type InMemoryStoreData,
} from "./store/index.js"

// ---------------------------------------------------------------------------
// Peer identity — browser-only persistent peerId generation
// ---------------------------------------------------------------------------

export { persistentPeerId } from "./persistent-peer-id.js"

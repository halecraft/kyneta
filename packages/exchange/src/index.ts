// @kyneta/exchange — substrate-agnostic state exchange.
//
// Provides sync infrastructure for any @kyneta/schema substrate.
// Three merge strategies (causal, sequential, lww) are dispatched
// by factory declaration over a uniform four-message protocol
// (present, interest, offer, dismiss).

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

export type {
  ChannelId,
  DocId,
  PeerChange,
  PeerDocSyncState,
  PeerId,
  PeerIdentityDetails,
  PeerState,
  ReadyState,
  TransportType,
} from "./types.js"

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
// Messages — the three-message sync vocabulary
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
// Channel — channel types and lifecycle
// ---------------------------------------------------------------------------

export type {
  Channel,
  ChannelActions,
  ChannelMeta,
  ConnectedChannel,
  EstablishedChannel,
  GeneratedChannel,
} from "./channel.js"
export { isEstablished } from "./channel.js"

// ---------------------------------------------------------------------------
// Transport — base class and transport manager
// ---------------------------------------------------------------------------

export {
  ClientStateMachine,
  type ClientStateMachineConfig,
  type StateTransition,
  type TransitionListener,
} from "./transport/client-state-machine.js"
export type {
  AnyTransport,
  TransportContext,
  TransportFactory,
} from "./transport/transport.js"
export { Transport } from "./transport/transport.js"
export { TransportManager } from "./transport/transport-manager.js"

// ---------------------------------------------------------------------------
// Bridge — in-process testing adapter
// ---------------------------------------------------------------------------

export type { BridgeTransportParams } from "./transport/bridge-transport.js"
export {
  Bridge,
  BridgeTransport,
  createBridgeTransport,
} from "./transport/bridge-transport.js"

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

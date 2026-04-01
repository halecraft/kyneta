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
  AdapterType,
  ChannelId,
  DocId,
  PeerDocSyncState,
  PeerId,
  PeerIdentityDetails,
  PeerState,
  ReadyState,
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
  PresentMsg,
  DismissMsg,
  EstablishmentMsg,
  EstablishRequestMsg,
  EstablishResponseMsg,
  ExchangeMsg,
  InterestMsg,
  OfferMsg,
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
// Adapter — base class and adapter manager
// ---------------------------------------------------------------------------

export type {
  AdapterContext,
  AdapterFactory,
  AnyAdapter,
} from "./adapter/adapter.js"
export { Adapter } from "./adapter/adapter.js"
export { AdapterManager } from "./adapter/adapter-manager.js"
export {
  ClientStateMachine,
  type ClientStateMachineConfig,
  type StateTransition,
  type TransitionListener,
} from "./adapter/client-state-machine.js"

// ---------------------------------------------------------------------------
// Bridge — in-process testing adapter
// ---------------------------------------------------------------------------

export type { BridgeAdapterParams } from "./adapter/bridge-adapter.js"
export {
  Bridge,
  BridgeAdapter,
  createBridgeAdapter,
} from "./adapter/bridge-adapter.js"

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

export type { StorageBackend, StorageEntry } from "./storage/index.js"
export {
  InMemoryStorageBackend,
  type InMemoryStorageData,
  createInMemoryStorage,
} from "./storage/index.js"

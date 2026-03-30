// @kyneta/exchange — substrate-agnostic state exchange.
//
// Provides sync infrastructure for any @kyneta/schema substrate.
// Three merge strategies (causal, sequential, lww) are dispatched
// by factory declaration over a uniform three-message protocol
// (discover, interest, offer).

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
  PendingInterest,
  ReadyState,
} from "./types.js"

// ---------------------------------------------------------------------------
// Bind — re-exported from @kyneta/schema for convenience
// ---------------------------------------------------------------------------

export type { BoundSchema, FactoryBuilder, MergeStrategy } from "@kyneta/schema"
export { bind, bindLww, bindPlain, isBoundSchema } from "@kyneta/schema"

// ---------------------------------------------------------------------------
// Unwrap — re-exported from @kyneta/schema for convenience
// ---------------------------------------------------------------------------

export { registerSubstrate, unwrap } from "@kyneta/schema"

// ---------------------------------------------------------------------------
// TimestampVersion — LWW version implementation
// ---------------------------------------------------------------------------

export { TimestampVersion } from "./timestamp-version.js"

// ---------------------------------------------------------------------------
// Messages — the three-message sync vocabulary
// ---------------------------------------------------------------------------

export type {
  AddressedEnvelope,
  ChannelMsg,
  DismissMsg,
  DiscoverMsg,
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
  ChannelKind,
  ChannelMeta,
  ConnectedChannel,
  EstablishedChannel,
  GeneratedChannel,
} from "./channel.js"
export { isEstablished } from "./channel.js"

// ---------------------------------------------------------------------------
// Adapter — base class and adapter manager
// ---------------------------------------------------------------------------

export { Adapter } from "./adapter/adapter.js"
export type { AdapterContext, AnyAdapter } from "./adapter/adapter.js"
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

export { Bridge, BridgeAdapter } from "./adapter/bridge-adapter.js"

// ---------------------------------------------------------------------------
// Synchronizer — TEA state machine
// ---------------------------------------------------------------------------

export type {
  Command,
  SynchronizerMessage,
  SynchronizerModel,
} from "./synchronizer-program.js"
export { init, createSynchronizerUpdate } from "./synchronizer-program.js"

// ---------------------------------------------------------------------------
// Synchronizer runtime
// ---------------------------------------------------------------------------

export { Synchronizer } from "./synchronizer.js"

// ---------------------------------------------------------------------------
// Exchange — the public API
// ---------------------------------------------------------------------------

export { Exchange } from "./exchange.js"
export type {
  AuthorizePredicate,
  ExchangeParams,
  OnDocDiscovered,
  OnDocDismissed,
  RoutePredicate,
} from "./exchange.js"

// ---------------------------------------------------------------------------
// Sync — sync capabilities access
// ---------------------------------------------------------------------------

export { sync, hasSync } from "./sync.js"
export type { SyncRef, WaitForSyncOptions } from "./sync.js"
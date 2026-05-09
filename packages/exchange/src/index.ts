// @kyneta/exchange — substrate-agnostic state exchange.
//
// Provides sync infrastructure for any @kyneta/schema substrate.
// Three sync protocols (authoritative, collaborative, ephemeral) are
// dispatched by factory declaration over a uniform four-message protocol
// (present, interest, offer, dismiss).

// ---------------------------------------------------------------------------
// Core types — sync-specific (defined here)
// ---------------------------------------------------------------------------

export type {
  DocChange,
  DocInfo,
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
// Schema binding — re-exported from @kyneta/schema for convenience
// ---------------------------------------------------------------------------

export type { BoundSchema, FactoryBuilder, SyncProtocol } from "@kyneta/schema"
export {
  bind,
  isBoundSchema,
  json,
  requiresBidirectionalSync,
  SYNC_AUTHORITATIVE,
  SYNC_COLLABORATIVE,
  SYNC_EPHEMERAL,
} from "@kyneta/schema"

// ---------------------------------------------------------------------------
// Unwrap — re-exported from @kyneta/schema for convenience
// ---------------------------------------------------------------------------

export type { HasNativeAny } from "@kyneta/schema"
export { unwrap } from "@kyneta/schema"

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
  DepartMsg,
  DismissMsg,
  EstablishMsg,
  InterestMsg,
  LifecycleMsg,
  OfferMsg,
  PresentMsg,
  ReturnEnvelope,
  SyncMsg,
} from "@kyneta/transport"
export { isLifecycleMsg, isSyncMsg } from "@kyneta/transport"

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
// Bridge — re-exported from @kyneta/bridge-transport
// ---------------------------------------------------------------------------

export type { BridgeTransportParams } from "@kyneta/bridge-transport"
export {
  Bridge,
  BridgeTransport,
  createBridgeTransport,
} from "@kyneta/bridge-transport"

// ---------------------------------------------------------------------------
// Session program — peer lifecycle TEA state machine
// ---------------------------------------------------------------------------

export type {
  ChannelEntry,
  SessionEffect,
  SessionInput,
  SessionModel,
  SessionNotification,
  SessionPeer,
  SessionUpdate,
} from "./session-program.js"
export { createSessionUpdate, initSession } from "./session-program.js"

// ---------------------------------------------------------------------------
// Sync program — document convergence TEA state machine
// ---------------------------------------------------------------------------

export type {
  DocEntry,
  SyncEffect,
  SyncInput,
  SyncModel,
  SyncNotification,
  SyncPeerState,
  SyncUpdate,
} from "./sync-program.js"
export { createSyncUpdate, initSync } from "./sync-program.js"

// ---------------------------------------------------------------------------
// Synchronizer runtime
// ---------------------------------------------------------------------------

export { Synchronizer } from "./synchronizer.js"

// ---------------------------------------------------------------------------
// Doc Governance — composable policy registration
// ---------------------------------------------------------------------------

export type {
  EpochBoundaryPredicate,
  GatePredicate,
  Policy,
} from "./governance.js"
export { composeGate, Governance } from "./governance.js"

// ---------------------------------------------------------------------------
// Exchange — the public API
// ---------------------------------------------------------------------------

export type {
  Disposition,
  ExchangeParams,
  PeerIdentityInput,
} from "./exchange.js"
export { Exchange } from "./exchange.js"

// ---------------------------------------------------------------------------
// Capabilities — registry of supported replica types and schema bindings
// ---------------------------------------------------------------------------

export type { Capabilities } from "./capabilities.js"
export { createCapabilities, DEFAULT_REPLICAS } from "./capabilities.js"

// ---------------------------------------------------------------------------
// Sync — sync capabilities access
// ---------------------------------------------------------------------------

export type { SyncRef, WaitForSyncOptions } from "./sync.js"
export { hasSync, sync } from "./sync.js"

// ---------------------------------------------------------------------------
// Storage — persistent storage adapters
// ---------------------------------------------------------------------------

export type { Store, StoreMeta, StoreRecord } from "./store/index.js"
export {
  createInMemoryStore,
  InMemoryStore,
  type InMemoryStoreData,
  resolveMetaFromBatch,
  SeqNoTracker,
  validateAppend,
} from "./store/index.js"

// ---------------------------------------------------------------------------
// Peer identity — browser-only persistent peerId generation
// ---------------------------------------------------------------------------

export type { LeaseDecision, LeaseState } from "./persistent-peer-id.js"
export {
  persistentPeerId,
  releasePeerId,
  resolveLease,
} from "./persistent-peer-id.js"

// ---------------------------------------------------------------------------
// Line — reliable bidirectional message stream between two peers
// ---------------------------------------------------------------------------

export type { LineListener, LineProtocol } from "./line.js"
export {
  createLineDocSchema,
  isLineDocId,
  Line,
  lineDocId,
  parseLineDocId,
  routeLine,
} from "./line.js"

// ---------------------------------------------------------------------------
// AsyncQueue — push/pull bridge for async iteration
// ---------------------------------------------------------------------------

export { AsyncQueue } from "./async-queue.js"

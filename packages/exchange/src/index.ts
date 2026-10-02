// @kyneta/exchange — substrate-agnostic state exchange.
//
// Provides sync infrastructure for any @kyneta/schema substrate.
// How a document syncs is declared by its factory's `SyncMode`, over one
// six-message sync protocol (present, interest, offer, accept, dismiss,
// vacant).

// ---------------------------------------------------------------------------
// Core types — sync-specific (defined here)
// ---------------------------------------------------------------------------

// DevTools observation protocol (experimental — `ObsEvent` v:1 may change).
export {
  createObservationBus,
  OBS_PROTOCOL_VERSION,
  type ObsEvent,
  type ObsEventBody,
  type ObservationBus,
  type ObsLayer,
  type ObsOp,
  type ObsSink,
  observeInput,
  observePeerSyncState,
  observeSessionEffect,
  observeSyncEffect,
  summarizeChangeset,
} from "./observe.js"
export type {
  Connectivity,
  DocChange,
  DocInfo,
  PeerChange,
  PeerDocSyncState,
  PeerState,
  PeerSyncState,
} from "./types.js"

// ---------------------------------------------------------------------------
// Core types — transport identity (re-exported from @kyneta/transport)
// ---------------------------------------------------------------------------

export type {
  ChannelId,
  DocId,
  PeerId,
  PeerIdentityDetails,
  PeerType,
  ProtocolVersion,
  TransportType,
} from "@kyneta/transport"
export {
  BASELINE_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
} from "@kyneta/transport"

// ---------------------------------------------------------------------------
// Schema binding — re-exported from @kyneta/schema for convenience
// ---------------------------------------------------------------------------

export type { BoundSchema, FactoryBuilder, SyncMode } from "@kyneta/schema"
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
// Messages — re-exported from @kyneta/transport
// ---------------------------------------------------------------------------

export type {
  AcceptMsg,
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
  WireFeatures,
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
} from "@kyneta/transport"
export {
  computeBackoffDelay,
  DEFAULT_RECONNECT,
  type ReconnectOptions,
  randomPeerId,
  type StateTransition,
  type TransitionListener,
  Transport,
} from "@kyneta/transport"
export { TransportManager } from "./transport/transport-manager.js"

// ---------------------------------------------------------------------------
// Session program — peer lifecycle TEA state machine
// ---------------------------------------------------------------------------

export type {
  ChannelEntry,
  SessionEffect,
  SessionInput,
  SessionModel,
  SessionPeer,
  SessionProgram,
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
  SyncPeerState,
  SyncProgram,
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
  Authority,
  GatePredicate,
  LineageBoundaryPredicate,
  Policy,
} from "./governance.js"
export { composeGate, Governance, NotAWriterError } from "./governance.js"

// ---------------------------------------------------------------------------
// Runtime — the local imperative shell (documents + stores + clock)
// ---------------------------------------------------------------------------

export type {
  DocReadyInfo,
  RuntimeHooks,
  RuntimeParams,
} from "./runtime.js"
export { Runtime } from "./runtime.js"

// ---------------------------------------------------------------------------
// Exchange — the network shell (transports + peers + sync graph)
// ---------------------------------------------------------------------------

export type {
  Disposition,
  ExchangeNetworkParams,
  ExchangeParams,
  PeerNaming,
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

export type { SyncRef } from "./sync.js"
export { sync, whenSettled } from "./sync.js"

// ---------------------------------------------------------------------------
// Settle terms — "have all of this document's truth sources reported?"
// ---------------------------------------------------------------------------

export type { DocStatus } from "./doc-status.js"
export {
  deriveDocStatus,
  docStatus,
  docStatusFeed,
} from "./doc-status.js"
export type { InitAction } from "./initialize.js"
export { initialize, planInitialization } from "./initialize.js"
export {
  persisted,
  persistedFeed,
  persistenceError,
  type WriteRefusalFeed,
  whenPersisted,
  writeRefusal,
  writeRefusalFeed,
} from "./persistence.js"
export {
  hydrated,
  hydratedFeed,
  hydrationError,
  settled,
  settledFeed,
  settledWith,
  whenHydrated,
} from "./settle.js"

// ---------------------------------------------------------------------------
// Storage — persistent storage adapters
// ---------------------------------------------------------------------------

export type {
  Store,
  StoreMark,
  StoreMeta,
  StoreRecord,
} from "./store/index.js"
export {
  allocateSeat,
  assertSeatHeld,
  createInMemoryStore,
  createInMemoryStoreData,
  decideStoreFormat,
  freshPeerIds,
  InMemoryStore,
  type InMemoryStoreData,
  type KeyOrder,
  type OwnedSeat,
  type OwnedSeating,
  type PooledSeat,
  type PooledSeating,
  parseSeatPool,
  parseStoreFormat,
  planStoreOpen,
  planWriter,
  prefixSuccessor,
  recordsOf,
  resolveMetaFromBatch,
  type Seat,
  type Seating,
  SeatLostError,
  type SeatPool,
  type SessionSeat,
  type SessionSeating,
  STORE_META_FORMAT_KEY,
  STORE_META_SEATS_KEY,
  type StoreFormatDecision,
  type StoreFormatRefusal,
  type StoreFormatVersion,
  StoreFormatVersionError,
  type StoreOpenInput,
  type StoreOpenPlan,
  sessionSeat,
  validateAppend,
  type WriteOptions,
  WriterRefusedError,
} from "./store/index.js"

// ---------------------------------------------------------------------------
// Peers — find a peer's seat by what it says it is
// ---------------------------------------------------------------------------

export { whenPeer } from "./when-peer.js"

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

// ---------------------------------------------------------------------------
// Undo — a stack of gestures across documents, kept in a document
// ---------------------------------------------------------------------------

export type {
  Direction,
  Note,
  Part,
  Step,
} from "./undo/schema.js"
export { UndoDoc, UndoSchema } from "./undo/schema.js"
export type {
  UndoOptions,
  UndoStack,
  UndoStackParams,
} from "./undo/stack.js"
export { createUndoStack } from "./undo/stack.js"

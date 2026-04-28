// synchronizer — runtime that wires the TEA state machines to adapters and substrates.
//
// The Synchronizer is the imperative shell around two pure TEA update functions:
// - Session program: manages channel topology, establish handshake, peer
//   identity, and the connection/disconnection/departure lifecycle.
// - Sync program: manages document convergence — present, interest, offer,
//   dismiss — and per-peer document sync states.
//
// Neither program calls the other. The shell orchestrates by forwarding
// `sync-event` effects from the session program into the sync program.
//
// It manages:
// - Dispatching inputs to both update functions
// - Executing effects (side effects) produced by the update functions
// - Adapter lifecycle and message routing
// - Substrate interactions (export, import) on behalf of the pure models

import type { ReactiveMap, ReactiveMapHandle } from "@kyneta/changefeed"
import { createReactiveMap } from "@kyneta/changefeed"
import type {
  DocMetadata,
  Replica,
  ReplicaFactory,
  ReplicaType,
  Substrate,
  SubstratePayload,
  SyncProtocol,
  Version,
} from "@kyneta/schema"
import type {
  AddressedEnvelope,
  AnyTransport,
  Channel,
  ChannelId,
  ChannelMsg,
  ConnectedChannel,
  DocId,
  PeerId,
  PeerIdentityDetails,
  SyncMsg,
} from "@kyneta/transport"
import { isLifecycleMsg } from "@kyneta/transport"

import {
  createSessionUpdate,
  initSession,
  type SessionEffect,
  type SessionInput,
  type SessionModel,
  type SessionNotification,
  type SessionUpdate,
} from "./session-program.js"
import {
  createSyncUpdate,
  type DocEntry,
  initSync,
  type SyncEffect,
  type SyncInput,
  type SyncModel,
  type SyncNotification,
  type SyncUpdate,
} from "./sync-program.js"
import { TransportManager } from "./transport/transport-manager.js"
import type { DocChange, DocInfo, PeerChange, ReadyState } from "./types.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Fields shared by both document modes — the uniform surface that
 * `#executeSendOfferToPeer`, `#executeImportDocData`, `registerDoc`, and
 * `notifyLocalChange` operate on without mode branching.
 */
type DocRuntimeBase = {
  docId: DocId
  replica: Replica<any>
  replicaFactory: ReplicaFactory<any>
  syncProtocol: SyncProtocol
  schemaHash: string
}

/**
 * Runtime state for a document — discriminated by participation mode.
 *
 * The only difference between modes is the narrowed `replica` type:
 * `Substrate` (interpret) vs `Replica` (replicate). The mode discriminant
 * exists solely to narrow the type, not to carry extra baggage.
 */
export type DocRuntime =
  | (DocRuntimeBase & {
      mode: "interpret"
      replica: Substrate<any> // narrows Replica to Substrate
    })
  | (DocRuntimeBase & {
      mode: "replicate"
    })

/**
 * Callback invoked by `ensure-doc` — ensures a document exists locally.
 *
 * Fired during effect execution when a peer announces an unknown doc.
 * The Exchange auto-resolves schemas or delegates to `resolve`.
 *
 * **Must be idempotent.** Batched ensure effects may fire for a doc that
 * a sibling effect's cascade has already created. Implementations must
 * check for existing state and return early (first writer wins).
 */
export type DocCreationCallback = (
  docId: DocId,
  peer: PeerIdentityDetails,
  replicaType: ReplicaType,
  syncProtocol: SyncProtocol,
  schemaHash: string,
  supportedHashes?: readonly string[],
) => void

/**
 * Callback invoked by `ensure-doc-dismissed` — ensures a dismissed
 * doc is handled locally.
 *
 * The Exchange handles cleanup via dismiss().
 *
 * **Must be idempotent.** First writer wins.
 */
export type DocDismissedCallback = (
  docId: DocId,
  peer: PeerIdentityDetails,
  origin: "local" | "remote",
) => void

/**
 * Epoch boundary predicate — decides whether to accept a compaction-induced
 * entirety reset for a document that already has local state.
 *
 * Returns `true` to accept (reset local state), `false` to reject (diverge).
 */
export type EpochBoundaryPredicate = (
  docId: DocId,
  peer: PeerIdentityDetails,
  syncProtocol: SyncProtocol,
) => boolean

export type SynchronizerParams = {
  identity: PeerIdentityDetails
  transports?: AnyTransport[]
  canShare: (docId: DocId, peer: PeerIdentityDetails) => boolean
  canAccept: (docId: DocId, peer: PeerIdentityDetails) => boolean
  canConnect?: (peer: PeerIdentityDetails) => boolean
  canReset: EpochBoundaryPredicate
  onEnsureDoc?: DocCreationCallback
  onEnsureDocDismissed?: DocDismissedCallback
  departureTimeout?: number
}

// ---------------------------------------------------------------------------
// Version-gap planning helpers
// ---------------------------------------------------------------------------

type VersionGapResult =
  | { kind: "parse-error"; error: unknown }
  | { kind: "no-gap"; comparison: "behind" | "equal" }
  | {
      kind: "gap"
      comparison: "ahead" | "concurrent"
      parsed: Version
    }

/**
 * Shared version-gap classifier used by the semantic inbound/outbound helpers.
 *
 * This centralizes the common mechanics:
 * - parse the serialized version string
 * - read the replica's current version
 * - run the supplied comparison
 * - classify the result as parse-error, no-gap, or actionable gap
 *
 * The comparison direction remains the responsibility of the wrapper:
 * - inbound uses `parsed.compare(current)`
 * - outbound uses `current.compare(parsed)`
 */
function classifyVersionGap(
  replica: Replica<any>,
  replicaFactory: ReplicaFactory<any>,
  serializedVersion: string,
  compare: (
    parsed: Version,
    current: Version,
  ) => "behind" | "equal" | "ahead" | "concurrent",
): VersionGapResult {
  let parsed: Version
  try {
    parsed = replicaFactory.parseVersion(serializedVersion)
  } catch (error) {
    return { kind: "parse-error", error }
  }

  const currentVersion = replica.version()
  const comparison = compare(parsed, currentVersion)

  if (comparison === "behind" || comparison === "equal") {
    return { kind: "no-gap", comparison }
  }

  return { kind: "gap", comparison, parsed }
}

/**
 * Compare an incoming peer version against our current replica version.
 *
 * Semantics:
 * - parse incoming serialized version
 * - compare `incoming.compare(current)`
 * - `"behind"` / `"equal"` → no action needed
 * - `"ahead"` / `"concurrent"` → remote peer has data we may need to import
 */
function resolveInboundVersionGap(
  replica: Replica<any>,
  replicaFactory: ReplicaFactory<any>,
  serializedVersion: string,
): VersionGapResult {
  return classifyVersionGap(
    replica,
    replicaFactory,
    serializedVersion,
    (parsed, current) => parsed.compare(current),
  )
}

/**
 * Compare our current replica version against a peer's declared version.
 *
 * Semantics:
 * - parse peer serialized version
 * - compare `current.compare(peerKnown)`
 * - `"behind"` / `"equal"` → nothing useful to send
 * - `"ahead"` / `"concurrent"` → we have data the peer is missing
 */
function resolveOutboundVersionGap(
  replica: Replica<any>,
  replicaFactory: ReplicaFactory<any>,
  serializedVersion: string,
): VersionGapResult {
  return classifyVersionGap(
    replica,
    replicaFactory,
    serializedVersion,
    (parsed, current) => current.compare(parsed),
  )
}

// ---------------------------------------------------------------------------
// Synchronizer
// ---------------------------------------------------------------------------

export class Synchronizer {
  readonly identity: PeerIdentityDetails
  readonly transports: TransportManager

  readonly #sessionUpdate: SessionUpdate
  readonly #syncUpdate: SyncUpdate
  readonly #docRuntimes = new Map<DocId, DocRuntime>()
  readonly #docCreationCallback?: DocCreationCallback
  readonly #docDismissedCallback?: DocDismissedCallback

  /**
   * Dirty doc IDs accumulated during a dispatch cycle from
   * `notify/state-advanced` notifications. Drained at quiescence
   * to fire `onStateAdvanced` listeners — only docs whose state
   * actually advanced (local mutation or network import).
   *
   * Context: jj:smmulzkm (unified persistence via notify/state-advanced)
   */
  readonly #dirtyStateAdvanced: Set<DocId> = new Set()

  /**
   * Outbound message queue — accumulated during dispatch, flushed at quiescence.
   * This batches outbound messages to avoid interleaving with model updates.
   */
  readonly #outboundQueue: AddressedEnvelope[] = []

  /**
   * Dirty doc IDs accumulated during a dispatch cycle from Notification
   * co-products. Drained at quiescence to emit targeted ready-state
   * changes — only docs whose peer sync state actually changed.
   */
  readonly #dirtyDocIds: Set<DocId> = new Set()

  /**
   * Work queue for serialized async dispatch.
   * Ensures inputs are processed one at a time and outbound messages
   * are flushed at quiescence (after all pending dispatches complete).
   */
  #dispatching = false
  #pendingInputs: (SessionInput | SyncInput)[] = []

  #sessionModel: SessionModel
  #syncModel: SyncModel

  // Departure timers — shell-managed side effects from session program
  #departureTimers = new Map<PeerId, ReturnType<typeof setTimeout>>()

  // Peer lifecycle — event accumulation and changefeed
  #pendingPeerEvents: PeerChange[] = []
  #peerHandle: ReactiveMapHandle<
    PeerId,
    PeerIdentityDetails,
    PeerChange
  > | null = null

  // Document lifecycle — event accumulation and changefeed
  #pendingDocEvents: DocChange[] = []
  #docHandle: ReactiveMapHandle<DocId, DocInfo, DocChange> | null = null

  // Event emitter for ready state changes
  readonly #readyStateListeners = new Set<
    (docId: DocId, readyStates: ReadyState[]) => void
  >()

  /**
   * Listeners for state-advanced events. Fired at quiescence when
   * a document's state has advanced — either from a local mutation
   * or a network import. The Exchange subscribes to persist deltas.
   *
   * Context: jj:smmulzkm (unified persistence via notify/state-advanced)
   */
  readonly #stateAdvancedListeners = new Set<(docId: DocId) => void>()

  readonly #canReset: EpochBoundaryPredicate

  /**
   * Backward-compat getter — exposes `documents` and `peers` from the
   * sync model for test access via `synchronizer.model.documents`.
   */
  get model(): { documents: Map<DocId, DocEntry>; peers: Map<PeerId, any> } {
    return {
      documents: this.#syncModel.documents,
      peers: this.#syncModel.peers,
    }
  }

  constructor({
    identity,
    transports = [],
    canShare,
    canAccept,
    canConnect,
    canReset,
    onEnsureDoc,
    onEnsureDocDismissed,
    departureTimeout,
  }: SynchronizerParams) {
    this.identity = identity

    this.#sessionUpdate = createSessionUpdate({ canConnect })
    this.#syncUpdate = createSyncUpdate({ canShare, canAccept })
    this.#canReset = canReset
    this.#docCreationCallback = onEnsureDoc
    this.#docDismissedCallback = onEnsureDocDismissed

    // Initialize models
    this.#sessionModel = initSession(this.identity, departureTimeout ?? 30_000)
    this.#syncModel = initSync(this.identity)

    // Create adapter context
    const transportContext = {
      identity: this.identity,
      onChannelAdded: this.channelAdded.bind(this),
      onChannelRemoved: this.channelRemoved.bind(this),
      onChannelReceive: this.channelReceive.bind(this),
      onChannelEstablish: this.channelEstablish.bind(this),
    }

    // Create TransportManager
    this.transports = new TransportManager({
      transports,
      context: transportContext,
      onReset: (transport: AnyTransport) => {
        for (const channel of transport.channels) {
          this.channelRemoved(channel)
        }
      },
    })

    // Start all adapters
    this.transports.startAll()
  }

  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
  // PUBLIC API — Document management
  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

  /**
   * Register a document runtime with the synchronizer.
   *
   * Called by Exchange.get() or Exchange.replicate() after creating
   * the substrate/replica. The synchronizer tracks the runtime and
   * dispatches doc-ensure to begin sync.
   */
  registerDoc(runtime: DocRuntime): void {
    // Accumulate doc event — detect promotion (deferred → interpret/replicate)
    // vs first-time creation. Check model before dispatching sync/doc-ensure,
    // which will update the model.
    const existing = this.#syncModel.documents.get(runtime.docId)
    if (existing?.mode === "deferred") {
      this.#pendingDocEvents.push({
        type: "doc-promoted",
        docId: runtime.docId,
      })
    } else if (!this.#docRuntimes.has(runtime.docId)) {
      this.#pendingDocEvents.push({
        type: "doc-created",
        docId: runtime.docId,
      })
    }

    this.#docRuntimes.set(runtime.docId, runtime)

    this.#dispatchSync({
      type: "sync/doc-ensure",
      docId: runtime.docId,
      mode: runtime.mode,
      version: runtime.replica.version().serialize(),
      replicaType: runtime.replicaFactory.replicaType,
      syncProtocol: runtime.syncProtocol,
      schemaHash: runtime.schemaHash,
    })
  }

  /**
   * Register a deferred document — routing participation only, no replica.
   *
   * The document will be added to `model.documents` with `mode: "deferred"`.
   * It participates in routing (`present` messages) but does not send
   * `interest` or handle `offer`/`interest` messages.
   */
  deferDoc(
    docId: DocId,
    replicaType: ReplicaType,
    syncProtocol: SyncProtocol,
    schemaHash: string,
  ): void {
    // Only accumulate if the doc doesn't already exist in the model —
    // handleDocDefer no-ops when the doc is already tracked.
    if (!this.#syncModel.documents.has(docId)) {
      this.#pendingDocEvents.push({ type: "doc-deferred", docId })
    }

    this.#dispatchSync({
      type: "sync/doc-defer",
      docId,
      replicaType,
      syncProtocol,
      schemaHash,
    })
  }

  /**
   * Get the metadata for a document in the synchronizer model.
   *
   * Returns `undefined` if the doc is not in the model. Used by the
   * Exchange to retrieve discovery metadata for deferred docs during
   * promotion.
   */
  getDocMetadata(docId: DocId): DocMetadata | undefined {
    const entry = this.#syncModel.documents.get(docId)
    if (!entry) return undefined
    return {
      replicaType: entry.replicaType,
      syncProtocol: entry.syncProtocol,
      schemaHash: entry.schemaHash,
    }
  }

  /**
   * Notify the synchronizer of a local change to a document.
   *
   * Triggers push to synced peers based on sync protocol.
   *
   * **Normally called automatically** by the Exchange's changefeed
   * subscription — you do NOT need to call this after `change()`.
   *
   * Call this directly only when mutating the substrate outside of
   * `change()`, e.g. via `unwrap(ref)` which bypasses the changefeed.
   */
  notifyLocalChange(docId: DocId): void {
    const runtime = this.#docRuntimes.get(docId)
    if (!runtime) return

    this.#dispatchSync({
      type: "sync/local-doc-change",
      docId,
      version: runtime.replica.version().serialize(),
    })
  }

  /**
   * Get the runtime for a document.
   */
  getDocRuntime(docId: DocId): DocRuntime | undefined {
    return this.#docRuntimes.get(docId)
  }

  /**
   * Compute the least common version (LCV) for a document across all
   * synced peers. The LCV is the greatest version that is ≤ every
   * synced peer's last known version — the safe trim point.
   *
   * Returns `null` if no peers are synced for this doc (nothing to
   * trim against), or if the doc doesn't exist.
   *
   * The local version is excluded — the LCV represents "what all
   * remote participants have." Including the local version would
   * raise the LCV incorrectly when the local node has advanced
   * past what it's pushed to peers.
   */
  leastCommonVersion(
    docId: DocId,
    peerFilter?: (peer: PeerIdentityDetails, docId: DocId) => boolean,
  ): Version | null {
    const runtime = this.#docRuntimes.get(docId)
    if (!runtime) return null

    let lcv: Version | null = null

    for (const [, peerState] of this.#syncModel.peers) {
      const docSync = peerState.docSyncStates.get(docId)
      if (!docSync || docSync.status !== "synced") continue
      if (peerFilter && !peerFilter(peerState.identity, docId)) continue

      let peerVersion: Version
      try {
        peerVersion = runtime.replicaFactory.parseVersion(
          docSync.lastKnownVersion,
        )
      } catch {
        // Skip peers with unparseable versions (shouldn't happen in
        // normal operation, but defensive against corrupted state).
        continue
      }

      lcv = lcv === null ? peerVersion : lcv.meet(peerVersion)
    }

    return lcv
  }

  /**
   * Check if a document exists in the synchronizer.
   */
  hasDoc(docId: DocId): boolean {
    return this.#docRuntimes.has(docId)
  }

  /**
   * Remove a document from the synchronizer (internal, no peer notification).
   */
  async removeDocument(docId: DocId): Promise<void> {
    if (this.#docRuntimes.has(docId) || this.#syncModel.documents.has(docId)) {
      this.#pendingDocEvents.push({ type: "doc-removed", docId })
    }
    this.#docRuntimes.delete(docId)
    this.#dispatchSync({
      type: "sync/doc-delete",
      docId,
    })
  }

  /**
   * Dismiss a document — remove locally and broadcast `dismiss` to peers.
   */
  dismissDocument(docId: DocId): void {
    if (this.#docRuntimes.has(docId) || this.#syncModel.documents.has(docId)) {
      this.#pendingDocEvents.push({ type: "doc-removed", docId })
    }
    this.#docRuntimes.delete(docId)
    this.#dispatchSync({
      type: "sync/doc-dismiss",
      docId,
    })
  }

  /**
   * Suspend a document — leave the sync graph but keep the runtime.
   *
   * Dispatches `sync/doc-dismiss` (removes from model, broadcasts wire
   * dismiss) but does NOT delete from `#docRuntimes`. The runtime survives
   * so `resumeDocument()` can re-register with the current version.
   */
  suspendDocument(docId: DocId): void {
    if (this.#docRuntimes.has(docId) || this.#syncModel.documents.has(docId)) {
      this.#pendingDocEvents.push({ type: "doc-suspended", docId })
    }
    this.#dispatchSync({
      type: "sync/doc-dismiss",
      docId,
    })
  }

  /**
   * Resume a suspended document — re-enter the sync graph.
   *
   * Reads the surviving `DocRuntime` from `#docRuntimes` and re-dispatches
   * `sync/doc-ensure` with the current version. Peers receive `present` +
   * `interest` and delta-sync from the suspended version.
   */
  resumeDocument(docId: DocId): void {
    const runtime = this.#docRuntimes.get(docId)
    if (!runtime) {
      throw new Error(
        `Cannot resume document '${docId}': no runtime found. ` +
          `The document may have been destroyed.`,
      )
    }
    this.#pendingDocEvents.push({ type: "doc-resumed", docId })
    this.#dispatchSync({
      type: "sync/doc-ensure",
      docId: runtime.docId,
      mode: runtime.mode,
      version: runtime.replica.version().serialize(),
      replicaType: runtime.replicaFactory.replicaType,
      syncProtocol: runtime.syncProtocol,
      schemaHash: runtime.schemaHash,
    })
  }

  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
  // PUBLIC API — Ready state
  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

  /**
   * Get current ready states for a document.
   */
  getReadyStates(docId: DocId): ReadyState[] {
    const states: ReadyState[] = []

    for (const [_peerId, peerState] of this.#syncModel.peers) {
      const docSync = peerState.docSyncStates.get(docId)
      if (docSync) {
        states.push({
          docId,
          identity: peerState.identity,
          status:
            docSync.status === "synced"
              ? "synced"
              : docSync.status === "absent"
                ? "absent"
                : "pending",
        })
      }
    }

    return states
  }

  /**
   * Wait until a document is synced with at least one peer.
   */
  async waitUntilReady(docId: DocId, timeoutMs = 30000): Promise<void> {
    // Check if already ready
    if (this.#isReady(docId)) return

    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined

      const listener = (changedDocId: DocId) => {
        if (changedDocId === docId && this.#isReady(docId)) {
          cleanup()
          resolve()
        }
      }

      const cleanup = () => {
        this.#readyStateListeners.delete(listener)
        if (timer) clearTimeout(timer)
      }

      this.#readyStateListeners.add(listener)

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          cleanup()
          reject(
            new Error(
              `waitForSync timed out after ${timeoutMs}ms for doc '${docId}'`,
            ),
          )
        }, timeoutMs)
      }
    })
  }

  /**
   * Subscribe to state-advanced events.
   *
   * The callback fires once per docId at quiescence when the document's
   * state has advanced — either from a local mutation (changefeed →
   * notifyLocalChange → handleLocalDocChange) or a network import
   * (handleOffer → import-doc-data → handleDocImported).
   *
   * Returns an unsubscribe function.
   *
   * Context: jj:smmulzkm (unified persistence via notify/state-advanced)
   */
  onStateAdvanced(cb: (docId: DocId) => void): () => void {
    this.#stateAdvancedListeners.add(cb)
    return () => {
      this.#stateAdvancedListeners.delete(cb)
    }
  }

  onReadyStateChange(
    cb: (docId: DocId, readyStates: ReadyState[]) => void,
  ): () => void {
    this.#readyStateListeners.add(cb)
    return () => this.#readyStateListeners.delete(cb)
  }

  #isReady(docId: DocId): boolean {
    for (const [peerId, peerState] of this.#syncModel.peers) {
      const docSync = peerState.docSyncStates.get(docId)
      if (!docSync) continue

      if (docSync.status === "synced" || docSync.status === "absent") {
        // Check if peer is connected (has channels in session model)
        const sessionPeer = this.#sessionModel.peers.get(peerId)
        if (sessionPeer && sessionPeer.channels.size > 0) {
          return true
        }
      }
    }
    return false
  }

  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
  // PUBLIC API — Adapter management
  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

  async addTransport(adapter: AnyTransport): Promise<void> {
    await this.transports.addTransport(adapter)
  }

  async removeTransport(transportId: string): Promise<void> {
    await this.transports.removeTransport(transportId)
  }

  hasTransport(transportId: string): boolean {
    return this.transports.hasTransport(transportId)
  }

  getTransport(transportId: string): AnyTransport | undefined {
    return this.transports.getTransport(transportId)
  }

  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
  // PUBLIC API — Lifecycle
  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

  async flush(): Promise<void> {
    await this.transports.flush()
  }

  reset(): void {
    this.#emitSyntheticDocRemovedEvents()
    this.#emitSyntheticDepartedEvents()
    this.#clearDepartureTimers()
    this.#docRuntimes.clear()
    this.#sessionModel = initSession(
      this.identity,
      this.#sessionModel.departureTimeout,
    )
    this.#syncModel = initSync(this.identity)
    this.transports.reset()
  }

  async shutdown(): Promise<void> {
    // Send depart to all connected peers
    this.#sendDepartToAllPeers()
    this.#drainOutbound() // Flush depart messages to transports
    await this.transports.flush() // Wait for transports to deliver
    this.#emitSyntheticDocRemovedEvents()
    this.#emitSyntheticDepartedEvents()
    this.#clearDepartureTimers()
    this.#sessionModel = initSession(
      this.identity,
      this.#sessionModel.departureTimeout,
    )
    this.#syncModel = initSync(this.identity)
    await this.transports.shutdown()
  }

  createPeerFeed(): ReactiveMap<PeerId, PeerIdentityDetails, PeerChange> {
    const [feed, handle] = createReactiveMap<
      PeerId,
      PeerIdentityDetails,
      PeerChange
    >()
    this.#peerHandle = handle
    return feed
  }

  createDocFeed(): ReactiveMap<DocId, DocInfo, DocChange> {
    const [feed, handle] = createReactiveMap<DocId, DocInfo, DocChange>()
    this.#docHandle = handle
    return feed
  }

  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
  // CHANNEL CALLBACKS — called by TransportManager
  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

  channelAdded(channel: ConnectedChannel): void {
    this.#dispatchSession({
      type: "sess/channel-added",
      channelId: channel.channelId,
      transportType: channel.transportType,
    })
  }

  channelEstablish(channel: ConnectedChannel): void {
    this.#dispatchSession({
      type: "sess/channel-establish",
      channelId: channel.channelId,
    })
  }

  channelReceive(channelId: ChannelId, message: ChannelMsg): void {
    if (isLifecycleMsg(message)) {
      this.#dispatchSession({
        type: "sess/message-received",
        fromChannelId: channelId,
        message,
      })
    } else {
      // Sync message — resolve channel → peer
      const entry = this.#sessionModel.channels.get(channelId)
      if (!entry?.remoteIdentity) return // not established, drop
      this.#dispatchSync({
        type: "sync/message-received",
        from: entry.remoteIdentity.peerId,
        message,
      })
    }
  }

  channelRemoved(channel: Channel): void {
    this.#dispatchSession({
      type: "sess/channel-removed",
      channelId: channel.channelId,
    })
  }

  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
  // DISPATCH — serialized input processing with quiescence flush
  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

  #dispatchSession(input: SessionInput): void {
    this.#pendingInputs.push(input)
    this.#drainPending()
  }

  #dispatchSync(input: SyncInput): void {
    this.#pendingInputs.push(input)
    this.#drainPending()
  }

  #drainPending(): void {
    if (this.#dispatching) return

    this.#dispatching = true
    try {
      while (this.#pendingInputs.length > 0) {
        const input = this.#pendingInputs.shift()
        if (!input) break
        if (input.type.startsWith("sess/")) {
          this.#processSessionInput(input as SessionInput)
        } else {
          this.#processSyncInput(input as SyncInput)
        }
      }

      // Quiescence — drain all accumulators. Each drain snapshots its
      // buffer, clears the field, then pushes to listeners/transports.
      this.#drainOutbound()
      this.#drainReadyStateChanges()
      this.#drainStateAdvanced()
      this.#drainPeerEvents()
      this.#drainDocEvents()
    } finally {
      this.#dispatching = false
    }
  }

  #processSessionInput(input: SessionInput): void {
    const [newModel, effect, notification] = this.#sessionUpdate(
      input,
      this.#sessionModel,
    )
    this.#sessionModel = newModel
    if (notification) this.#accumulateSessionNotification(notification)
    if (effect) this.#executeSessionEffect(effect)
  }

  #processSyncInput(input: SyncInput): void {
    const [newModel, effect, notification] = this.#syncUpdate(
      input,
      this.#syncModel,
    )
    this.#syncModel = newModel
    if (notification) this.#accumulateSyncNotification(notification)
    if (effect) this.#executeSyncEffect(effect)
  }

  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
  // NOTIFICATION ACCUMULATION
  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

  #accumulateSessionNotification(notification: SessionNotification): void {
    switch (notification.type) {
      case "notify/peer-established":
        this.#pendingPeerEvents.push({
          type: "peer-established",
          peer: notification.peer,
        })
        break
      case "notify/peer-disconnected":
        this.#pendingPeerEvents.push({
          type: "peer-disconnected",
          peer: notification.peer,
        })
        break
      case "notify/peer-reconnected":
        this.#pendingPeerEvents.push({
          type: "peer-reconnected",
          peer: notification.peer,
        })
        break
      case "notify/peer-departed":
        this.#pendingPeerEvents.push({
          type: "peer-departed",
          peer: notification.peer,
        })
        break
      case "notify/warning":
        console.warn(notification.message)
        break
      case "notify/batch":
        for (const sub of notification.notifications) {
          this.#accumulateSessionNotification(sub)
        }
        break
    }
  }

  #accumulateSyncNotification(notification: SyncNotification): void {
    switch (notification.type) {
      case "notify/ready-state-changed":
        for (const docId of notification.docIds) {
          this.#dirtyDocIds.add(docId)
        }
        break
      case "notify/state-advanced":
        for (const docId of notification.docIds) {
          this.#dirtyStateAdvanced.add(docId)
        }
        break
      case "notify/warning":
        console.warn(notification.message)
        break
      case "notify/batch":
        for (const sub of notification.notifications) {
          this.#accumulateSyncNotification(sub)
        }
        break
    }
  }

  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
  // SESSION EFFECT EXECUTION
  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

  #executeSessionEffect(effect: SessionEffect): void {
    switch (effect.type) {
      case "send": {
        // Send lifecycle message to a specific channel via the outbound queue
        this.#outboundQueue.push({
          toChannelIds: [effect.to],
          message: effect.message,
        })
        break
      }
      case "reject-channel":
        // Reject the connection by dispatching channel-removed to clean up
        // the session model. The transport channel is not explicitly closed
        // — it will time out or be cleaned up by the transport layer.
        this.#pendingInputs.push({
          type: "sess/channel-removed",
          channelId: effect.channelId,
        })
        break
      case "start-departure-timer": {
        // Clear any existing timer for this peer
        const existing = this.#departureTimers.get(effect.peerId)
        if (existing) clearTimeout(existing)
        const timer = setTimeout(() => {
          this.#departureTimers.delete(effect.peerId)
          this.#dispatchSession({
            type: "sess/departure-timer-expired",
            peerId: effect.peerId,
          })
        }, effect.delayMs)
        this.#departureTimers.set(effect.peerId, timer)
        break
      }
      case "cancel-departure-timer": {
        const timer = this.#departureTimers.get(effect.peerId)
        if (timer) {
          clearTimeout(timer)
          this.#departureTimers.delete(effect.peerId)
        }
        break
      }
      case "sync-event":
        // Forward to sync program — enqueue so it's processed in the current drain
        this.#pendingInputs.push(effect.event)
        break
      case "batch":
        for (const sub of effect.effects) {
          this.#executeSessionEffect(sub)
        }
        break
    }
  }

  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
  // SYNC EFFECT EXECUTION
  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

  #executeSyncEffect(effect: SyncEffect): void {
    switch (effect.type) {
      case "send-to-peer": {
        this.#sendToPeer(effect.to, effect.message)
        break
      }
      case "send-to-peers": {
        for (const peerId of effect.to) {
          this.#sendToPeer(peerId, effect.message)
        }
        break
      }
      case "send-offer": {
        this.#executeSendOfferToPeer(
          effect.to,
          effect.docId,
          effect.sinceVersion,
          effect.reciprocate,
        )
        break
      }
      case "send-offers": {
        for (const peerId of effect.to) {
          this.#executeSendOfferToPeer(
            peerId,
            effect.docId,
            effect.sinceVersion,
            effect.reciprocate,
          )
        }
        break
      }
      case "import-doc-data":
        this.#executeImportDocData(effect)
        break
      case "ensure-doc":
        // Ensure semantics — callback must be idempotent (first writer wins).
        // Reentrant dispatch from the callback (e.g. registerDoc → doc-ensure)
        // is queued in #pendingInputs and processed before quiescence.
        this.#docCreationCallback?.(
          effect.docId,
          effect.peer,
          effect.replicaType,
          effect.syncProtocol,
          effect.schemaHash,
          effect.supportedHashes,
        )
        break
      case "ensure-doc-dismissed":
        // Ensure semantics — callback must be idempotent (first writer wins).
        // The Exchange handles cleanup via dismiss().
        this.#docDismissedCallback?.(effect.docId, effect.peer, "remote")
        break
      case "batch":
        for (const sub of effect.effects) {
          this.#executeSyncEffect(sub)
        }
        break
    }
  }

  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
  // PEER→CHANNEL RESOLUTION
  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

  /**
   * Resolve a PeerId to channel IDs via the session model and enqueue
   * a sync message for delivery.
   */
  #sendToPeer(peerId: PeerId, message: SyncMsg): void {
    const peer = this.#sessionModel.peers.get(peerId)
    if (!peer || peer.channels.size === 0) return // disconnected, drop

    const toChannelIds: ChannelId[] = Array.from(peer.channels)

    this.#outboundQueue.push({
      toChannelIds,
      message,
    })
  }

  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
  // SEND OFFER — build and queue outbound offer for a document
  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

  /**
   * Build and queue an outbound offer for a document to a specific peer.
   *
   * Version-gap planning happens via `resolveOutboundVersionGap()`.
   * Effect execution stays here in the shell: warnings, payload export,
   * and outbound queue mutation.
   *
   * No mode branching needed — `replica` exists on both modes.
   * For interpreted docs, `runtime.replica` is the `Substrate` itself
   * (since `Substrate extends Replica`).
   */
  #executeSendOfferToPeer(
    peerId: PeerId,
    docId: DocId,
    sinceVersion?: string,
    reciprocate?: boolean,
  ): void {
    const peer = this.#sessionModel.peers.get(peerId)
    if (!peer || peer.channels.size === 0) return

    const runtime = this.#docRuntimes.get(docId)
    if (!runtime) {
      console.warn(`[exchange] doc runtime not found, offer not sent: ${docId}`)
      return
    }

    const toChannelIds = Array.from(peer.channels)

    const enqueueOffer = (payload: SubstratePayload): void => {
      const version = runtime.replica.version().serialize()
      this.#outboundQueue.push({
        toChannelIds,
        message: {
          type: "offer",
          docId,
          payload,
          version,
          reciprocate,
        },
      })
    }

    if (sinceVersion) {
      const gap = resolveOutboundVersionGap(
        runtime.replica,
        runtime.replicaFactory,
        sinceVersion,
      )

      switch (gap.kind) {
        case "parse-error":
          console.warn(
            `[exchange] version parse failed for doc '${docId}':`,
            gap.error,
          )
          return

        case "no-gap":
          return

        case "gap": {
          const payload = runtime.replica.exportSince(gap.parsed)
          if (!payload) {
            // exportSince returned null — the peer's version is behind
            // the replica's base (history was trimmed via advance()).
            // Fall back to exportEntirety() so the peer can reset.
            enqueueOffer(runtime.replica.exportEntirety())
            return
          }

          enqueueOffer(payload)
          return
        }
      }
    }

    enqueueOffer(runtime.replica.exportEntirety())
  }

  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
  // IMPORT DOC DATA — merge inbound data and notify model on success
  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

  /**
   * Import document data from a peer and notify the model on success.
   *
   * Version-gap planning happens via `resolveInboundVersionGap()`.
   * Effect execution stays here in the shell: warnings, merge, and
   * follow-up dispatch.
   */
  #executeImportDocData(effect: {
    type: "import-doc-data"
    docId: DocId
    payload: SubstratePayload
    version: string
    fromPeerId: PeerId
  }): void {
    const runtime = this.#docRuntimes.get(effect.docId)
    if (!runtime) return

    const gap = resolveInboundVersionGap(
      runtime.replica,
      runtime.replicaFactory,
      effect.version,
    )

    switch (gap.kind) {
      case "parse-error":
        console.warn(
          `[exchange] version parse failed for doc '${effect.docId}':`,
          gap.error,
        )
        return

      case "no-gap":
        return

      case "gap":
        break
    }

    // --- Epoch boundary detection ---
    // If this doc has previously synced with any peer and the incoming
    // payload is an entirety, this may be a compaction-induced reset
    // (the sender trimmed history past our version). Consult the epoch
    // boundary policy before proceeding.
    //
    // We distinguish initial sync from compaction reset by checking
    // whether ANY peer has reached "synced" status for this doc.
    // Initial sync (first entirety from any peer) skips the policy —
    // the existing merge path handles it correctly. Subsequent entirety
    // payloads after the doc has been synced trigger the policy.
    const isEntirety = effect.payload.kind === "entirety"
    const hasEverSynced = (() => {
      for (const [, peerState] of this.#syncModel.peers) {
        const docSync = peerState.docSyncStates.get(effect.docId)
        if (docSync && docSync.status === "synced") return true
      }
      return false
    })()

    if (isEntirety && hasEverSynced) {
      // Look up the peer identity for the policy predicate.
      const peerState = this.#syncModel.peers.get(effect.fromPeerId)
      const peerIdentity = peerState?.identity ?? {
        peerId: effect.fromPeerId,
      }

      const accept = this.#canReset(
        effect.docId,
        peerIdentity as PeerIdentityDetails,
        runtime.syncProtocol,
      )

      if (!accept) {
        // Rejected — keep local state, diverge from compacted peers.
        return
      }

      // Accepted — for CRDT replicas, replace the replica entirely
      // (not doc.import(), which would merge and preserve local ops
      // that reference trimmed causal anchors). For plain replicas,
      // merge() already handles entirety correctly (decomposes to
      // ReplaceChange ops).
      if (runtime.mode === "replicate") {
        // Headless replica — replace with a fresh one from the entirety.
        try {
          runtime.replica = runtime.replicaFactory.fromEntirety(effect.payload)
        } catch (err) {
          console.warn(
            `[exchange] epoch boundary reset failed for doc '${effect.docId}'.`,
            err,
          )
          return
        }

        const newVersion = runtime.replica.version().serialize()
        this.#dispatchSync({
          type: "sync/doc-imported",
          docId: effect.docId,
          version: newVersion,
          fromPeerId: effect.fromPeerId,
        })
        return
      }
      // For interpreted substrates, fall through to normal merge —
      // plain substrates handle entirety correctly via executeBatch.
    }

    try {
      runtime.replica.merge(effect.payload, "sync")
    } catch (err) {
      // Import failed — log and continue. A common cause is replica type
      // mismatch: e.g. Loro binary data fed to a Yjs decoder after switching
      // CRDT backends. Check for stale clients sending incompatible data.
      console.warn(
        `[exchange] import failed for doc '${effect.docId}'. ` +
          `If you recently switched CRDT backends, stale clients may be sending incompatible data.`,
        err,
      )
      return
    }

    // Notify the model of successful import
    const newVersion = runtime.replica.version().serialize()
    this.#dispatchSync({
      type: "sync/doc-imported",
      docId: effect.docId,
      version: newVersion,
      fromPeerId: effect.fromPeerId,
    })
  }

  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
  // OUTBOUND — flush accumulated messages
  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

  #drainOutbound(): void {
    while (this.#outboundQueue.length > 0) {
      const envelope = this.#outboundQueue.shift()
      if (!envelope) break
      this.transports.send(envelope)
    }
  }

  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
  // READY STATE — emit changes after quiescence
  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

  /**
   * Drain accumulated peer lifecycle events at quiescence.
   *
   * Follows the snapshot-then-clear pattern: snapshot the pending events,
   * reset the field, then rebuild the peer map from the model and emit.
   * The field is clean before any subscriber code runs.
   *
   * Context: jj:qpurktzy (peer lifecycle feed)
   */
  #drainPeerEvents(): void {
    const events = this.#pendingPeerEvents
    this.#pendingPeerEvents = []

    if (events.length === 0) return

    // Rebuild peer map from session model (source of truth for presence)
    if (!this.#peerHandle) return
    this.#peerHandle.clear()
    for (const [peerId, sessionPeer] of this.#sessionModel.peers) {
      this.#peerHandle.set(peerId, sessionPeer.identity)
    }

    // Emit to subscribers
    this.#peerHandle.emit({ changes: events })
  }

  /**
   * Drain accumulated document lifecycle events at quiescence.
   *
   * Follows the same snapshot-then-clear pattern as `#drainPeerEvents()`:
   * snapshot pending events, reset the field, rebuild the doc map from
   * the two sources of truth (`#docRuntimes` + deferred entries in
   * `syncModel.documents`), then emit.
   */
  #drainDocEvents(): void {
    const events = this.#pendingDocEvents
    this.#pendingDocEvents = []

    if (events.length === 0) return

    if (!this.#docHandle) return
    this.#docHandle.clear()

    // Rebuild from #docRuntimes (interpret + replicate docs)
    for (const [docId, runtime] of this.#docRuntimes) {
      const suspended = !this.#syncModel.documents.has(docId)
      this.#docHandle.set(docId, { mode: runtime.mode, suspended })
    }

    // Merge deferred docs from syncModel (no runtime, only model entry)
    for (const [docId, entry] of this.#syncModel.documents) {
      if (entry.mode === "deferred") {
        this.#docHandle.set(docId, { mode: "deferred", suspended: false })
      }
    }

    // Emit to subscribers
    this.#docHandle.emit({ changes: events })
  }

  /**
   * Emit synthetic `doc-removed` events for all tracked documents.
   * Called during `reset()` and `shutdown()` — symmetric with
   * `#emitSyntheticDepartedEvents()`.
   */
  #emitSyntheticDocRemovedEvents(): void {
    if (!this.#docHandle) return

    const docIds = new Set<DocId>()
    for (const docId of this.#docRuntimes.keys()) {
      docIds.add(docId)
    }
    for (const [docId, entry] of this.#syncModel.documents) {
      if (entry.mode === "deferred") docIds.add(docId)
    }

    if (docIds.size === 0) return

    const events: DocChange[] = Array.from(docIds).map(docId => ({
      type: "doc-removed" as const,
      docId,
    }))

    this.#docHandle.clear()
    this.#docHandle.emit({ changes: events })
  }

  #emitSyntheticDepartedEvents(): void {
    if (this.#sessionModel.peers.size === 0 || !this.#peerHandle) return

    const events: PeerChange[] = Array.from(
      this.#sessionModel.peers.values(),
    ).map(peer => ({ type: "peer-departed" as const, peer: peer.identity }))

    // Clear peer map (consistent with the about-to-be-wiped model)
    this.#peerHandle.clear()

    this.#peerHandle.emit({ changes: events })
  }

  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
  // SHUTDOWN HELPERS
  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

  #sendDepartToAllPeers(): void {
    for (const [_peerId, peer] of this.#sessionModel.peers) {
      for (const channelId of peer.channels) {
        this.#outboundQueue.push({
          toChannelIds: [channelId],
          message: { type: "depart" },
        })
      }
    }
  }

  #clearDepartureTimers(): void {
    for (const timer of this.#departureTimers.values()) {
      clearTimeout(timer)
    }
    this.#departureTimers.clear()
  }

  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
  // STATE ADVANCED — emit persistence events after quiescence
  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

  /**
   * Emit state-advanced events for docs touched this dispatch cycle.
   * Fires listeners at quiescence — multiple imports in one cycle
   * produce one event per docId.
   *
   * Context: jj:smmulzkm (unified persistence via notify/state-advanced)
   */
  #drainStateAdvanced(): void {
    const docIds = new Set(this.#dirtyStateAdvanced)
    this.#dirtyStateAdvanced.clear()

    if (this.#stateAdvancedListeners.size === 0 || docIds.size === 0) return

    for (const docId of docIds) {
      // Only emit if we still track this doc (it may have been removed
      // during the same dispatch cycle).
      if (!this.#docRuntimes.has(docId)) continue

      for (const listener of this.#stateAdvancedListeners) {
        listener(docId)
      }
    }
  }

  #drainReadyStateChanges(): void {
    const docIds = new Set(this.#dirtyDocIds)
    this.#dirtyDocIds.clear()

    if (this.#readyStateListeners.size === 0 || docIds.size === 0) return

    // Emit only for docs whose peer sync state was touched this cycle.
    for (const docId of docIds) {
      // Only emit if we still track this doc (it may have been removed
      // during the same dispatch cycle).
      if (!this.#docRuntimes.has(docId)) continue

      const readyStates = this.getReadyStates(docId)
      for (const listener of this.#readyStateListeners) {
        listener(docId, readyStates)
      }
    }
  }
}

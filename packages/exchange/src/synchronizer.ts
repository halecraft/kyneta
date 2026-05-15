// synchronizer — runtime that wires the TEA state machines to adapters and substrates.
//
// The Synchronizer is the imperative shell around two pure TEA update functions:
// - Session program: manages channel topology, establish handshake, peer
//   identity, and the connection/disconnection/departure lifecycle.
// - Sync program: manages document convergence — present, interest, offer,
//   dismiss — and per-peer document sync states.
//
// Both pure programs are hosted by `createObservableProgram` (from
// @kyneta/machine) sharing a single `Lease`. An outer coordinator —
// itself a `createDispatcher` — owns cross-program input ordering and
// drives `tick/quiescent` self-messages until the cascade reaches a
// output-phase level.

import type { ReactiveMap, ReactiveMapHandle } from "@kyneta/changefeed"
import { createReactiveMap } from "@kyneta/changefeed"
import {
  createDispatcher,
  createLease,
  createObservableProgram,
  type DispatcherHandle,
  type Lease,
  type ObservableHandle,
} from "@kyneta/machine"
import type {
  DocMetadata,
  ReplicaFactoryLike,
  ReplicaLike,
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
  WireFeatures,
} from "@kyneta/transport"
import { isLifecycleMsg } from "@kyneta/transport"

import {
  createSessionUpdate,
  initSession,
  type SessionEffect,
  type SessionInput,
  type SessionModel,
} from "./session-program.js"
import {
  createSyncUpdate,
  type DocEntry,
  initSync,
  type SyncEffect,
  type SyncInput,
  type SyncModel,
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
  replica: ReplicaLike
  replicaFactory: ReplicaFactoryLike
  syncProtocol: SyncProtocol
  schemaHash: string
}

/**
 * Discriminated by participation mode so the `mode === "interpret"`
 * branch can narrow `replica` to `Substrate<Version>` — the only
 * functional difference between modes. The discriminant carries no
 * other baggage.
 */
export type DocRuntime =
  | (DocRuntimeBase & {
      mode: "interpret"
      replica: Substrate<Version>
    })
  | (DocRuntimeBase & {
      mode: "replicate"
    })

/**
 * Fired by the `ensure-doc` effect when a peer announces an unknown doc.
 *
 * **Must be idempotent.** A doc may be announced by multiple peers in the
 * same dispatch cycle, producing one `ensure-doc` effect each. The first
 * caller to register state wins; subsequent ones must return early.
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
 * Fired by the `ensure-doc-dismissed` effect when a peer dismisses a doc.
 *
 * **Must be idempotent** — same rationale as `DocCreationCallback`.
 */
export type DocDismissedCallback = (
  docId: DocId,
  peer: PeerIdentityDetails,
  origin: "local" | "remote",
) => void

/**
 * Consulted when an incoming entirety payload would overwrite a doc that
 * has already synced with at least one peer (a likely compaction-induced
 * reset). Returns `true` to accept the reset, `false` to keep local state
 * and diverge from compacted peers.
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
  /**
   * Wire features advertised by this peer in outbound `establish`.
   * Defaults to `{ alias: true }` for v1.
   */
  selfFeatures?: WireFeatures
  /**
   * Optional shared dispatch budget. If omitted, the Synchronizer
   * creates its own private lease.
   */
  lease?: Lease
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
 * Common parse + compare + classify pipeline. Comparison *direction* is
 * the caller's responsibility — see `resolveInboundVersionGap` and
 * `resolveOutboundVersionGap` for the two specializations.
 */
function classifyVersionGap(
  replica: ReplicaLike,
  replicaFactory: ReplicaFactoryLike,
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
 * Inbound: compare `incoming` against `current`. `ahead`/`concurrent`
 * means the peer has data we may need to import; `behind`/`equal` means
 * the offer is stale — no action.
 */
function resolveInboundVersionGap(
  replica: ReplicaLike,
  replicaFactory: ReplicaFactoryLike,
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
 * Outbound: compare `current` against the peer's declared version.
 * `ahead`/`concurrent` means we have data the peer is missing — emit
 * the offer; `behind`/`equal` means there's nothing useful to send.
 */
function resolveOutboundVersionGap(
  replica: ReplicaLike,
  replicaFactory: ReplicaFactoryLike,
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
// Outer coordinator message
// ---------------------------------------------------------------------------

type OuterMsg =
  | { type: "route"; input: SessionInput | SyncInput }
  | { type: "tick" }

// ---------------------------------------------------------------------------
// Synchronizer
// ---------------------------------------------------------------------------

export class Synchronizer {
  readonly identity: PeerIdentityDetails
  readonly transports: TransportManager

  readonly #lease: Lease
  readonly #departureTimeout: number
  readonly #selfFeatures: WireFeatures | undefined

  #sessionHandle: ObservableHandle<SessionInput, SessionModel>
  #syncHandle: ObservableHandle<SyncInput, SyncModel>
  #outerHandle: DispatcherHandle<OuterMsg>

  readonly #docRuntimes = new Map<DocId, DocRuntime>()
  readonly #docCreationCallback?: DocCreationCallback
  readonly #docDismissedCallback?: DocDismissedCallback

  /**
   * Outbound message queue — accumulated during dispatch, flushed at
   * quiescence by the outer coordinator's tick. Carries channelId
   * routing + transport-selection knowledge that the pure programs do
   * not have.
   */
  readonly #outboundQueue: AddressedEnvelope[] = []

  // Departure timers — shell-managed side effects from session program
  #departureTimers = new Map<PeerId, ReturnType<typeof setTimeout>>()

  // Peer lifecycle — changefeed
  #peerHandle: ReactiveMapHandle<
    PeerId,
    PeerIdentityDetails,
    PeerChange
  > | null = null

  // Document lifecycle — changefeed
  #docHandle: ReactiveMapHandle<DocId, DocInfo, DocChange> | null = null

  // Ready-state listeners
  readonly #readyStateListeners = new Set<
    (docId: DocId, readyStates: ReadyState[]) => void
  >()

  // State-advanced listeners
  readonly #stateAdvancedListeners = new Set<(docId: DocId) => void>()

  readonly #canReset: EpochBoundaryPredicate
  readonly #canConnect?: (peer: PeerIdentityDetails) => boolean
  readonly #canShare: (docId: DocId, peer: PeerIdentityDetails) => boolean
  readonly #canAccept: (docId: DocId, peer: PeerIdentityDetails) => boolean

  /**
   * Backward-compat getter — exposes `documents` and `peers` from the
   * sync model for test access via `synchronizer.model.documents`.
   */
  get model(): {
    documents: Map<DocId, DocEntry>
    peers: Map<PeerId, unknown>
  } {
    const sync = this.#syncHandle.getState()
    return {
      documents: sync.documents,
      peers: sync.peers,
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
    selfFeatures,
    lease,
  }: SynchronizerParams) {
    this.identity = identity
    this.#departureTimeout = departureTimeout ?? 30_000
    this.#selfFeatures = selfFeatures
    this.#canReset = canReset
    this.#canConnect = canConnect
    this.#canShare = canShare
    this.#canAccept = canAccept
    this.#docCreationCallback = onEnsureDoc
    this.#docDismissedCallback = onEnsureDocDismissed
    this.#lease = lease ?? createLease()
    ;[this.#sessionHandle, this.#syncHandle, this.#outerHandle] =
      this.#buildHandles()

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
  // HANDLE CONSTRUCTION
  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

  #buildHandles(): [
    ObservableHandle<SessionInput, SessionModel>,
    ObservableHandle<SyncInput, SyncModel>,
    DispatcherHandle<OuterMsg>,
  ] {
    const sessionProgram = {
      init: [
        initSession(this.identity, this.#departureTimeout, this.#selfFeatures),
      ] as [SessionModel],
      update: createSessionUpdate({ canConnect: this.#canConnect }),
    }
    const sessionHandle = createObservableProgram(
      sessionProgram,
      (effect, _dispatch) => this.#executeSessionEffect(effect),
      { lease: this.#lease, label: "synchronizer:session" },
    )

    const syncProgram = {
      init: [initSync(this.identity)] as [SyncModel],
      update: createSyncUpdate({
        canShare: this.#canShare,
        canAccept: this.#canAccept,
      }),
    }
    const syncHandle = createObservableProgram(
      syncProgram,
      (effect, _dispatch) => this.#executeSyncEffect(effect),
      { lease: this.#lease, label: "synchronizer:sync" },
    )

    // The outer coordinator owns cross-program input ordering: a
    // session `sync-event` effect re-enters as a `route` here rather
    // than dispatching directly into syncHandle, so user-dispatched
    // inputs and cross-program inputs interleave in arrival order.
    // It also drives ticks — and because it is itself a dispatcher,
    // ticks that produce more `route` msgs (via subscriber re-entry)
    // converge in the same drain.
    //
    // `tickPending` is closure-scoped imperative state. It coalesces a
    // burst of routes into at most one queued tick — the tick-quiescent
    // handlers are idempotent (`session-program.ts:handleTickQuiescent`,
    // `sync-program.ts:handleTickQuiescent` both early-return when their
    // accumulators are empty), so coalescing is semantics-preserving and
    // bounds the iteration count of long cascades by ~⅓.
    //
    // This is structurally inconsistent with `jj:qlvnvxox`'s thesis that
    // accumulator state lives inside the algebra; promoting the outer
    // coordinator from `createDispatcher` to a `Program<OuterMsg,
    // {tickPending: boolean}, OuterEffect>` would put this in the model.
    // Out of scope for `jj:tozwpvuu`; follow up if the flag accretes
    // siblings.
    let tickPending = false
    const outerHandle = createDispatcher<OuterMsg>(
      (msg, dispatch) => {
        if (msg.type === "route") {
          if (msg.input.type.startsWith("sess/")) {
            sessionHandle.dispatch(msg.input as SessionInput)
          } else {
            syncHandle.dispatch(msg.input as SyncInput)
          }
          if (!tickPending) {
            tickPending = true
            dispatch({ type: "tick" })
          }
        } else {
          // Clear *before* the tick-quiescent dispatches so a subscriber
          // inside an emit-* effect that issues a new route can queue a
          // fresh tick — preserving the `peer-event-reentry.test.ts`
          // "tick-induced" guarantee.
          tickPending = false
          // Outbound flushes last so subscribers fired by the emit-*
          // effects observe the model→world ordering implied by their
          // events (e.g., a ready-state listener that reads peer state
          // sees it after the program update committed).
          sessionHandle.dispatch({ type: "sess/tick-quiescent" })
          syncHandle.dispatch({ type: "sync/tick-quiescent" })
          this.#drainOutboundOnce()
        }
      },
      { lease: this.#lease, label: "synchronizer:outer" },
    )

    return [sessionHandle, syncHandle, outerHandle]
  }

  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
  // PUBLIC API — Document management
  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

  /**
   * Multi-channel peers advertise one feature set per identity. Any
   * established channel for the peer is authoritative; returns the first
   * one found, or `undefined` if the peer is unestablished.
   */
  getPeerFeatures(peerId: PeerId): WireFeatures | undefined {
    const session = this.#sessionHandle.getState()
    const peer = session.peers.get(peerId)
    if (!peer) return undefined
    for (const channelId of peer.channels) {
      const entry = session.channels.get(channelId)
      if (entry?.peerFeatures) return entry.peerFeatures
    }
    return undefined
  }

  /**
   * Track a doc-runtime and announce the doc to peers via `doc-ensure`.
   * Called by Exchange.get() / Exchange.replicate() after the
   * substrate/replica is created.
   */
  registerDoc(runtime: DocRuntime): void {
    const sync = this.#syncHandle.getState()
    const existing = sync.documents.get(runtime.docId)
    // The promoted-vs-created distinction depends on the *pre-dispatch*
    // model state; capture it before #docRuntimes mutates and the
    // dispatch updates sync.documents.
    let event: DocChange | undefined
    if (existing?.mode === "deferred") {
      event = { type: "doc-promoted", docId: runtime.docId }
    } else if (!this.#docRuntimes.has(runtime.docId)) {
      event = { type: "doc-created", docId: runtime.docId }
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
      event,
    })
  }

  /**
   * Register a doc as deferred — participates in routing (peers learn it
   * exists via `present`) but does not exchange data. Promoted to
   * interpret/replicate later by a subsequent `registerDoc`.
   */
  deferDoc(
    docId: DocId,
    replicaType: ReplicaType,
    syncProtocol: SyncProtocol,
    schemaHash: string,
  ): void {
    const sync = this.#syncHandle.getState()
    const event: DocChange | undefined = !sync.documents.has(docId)
      ? { type: "doc-deferred", docId }
      : undefined

    this.#dispatchSync({
      type: "sync/doc-defer",
      docId,
      replicaType,
      syncProtocol,
      schemaHash,
      event,
    })
  }

  getDocMetadata(docId: DocId): DocMetadata | undefined {
    const entry = this.#syncHandle.getState().documents.get(docId)
    if (!entry) return undefined
    return {
      replicaType: entry.replicaType,
      syncProtocol: entry.syncProtocol,
      schemaHash: entry.schemaHash,
    }
  }

  /**
   * Normally fired automatically by the Exchange's changefeed
   * subscription after `change(doc, ...)`. Call directly only when
   * mutating the substrate outside the changefeed (e.g., via `unwrap`).
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

  getDocRuntime(docId: DocId): DocRuntime | undefined {
    return this.#docRuntimes.get(docId)
  }

  /**
   * Greatest version that is ≤ every synced peer's last-known version —
   * the safe trim point for `advance()`. The local version is excluded
   * deliberately: the LCV represents "what every remote has," so
   * including local state would raise it past what peers actually have
   * and strand them on subsequent syncs.
   *
   * Returns `null` when no peers are synced (nothing to bound against)
   * or the doc is unknown.
   */
  leastCommonVersion(
    docId: DocId,
    peerFilter?: (peer: PeerIdentityDetails, docId: DocId) => boolean,
  ): Version | null {
    const runtime = this.#docRuntimes.get(docId)
    if (!runtime) return null

    let lcv: Version | null = null

    for (const [, peerState] of this.#syncHandle.getState().peers) {
      const docSync = peerState.docSyncStates.get(docId)
      if (!docSync || docSync.status !== "synced") continue
      if (peerFilter && !peerFilter(peerState.identity, docId)) continue

      let peerVersion: Version
      try {
        peerVersion = runtime.replicaFactory.parseVersion(
          docSync.lastKnownVersion,
        )
      } catch {
        // Unparseable peer versions are excluded so a single corrupted
        // entry can't poison the LCV for the rest of the cohort.
        continue
      }

      lcv = lcv === null ? peerVersion : lcv.meet(peerVersion)
    }

    return lcv
  }

  hasDoc(docId: DocId): boolean {
    return this.#docRuntimes.has(docId)
  }

  async removeDocument(docId: DocId): Promise<void> {
    const sync = this.#syncHandle.getState()
    const event: DocChange | undefined =
      this.#docRuntimes.has(docId) || sync.documents.has(docId)
        ? { type: "doc-removed", docId }
        : undefined
    // Runtime must be deleted before the dispatch: emit-doc-events
    // rebuilds the doc map from #docRuntimes, so a live entry here
    // would re-introduce the doc the event is meant to remove.
    this.#docRuntimes.delete(docId)
    this.#dispatchSync({
      type: "sync/doc-delete",
      docId,
      event,
    })
  }

  dismissDocument(docId: DocId): void {
    const sync = this.#syncHandle.getState()
    const event: DocChange | undefined =
      this.#docRuntimes.has(docId) || sync.documents.has(docId)
        ? { type: "doc-removed", docId }
        : undefined
    // See removeDocument: runtime delete must precede the dispatch.
    this.#docRuntimes.delete(docId)
    this.#dispatchSync({
      type: "sync/doc-dismiss",
      docId,
      event,
    })
  }

  suspendDocument(docId: DocId): void {
    const sync = this.#syncHandle.getState()
    const event: DocChange | undefined =
      this.#docRuntimes.has(docId) || sync.documents.has(docId)
        ? { type: "doc-suspended", docId }
        : undefined
    // Runtime survives — `resume()` re-registers from it. Emit-doc-events
    // computes `suspended: !sync.documents.has(docId)`; folding the event
    // into doc-dismiss is what makes sync.documents lose the doc before
    // the emit rebuild reads it, so `suspended: true` is visible.
    this.#dispatchSync({
      type: "sync/doc-dismiss",
      docId,
      event,
    })
  }

  /**
   * Rejoin the sync graph using the surviving runtime's current version.
   * Peers receive `present` + `interest` and delta-sync from the
   * suspended version, so any drift accumulated during suspension is
   * reconciled rather than overwritten.
   */
  resumeDocument(docId: DocId): void {
    const runtime = this.#docRuntimes.get(docId)
    if (!runtime) {
      throw new Error(
        `Cannot resume document '${docId}': no runtime found. ` +
          `The document may have been destroyed.`,
      )
    }
    this.#dispatchSync({
      type: "sync/doc-ensure",
      docId: runtime.docId,
      mode: runtime.mode,
      version: runtime.replica.version().serialize(),
      replicaType: runtime.replicaFactory.replicaType,
      syncProtocol: runtime.syncProtocol,
      schemaHash: runtime.schemaHash,
      event: { type: "doc-resumed", docId },
    })
  }

  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
  // PUBLIC API — Ready state
  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

  getReadyStates(docId: DocId): ReadyState[] {
    const states: ReadyState[] = []

    for (const [_peerId, peerState] of this.#syncHandle.getState().peers) {
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

  async waitUntilReady(docId: DocId, timeoutMs = 30000): Promise<void> {
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
   * Fires once per docId at quiescence when the document's state has
   * advanced — from a local mutation (changefeed → notifyLocalChange)
   * or a network import (handleOffer → import-doc-data → handleDocImported).
   * Coalescing is intentional: multiple advances within one dispatch
   * cycle produce a single notification so persistence reads the full
   * delta once instead of re-exporting per change.
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
    const session = this.#sessionHandle.getState()
    for (const [peerId, peerState] of this.#syncHandle.getState().peers) {
      const docSync = peerState.docSyncStates.get(docId)
      if (!docSync) continue

      if (docSync.status === "synced" || docSync.status === "absent") {
        const sessionPeer = session.peers.get(peerId)
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
    this.#emitSyntheticOnTeardown()
    this.#clearDepartureTimers()
    this.#sessionHandle.dispose()
    this.#syncHandle.dispose()
    ;[this.#sessionHandle, this.#syncHandle, this.#outerHandle] =
      this.#buildHandles()
    this.transports.reset()
  }

  async shutdown(): Promise<void> {
    this.#sendDepartToAllPeers()
    // transports.flush() drains the transport layer, not #outboundQueue
    // — without this explicit drain the depart envelopes never reach
    // the transport and peers don't see the departure before close.
    this.#drainOutboundOnce()
    await this.transports.flush()
    this.#emitSyntheticOnTeardown()
    this.#clearDepartureTimers()
    this.#sessionHandle.dispose()
    this.#syncHandle.dispose()
    ;[this.#sessionHandle, this.#syncHandle, this.#outerHandle] =
      this.#buildHandles()
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
      const entry = this.#sessionHandle.getState().channels.get(channelId)
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
  // DISPATCH — all entry points route through the outer coordinator
  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

  #dispatchSession(input: SessionInput): void {
    this.#outerHandle.dispatch({ type: "route", input })
  }

  #dispatchSync(input: SyncInput): void {
    this.#outerHandle.dispatch({ type: "route", input })
  }

  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
  // SESSION EFFECT EXECUTION
  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

  #executeSessionEffect(effect: SessionEffect): void {
    switch (effect.type) {
      case "send": {
        this.#outboundQueue.push({
          toChannelIds: [effect.to],
          message: effect.message,
        })
        break
      }
      case "reject-channel":
        // Re-route through the outer (rather than touching the session
        // queue directly) so the synthetic channel-removed interleaves
        // with any other pending input in arrival order.
        this.#dispatchSession({
          type: "sess/channel-removed",
          channelId: effect.channelId,
        })
        break
      case "start-departure-timer": {
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
        // Direct sync-handle dispatch would skip the outer's queue and
        // reorder relative to concurrently-dispatched user inputs;
        // routing through the outer is what keeps cross-program inputs
        // in arrival order.
        this.#dispatchSync(effect.event)
        break
      case "emit-peer-events":
        this.#emitPeerEvents(effect.events)
        break
      case "warning":
        console.warn(effect.message)
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
        this.#docDismissedCallback?.(effect.docId, effect.peer, "remote")
        break
      case "emit-doc-events":
        this.#emitDocEvents(effect.events)
        break
      case "emit-ready-state-changes":
        this.#emitReadyStateChanges(effect.docIds)
        break
      case "emit-state-advanced":
        this.#emitStateAdvanced(effect.docIds)
        break
      case "warning":
        console.warn(effect.message)
        break
    }
  }

  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
  // PEER→CHANNEL RESOLUTION
  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

  #sendToPeer(peerId: PeerId, message: SyncMsg): void {
    const peer = this.#sessionHandle.getState().peers.get(peerId)
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

  #executeSendOfferToPeer(
    peerId: PeerId,
    docId: DocId,
    sinceVersion?: string,
    reciprocate?: boolean,
  ): void {
    const peer = this.#sessionHandle.getState().peers.get(peerId)
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
            // exportSince returns null when the peer's version is older
            // than our replica's base (history has been trimmed via
            // advance()). Falling back to entirety lets the peer reset
            // to our current state rather than diverge.
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

    // Epoch boundary detection: an entirety payload arriving for a doc
    // that has *already* synced with some peer signals a compaction-
    // induced reset (the sender trimmed history past our version). The
    // first-ever entirety is initial sync — the normal merge path
    // handles that; subsequent entireties go through the policy.
    const isEntirety = effect.payload.kind === "entirety"
    const sync = this.#syncHandle.getState()
    const hasEverSynced = (() => {
      for (const [, peerState] of sync.peers) {
        const docSync = peerState.docSyncStates.get(effect.docId)
        if (docSync && docSync.status === "synced") return true
      }
      return false
    })()

    if (isEntirety && hasEverSynced) {
      const peerState = sync.peers.get(effect.fromPeerId)
      const peerIdentity = peerState?.identity ?? {
        peerId: effect.fromPeerId,
      }

      const accept = this.#canReset(
        effect.docId,
        peerIdentity as PeerIdentityDetails,
        runtime.syncProtocol,
      )

      if (!accept) {
        // Reject keeps local state — the doc diverges from the
        // compacted peers until governance reconciles or a new
        // entirety is accepted.
        return
      }

      if (runtime.mode === "replicate") {
        // Headless replicas must replace the whole replica via
        // fromEntirety. A plain `merge()` would preserve local ops
        // whose causal anchors were trimmed, leaving the replica in
        // an inconsistent state. Interpreted substrates fall through
        // to merge — entirety decomposes correctly there.
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
    }

    try {
      runtime.replica.merge(effect.payload, "sync")
    } catch (err) {
      console.warn(
        `[exchange] import failed for doc '${effect.docId}'. ` +
          `If you recently switched CRDT backends, stale clients may be sending incompatible data.`,
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
  }

  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
  // OUTBOUND — flush accumulated envelopes
  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

  #drainOutboundOnce(): void {
    while (this.#outboundQueue.length > 0) {
      const envelope = this.#outboundQueue.shift()
      if (!envelope) break
      this.transports.send(envelope)
    }
  }

  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
  // EMIT HANDLERS — interpret emit-* effects against ReactiveMaps / listeners
  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

  #emitPeerEvents(events: readonly PeerChange[]): void {
    if (events.length === 0) return
    if (!this.#peerHandle) return

    // Rebuild peer map from session model (source of truth for presence)
    this.#peerHandle.clear()
    for (const [peerId, sessionPeer] of this.#sessionHandle.getState().peers) {
      this.#peerHandle.set(peerId, sessionPeer.identity)
    }

    this.#peerHandle.emit({ changes: [...events] })
  }

  #emitDocEvents(events: readonly DocChange[]): void {
    if (events.length === 0) return
    if (!this.#docHandle) return

    this.#docHandle.clear()

    // Rebuild from #docRuntimes (interpret + replicate docs)
    const sync = this.#syncHandle.getState()
    for (const [docId, runtime] of this.#docRuntimes) {
      const suspended = !sync.documents.has(docId)
      this.#docHandle.set(docId, { mode: runtime.mode, suspended })
    }

    // Merge deferred docs from syncModel (no runtime, only model entry)
    for (const [docId, entry] of sync.documents) {
      if (entry.mode === "deferred") {
        this.#docHandle.set(docId, { mode: "deferred", suspended: false })
      }
    }

    this.#docHandle.emit({ changes: [...events] })
  }

  #emitReadyStateChanges(docIds: readonly DocId[]): void {
    if (this.#readyStateListeners.size === 0 || docIds.length === 0) return

    for (const docId of docIds) {
      if (!this.#docRuntimes.has(docId)) continue
      const readyStates = this.getReadyStates(docId)
      for (const listener of this.#readyStateListeners) {
        listener(docId, readyStates)
      }
    }
  }

  #emitStateAdvanced(docIds: readonly DocId[]): void {
    if (this.#stateAdvancedListeners.size === 0 || docIds.length === 0) return

    for (const docId of docIds) {
      if (!this.#docRuntimes.has(docId)) continue
      for (const listener of this.#stateAdvancedListeners) {
        listener(docId)
      }
    }
  }

  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
  // SHUTDOWN / RESET HELPERS
  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

  #sendDepartToAllPeers(): void {
    for (const [_peerId, peer] of this.#sessionHandle.getState().peers) {
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

  /**
   * Run the teardown emit cascade through the algebra so subscribers
   * see doc-removed / peer-departed events before the handles are
   * disposed.
   *
   * The docIds snapshot must be taken before `#docRuntimes` is cleared;
   * the clear itself must happen before the dispatch, because
   * `#emitDocEvents` rebuilds the doc map from `#docRuntimes` and a
   * live entry there would re-introduce the doc the event is meant to
   * remove.
   */
  #emitSyntheticOnTeardown(): void {
    const sync = this.#syncHandle.getState()

    const docIds: DocId[] = []
    for (const docId of this.#docRuntimes.keys()) docIds.push(docId)
    for (const [docId, entry] of sync.documents) {
      if (entry.mode === "deferred" && !this.#docRuntimes.has(docId)) {
        docIds.push(docId)
      }
    }

    this.#docRuntimes.clear()

    if (docIds.length > 0) {
      this.#dispatchSync({
        type: "sync/synthetic-doc-removed-all",
        docIds,
      })
    }

    if (this.#sessionHandle.getState().peers.size > 0) {
      this.#dispatchSession({ type: "sess/synthetic-depart-all" })
    }
  }
}

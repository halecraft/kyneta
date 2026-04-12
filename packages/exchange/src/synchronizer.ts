// synchronizer — runtime that wires the TEA state machine to adapters and substrates.
//
// The Synchronizer is the imperative shell around the pure TEA update function.
// It manages:
// - Dispatching messages to the update function
// - Executing commands (side effects) produced by the update function
// - Adapter lifecycle and message routing
// - Substrate interactions (export, import) on behalf of the pure model
//
// Ported from @loro-extended/repo's Synchronizer with Loro-specific types
// replaced by substrate-agnostic equivalents.

import type { ReactiveMap, ReactiveMapHandle } from "@kyneta/changefeed"
import { createReactiveMap } from "@kyneta/changefeed"
import type {
  DocMetadata,
  MergeStrategy,
  Replica,
  ReplicaFactory,
  ReplicaType,
  Substrate,
  SubstratePayload,
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
} from "@kyneta/transport"
import type { AuthorizePredicate, RoutePredicate } from "./exchange.js"
import {
  type Command,
  createSynchronizerUpdate,
  init,
  type Notification,
  type SynchronizerMessage,
  type SynchronizerModel,
} from "./synchronizer-program.js"
import { TransportManager } from "./transport/transport-manager.js"
import type { PeerChange, ReadyState } from "./types.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Fields shared by both document modes — the uniform surface that
 * `#executeSendOffer`, `#executeImportDocData`, `registerDoc`, and
 * `notifyLocalChange` operate on without mode branching.
 */
type DocRuntimeBase = {
  docId: DocId
  replica: Replica<any>
  replicaFactory: ReplicaFactory<any>
  strategy: MergeStrategy
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
 * Callback invoked when a peer discovers a document the local exchange
 * doesn't have. The Synchronizer fires this during command execution;
 * the Exchange wraps the user's `onDocDiscovered` callback to call
 * `exchange.get()` if a BoundSchema is returned.
 */
export type DocCreationCallback = (
  docId: DocId,
  peer: PeerIdentityDetails,
  replicaType: ReplicaType,
  mergeStrategy: MergeStrategy,
  schemaHash: string,
) => void

/**
 * Callback invoked when a document is dismissed.
 * The Exchange wraps the user's `onDocDismissed` callback.
 *
 * @param origin - `"remote"` when a peer sends a dismiss message;
 *   `"local"` when the local exchange calls `dismiss()`.
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
  strategy: MergeStrategy,
) => boolean

export type SynchronizerParams = {
  identity: PeerIdentityDetails
  transports?: AnyTransport[]
  route: RoutePredicate
  authorize: AuthorizePredicate
  epochBoundary: EpochBoundaryPredicate
  onDocCreationRequested?: DocCreationCallback
  onDocDismissed?: DocDismissedCallback
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

  readonly #updateFn: ReturnType<typeof createSynchronizerUpdate>
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
   * Ensures messages are processed one at a time and outbound messages
   * are flushed at quiescence (after all pending dispatches complete).
   */
  #dispatching = false
  readonly #pendingMessages: SynchronizerMessage[] = []

  model: SynchronizerModel

  // Peer lifecycle — event accumulation and changefeed
  #pendingPeerEvents: PeerChange[] = []
  #peerHandle: ReactiveMapHandle<
    PeerId,
    PeerIdentityDetails,
    PeerChange
  > | null = null

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

  readonly #epochBoundary: EpochBoundaryPredicate

  constructor({
    identity,
    transports = [],
    route,
    authorize,
    epochBoundary,
    onDocCreationRequested,
    onDocDismissed,
  }: SynchronizerParams) {
    this.identity = identity

    this.#updateFn = createSynchronizerUpdate({ route, authorize })
    this.#epochBoundary = epochBoundary
    this.#docCreationCallback = onDocCreationRequested
    this.#docDismissedCallback = onDocDismissed

    // Initialize model
    const [initialModel, initialCommand] = init(this.identity)
    this.model = initialModel

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

    // Execute initial command
    if (initialCommand) {
      this.#executeCommand(initialCommand)
    }

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
    this.#docRuntimes.set(runtime.docId, runtime)

    this.#dispatch({
      type: "synchronizer/doc-ensure",
      docId: runtime.docId,
      mode: runtime.mode,
      version: runtime.replica.version().serialize(),
      replicaType: runtime.replicaFactory.replicaType,
      mergeStrategy: runtime.strategy,
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
    mergeStrategy: MergeStrategy,
    schemaHash: string,
  ): void {
    this.#dispatch({
      type: "synchronizer/doc-defer",
      docId,
      replicaType,
      mergeStrategy,
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
    const entry = this.model.documents.get(docId)
    if (!entry) return undefined
    return {
      replicaType: entry.replicaType,
      mergeStrategy: entry.mergeStrategy,
      schemaHash: entry.schemaHash,
    }
  }

  /**
   * Notify the synchronizer of a local change to a document.
   *
   * Triggers push to synced peers based on merge strategy.
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

    this.#dispatch({
      type: "synchronizer/local-doc-change",
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
  leastCommonVersion(docId: DocId): Version | null {
    const runtime = this.#docRuntimes.get(docId)
    if (!runtime) return null

    let lcv: Version | null = null

    for (const [, peerState] of this.model.peers) {
      const docSync = peerState.docSyncStates.get(docId)
      if (!docSync || docSync.status !== "synced") continue

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
    this.#docRuntimes.delete(docId)
    this.#dispatch({
      type: "synchronizer/doc-delete",
      docId,
    })
  }

  /**
   * Dismiss a document — remove locally and broadcast `dismiss` to peers.
   */
  dismissDocument(docId: DocId): void {
    this.#docRuntimes.delete(docId)
    this.#dispatch({
      type: "synchronizer/doc-dismiss",
      docId,
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

    for (const [_peerId, peerState] of this.model.peers) {
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
   * Subscribe to ready state changes.
   */
  /**
   * Subscribe to state-advanced events.
   *
   * The callback fires once per docId at quiescence when the document's
   * state has advanced — either from a local mutation (changefeed →
   * notifyLocalChange → handleLocalDocChange) or a network import
   * (handleOffer → cmd/import-doc-data → handleDocImported).
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
    for (const [_peerId, peerState] of this.model.peers) {
      const docSync = peerState.docSyncStates.get(docId)
      if (!docSync) continue

      if (docSync.status === "synced" || docSync.status === "absent") {
        // At least one peer has completed sync for this doc
        if (peerState.channels.size > 0) {
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
    this.#emitSyntheticPeerLeftEvents()
    this.#docRuntimes.clear()
    const [initialModel] = init(this.identity)
    this.model = initialModel
    this.transports.reset()
  }

  async shutdown(): Promise<void> {
    await this.transports.flush()
    this.#emitSyntheticPeerLeftEvents()
    const [initialModel] = init(this.identity)
    this.model = initialModel
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

  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
  // CHANNEL CALLBACKS — called by TransportManager
  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

  channelAdded(channel: ConnectedChannel): void {
    this.#dispatch({
      type: "synchronizer/channel-added",
      channel,
    })
  }

  channelEstablish(channel: ConnectedChannel): void {
    this.#dispatch({
      type: "synchronizer/establish-channel",
      channelId: channel.channelId,
    })
  }

  channelReceive(channelId: ChannelId, message: ChannelMsg): void {
    this.#dispatch({
      type: "synchronizer/channel-receive-message",
      envelope: { fromChannelId: channelId, message },
    })
  }

  channelRemoved(channel: Channel): void {
    this.#dispatch({
      type: "synchronizer/channel-removed",
      channel,
    })
  }

  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
  // DISPATCH — serialized message processing with quiescence flush
  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

  #dispatch(msg: SynchronizerMessage): void {
    this.#pendingMessages.push(msg)

    if (this.#dispatching) return

    this.#dispatching = true
    try {
      while (this.#pendingMessages.length > 0) {
        const nextMsg = this.#pendingMessages.shift()
        if (!nextMsg) break
        this.#dispatchInternal(nextMsg)
      }

      // Quiescence — drain all accumulators. Each drain snapshots its
      // buffer, clears the field, then pushes to listeners/transports.
      this.#drainOutbound()
      this.#drainReadyStateChanges()
      this.#drainStateAdvanced()
      this.#drainPeerEvents()
    } finally {
      this.#dispatching = false
    }
  }

  #dispatchInternal(msg: SynchronizerMessage): void {
    const [newModel, command, notification] = this.#updateFn(msg, this.model)
    this.model = newModel

    if (notification) {
      this.#accumulateNotification(notification)
    }

    if (command) {
      this.#executeCommand(command)
    }
  }

  /**
   * Accumulate a notification into the dirty set for this dispatch cycle.
   * Recursively flattens batch notifications.
   */
  #accumulateNotification(notification: Notification): void {
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
      case "notify/peer-joined":
        this.#pendingPeerEvents.push({
          type: "peer-joined",
          peer: notification.peer,
        })
        break
      case "notify/peer-left":
        this.#pendingPeerEvents.push({
          type: "peer-left",
          peer: notification.peer,
        })
        break
      case "notify/warning":
        console.warn(notification.message)
        break
      case "notify/batch":
        for (const sub of notification.notifications) {
          this.#accumulateNotification(sub)
        }
        break
    }
  }

  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
  // COMMAND EXECUTION — side effects
  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

  #executeCommand(command: Command): void {
    switch (command.type) {
      case "cmd/send-message":
        this.#outboundQueue.push(command.envelope)
        break

      case "cmd/send-offer":
        this.#executeSendOffer(command)
        break

      case "cmd/import-doc-data":
        this.#executeImportDocData(command)
        break

      case "cmd/stop-channel":
        command.channel.stop()
        break

      case "cmd/subscribe-doc":
        // No-op for now — the Exchange handles subscription wiring
        break

      case "cmd/request-doc-creation":
        // Fire-and-forget: if the callback calls exchange.get(), that
        // triggers registerDoc() → #dispatch(doc-ensure), which is
        // queued in #pendingMessages and processed before quiescence.
        this.#docCreationCallback?.(
          command.docId,
          command.peer,
          command.replicaType,
          command.mergeStrategy,
          command.schemaHash,
        )
        break

      case "cmd/notify-doc-dismissed":
        // Fire-and-forget: the Exchange's onDocDismissed callback
        // handles application-level cleanup (e.g. exchange.dismiss()).
        this.#docDismissedCallback?.(command.docId, command.peer, "remote")
        break

      case "cmd/dispatch":
        this.#dispatch(command.dispatch)
        break

      case "cmd/batch":
        for (const subcmd of command.commands) {
          this.#executeCommand(subcmd)
        }
        break
    }
  }

  /**
   * Build and queue an outbound offer for a document.
   *
   * Version-gap planning happens via `resolveOutboundVersionGap()`.
   * Effect execution stays here in the shell: warnings, payload export,
   * and outbound queue mutation.
   *
   * No mode branching needed — `replica` exists on both modes.
   * For interpreted docs, `runtime.replica` is the `Substrate` itself
   * (since `Substrate extends Replica`).
   */
  #executeSendOffer(command: {
    type: "cmd/send-offer"
    docId: DocId
    toChannelIds: ChannelId[]
    sinceVersion?: string
    reciprocate?: boolean
  }): void {
    const runtime = this.#docRuntimes.get(command.docId)
    if (!runtime) {
      console.warn(
        `[exchange] doc runtime not found, offer not sent: ${command.docId}`,
      )
      return
    }

    const enqueueOffer = (payload: SubstratePayload): void => {
      const version = runtime.replica.version().serialize()

      this.#outboundQueue.push({
        toChannelIds: command.toChannelIds,
        message: {
          type: "offer",
          docId: command.docId,
          payload,
          version,
          reciprocate: command.reciprocate,
        },
      })
    }

    if (command.sinceVersion) {
      const gap = resolveOutboundVersionGap(
        runtime.replica,
        runtime.replicaFactory,
        command.sinceVersion,
      )

      switch (gap.kind) {
        case "parse-error":
          console.warn(
            `[exchange] version parse failed for doc '${command.docId}':`,
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

  /**
   * Import document data from a peer and notify the model on success.
   *
   * Version-gap planning happens via `resolveInboundVersionGap()`.
   * Effect execution stays here in the shell: warnings, merge, and
   * follow-up dispatch.
   */
  #executeImportDocData(command: {
    type: "cmd/import-doc-data"
    docId: DocId
    payload: SubstratePayload
    version: string
    fromPeerId: PeerId
  }): void {
    const runtime = this.#docRuntimes.get(command.docId)
    if (!runtime) return

    const gap = resolveInboundVersionGap(
      runtime.replica,
      runtime.replicaFactory,
      command.version,
    )

    switch (gap.kind) {
      case "parse-error":
        console.warn(
          `[exchange] version parse failed for doc '${command.docId}':`,
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
    const isEntirety = command.payload.kind === "entirety"
    const hasEverSynced = (() => {
      for (const [, peerState] of this.model.peers) {
        const docSync = peerState.docSyncStates.get(command.docId)
        if (docSync && docSync.status === "synced") return true
      }
      return false
    })()

    if (isEntirety && hasEverSynced) {
      // Look up the peer identity for the policy predicate.
      const peerState = this.model.peers.get(command.fromPeerId)
      const peerIdentity = peerState?.identity ?? {
        peerId: command.fromPeerId,
      }

      const accept = this.#epochBoundary(
        command.docId,
        peerIdentity as PeerIdentityDetails,
        runtime.strategy,
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
          runtime.replica = runtime.replicaFactory.fromEntirety(command.payload)
        } catch (err) {
          console.warn(
            `[exchange] epoch boundary reset failed for doc '${command.docId}'.`,
            err,
          )
          return
        }

        const newVersion = runtime.replica.version().serialize()
        this.#dispatch({
          type: "synchronizer/doc-imported",
          docId: command.docId,
          version: newVersion,
          fromPeerId: command.fromPeerId,
        })
        return
      }
      // For interpreted substrates, fall through to normal merge —
      // plain substrates handle entirety correctly via executeBatch.
    }

    try {
      runtime.replica.merge(command.payload, "sync")
    } catch (err) {
      // Import failed — log and continue. A common cause is replica type
      // mismatch: e.g. Loro binary data fed to a Yjs decoder after switching
      // CRDT backends. Check for stale clients sending incompatible data.
      console.warn(
        `[exchange] import failed for doc '${command.docId}'. ` +
          `If you recently switched CRDT backends, stale clients may be sending incompatible data.`,
        err,
      )
      return
    }

    // Notify the model of successful import
    const newVersion = runtime.replica.version().serialize()
    this.#dispatch({
      type: "synchronizer/doc-imported",
      docId: command.docId,
      version: newVersion,
      fromPeerId: command.fromPeerId,
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

    // Rebuild peer map from model (single source of truth at quiescence)
    this.#peerHandle!.clear()
    for (const [peerId, peerState] of this.model.peers) {
      this.#peerHandle!.set(peerId, peerState.identity)
    }

    // Emit to subscribers
    this.#peerHandle!.emit({ changes: events })
  }

  #emitSyntheticPeerLeftEvents(): void {
    if (this.model.peers.size === 0 || !this.#peerHandle) return

    const events: PeerChange[] = Array.from(this.model.peers.values()).map(
      peerState => ({ type: "peer-left" as const, peer: peerState.identity }),
    )

    // Clear peer map (consistent with the about-to-be-wiped model)
    this.#peerHandle.clear()

    this.#peerHandle.emit({ changes: events })
  }

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

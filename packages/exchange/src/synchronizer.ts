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

import type {
  MergeStrategy,
  Replica,
  ReplicaFactory,
  Substrate,
  SubstratePayload,
  Version,
} from "@kyneta/schema"
import type { AnyAdapter } from "./adapter/adapter.js"
import { AdapterManager } from "./adapter/adapter-manager.js"
import type { Channel, ConnectedChannel } from "./channel.js"
import type { AuthorizePredicate, RoutePredicate } from "./exchange.js"
import type { AddressedEnvelope, ChannelMsg } from "./messages.js"
import {
  type Command,
  createSynchronizerUpdate,
  init,
  type SynchronizerMessage,
  type SynchronizerModel,
} from "./synchronizer-program.js"
import type {
  ChannelId,
  DocId,
  PeerId,
  PeerIdentityDetails,
  ReadyState,
} from "./types.js"

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
) => void

/**
 * Callback invoked when a peer sends a `dismiss` message for a document.
 * The Exchange wraps the user's `onDocDismissed` callback.
 */
export type DocDismissedCallback = (
  docId: DocId,
  peer: PeerIdentityDetails,
) => void

export type SynchronizerParams = {
  identity: PeerIdentityDetails
  adapters?: AnyAdapter[]
  route: RoutePredicate
  authorize: AuthorizePredicate
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
  readonly adapters: AdapterManager

  readonly #updateFn: ReturnType<typeof createSynchronizerUpdate>
  readonly #docRuntimes = new Map<DocId, DocRuntime>()
  readonly #docCreationCallback?: DocCreationCallback
  readonly #docDismissedCallback?: DocDismissedCallback

  /**
   * Outbound message queue — accumulated during dispatch, flushed at quiescence.
   * This batches outbound messages to avoid interleaving with model updates.
   */
  readonly #outboundQueue: AddressedEnvelope[] = []

  /**
   * Work queue for serialized async dispatch.
   * Ensures messages are processed one at a time and outbound messages
   * are flushed at quiescence (after all pending dispatches complete).
   */
  #dispatching = false
  readonly #pendingMessages: SynchronizerMessage[] = []

  model: SynchronizerModel

  // Event emitter for ready state changes
  readonly #readyStateListeners = new Set<
    (docId: DocId, readyStates: ReadyState[]) => void
  >()

  constructor({
    identity,
    adapters = [],
    route,
    authorize,
    onDocCreationRequested,
    onDocDismissed,
  }: SynchronizerParams) {
    this.identity = identity

    this.#updateFn = createSynchronizerUpdate({ route, authorize })
    this.#docCreationCallback = onDocCreationRequested
    this.#docDismissedCallback = onDocDismissed

    // Initialize model
    const [initialModel, initialCommand] = init(this.identity)
    this.model = initialModel

    // Create adapter context
    const adapterContext = {
      identity: this.identity,
      onChannelAdded: this.channelAdded.bind(this),
      onChannelRemoved: this.channelRemoved.bind(this),
      onChannelReceive: this.channelReceive.bind(this),
      onChannelEstablish: this.channelEstablish.bind(this),
    }

    // Create AdapterManager
    this.adapters = new AdapterManager({
      adapters,
      context: adapterContext,
      onReset: (adapter: AnyAdapter) => {
        for (const channel of adapter.channels) {
          this.channelRemoved(channel)
        }
      },
    })

    // Execute initial command
    if (initialCommand) {
      this.#executeCommand(initialCommand)
    }

    // Start all adapters
    this.adapters.startAll()
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
      mergeStrategy: runtime.strategy,
    })
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
   * Wait until a document is synced with at least one peer of the
   * specified kind.
   */
  async waitUntilReady(
    docId: DocId,
    kind: "network" | "storage" = "network",
    timeoutMs = 30000,
  ): Promise<void> {
    // Check if already ready
    if (this.#isReady(docId, kind)) return

    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined

      const listener = (changedDocId: DocId) => {
        if (changedDocId === docId && this.#isReady(docId, kind)) {
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
              `waitForSync timed out after ${timeoutMs}ms for doc '${docId}' (kind: ${kind})`,
            ),
          )
        }, timeoutMs)
      }
    })
  }

  /**
   * Subscribe to ready state changes.
   */
  onReadyStateChange(
    cb: (docId: DocId, readyStates: ReadyState[]) => void,
  ): () => void {
    this.#readyStateListeners.add(cb)
    return () => this.#readyStateListeners.delete(cb)
  }

  #isReady(docId: DocId, kind: "network" | "storage"): boolean {
    for (const [_peerId, peerState] of this.model.peers) {
      const docSync = peerState.docSyncStates.get(docId)
      if (!docSync) continue

      if (docSync.status === "synced" || docSync.status === "absent") {
        // Check if this peer has a channel of the requested kind
        for (const channelId of peerState.channels) {
          const channel = this.model.channels.get(channelId)
          if (channel && channel.kind === kind) {
            return true
          }
        }
      }
    }
    return false
  }

  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
  // PUBLIC API — Adapter management
  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

  async addAdapter(adapter: AnyAdapter): Promise<void> {
    await this.adapters.addAdapter(adapter)
  }

  async removeAdapter(adapterId: string): Promise<void> {
    await this.adapters.removeAdapter(adapterId)
  }

  hasAdapter(adapterId: string): boolean {
    return this.adapters.hasAdapter(adapterId)
  }

  getAdapter(adapterId: string): AnyAdapter | undefined {
    return this.adapters.getAdapter(adapterId)
  }

  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
  // PUBLIC API — Lifecycle
  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

  async flush(): Promise<void> {
    await this.adapters.flush()
  }

  reset(): void {
    this.#docRuntimes.clear()
    const [initialModel] = init(this.identity)
    this.model = initialModel
    this.adapters.reset()
  }

  async shutdown(): Promise<void> {
    await this.adapters.flush()
    const [initialModel] = init(this.identity)
    this.model = initialModel
    await this.adapters.shutdown()
  }

  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
  // CHANNEL CALLBACKS — called by AdapterManager
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
        const nextMsg = this.#pendingMessages.shift()!
        this.#dispatchInternal(nextMsg)
      }

      // Quiescence — flush outbound messages
      this.#flushOutbound()
      this.#emitReadyStateChanges()
    } finally {
      this.#dispatching = false
    }
  }

  #dispatchInternal(msg: SynchronizerMessage): void {
    const [newModel, command] = this.#updateFn(msg, this.model)
    this.model = newModel

    if (command) {
      this.#executeCommand(command)
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
        this.#docCreationCallback?.(command.docId, command.peer)
        break

      case "cmd/notify-doc-dismissed":
        // Fire-and-forget: the Exchange's onDocDismissed callback
        // handles application-level cleanup (e.g. exchange.dismiss()).
        this.#docDismissedCallback?.(command.docId, command.peer)
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
            console.warn(
              `[exchange] exportSince returned null for doc '${command.docId}' despite comparison '${gap.comparison}'`,
            )
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

    try {
      runtime.replica.merge(command.payload, "sync")
    } catch (err) {
      // Import failed — log and continue
      console.warn(`[exchange] import failed for doc '${command.docId}':`, err)
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

  #flushOutbound(): void {
    while (this.#outboundQueue.length > 0) {
      const envelope = this.#outboundQueue.shift()!
      this.adapters.send(envelope)
    }
  }

  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
  // READY STATE — emit changes after quiescence
  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

  #emitReadyStateChanges(): void {
    if (this.#readyStateListeners.size === 0) return

    // Emit for all tracked documents
    for (const docId of this.#docRuntimes.keys()) {
      const readyStates = this.getReadyStates(docId)
      for (const listener of this.#readyStateListeners) {
        listener(docId, readyStates)
      }
    }
  }
}

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

import type { Substrate, SubstratePayload, SubstrateFactory, MergeStrategy } from "@kyneta/schema"
import { executeBatch } from "@kyneta/schema"
import type { AnyAdapter } from "./adapter/adapter.js"
import { AdapterManager } from "./adapter/adapter-manager.js"
import type { Channel, ConnectedChannel } from "./channel.js"
import type { AddressedEnvelope, ChannelMsg } from "./messages.js"
import { createPermissions, type Permissions } from "./permissions.js"
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
 * Holds the runtime state for a document — the substrate, ref, and
 * factory that the pure synchronizer model doesn't track.
 */
export type DocRuntime = {
  docId: DocId
  substrate: Substrate<any>
  factory: SubstrateFactory<any>
  strategy: MergeStrategy
  ref: any // The interpreted Ref<S>
  schema: any // The schema (SchemaNode)
}

export type SynchronizerParams = {
  identity: PeerIdentityDetails
  adapters?: AnyAdapter[]
  permissions?: Partial<Permissions>
}

// ---------------------------------------------------------------------------
// Synchronizer
// ---------------------------------------------------------------------------

export class Synchronizer {
  readonly identity: PeerIdentityDetails
  readonly adapters: AdapterManager

  readonly #updateFn: ReturnType<typeof createSynchronizerUpdate>
  readonly #docRuntimes = new Map<DocId, DocRuntime>()

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

  constructor({ identity, adapters = [], permissions }: SynchronizerParams) {
    this.identity = identity

    this.#updateFn = createSynchronizerUpdate({
      permissions: createPermissions(permissions),
    })

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
   * Called by Exchange.get() after creating the substrate and ref.
   * The synchronizer tracks the runtime and dispatches doc-ensure
   * to begin sync.
   */
  registerDoc(runtime: DocRuntime): void {
    this.#docRuntimes.set(runtime.docId, runtime)

    this.#dispatch({
      type: "synchronizer/doc-ensure",
      docId: runtime.docId,
      version: runtime.substrate.version().serialize(),
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
      version: runtime.substrate.version().serialize(),
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
   * Remove a document from the synchronizer.
   */
  async removeDocument(docId: DocId): Promise<void> {
    this.#docRuntimes.delete(docId)
    this.#dispatch({
      type: "synchronizer/doc-delete",
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
   * Build and send an offer from the substrate.
   *
   * This is where the runtime interacts with the substrate to produce
   * the actual payload. The pure model only knows about serialized
   * version strings — the runtime resolves them to real Version objects
   * and calls exportSince/exportSnapshot on the substrate.
   */
  #executeSendOffer(command: {
    type: "cmd/send-offer"
    docId: DocId
    toChannelIds: ChannelId[]
    sinceVersion?: string
    reciprocate?: boolean
    forceSnapshot?: boolean
  }): void {
    const runtime = this.#docRuntimes.get(command.docId)
    if (!runtime) return

    let payload: SubstratePayload | null = null
    let offerType: "snapshot" | "delta" = "snapshot"

    // Try delta first if sinceVersion is provided and not forced to snapshot
    if (command.sinceVersion && !command.forceSnapshot) {
      try {
        const sinceVer = runtime.factory.parseVersion(command.sinceVersion)
        const currentVersion = runtime.substrate.version()
        const comparison = currentVersion.compare(sinceVer)

        // Only attempt delta if we're strictly ahead of the requester.
        // If versions are equal, the requester has the same version counter
        // but may have different content (e.g. one was seeded, one wasn't).
        // In that case, fall through to snapshot.
        if (comparison === "ahead" || comparison === "concurrent") {
          payload = runtime.substrate.exportSince(sinceVer)
          if (payload) {
            // Check for trivially empty deltas (e.g. JSON "[]")
            const isEmpty =
              payload.encoding === "json" &&
              typeof payload.data === "string" &&
              (payload.data === "[]" || payload.data === "")
            if (!isEmpty) {
              offerType = "delta"
            } else {
              payload = null // fall through to snapshot
            }
          }
        }
        // If "behind" or "equal", fall through to snapshot
      } catch {
        // Fall through to snapshot
      }
    }

    // Fallback to snapshot
    if (!payload) {
      payload = runtime.substrate.exportSnapshot()
      offerType = "snapshot"
    }

    const version = runtime.substrate.version().serialize()

    this.#outboundQueue.push({
      toChannelIds: command.toChannelIds,
      message: {
        type: "offer",
        docId: command.docId,
        offerType,
        payload,
        version,
        reciprocate: command.reciprocate,
      },
    })
  }

  /**
   * Import document data from a peer.
   *
   * For delta offers, calls substrate.importDelta().
   * For snapshot offers, reconstructs the substrate from scratch via
   * factory.fromSnapshot() and replaces the runtime's substrate and ref.
   *
   * For LWW substrates, the runtime compares timestamps before importing.
   * For causal/sequential, the substrate handles merge internally.
   */
  #executeImportDocData(command: {
    type: "cmd/import-doc-data"
    docId: DocId
    payload: SubstratePayload
    offerType: "snapshot" | "delta"
    version: string
    fromPeerId: PeerId
  }): void {
    const runtime = this.#docRuntimes.get(command.docId)
    if (!runtime) return

    // For LWW: compare timestamps and reject stale
    if (runtime.strategy === "lww") {
      try {
        const incomingVersion = runtime.factory.parseVersion(command.version)
        const currentVersion = runtime.substrate.version()
        const comparison = incomingVersion.compare(currentVersion)
        if (comparison === "behind" || comparison === "equal") {
          // Stale or duplicate — discard
          return
        }
      } catch {
        // If version parsing fails, still try to import
      }
    }

    try {
      if (command.offerType === "snapshot") {
        // Snapshot: reconstruct the substrate from the payload and
        // rebuild the interpreter stack. This is an epoch boundary.
        this.#importSnapshot(runtime, command.payload)
      } else {
        // Delta: apply incrementally
        runtime.substrate.importDelta(command.payload, "sync")
      }
    } catch (err) {
      // Import failed — log and continue
      console.warn(`[exchange] import failed for doc '${command.docId}':`, err)
      return
    }

    // Notify the model of successful import
    const newVersion = runtime.substrate.version().serialize()
    this.#dispatch({
      type: "synchronizer/doc-imported",
      docId: command.docId,
      version: newVersion,
      fromPeerId: command.fromPeerId,
    })
  }

  /**
   * Import a snapshot payload into an existing document runtime.
   *
   * This is an epoch boundary for substrates that can't handle snapshot
   * payloads via importDelta (e.g. PlainSubstrate).
   *
   * Strategy:
   * 1. Try importDelta first (works for Loro which handles both
   *    snapshots and updates through import()).
   * 2. If that fails, reconstruct a temporary substrate from the
   *    snapshot, read its state, and replay as ReplaceChange ops
   *    into the existing substrate via executeBatch. This keeps
   *    the original ref objects alive.
   */
  #importSnapshot(runtime: DocRuntime, payload: SubstratePayload): void {
    // Strategy 1: try importDelta (works for Loro and any substrate
    // whose importDelta accepts snapshot payloads)
    try {
      runtime.substrate.importDelta(payload, "sync")
      return
    } catch {
      // importDelta doesn't support this payload format — use strategy 2
    }

    // Strategy 2: reconstruct from snapshot, read state, replay into
    // existing substrate as ReplaceChange ops.
    const tempSubstrate = runtime.factory.fromSnapshot(payload, runtime.schema)
    const tempSnapshot = tempSubstrate.exportSnapshot()

    if (
      tempSnapshot.encoding === "json" &&
      typeof tempSnapshot.data === "string"
    ) {
      const state = JSON.parse(tempSnapshot.data) as Record<string, unknown>
      const ctx = runtime.substrate.context()

      // Build ops: one ReplaceChange per top-level key
      const ops: Array<{
        path: Array<{ type: "key"; key: string }>
        change: { type: "replace"; value: unknown }
      }> = []
      for (const [key, value] of Object.entries(state)) {
        ops.push({
          path: [{ type: "key" as const, key }],
          change: { type: "replace" as const, value },
        })
      }

      if (ops.length > 0) {
        executeBatch(ctx, ops, "sync")
      }
    }
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

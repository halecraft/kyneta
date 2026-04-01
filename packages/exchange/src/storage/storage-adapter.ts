// storage-adapter — protocol translator between the exchange and StorageBackend.
//
// The StorageAdapter extends Adapter<void> and translates the 6-message
// sync protocol into StorageBackend operations. It creates a single
// channel with kind "storage", which causes the synchronizer to:
// - Bypass route filtering (storage is local infrastructure)
// - Bypass authorize checks on incoming offers
// - Recognize the channel for storage-first sync probes
//
// Message flow:
//   establish-request → reply with establish-response (identity)
//   discover          → check backend.has() for each docId, reply with available
//   interest          → loadAll from backend, send offers, then completion interest
//   offer             → append to backend (persist incoming data)
//   dismiss           → delete from backend
//
// The reply function delivers messages synchronously via
// storageChannel.onReceive(). The Synchronizer's dispatch queue
// handles recursion prevention by queuing messages and processing
// them iteratively.

import type { SubstratePayload } from "@kyneta/schema"
import type { GeneratedChannel } from "../channel.js"
import type { ChannelMsg } from "../messages.js"
import type { DocId } from "../types.js"
import { generatePeerId } from "../utils.js"
import { Adapter } from "../adapter/adapter.js"
import type { ConnectedChannel } from "../channel.js"
import type { StorageBackend } from "./storage-backend.js"

// ---------------------------------------------------------------------------
// StorageAdapter
// ---------------------------------------------------------------------------

export class StorageAdapter extends Adapter<void> {
  /**
   * Storage adapters always create storage channels.
   * This overrides the default "network" kind from the base Adapter class.
   */
  override readonly kind = "storage" as const

  readonly backend: StorageBackend

  /**
   * The single channel this adapter creates for communicating with
   * the synchronizer. Set during onStart().
   */
  protected storageChannel?: ConnectedChannel

  /**
   * A unique peer ID for this storage adapter instance. Generated
   * once at construction so it is stable across the adapter's lifetime.
   */
  private readonly storagePeerId: string = generatePeerId()

  /**
   * Track pending async operations (saves, loads, etc.) so they can
   * be awaited during flush/shutdown.
   */
  readonly #pendingOps: Set<Promise<void>> = new Set()

  /**
   * Per-doc operation chains ensuring sequential backend access.
   * Each docId maps to the tail of a promise chain — new operations
   * for that docId await the previous one before proceeding.
   */
  readonly #docQueues: Map<DocId, Promise<void>> = new Map()

  constructor({
    backend,
    adapterType = "storage",
    adapterId,
  }: {
    backend: StorageBackend
    adapterType?: string
    adapterId?: string
  }) {
    super({ adapterType, adapterId })
    this.backend = backend
  }

  // =========================================================================
  // Channel generation
  // =========================================================================

  /**
   * Generate channel actions for storage operations.
   *
   * The send function wraps handleChannelMessage to track pending
   * async operations, enabling flush() to await all in-flight saves.
   */
  protected generate(): GeneratedChannel {
    return {
      kind: this.kind,
      adapterType: this.adapterType,
      send: (msg: ChannelMsg) => {
        const op = this.#handleChannelMessage(msg).catch(error => {
          console.error(
            `[storage-adapter] unhandled error in storage channel message:`,
            error,
          )
        })
        this.#trackOp(op)
      },
      stop: () => {},
    }
  }

  // =========================================================================
  // Lifecycle
  // =========================================================================

  /**
   * Start the storage adapter by creating its single channel and
   * triggering the establishment handshake.
   */
  async onStart(): Promise<void> {
    this.storageChannel = this.addChannel()
    this.establishChannel(this.storageChannel.channelId)
  }

  /**
   * Stop the storage adapter: flush pending operations, remove channel.
   */
  async onStop(): Promise<void> {
    await this.flush()
    if (this.storageChannel) {
      this.removeChannel(this.storageChannel.channelId)
      this.storageChannel = undefined
    }
  }

  // =========================================================================
  // Flush
  // =========================================================================

  /**
   * Await all pending async storage operations.
   *
   * Call this before shutting down to ensure all data has been persisted.
   * The loop handles operations that spawn new operations (e.g. a
   * compaction triggered by a save).
   */
  override async flush(): Promise<void> {
    while (this.#pendingOps.size > 0) {
      await Promise.all(this.#pendingOps)
    }
  }

  /**
   * Track an async operation so flush() can await it.
   */
  #trackOp(op: Promise<void>): void {
    this.#pendingOps.add(op)
    op.finally(() => {
      this.#pendingOps.delete(op)
    })
  }

  // =========================================================================
  // Per-doc serialization
  // =========================================================================

  /**
   * Enqueue a backend operation for a specific docId, ensuring
   * sequential execution per document.
   *
   * Uses a promise-chain pattern: each new operation for a docId
   * is chained onto the previous one. Cross-document operations
   * remain concurrent for throughput.
   */
  #enqueueForDoc(docId: DocId, fn: () => Promise<void>): Promise<void> {
    const prev = this.#docQueues.get(docId) ?? Promise.resolve()
    const next = prev.then(fn, fn) // Run fn regardless of prev result
    this.#docQueues.set(docId, next)

    // Clean up the queue entry when this tail settles (resolves OR rejects)
    // and nothing new has been chained on since. We must handle both outcomes
    // to avoid an unhandled rejection from the cleanup branch.
    const cleanup = () => {
      if (this.#docQueues.get(docId) === next) {
        this.#docQueues.delete(docId)
      }
    }
    next.then(cleanup, cleanup)

    return next
  }

  // =========================================================================
  // Message dispatch
  // =========================================================================

  /**
   * Handle incoming channel messages from the synchronizer.
   * Translates sync protocol messages into StorageBackend operations.
   */
  async #handleChannelMessage(msg: ChannelMsg): Promise<void> {
    switch (msg.type) {
      case "establish-request":
        return this.#handleEstablishRequest()

      case "establish-response":
        // Nothing to do — storage initiates, doesn't receive responses
        break

      case "discover":
        return this.#handleDiscover(msg.docIds)

      case "interest":
        return this.#handleInterest(msg.docId, msg.version, msg.reciprocate)

      case "offer":
        return this.#handleOffer(msg.docId, msg.payload, msg.version)

      case "dismiss":
        return this.#handleDismiss(msg.docId)
    }
  }

  // =========================================================================
  // Message handlers
  // =========================================================================

  /**
   * Respond to establishment request with our identity.
   *
   * Storage is always ready — no async initialization needed.
   * We respond immediately so the channel becomes established and
   * the synchronizer can route messages to us.
   */
  #handleEstablishRequest(): void {
    this.#reply({
      type: "establish-response",
      identity: {
        peerId: this.storagePeerId,
        name: this.adapterType,
        type: "service",
      },
    })
  }

  /**
   * Handle discover probes: check which of the requested docIds
   * exist in storage and reply with the available ones.
   *
   * This is the storage-first sync entry point: the synchronizer
   * sends discover to all storage channels when a network peer
   * requests an unknown document.
   */
  async #handleDiscover(docIds: DocId[]): Promise<void> {
    const available: DocId[] = []
    for (const docId of docIds) {
      if (await this.backend.has(docId)) {
        available.push(docId)
      }
    }
    if (available.length > 0) {
      this.#reply({
        type: "discover",
        docIds: available,
      })
    }
  }

  /**
   * Handle interest: hydrate a document from storage.
   *
   * If storage has entries for the doc: send one offer per entry
   * (with the stored payload and version), then send a completion
   * interest. All replies are synchronous (via onReceive) so the
   * synchronizer processes them in a single dispatch cycle.
   *
   * If storage has nothing: send only the completion interest
   * (signals "I have nothing for this doc").
   *
   * The completion interest also subscribes the storage channel
   * to future updates for this doc.
   */
  async #handleInterest(
    docId: DocId,
    version?: string,
    reciprocate?: boolean,
  ): Promise<void> {
    await this.#enqueueForDoc(docId, async () => {
      // Load all stored entries and send offers
      for await (const entry of this.backend.loadAll(docId)) {
        this.#reply({
          type: "offer",
          docId,
          payload: entry.payload,
          version: entry.version,
        })
      }

      // Send completion interest — "I'm done sending offers for this doc"
      // The version we send is the latest stored version, but since we may
      // have sent nothing, we use the requester's version (or empty string).
      // The synchronizer uses this as a completion signal, not for version
      // comparison.
      this.#reply({
        type: "interest",
        docId,
        version: version ?? "",
        reciprocate: false,
      })
    })
  }

  /**
   * Handle offer: persist incoming data from the synchronizer.
   *
   * When a network peer sends an offer that gets imported by the
   * synchronizer, the synchronizer relays it to all channels including
   * storage. We extract the payload and version and append to storage.
   */
  async #handleOffer(
    docId: DocId,
    payload: SubstratePayload,
    version: string,
  ): Promise<void> {
    await this.#enqueueForDoc(docId, async () => {
      await this.backend.append(docId, { payload, version })
    })
  }

  /**
   * Handle dismiss: delete all stored entries for a document.
   */
  async #handleDismiss(docId: DocId): Promise<void> {
    await this.#enqueueForDoc(docId, async () => {
      await this.backend.delete(docId)
    })
  }

  // =========================================================================
  // Reply helper
  // =========================================================================

  /**
   * Send a reply message through the storage channel.
   *
   * Delivers messages synchronously via storageChannel.onReceive().
   * The Synchronizer's dispatch queue handles recursion prevention
   * by queuing messages and processing them iteratively.
   */
  #reply(msg: ChannelMsg): void {
    if (!this.storageChannel) {
      throw new Error("Cannot reply: storage channel not initialized")
    }
    this.storageChannel.onReceive(msg)
  }
}
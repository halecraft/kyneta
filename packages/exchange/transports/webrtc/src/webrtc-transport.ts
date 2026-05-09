// webrtc-transport — BYODC WebRTC data channel transport for @kyneta/exchange.
//
// "Bring Your Own Data Channel" design: the application manages WebRTC
// connections (signaling, ICE, media streams). This transport attaches
// to already-established data channels for kyneta document sync.
//
// Uses the shared binary pipeline from @kyneta/wire (same as WebSocket):
//   encodeBinaryAndSend — outbound: encode → fragment → sendFn
//   decodeBinaryMessages — inbound: reassemble → decode → ChannelMsg[]
//
// The transport accepts any object satisfying `DataChannelLike` — a
// 5-member interface that native RTCDataChannel satisfies structurally
// and that libraries like simple-peer can conform to via a trivial bridge.

import type {
  ChannelId,
  ChannelMsg,
  GeneratedChannel,
  TransportFactory,
} from "@kyneta/transport"
import { Transport } from "@kyneta/transport"
import {
  type AliasState,
  applyInboundAliasing,
  applyOutboundAliasing,
  createFrameIdCounter,
  decodeBinaryWires,
  emptyAliasState,
  encodeWireFrameAndSend,
  FragmentReassembler,
} from "@kyneta/wire"
import type { DataChannelLike } from "./data-channel-like.js"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default fragment threshold in bytes.
 *
 * SCTP (the underlying transport for WebRTC data channels) has a message
 * size limit of approximately 256KB. 200KB provides a safe margin.
 *
 * This differs from the WebSocket transport's 100KB default, which
 * targets AWS API Gateway's 128KB limit. WebRTC has no such gateway.
 */
export const DEFAULT_FRAGMENT_THRESHOLD = 200 * 1024

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Configuration options for the WebRTC transport.
 */
export interface WebrtcTransportOptions {
  /**
   * Fragment threshold in bytes. Messages larger than this are fragmented
   * for SCTP compatibility. Set to 0 to disable fragmentation (not recommended).
   *
   * @default 204800 (200KB)
   */
  fragmentThreshold?: number
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/**
 * Context for each attached data channel — stored per remotePeerId.
 */
type DataChannelContext = {
  remotePeerId: string
  channel: DataChannelLike
}

/**
 * Internal tracking for an attached data channel.
 */
type AttachedChannel = {
  remotePeerId: string
  channel: DataChannelLike
  channelId: ChannelId | null
  reassembler: FragmentReassembler
  nextFrameId: () => number
  /** Per-channel alias state (Phase 4). */
  aliasState: AliasState
  cleanup: () => void
}

// ---------------------------------------------------------------------------
// WebrtcTransport
// ---------------------------------------------------------------------------

/**
 * WebRTC data channel transport for @kyneta/exchange.
 *
 * Follows a "Bring Your Own Data Channel" (BYODC) design — the application
 * manages WebRTC connections and attaches data channels to this transport
 * for kyneta document synchronization.
 *
 * Uses binary CBOR encoding with transport-level fragmentation via
 * `@kyneta/wire` — the same pipeline as the WebSocket transport.
 *
 * ## Usage
 *
 * ```typescript
 * import { Exchange } from "@kyneta/exchange"
 * import { createWebrtcTransport } from "@kyneta/webrtc-transport"
 *
 * const webrtcTransport = createWebrtcTransport()
 *
 * const exchange = new Exchange({
 *   id: { peerId: "alice", name: "Alice" },
 *   transports: [webrtcTransport],
 * })
 *
 * // When a WebRTC connection is established:
 * const cleanup = transport.attachDataChannel(remotePeerId, dataChannel)
 *
 * // When done:
 * cleanup() // or transport.detachDataChannel(remotePeerId)
 * ```
 *
 * ## Ownership
 *
 * The transport does NOT own the data channel. `detachDataChannel()`
 * removes the sync channel and event listeners but does not close the
 * data channel or the peer connection. The application manages the
 * WebRTC connection lifecycle independently.
 */
export class WebrtcTransport extends Transport<DataChannelContext> {
  /**
   * Map of remotePeerId → attached channel tracking.
   */
  readonly #attachedChannels = new Map<string, AttachedChannel>()

  /**
   * Fragment threshold in bytes.
   */
  readonly #fragmentThreshold: number

  constructor(options?: WebrtcTransportOptions) {
    super({ transportType: "webrtc-datachannel" })
    this.#fragmentThreshold =
      options?.fragmentThreshold ?? DEFAULT_FRAGMENT_THRESHOLD
  }

  // ==========================================================================
  // Transport abstract method implementations
  // ==========================================================================

  /**
   * Generate a channel for a data channel context.
   *
   * Called internally by the `Transport` base class when `addChannel()` is
   * invoked. Users never call this directly — use `attachDataChannel()`.
   */
  protected generate(context: DataChannelContext): GeneratedChannel {
    const { channel } = context

    return {
      transportType: this.transportType,
      send: (msg: ChannelMsg) => {
        const attached = this.#attachedChannels.get(context.remotePeerId)
        if (!attached || channel.readyState !== "open") {
          return
        }
        const { state, wire } = applyOutboundAliasing(attached.aliasState, msg)
        attached.aliasState = state
        encodeWireFrameAndSend(
          wire,
          data => channel.send(data),
          this.#fragmentThreshold,
          attached.nextFrameId,
        )
      },
      stop: () => {
        // Cleanup is handled by detachDataChannel().
        // This callback fires when the internal channel is removed.
      },
    }
  }

  /**
   * Called when the transport starts.
   *
   * No-op for WebRTC — channels are added dynamically via
   * `attachDataChannel()`, not at start time.
   */
  async onStart(): Promise<void> {}

  /**
   * Called when the transport stops.
   *
   * Detaches all attached data channels and cleans up resources.
   */
  async onStop(): Promise<void> {
    for (const remotePeerId of [...this.#attachedChannels.keys()]) {
      this.detachDataChannel(remotePeerId)
    }
  }

  // ==========================================================================
  // Public API — data channel management
  // ==========================================================================

  /**
   * Attach a data channel for a remote peer.
   *
   * Creates an internal sync channel when the data channel is open
   * (or waits for the `"open"` event if still connecting). The sync
   * channel triggers the establishment handshake with the remote peer.
   *
   * If a data channel is already attached for this peer, the old one
   * is detached first.
   *
   * @param remotePeerId - The stable peer ID of the remote peer
   * @param channel - Any object satisfying `DataChannelLike`
   * @returns A cleanup function that calls `detachDataChannel(remotePeerId)`
   */
  attachDataChannel(
    remotePeerId: string,
    channel: DataChannelLike,
  ): () => void {
    // Detach existing channel for this peer if any
    if (this.#attachedChannels.has(remotePeerId)) {
      this.detachDataChannel(remotePeerId)
    }

    // Best-effort: request arraybuffer mode for incoming data.
    // The message handler doesn't depend on this — it accepts both
    // ArrayBuffer and Uint8Array regardless.
    channel.binaryType = "arraybuffer"

    // Create reassembler for this data channel
    const reassembler = new FragmentReassembler({ timeoutMs: 10_000 })

    // Event handlers — stored as named functions for removeEventListener
    const onOpen = () => {
      this.#createSyncChannel(remotePeerId)
    }

    const onClose = () => {
      this.#removeSyncChannel(remotePeerId)
    }

    const onError = () => {
      this.#removeSyncChannel(remotePeerId)
    }

    const onMessage = (event: any) => {
      this.#handleMessage(remotePeerId, event)
    }

    // Cleanup function to remove all event listeners
    const cleanup = () => {
      channel.removeEventListener("open", onOpen)
      channel.removeEventListener("close", onClose)
      channel.removeEventListener("error", onError)
      channel.removeEventListener("message", onMessage)
    }

    // Register event listeners
    channel.addEventListener("open", onOpen)
    channel.addEventListener("close", onClose)
    channel.addEventListener("error", onError)
    channel.addEventListener("message", onMessage)

    // Track the attached channel
    const attached: AttachedChannel = {
      remotePeerId,
      channel,
      channelId: null,
      reassembler,
      nextFrameId: createFrameIdCounter(),
      aliasState: emptyAliasState(),
      cleanup,
    }
    this.#attachedChannels.set(remotePeerId, attached)

    // If the channel is already open, create the sync channel immediately
    if (channel.readyState === "open") {
      this.#createSyncChannel(remotePeerId)
    }

    return () => this.detachDataChannel(remotePeerId)
  }

  /**
   * Detach a data channel for a remote peer.
   *
   * Removes the sync channel, cleans up event listeners, and disposes
   * the reassembler. Does NOT close the data channel — the application
   * manages the WebRTC connection lifecycle.
   *
   * @param remotePeerId - The peer ID to detach
   */
  detachDataChannel(remotePeerId: string): void {
    const attached = this.#attachedChannels.get(remotePeerId)
    if (!attached) return

    // Remove the sync channel if it exists
    this.#removeSyncChannel(remotePeerId)

    // Dispose the reassembler to clean up timers
    attached.reassembler.dispose()

    // Remove event listeners from the data channel
    attached.cleanup()

    // Remove from tracking
    this.#attachedChannels.delete(remotePeerId)
  }

  /**
   * Check if a data channel is attached for a peer.
   */
  hasDataChannel(remotePeerId: string): boolean {
    return this.#attachedChannels.has(remotePeerId)
  }

  /**
   * Get all peer IDs with attached data channels.
   */
  getAttachedPeerIds(): string[] {
    return [...this.#attachedChannels.keys()]
  }

  // ==========================================================================
  // Internal — sync channel lifecycle
  // ==========================================================================

  /**
   * Create an internal sync channel for an attached data channel.
   *
   * Called when the data channel's `"open"` event fires (or immediately
   * if already open on attach). The sync channel is registered with the
   * Transport base class, which triggers the establishment handshake.
   */
  #createSyncChannel(remotePeerId: string): void {
    const attached = this.#attachedChannels.get(remotePeerId)
    if (!attached) return

    // Don't create if already exists
    if (attached.channelId !== null) return

    // addChannel() creates and registers the sync channel
    const syncChannel = this.addChannel({
      remotePeerId,
      channel: attached.channel,
    })
    attached.channelId = syncChannel.channelId

    // Start the establishment handshake
    this.establishChannel(syncChannel.channelId)
  }

  /**
   * Remove the internal sync channel for a peer.
   */
  #removeSyncChannel(remotePeerId: string): void {
    const attached = this.#attachedChannels.get(remotePeerId)
    if (!attached || attached.channelId === null) return

    this.removeChannel(attached.channelId)
    attached.channelId = null
  }

  // ==========================================================================
  // Internal — message handling
  // ==========================================================================

  /**
   * Handle an incoming message from a data channel.
   *
   * Extracts binary data from the event, feeding both `ArrayBuffer`
   * (native RTCDataChannel with binaryType "arraybuffer") and
   * `Uint8Array` (simple-peer and other wrappers) into the shared
   * decode pipeline.
   */
  #handleMessage(remotePeerId: string, event: any): void {
    const attached = this.#attachedChannels.get(remotePeerId)
    if (!attached || attached.channelId === null) return

    const syncChannel = this.channels.get(attached.channelId)
    if (!syncChannel) return

    // Extract bytes — robust to both ArrayBuffer and Uint8Array
    const raw = event.data
    const bytes =
      raw instanceof ArrayBuffer
        ? new Uint8Array(raw)
        : raw instanceof Uint8Array
          ? raw
          : null

    if (!bytes) {
      // Unexpected data type (e.g. string) — ignore silently
      return
    }

    try {
      const wires = decodeBinaryWires(bytes, attached.reassembler)
      if (!wires) return
      for (const wire of wires) {
        const result = applyInboundAliasing(attached.aliasState, wire)
        attached.aliasState = result.state
        if (result.error || !result.msg) {
          console.warn(
            `[webrtc-transport] alias resolution failed for peer ${remotePeerId}:`,
            result.error,
          )
          continue
        }
        syncChannel.onReceive(result.msg)
      }
    } catch (error) {
      console.error(
        `[webrtc-transport] Failed to decode message from peer ${remotePeerId}:`,
        error,
      )
    }
  }
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

/**
 * Create a WebRTC transport factory for use with `Exchange`.
 *
 * Returns a `TransportFactory` — pass directly to
 * `Exchange({ transports: [...] })`. The returned transport instance
 * exposes `attachDataChannel()` / `detachDataChannel()` for BYODC
 * data channel management.
 *
 * To access the transport instance after creation, use
 * `exchange.getTransport("webrtc-datachannel")`.
 *
 * @example
 * ```typescript
 * import { Exchange } from "@kyneta/exchange"
 * import { createWebrtcTransport } from "@kyneta/webrtc-transport"
 *
 * const exchange = new Exchange({
 *   id: { peerId: "alice", name: "Alice" },
 *   transports: [createWebrtcTransport()],
 * })
 * ```
 */
export function createWebrtcTransport(
  options?: WebrtcTransportOptions,
): TransportFactory {
  return () => new WebrtcTransport(options)
}

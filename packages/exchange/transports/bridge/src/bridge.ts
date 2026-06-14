// bridge-adapter — in-process transport with Pipeline-based delivery.
//
// BridgeTransport is a real transport that runs the full wire pipeline
// (aliasing, framing, fragmentation) end-to-end via per-channel
// Pipeline<"binary"> instances — exactly like every other binary
// transport. Async delivery is preserved via `queueMicrotask()` to keep
// test behavior representative of real network adapters.
//
// Usage:
//   const bridge = new Bridge()
//   const exchangeA = new Exchange({
//     transports: [createBridgeTransport({ transportId: "peer-a", bridge })],
//   })

import type { ChannelId, GeneratedChannel } from "@kyneta/transport"
import { Pipeline, Transport } from "@kyneta/transport"

// ---------------------------------------------------------------------------
// Bridge — message router connecting multiple BridgeTransports in-process
// ---------------------------------------------------------------------------

/**
 * In-process byte router connecting multiple `BridgeTransport`s,
 * keyed by each transport's unique `transportId`.
 *
 * Channel-level sends route through per-channel `Pipeline<"binary">`
 * instances and call `routeBytes`.
 */
export class Bridge {
  readonly transports = new Map<string, BridgeTransport>()

  addTransport(transport: BridgeTransport): void {
    if (!transport.transportId) {
      throw new Error("can't add transport without transport id")
    }
    this.transports.set(transport.transportId, transport)
  }

  removeTransport(transportId: string): void {
    this.transports.delete(transportId)
  }

  /**
   * Route already-encoded bytes from one transport to another. The
   * receiving transport's `deliverBytes` is responsible for decoding
   * and applying the inbound alias transformer.
   *
   * Used by `BridgeTransport`'s channel send path.
   */
  routeBytes(
    fromTransportId: string,
    toTransportId: string,
    bytes: Uint8Array<ArrayBuffer>,
  ): void {
    const toTransport = this.transports.get(toTransportId)
    if (!toTransport) return
    toTransport.deliverBytes(fromTransportId, bytes)
  }

  get transportIds(): Set<string> {
    return new Set(this.transports.keys())
  }
}

// ---------------------------------------------------------------------------
// BridgeTransport — in-process network adapter for testing
// ---------------------------------------------------------------------------

type BridgeTransportContext = {
  targetTransportId: string
}

export type BridgeTransportParams = {
  /** Unique identifier for this transport instance (e.g. "peer-a", "server"). */
  transportId: string
  /**
   * Transport type category. Defaults to "bridge".
   * Stored in ChannelMeta for informational purposes.
   */
  transportType?: string
  bridge: Bridge
}

/**
 * In-memory transport that runs the full wire pipeline end-to-end
 * via per-channel `Pipeline<"binary">` instances. Tests that use this
 * transport exercise the same wire path as production transports.
 *
 * @example
 * ```typescript
 * const bridge = new Bridge()
 * const exchangeA = new Exchange({
 *   transports: [createBridgeTransport({ transportId: "peer-a", bridge })],
 * })
 * ```
 */
export class BridgeTransport extends Transport<BridgeTransportContext> {
  readonly bridge: Bridge

  // Track which remote transport each channel connects to.
  private channelToAdapter = new Map<ChannelId, string>()
  private adapterToChannel = new Map<string, ChannelId>()

  // Per-channel pipeline. Created with the channel; lives until removal.
  // Keyed by channelId.
  private pipelineByChannel = new Map<ChannelId, Pipeline<"binary">>()

  constructor({ transportId, transportType, bridge }: BridgeTransportParams) {
    super({ transportType: transportType ?? "bridge", transportId })
    this.bridge = bridge
  }

  generate(context: BridgeTransportContext): GeneratedChannel {
    return {
      transportType: this.transportType,
      send: msg => {
        const channelId = this.adapterToChannel.get(context.targetTransportId)
        if (channelId === undefined) return
        const pipeline = this.pipelineByChannel.get(channelId)
        if (!pipeline) return
        for (const r of pipeline.send(msg)) {
          if (r.ok) {
            this.bridge.routeBytes(
              this.transportId,
              context.targetTransportId,
              r.value,
            )
          }
        }
      },
      stop: () => {
        // Cleanup handled by removeChannel.
      },
    }
  }

  async onStart(): Promise<void> {
    this.bridge.addTransport(this)

    // Phase 1: create channels on both sides (no establish yet).
    // Doing remote-side and local-side creation separately ensures both
    // peers' `adapterToChannel` maps are populated before the joining
    // side initiates the handshake — otherwise the joining side's
    // establish message would arrive at a remote that hasn't routed
    // bytes back yet.
    for (const [transportId, adapter] of this.bridge.transports) {
      if (transportId !== this.transportId) {
        adapter.createChannelTo(this.transportId)
      }
    }
    for (const transportId of this.bridge.transports.keys()) {
      if (transportId !== this.transportId) {
        this.createChannelTo(transportId)
      }
    }

    // Phase 2: only the joining transport initiates establish. The
    // already-started side learns the joining peer's identity from
    // the establish handshake it echoes back.
    for (const channelId of this.adapterToChannel.values()) {
      this.establishChannel(channelId)
    }
  }

  async onStop(): Promise<void> {
    for (const [transportId, adapter] of this.bridge.transports) {
      if (transportId !== this.transportId) {
        adapter.removeChannelTo(this.transportId)
      }
    }
    this.bridge.removeTransport(this.transportId)

    for (const channelId of this.channelToAdapter.keys()) {
      this.removeChannel(channelId)
    }
    for (const pipeline of this.pipelineByChannel.values()) {
      pipeline.dispose()
    }
    this.pipelineByChannel.clear()
    this.channelToAdapter.clear()
    this.adapterToChannel.clear()
  }

  createChannelTo(targetTransportId: string): void {
    if (this.adapterToChannel.has(targetTransportId)) return
    const channel = this.addChannel({ targetTransportId })
    this.channelToAdapter.set(channel.channelId, targetTransportId)
    this.adapterToChannel.set(targetTransportId, channel.channelId)
    this.pipelineByChannel.set(
      channel.channelId,
      new Pipeline({
        send: "binary",
        opts: {
          threshold: 100 * 1024,
          onError: (e, dir) =>
            console.warn(`[BridgeTransport] wire error (${dir}):`, e),
          onFrame: this.frameObserver,
        },
      }),
    )
  }

  removeChannelTo(targetTransportId: string): void {
    const channelId = this.adapterToChannel.get(targetTransportId)
    if (channelId !== undefined) {
      this.removeChannel(channelId)
      this.channelToAdapter.delete(channelId)
      this.adapterToChannel.delete(targetTransportId)
      this.pipelineByChannel.get(channelId)?.dispose()
      this.pipelineByChannel.delete(channelId)
    }
  }

  /**
   * Deliver encoded bytes to the appropriate channel.
   *
   * Routes through the per-channel `Pipeline.receive()` which handles
   * decoding, deframing, reassembly, and alias resolution. Delivers
   * each resolved message asynchronously via `queueMicrotask()`.
   */
  deliverBytes(fromTransportId: string, bytes: Uint8Array<ArrayBuffer>): void {
    const channelId = this.adapterToChannel.get(fromTransportId)
    if (channelId === undefined) return
    const channel = this.channels.get(channelId)
    if (!channel) return
    const pipeline = this.pipelineByChannel.get(channelId)
    if (!pipeline) return
    for (const r of pipeline.receive(bytes)) {
      if (r.ok) {
        const msg = r.value
        queueMicrotask(() => {
          channel.onReceive(msg)
        })
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

/**
 * Create a BridgeTransport factory for in-process testing.
 *
 * @example
 * ```typescript
 * const bridge = new Bridge()
 * const exchangeA = new Exchange({
 *   transports: [createBridgeTransport({ transportId: "peer-a", bridge })],
 * })
 * ```
 */
export function createBridgeTransport(
  params: BridgeTransportParams,
): BridgeTransport {
  return new BridgeTransport(params)
}

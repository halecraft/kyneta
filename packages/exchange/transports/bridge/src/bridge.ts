// bridge-adapter — in-process transport with alias-aware delivery.
//
// BridgeTransport is a real transport that runs the alias-aware pipeline
// end-to-end and applies the docId/schemaHash alias transformer at the
// channel send/receive boundary — exactly like every other binary
// transport. Async delivery is preserved via `queueMicrotask()` to keep
// test behavior representative of real network adapters.
//
// Usage:
//   const bridge = new Bridge()
//   const exchangeA = new Exchange({
//     transports: [createBridgeTransport({ transportId: "peer-a", bridge })],
//   })

import type {
  ChannelId,
  GeneratedChannel,
  TransportFactory,
} from "@kyneta/transport"
import { Transport } from "@kyneta/transport"
import {
  type AliasState,
  applyInboundAliasing,
  applyOutboundAliasing,
  decodeWireMessage,
  emptyAliasState,
  encodeWireMessage,
} from "@kyneta/wire"

// ---------------------------------------------------------------------------
// Bridge — message router connecting multiple BridgeTransports in-process
// ---------------------------------------------------------------------------

/**
 * In-process byte router connecting multiple `BridgeTransport`s,
 * keyed by each transport's unique `transportId`.
 *
 * Channel-level sends produce alias-aware encoded bytes via the wire-layer
 * transformer and call `routeBytes`.
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
    bytes: Uint8Array,
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
 * In-memory transport that runs the alias-aware pipeline end-to-end.
 * Tests that use this transport exercise the same wire path as
 * production transports.
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

  // Per-channel alias state. Created with the channel; lives until removal.
  // Keyed by channelId.
  private aliasStateByChannel = new Map<ChannelId, AliasState>()

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

        const state =
          this.aliasStateByChannel.get(channelId) ?? emptyAliasState()
        const { state: nextState, wire } = applyOutboundAliasing(state, msg)
        this.aliasStateByChannel.set(channelId, nextState)

        const bytes = encodeWireMessage(wire)
        this.bridge.routeBytes(
          this.transportId,
          context.targetTransportId,
          bytes,
        )
      },
      stop: () => {
        // Cleanup handled by removeChannel.
      },
    }
  }

  async onStart(): Promise<void> {
    this.bridge.addTransport(this)

    // Phase 1: Create all channels (no establishment yet).
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

    // Phase 2: Only the joining transport initiates establishment.
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
      this.aliasStateByChannel.delete(channelId)
    }
    this.channelToAdapter.clear()
    this.adapterToChannel.clear()
  }

  createChannelTo(targetTransportId: string): void {
    if (this.adapterToChannel.has(targetTransportId)) return
    const channel = this.addChannel({ targetTransportId })
    this.channelToAdapter.set(channel.channelId, targetTransportId)
    this.adapterToChannel.set(targetTransportId, channel.channelId)
    this.aliasStateByChannel.set(channel.channelId, emptyAliasState())
  }

  removeChannelTo(targetTransportId: string): void {
    const channelId = this.adapterToChannel.get(targetTransportId)
    if (channelId !== undefined) {
      this.removeChannel(channelId)
      this.channelToAdapter.delete(channelId)
      this.adapterToChannel.delete(targetTransportId)
      this.aliasStateByChannel.delete(channelId)
    }
  }

  /**
   * Deliver encoded bytes to the appropriate channel.
   *
   * Decodes via `decodeWireMessage`, applies the inbound alias
   * transformer, and delivers each resolved message asynchronously
   * via `queueMicrotask()`.
   */
  deliverBytes(fromTransportId: string, bytes: Uint8Array): void {
    const channelId = this.adapterToChannel.get(fromTransportId)
    if (channelId === undefined) return

    const channel = this.channels.get(channelId)
    if (!channel) return

    const wire = decodeWireMessage(bytes)
    const state = this.aliasStateByChannel.get(channelId) ?? emptyAliasState()
    const result = applyInboundAliasing(state, wire)
    this.aliasStateByChannel.set(channelId, result.state)

    if (result.error || !result.msg) {
      console.warn("[BridgeTransport] alias resolution failed:", result.error)
      return
    }
    const msg = result.msg
    queueMicrotask(() => {
      channel.onReceive(msg)
    })
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
): TransportFactory {
  return () => new BridgeTransport(params)
}

// bridge-adapter — in-process transport with codec-faithful + alias-aware delivery.
//
// BridgeTransport is a real transport that runs the production codec
// end-to-end and applies the docId/schemaHash alias transformer at the
// channel send/receive boundary — exactly like every other binary
// transport. Async delivery is preserved via `queueMicrotask()` to keep
// test behavior representative of real network adapters.
//
// `@kyneta/transport` peer-depends on `@kyneta/wire` (a workspace-circular
// peer-dep that resolves cleanly because the imports between the two
// packages are runtime-disjoint: wire imports types from transport,
// transport imports concrete machinery from wire).
//
// Usage:
//   const bridge = new Bridge({ codec: cborCodec })
//   const exchangeA = new Exchange({
//     transports: [createBridgeTransport({ transportType: "peer-a", bridge })],
//   })

import type {
  ChannelId,
  ChannelMsg,
  GeneratedChannel,
  TransportFactory,
  TransportType,
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

/**
 * Structural codec interface used by `Bridge`'s convenience
 * `routeMessage` API. Compatible with `cborCodec` from `@kyneta/wire`.
 *
 * The bridge's main delivery path (`routeBytes`) is codec-agnostic; only
 * `routeMessage` (used by tests that bypass channel sends) needs a codec.
 */
export type BridgeCodec = {
  encode(input: ChannelMsg | ChannelMsg[]): Uint8Array<ArrayBuffer>
  decode(data: Uint8Array): ChannelMsg[]
}

// ---------------------------------------------------------------------------
// Bridge — message router connecting multiple BridgeTransports in-process
// ---------------------------------------------------------------------------

export type BridgeParams = {
  /**
   * Codec used by the convenience `routeMessage(from, to, msg)` API to
   * encode `ChannelMsg` to bytes. Channel sends bypass this and produce
   * bytes directly via the alias transformer + `encodeWireMessage`.
   *
   * Typically `cborCodec` from `@kyneta/wire`.
   */
  codec: BridgeCodec
}

/**
 * In-process byte router connecting multiple `BridgeTransport`s.
 *
 * Channel-level sends produce alias-aware encoded bytes via the wire-layer
 * transformer and call `routeBytes`. The convenience `routeMessage` API
 * encodes a `ChannelMsg` to bytes via the injected codec for tests that
 * bypass channel sends.
 */
export class Bridge {
  readonly transports = new Map<TransportType, BridgeTransport>()
  readonly codec: BridgeCodec

  constructor(params: BridgeParams) {
    this.codec = params.codec
  }

  addTransport(transport: BridgeTransport): void {
    if (!transport.transportType) {
      throw new Error("can't add transport without transport type")
    }
    this.transports.set(transport.transportType, transport)
  }

  removeTransport(transportType: TransportType): void {
    this.transports.delete(transportType)
  }

  /**
   * Route already-encoded bytes from one transport to another. The
   * receiving transport's `deliverBytes` is responsible for decoding
   * and applying the inbound alias transformer.
   *
   * Used by `BridgeTransport`'s channel send path.
   */
  routeBytes(
    fromTransportType: TransportType,
    toTransportType: TransportType,
    bytes: Uint8Array,
  ): void {
    const toTransport = this.transports.get(toTransportType)
    if (!toTransport) return
    toTransport.deliverBytes(fromTransportType, bytes)
  }

  /**
   * Convenience: encode a `ChannelMsg` via the bridge's codec and route
   * the bytes. Used by tests that inject messages directly into the
   * bridge without going through a channel send.
   *
   * NOTE: Bypasses the alias transformer. The receiving channel still
   * runs the inbound transformer, but the message will not carry alias
   * fields. Production code should always send through a channel.
   */
  routeMessage(
    fromTransportType: TransportType,
    toTransportType: TransportType,
    message: ChannelMsg,
  ): void {
    const bytes = this.codec.encode(message)
    this.routeBytes(fromTransportType, toTransportType, bytes)
  }

  get transportTypes(): Set<TransportType> {
    return new Set(this.transports.keys())
  }
}

// ---------------------------------------------------------------------------
// BridgeTransport — in-process network adapter for testing
// ---------------------------------------------------------------------------

type BridgeTransportContext = {
  targetTransportType: TransportType
}

export type BridgeTransportParams = {
  transportType: TransportType
  /**
   * Unique identifier for this adapter instance. Defaults to transportType.
   */
  transportId?: string
  bridge: Bridge
}

/**
 * In-memory transport that runs the production codec and alias transformer
 * end-to-end. Tests that use this transport exercise the same wire path
 * as production transports.
 *
 * @example
 * ```typescript
 * const bridge = new Bridge({ codec: cborCodec })
 * const exchangeA = new Exchange({
 *   transports: [createBridgeTransport({ transportType: "peer-a", bridge })],
 * })
 * ```
 */
export class BridgeTransport extends Transport<BridgeTransportContext> {
  readonly bridge: Bridge

  // Track which remote adapter each channel connects to.
  private channelToAdapter = new Map<ChannelId, TransportType>()
  private adapterToChannel = new Map<TransportType, ChannelId>()

  // Per-channel alias state. Created with the channel; lives until removal.
  // Keyed by channelId.
  private aliasStateByChannel = new Map<ChannelId, AliasState>()

  constructor({ transportType, transportId, bridge }: BridgeTransportParams) {
    super({ transportType, transportId: transportId ?? transportType })
    this.bridge = bridge
  }

  generate(context: BridgeTransportContext): GeneratedChannel {
    return {
      transportType: this.transportType,
      send: msg => {
        const channelId = this.adapterToChannel.get(context.targetTransportType)
        if (channelId === undefined) return

        const state =
          this.aliasStateByChannel.get(channelId) ?? emptyAliasState()
        const { state: nextState, wire } = applyOutboundAliasing(state, msg)
        this.aliasStateByChannel.set(channelId, nextState)

        const bytes = encodeWireMessage(wire)
        this.bridge.routeBytes(
          this.transportType,
          context.targetTransportType,
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
    for (const [transportType, adapter] of this.bridge.transports) {
      if (transportType !== this.transportType) {
        adapter.createChannelTo(this.transportType)
      }
    }
    for (const transportType of this.bridge.transports.keys()) {
      if (transportType !== this.transportType) {
        this.createChannelTo(transportType)
      }
    }

    // Phase 2: Only the joining transport initiates establishment.
    for (const channelId of this.adapterToChannel.values()) {
      this.establishChannel(channelId)
    }
  }

  async onStop(): Promise<void> {
    for (const [transportType, adapter] of this.bridge.transports) {
      if (transportType !== this.transportType) {
        adapter.removeChannelTo(this.transportType)
      }
    }
    this.bridge.removeTransport(this.transportType)

    for (const channelId of this.channelToAdapter.keys()) {
      this.removeChannel(channelId)
      this.aliasStateByChannel.delete(channelId)
    }
    this.channelToAdapter.clear()
    this.adapterToChannel.clear()
  }

  createChannelTo(targetTransportType: TransportType): void {
    if (this.adapterToChannel.has(targetTransportType)) return
    const channel = this.addChannel({ targetTransportType })
    this.channelToAdapter.set(channel.channelId, targetTransportType)
    this.adapterToChannel.set(targetTransportType, channel.channelId)
    this.aliasStateByChannel.set(channel.channelId, emptyAliasState())
  }

  removeChannelTo(targetTransportType: TransportType): void {
    const channelId = this.adapterToChannel.get(targetTransportType)
    if (channelId !== undefined) {
      this.removeChannel(channelId)
      this.channelToAdapter.delete(channelId)
      this.adapterToChannel.delete(targetTransportType)
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
  deliverBytes(fromTransportType: TransportType, bytes: Uint8Array): void {
    const channelId = this.adapterToChannel.get(fromTransportType)
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
 * const bridge = new Bridge({ codec: cborCodec })
 * const exchangeA = new Exchange({
 *   transports: [createBridgeTransport({ transportType: "peer-a", bridge })],
 * })
 * ```
 */
export function createBridgeTransport(
  params: BridgeTransportParams,
): TransportFactory {
  return () => new BridgeTransport(params)
}

// bridge-adapter — in-process adapter for testing multi-peer scenarios.
//
// Ported from @loro-extended/repo's BridgeTransport with Loro-specific
// types replaced by substrate-agnostic equivalents.
//
// BridgeTransport simulates real network adapter behavior by delivering
// messages asynchronously via `queueMicrotask()`. This ensures tests
// exercise the same async codepaths as production adapters.
//
// Usage:
//   const bridge = new Bridge()
//   const exchangeA = new Exchange({
//     transports: [createBridgeTransport({ transportType: "peer-a", bridge })],
//   })
//   const exchangeB = new Exchange({
//     transports: [createBridgeTransport({ transportType: "peer-b", bridge })],
//   })

import type { GeneratedChannel } from "./channel.js"
import type { ChannelMsg } from "./messages.js"
import type { TransportFactory } from "./transport.js"
import { Transport } from "./transport.js"
import type { ChannelId, TransportType } from "./types.js"

// ---------------------------------------------------------------------------
// Bridge — message router connecting multiple BridgeTransports in-process
// ---------------------------------------------------------------------------

/**
 * A simple message router that connects multiple BridgeTransports within
 * the same process. This enables direct message passing between transports
 * for testing purposes.
 */
export class Bridge {
  readonly transports = new Map<TransportType, BridgeTransport>()

  /**
   * Register an adapter with this bridge.
   */
  addTransport(transport: BridgeTransport): void {
    if (!transport.transportType) {
      throw new Error("can't add transport without transport type")
    }
    this.transports.set(transport.transportType, transport)
  }

  /**
   * Remove a transport from this bridge.
   */
  removeTransport(transportType: TransportType): void {
    this.transports.delete(transportType)
  }

  /**
   * Route a message from one adapter to another.
   */
  routeMessage(
    fromTransportType: TransportType,
    toTransportType: TransportType,
    message: ChannelMsg,
  ): void {
    const toTransport = this.transports.get(toTransportType)
    if (toTransport) {
      toTransport.deliverMessage(fromTransportType, message)
    }
  }

  /**
   * Get all adapter types currently in the bridge.
   */
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
   * Unique identifier for this adapter instance.
   * If not provided, defaults to transportType for backwards compatibility.
   */
  transportId?: string
  bridge: Bridge
}

/**
 * An in-memory adapter for testing that connects multiple peers within
 * the same process.
 *
 * Messages are delivered asynchronously via `queueMicrotask()` to
 * simulate real network adapter behavior. Tests should use
 * `waitForSync()` to await synchronization.
 *
 * @example
 * ```typescript
 * const bridge = new Bridge()
 * const exchangeA = new Exchange({
 *   transports: [createBridgeTransport({ transportType: "peer-a", bridge })],
 * })
 * const exchangeB = new Exchange({
 *   transports: [createBridgeTransport({ transportType: "peer-b", bridge })],
 * })
 * ```
 */
export class BridgeTransport extends Transport<BridgeTransportContext> {
  readonly bridge: Bridge

  // Track which remote adapter each channel connects to
  private channelToAdapter = new Map<ChannelId, TransportType>()
  private adapterToChannel = new Map<TransportType, ChannelId>()

  constructor({ transportType, transportId, bridge }: BridgeTransportParams) {
    // Default transportId to transportType for backwards compatibility
    super({ transportType, transportId: transportId ?? transportType })
    this.bridge = bridge
  }

  generate(context: BridgeTransportContext): GeneratedChannel {
    return {
      transportType: this.transportType,
      send: msg => {
        // Route message through bridge to target adapter
        this.bridge.routeMessage(
          this.transportType,
          context.targetTransportType,
          msg,
        )
      },
      stop: () => {
        // Cleanup handled by removeChannel
      },
    }
  }

  /**
   * Start participating in the in-process network.
   * Uses two-phase initialization:
   * 1. Create all channels (no messages sent)
   * 2. Establish channels (only the "newer" adapter initiates)
   */
  async onStart(): Promise<void> {
    // Step 1: Register with bridge
    this.bridge.addTransport(this)

    // Phase 1: Create all channels (no establishment yet)
    // Tell existing adapters to create channels to us
    for (const [transportType, adapter] of this.bridge.transports) {
      if (transportType !== this.transportType) {
        adapter.createChannelTo(this.transportType)
      }
    }

    // Create our channels to existing adapters
    for (const transportType of this.bridge.transports.keys()) {
      if (transportType !== this.transportType) {
        this.createChannelTo(transportType)
      }
    }

    // Phase 2: Establish channels
    // Only WE initiate establishment (to existing adapters)
    // This avoids double-establishment since we're the "new" adapter joining
    for (const channelId of this.adapterToChannel.values()) {
      this.establishChannel(channelId)
    }
  }

  /**
   * Stop participating in the in-process network.
   */
  async onStop(): Promise<void> {
    // Tell other adapters to remove their channels to us
    for (const [transportType, adapter] of this.bridge.transports) {
      if (transportType !== this.transportType) {
        adapter.removeChannelTo(this.transportType)
      }
    }

    // Remove ourselves from bridge
    this.bridge.removeTransport(this.transportType)

    // Remove all our channels
    for (const channelId of this.channelToAdapter.keys()) {
      this.removeChannel(channelId)
    }
    this.channelToAdapter.clear()
    this.adapterToChannel.clear()
  }

  /**
   * Create a channel to a target adapter (Phase 1).
   * Does NOT trigger establishment — that happens in Phase 2.
   */
  createChannelTo(targetTransportType: TransportType): void {
    if (this.adapterToChannel.has(targetTransportType)) {
      return
    }

    const channel = this.addChannel({ targetTransportType })
    this.channelToAdapter.set(channel.channelId, targetTransportType)
    this.adapterToChannel.set(targetTransportType, channel.channelId)
  }

  /**
   * Remove a channel to a target adapter.
   * Called by other adapters when they stop.
   */
  removeChannelTo(targetTransportType: TransportType): void {
    const channelId = this.adapterToChannel.get(targetTransportType)
    if (channelId) {
      this.removeChannel(channelId)
      this.channelToAdapter.delete(channelId)
      this.adapterToChannel.delete(targetTransportType)
    }
  }

  /**
   * Deliver a message from another adapter to the appropriate channel.
   * Called by Bridge.routeMessage().
   *
   * Delivers messages asynchronously via queueMicrotask() to simulate
   * real network adapter behavior.
   */
  deliverMessage(fromTransportType: TransportType, message: ChannelMsg): void {
    const channelId = this.adapterToChannel.get(fromTransportType)
    if (channelId) {
      const channel = this.channels.get(channelId)
      if (channel) {
        // Defer delivery to next microtask — simulates async network behavior
        queueMicrotask(() => {
          channel.onReceive(message)
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
 * Returns an `TransportFactory` — pass directly to `Exchange({ transports: [...] })`.
 * The `Bridge` is shared configuration (the rendezvous point); each call to
 * the factory creates a fresh `BridgeTransport` instance.
 *
 * @example
 * ```typescript
 * const bridge = new Bridge()
 * const exchangeA = new Exchange({
 *   transports: [createBridgeTransport({ transportType: "peer-a", bridge })],
 * })
 * const exchangeB = new Exchange({
 *   transports: [createBridgeTransport({ transportType: "peer-b", bridge })],
 * })
 * ```
 */
export function createBridgeTransport(
  params: BridgeTransportParams,
): TransportFactory {
  return () => new BridgeTransport(params)
}

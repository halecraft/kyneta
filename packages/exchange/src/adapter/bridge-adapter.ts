// bridge-adapter — in-process adapter for testing multi-peer scenarios.
//
// Ported from @loro-extended/repo's BridgeAdapter with Loro-specific
// types replaced by substrate-agnostic equivalents.
//
// BridgeAdapter simulates real network adapter behavior by delivering
// messages asynchronously via `queueMicrotask()`. This ensures tests
// exercise the same async codepaths as production adapters.
//
// Usage:
//   const bridge = new Bridge()
//   const exchangeA = new Exchange({
//     adapters: [new BridgeAdapter({ adapterType: "peer-a", bridge })],
//   })
//   const exchangeB = new Exchange({
//     adapters: [new BridgeAdapter({ adapterType: "peer-b", bridge })],
//   })

import type { ChannelMsg } from "../messages.js"
import type { GeneratedChannel } from "../channel.js"
import type { AdapterType, ChannelId } from "../types.js"
import { Adapter } from "./adapter.js"

// ---------------------------------------------------------------------------
// Bridge — message router connecting multiple BridgeAdapters in-process
// ---------------------------------------------------------------------------

/**
 * A simple message router that connects multiple BridgeAdapters within
 * the same process. This enables direct message passing between adapters
 * for testing purposes.
 */
export class Bridge {
  readonly adapters = new Map<AdapterType, BridgeAdapter>()

  /**
   * Register an adapter with this bridge.
   */
  addAdapter(adapter: BridgeAdapter): void {
    if (!adapter.adapterType) {
      throw new Error("can't add adapter without adapter type")
    }
    this.adapters.set(adapter.adapterType, adapter)
  }

  /**
   * Remove an adapter from this bridge.
   */
  removeAdapter(adapterType: AdapterType): void {
    this.adapters.delete(adapterType)
  }

  /**
   * Route a message from one adapter to another.
   */
  routeMessage(
    fromAdapterType: AdapterType,
    toAdapterType: AdapterType,
    message: ChannelMsg,
  ): void {
    const toAdapter = this.adapters.get(toAdapterType)
    if (toAdapter) {
      toAdapter.deliverMessage(fromAdapterType, message)
    }
  }

  /**
   * Get all adapter types currently in the bridge.
   */
  get adapterTypes(): Set<AdapterType> {
    return new Set(this.adapters.keys())
  }
}

// ---------------------------------------------------------------------------
// BridgeAdapter — in-process network adapter for testing
// ---------------------------------------------------------------------------

type BridgeAdapterContext = {
  targetAdapterType: AdapterType
}

type BridgeAdapterParams = {
  adapterType: AdapterType
  /**
   * Unique identifier for this adapter instance.
   * If not provided, defaults to adapterType for backwards compatibility.
   */
  adapterId?: string
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
 *   adapters: [new BridgeAdapter({ adapterType: "peer-a", bridge })],
 *   substrates: { plain: plainFactory },
 * })
 * const exchangeB = new Exchange({
 *   adapters: [new BridgeAdapter({ adapterType: "peer-b", bridge })],
 *   substrates: { plain: plainFactory },
 * })
 * ```
 */
export class BridgeAdapter extends Adapter<BridgeAdapterContext> {
  readonly bridge: Bridge

  // Track which remote adapter each channel connects to
  private channelToAdapter = new Map<ChannelId, AdapterType>()
  private adapterToChannel = new Map<AdapterType, ChannelId>()

  constructor({ adapterType, adapterId, bridge }: BridgeAdapterParams) {
    // Default adapterId to adapterType for backwards compatibility
    super({ adapterType, adapterId: adapterId ?? adapterType })
    this.bridge = bridge
  }

  generate(context: BridgeAdapterContext): GeneratedChannel {
    return {
      adapterType: this.adapterType,
      kind: "network",
      send: (msg) => {
        // Route message through bridge to target adapter
        this.bridge.routeMessage(
          this.adapterType,
          context.targetAdapterType,
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
    this.bridge.addAdapter(this)

    // Phase 1: Create all channels (no establishment yet)
    // Tell existing adapters to create channels to us
    for (const [adapterType, adapter] of this.bridge.adapters) {
      if (adapterType !== this.adapterType) {
        adapter.createChannelTo(this.adapterType)
      }
    }

    // Create our channels to existing adapters
    for (const adapterType of this.bridge.adapters.keys()) {
      if (adapterType !== this.adapterType) {
        this.createChannelTo(adapterType)
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
    for (const [adapterType, adapter] of this.bridge.adapters) {
      if (adapterType !== this.adapterType) {
        adapter.removeChannelTo(this.adapterType)
      }
    }

    // Remove ourselves from bridge
    this.bridge.removeAdapter(this.adapterType)

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
  createChannelTo(targetAdapterType: AdapterType): void {
    if (this.adapterToChannel.has(targetAdapterType)) {
      return
    }

    const channel = this.addChannel({ targetAdapterType })
    this.channelToAdapter.set(channel.channelId, targetAdapterType)
    this.adapterToChannel.set(targetAdapterType, channel.channelId)
  }

  /**
   * Remove a channel to a target adapter.
   * Called by other adapters when they stop.
   */
  removeChannelTo(targetAdapterType: AdapterType): void {
    const channelId = this.adapterToChannel.get(targetAdapterType)
    if (channelId) {
      this.removeChannel(channelId)
      this.channelToAdapter.delete(channelId)
      this.adapterToChannel.delete(targetAdapterType)
    }
  }

  /**
   * Deliver a message from another adapter to the appropriate channel.
   * Called by Bridge.routeMessage().
   *
   * Delivers messages asynchronously via queueMicrotask() to simulate
   * real network adapter behavior.
   */
  deliverMessage(fromAdapterType: AdapterType, message: ChannelMsg): void {
    const channelId = this.adapterToChannel.get(fromAdapterType)
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
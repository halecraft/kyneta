// adapter — base class for exchange adapters.
//
// Ported from @loro-extended/repo's Adapter with Loro-specific types
// replaced by the substrate-agnostic message vocabulary. The logger
// dependency on @logtape/logtape is removed — we use a minimal
// console-based approach instead.
//
// Adapter lifecycle: created → initialized → started → stopped
//
// The adapter creates channels via its `generate()` method. The exchange
// calls `_initialize()` to inject identity and callbacks, `_start()` to
// begin operation, and `_stop()` to shut down.

import type { AddressedEnvelope, ChannelMsg } from "../messages.js"
import type {
  Channel,
  ChannelKind,
  ConnectedChannel,
  GeneratedChannel,
} from "../channel.js"
import { ChannelDirectory } from "../channel-directory.js"
import type { AdapterType, ChannelId, PeerIdentityDetails } from "../types.js"

export type AnyAdapter = Adapter<any>

/**
 * A zero-argument function that creates a fresh adapter instance.
 *
 * Adapters have a linear lifecycle (create → use → discard) and cannot
 * be restarted after `_stop()`. Passing factories instead of instances
 * ensures the Exchange can create fresh adapters on construction and
 * discard them on reset — no shared mutable state across lifecycles.
 *
 * Use the `create*` helper functions for low-friction configuration:
 * ```typescript
 * import { createWebsocketClient } from "@kyneta/websocket-network-adapter/client"
 *
 * const exchange = new Exchange({
 *   adapters: [createWebsocketClient({ url: "ws://localhost:3000/ws" })],
 * })
 * ```
 */
export type AdapterFactory = () => AnyAdapter

type AdapterParams = {
  adapterType: AdapterType
  /**
   * Unique identifier for this adapter instance.
   * If not provided, auto-generated as `{adapterType}-{counter}`.
   */
  adapterId?: string
}

let adapterIdCounter = 1

/**
 * Context provided to adapters during initialization.
 * Contains identity and callbacks for channel lifecycle events.
 */
export type AdapterContext = {
  identity: PeerIdentityDetails
  /**
   * Called when a message is received on a channel.
   * channelId is passed instead of channel object because the channel
   * object may be stale (due to immutable state updates in the synchronizer).
   */
  onChannelReceive: (channelId: ChannelId, message: ChannelMsg) => void
  onChannelAdded: (channel: ConnectedChannel) => void
  onChannelRemoved: (channel: Channel) => void
  onChannelEstablish: (channel: ConnectedChannel) => void
}

// Callbacks only (without identity) for lifecycle state
type AdapterCallbacks = Omit<AdapterContext, "identity">

type AdapterLifecycleState =
  | { state: "created" }
  | ({ state: "initialized" } & AdapterCallbacks)
  | ({ state: "started" } & AdapterCallbacks)
  | { state: "stopped" }

export abstract class Adapter<G> {
  /**
   * The kind of channels this adapter creates.
   * Default is "network". StorageAdapter overrides this to "storage".
   */
  readonly kind: ChannelKind = "network"

  readonly adapterType: AdapterType
  readonly adapterId: string
  readonly channels: ChannelDirectory<G>

  protected identity?: PeerIdentityDetails

  #lifecycle: AdapterLifecycleState = { state: "created" }

  constructor({ adapterType, adapterId }: AdapterParams) {
    this.adapterType = adapterType
    this.adapterId = adapterId ?? `${adapterType}-${adapterIdCounter++}`
    this.channels = new ChannelDirectory(this._generate.bind(this))
  }

  // ============================================================================
  // PROTECTED API - For Subclasses
  // ============================================================================

  /**
   * Create a channel. Only callable during "started" state.
   * The channel must be ready to send/receive immediately.
   */
  protected addChannel(context: G): ConnectedChannel {
    const lifecycle = this.#lifecycle

    if (lifecycle.state !== "started") {
      throw new Error(
        `can't add channel in '${lifecycle.state}' state (must be 'started')`,
      )
    }

    const channel = this.channels.create(context, (message) =>
      lifecycle.onChannelReceive(channel.channelId, message),
    )

    lifecycle.onChannelAdded(channel)

    return channel
  }

  /**
   * Remove a channel. Only callable during "started" state.
   */
  protected removeChannel(channelId: ChannelId): Channel | undefined {
    const lifecycle = this.#lifecycle

    if (lifecycle.state !== "started") {
      throw new Error(
        `can't remove channel in '${lifecycle.state}' state (must be 'started')`,
      )
    }

    const channel = this.channels.remove(channelId)

    if (channel) {
      lifecycle.onChannelRemoved(channel)
    }

    return channel
  }

  /**
   * Establish a channel by triggering the establishment handshake.
   * Called after addChannel() to initiate communication.
   * Only callable during "started" state.
   */
  protected establishChannel(channelId: ChannelId): void {
    const lifecycle = this.#lifecycle

    if (lifecycle.state !== "started") {
      throw new Error(
        `can't establish channel in '${lifecycle.state}' state (must be 'started')`,
      )
    }

    const channel = this.channels.get(channelId)
    if (!channel) {
      throw new Error(`can't establish channel ${channelId}: channel not found`)
    }

    // Only establish if channel is still in connected state
    if (channel.type === "connected") {
      lifecycle.onChannelEstablish(channel)
    }
  }

  /**
   * Generate a GeneratedChannel for the given context.
   * Subclasses must implement this.
   */
  protected abstract generate(context: G): GeneratedChannel

  /**
   * Internal method that ensures channel metadata comes from the adapter.
   */
  private _generate(context: G): GeneratedChannel {
    const generated = this.generate(context)
    return {
      ...generated,
      kind: this.kind,
      adapterType: this.adapterType,
    }
  }

  /**
   * Start the adapter. Create initial channels here.
   */
  abstract onStart(): Promise<void>

  /**
   * Stop the adapter. Clean up resources and remove channels.
   */
  abstract onStop(): Promise<void>

  // ============================================================================
  // INTERNAL API - For Synchronizer / AdapterManager
  // ============================================================================

  _initialize(context: AdapterContext): void {
    // Allow re-initialization (handles HMR)
    if (
      this.#lifecycle.state === "initialized" ||
      this.#lifecycle.state === "started"
    ) {
      this.channels.reset()
      this.#lifecycle = { state: "stopped" }
    }

    if (
      this.#lifecycle.state !== "created" &&
      this.#lifecycle.state !== "stopped"
    ) {
      throw new Error(`Adapter ${this.adapterType} already initialized`)
    }

    this.identity = context.identity
    this.#lifecycle = {
      state: "initialized",
      onChannelReceive: context.onChannelReceive,
      onChannelAdded: context.onChannelAdded,
      onChannelRemoved: context.onChannelRemoved,
      onChannelEstablish: context.onChannelEstablish,
    }
  }

  async _start(): Promise<void> {
    if (this.#lifecycle.state !== "initialized") {
      throw new Error(
        `Cannot start adapter ${this.adapterType} in state ${this.#lifecycle.state}`,
      )
    }
    // Transition to started BEFORE calling onStart so subclasses
    // can call addChannel() during their onStart() implementation
    this.#lifecycle = { ...this.#lifecycle, state: "started" }
    await this.onStart()
  }

  async _stop(): Promise<void> {
    await this.onStop()
    this.channels.reset()
    this.#lifecycle = { state: "stopped" }
  }

  /**
   * Await all pending async operations in this adapter.
   * Override in subclasses (e.g. StorageAdapter) to await in-flight saves.
   */
  async flush(): Promise<void> {
    // No-op by default
  }

  /**
   * Send an envelope through this adapter's channels.
   *
   * @returns the number of channels to which the message was sent
   */
  _send(envelope: AddressedEnvelope): number {
    let sentCount = 0

    for (const toChannelId of envelope.toChannelIds) {
      const channel = this.channels.get(toChannelId)
      if (channel) {
        channel.send(envelope.message)
        sentCount++
      }
    }

    return sentCount
  }
}
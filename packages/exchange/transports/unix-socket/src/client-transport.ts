// client-transport — Unix socket client transport for @kyneta/exchange.
//
// Connects to a unix domain socket path and manages a single connection
// with reconnection via the shared `createReconnectScheduler` from
// `@kyneta/exchange`.
//
// Uses `UnixSocketConnection` for stream framing (StreamFrameParser)
// and backpressure-aware writes. No fragmentation, no transport prefixes,
// no "ready" handshake — UDS connections are bidirectionally ready
// immediately.
//
// The client has a 4-state machine (same as SSE):
//   disconnected → connecting → connected
//                      ↓            ↓
//                 reconnecting ← ─ ─┘
//                      ↓
//                 connecting (retry)
//                      ↓
//                 disconnected (max retries)

import type {
  Channel,
  ChannelMsg,
  GeneratedChannel,
  PeerId,
  ReconnectScheduler,
  StateTransition,
  TransitionListener,
  TransportFactory,
} from "@kyneta/exchange"
import {
  ClientStateMachine,
  createReconnectScheduler,
  Transport,
} from "@kyneta/exchange"
import { connect } from "./connect.js"
import { UnixSocketConnection } from "./connection.js"
import type {
  DisconnectReason,
  UnixSocketClientState,
} from "./types.js"

// Re-export state types for convenience
export type { DisconnectReason, UnixSocketClientState }

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

/**
 * Valid transitions for the unix socket client state machine.
 *
 * Identical to SSE's 4-state transition map — no "ready" phase because
 * UDS connections are bidirectionally ready immediately.
 */
const UDS_VALID_TRANSITIONS: Record<string, string[]> = {
  disconnected: ["connecting"],
  connecting: ["connected", "disconnected", "reconnecting"],
  connected: ["disconnected", "reconnecting"],
  reconnecting: ["connecting", "disconnected"],
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Options for the unix socket client transport.
 */
export interface UnixSocketClientOptions {
  /** Path to the unix socket file. */
  path: string
  /** Reconnection options. */
  reconnect?: {
    enabled?: boolean
    maxAttempts?: number
    baseDelay?: number
    maxDelay?: number
  }
}

// ---------------------------------------------------------------------------
// Lifecycle events
// ---------------------------------------------------------------------------

/**
 * State transition event for unix socket client states.
 */
export type UnixSocketClientStateTransition = StateTransition<UnixSocketClientState>

// ---------------------------------------------------------------------------
// UnixSocketClientTransport
// ---------------------------------------------------------------------------

/**
 * Unix socket client transport for @kyneta/exchange.
 *
 * Connects to a unix domain socket path and manages a single connection.
 * Uses `UnixSocketConnection` for stream framing and backpressure-aware
 * writes. Reconnects with exponential backoff via the shared
 * `createReconnectScheduler`.
 *
 * ## Usage
 *
 * ```typescript
 * import { Exchange } from "@kyneta/exchange"
 * import { createUnixSocketClient } from "@kyneta/unix-socket-transport"
 *
 * const exchange = new Exchange({
 *   identity: { peerId: "service-a", name: "Service A" },
 *   transports: [
 *     createUnixSocketClient({ path: "/tmp/kyneta.sock" }),
 *   ],
 * })
 * ```
 */
export class UnixSocketClientTransport extends Transport<void> {
  #peerId?: PeerId
  #connection?: UnixSocketConnection
  #serverChannel?: Channel
  #options: UnixSocketClientOptions
  #reconnect: ReconnectScheduler
  #wasConnectedBefore = false

  // State machine
  readonly #stateMachine: ClientStateMachine<UnixSocketClientState>

  constructor(options: UnixSocketClientOptions) {
    super({ transportType: "unix-socket-client" })
    this.#options = options

    this.#stateMachine = new ClientStateMachine<UnixSocketClientState>({
      initialState: { status: "disconnected" },
      validTransitions: UDS_VALID_TRANSITIONS,
    })

    this.#reconnect = createReconnectScheduler({
      stateMachine: this.#stateMachine,
      connectFn: () => this.#connect(),
      options: this.#options.reconnect ?? {},
    })
  }

  // ==========================================================================
  // State observation
  // ==========================================================================

  /**
   * Get the current connection state.
   */
  getState(): UnixSocketClientState {
    return this.#stateMachine.getState()
  }

  /**
   * Subscribe to state transitions.
   */
  subscribeToTransitions(
    listener: TransitionListener<UnixSocketClientState>,
  ): () => void {
    return this.#stateMachine.subscribeToTransitions(listener)
  }

  /**
   * Wait for a specific state.
   */
  waitForState(
    predicate: (state: UnixSocketClientState) => boolean,
    options?: { timeoutMs?: number },
  ): Promise<UnixSocketClientState> {
    return this.#stateMachine.waitForState(predicate, options)
  }

  /**
   * Wait for a specific status.
   */
  waitForStatus(
    status: UnixSocketClientState["status"],
    options?: { timeoutMs?: number },
  ): Promise<UnixSocketClientState> {
    return this.#stateMachine.waitForStatus(status, options)
  }

  /**
   * Whether the client is connected and ready to send/receive.
   */
  get isConnected(): boolean {
    return this.#stateMachine.getStatus() === "connected"
  }

  // ==========================================================================
  // Transport abstract method implementations
  // ==========================================================================

  protected generate(): GeneratedChannel {
    return {
      transportType: this.transportType,
      send: (msg: ChannelMsg) => {
        if (this.#connection) {
          this.#connection.send(msg)
        }
      },
      stop: () => {
        // Don't call disconnect() here — channel.stop() is called when
        // the channel is removed, which can happen during handleClose().
        // The actual disconnect is handled by onStop() or handleClose().
      },
    }
  }

  async onStart(): Promise<void> {
    if (!this.identity) {
      throw new Error(
        "Adapter not properly initialized — identity not available",
      )
    }
    this.#peerId = this.identity.peerId
    this.#reconnect.setEnabled(true)
    this.#wasConnectedBefore = false
    await this.#connect()
  }

  async onStop(): Promise<void> {
    this.#reconnect.setEnabled(false)
    this.#disconnect({ type: "intentional" })
  }

  // ==========================================================================
  // Connection management
  // ==========================================================================

  /**
   * Connect to the unix socket server.
   */
  async #connect(): Promise<void> {
    const currentState = this.#stateMachine.getState()
    if (currentState.status === "connecting") {
      return
    }

    // Determine attempt number
    const attempt =
      currentState.status === "reconnecting" ? currentState.attempt : 1

    this.#stateMachine.transition({ status: "connecting", attempt })

    try {
      const socket = await connect(this.#options.path)

      // Set up error and close handlers
      socket.onClose(() => {
        this.#handleClose()
      })

      socket.onError(error => {
        this.#handleError(error)
      })

      // Transition to connected
      this.#stateMachine.transition({ status: "connected" })

      // Create channel and connection
      this.#serverChannel = this.addChannel(undefined as void)

      this.#connection = new UnixSocketConnection(
        this.#peerId ?? "unknown",
        this.#serverChannel.channelId,
        socket,
      )
      this.#connection._setChannel(this.#serverChannel)
      this.#connection.start()

      // No "ready" handshake — establish immediately
      this.establishChannel(this.#serverChannel.channelId)

      this.#wasConnectedBefore = true
    } catch (error) {
      // Wrap error with errno context for socket-specific failures
      const wrappedError =
        error instanceof Error ? error : new Error(String(error))
      const errno = (error as NodeJS.ErrnoException).code

      this.#reconnect.schedule({
        type: "error",
        error: wrappedError,
        errno,
      })
    }
  }

  /**
   * Disconnect from the unix socket server.
   */
  #disconnect(reason: DisconnectReason): void {
    this.#reconnect.cancel()

    if (this.#connection) {
      this.#connection.close()
      this.#connection = undefined
    }

    if (this.#serverChannel) {
      this.removeChannel(this.#serverChannel.channelId)
      this.#serverChannel = undefined
    }

    // Only transition if not already disconnected
    const currentState = this.#stateMachine.getState()
    if (currentState.status !== "disconnected") {
      this.#stateMachine.transition({ status: "disconnected", reason })
    }
  }

  // ==========================================================================
  // Event handlers
  // ==========================================================================

  /**
   * Handle socket close event.
   */
  #handleClose(): void {
    if (this.#connection) {
      this.#connection = undefined
    }

    if (this.#serverChannel) {
      this.removeChannel(this.#serverChannel.channelId)
      this.#serverChannel = undefined
    }

    // Schedule reconnect or transition to disconnected
    this.#reconnect.schedule({ type: "closed" })
  }

  /**
   * Handle socket error event.
   */
  #handleError(error: Error): void {
    if (this.#connection) {
      this.#connection = undefined
    }

    if (this.#serverChannel) {
      this.removeChannel(this.#serverChannel.channelId)
      this.#serverChannel = undefined
    }

    const errno = (error as NodeJS.ErrnoException).code

    // Schedule reconnect or transition to disconnected
    this.#reconnect.schedule({
      type: "error",
      error,
      errno,
    })
  }
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

/**
 * Create a unix socket client transport factory for use with `Exchange`.
 *
 * Returns a `TransportFactory` — pass directly to
 * `Exchange({ transports: [...] })`.
 *
 * @example
 * ```typescript
 * import { Exchange } from "@kyneta/exchange"
 * import { createUnixSocketClient } from "@kyneta/unix-socket-transport"
 *
 * const exchange = new Exchange({
 *   identity: { peerId: "service-a", name: "Service A" },
 *   transports: [
 *     createUnixSocketClient({ path: "/tmp/kyneta.sock" }),
 *   ],
 * })
 * ```
 */
export function createUnixSocketClient(
  options: UnixSocketClientOptions,
): TransportFactory {
  return () => new UnixSocketClientTransport(options)
}
// client-transport — Unix socket client transport for @kyneta/exchange.
//
// Thin imperative shell around the pure client program (client-program.ts).
// The program produces data effects; this module interprets them as I/O.
//
// FC/IS design:
// - client-program.ts: pure Mealy machine (functional core)
// - client-transport.ts: effect executor (imperative shell)
//
// Uses `UnixSocketConnection` for stream framing (StreamFrameParser)
// and backpressure-aware writes. No fragmentation, no transport prefixes,
// no "ready" handshake — unix socket connections are bidirectionally
// ready immediately.

import type {
  ObservableHandle,
  StateTransition,
  TransitionListener,
} from "@kyneta/machine"
import { createObservableProgram } from "@kyneta/machine"
import type {
  Channel,
  ChannelMsg,
  GeneratedChannel,
  PeerId,
  TransportFactory,
} from "@kyneta/transport"
import { Transport } from "@kyneta/transport"
import {
  createUnixSocketClientProgram,
  type UnixSocketClientEffect,
  type UnixSocketClientMsg,
} from "./client-program.js"
import { connect } from "./connect.js"
import { UnixSocketConnection } from "./connection.js"
import type { DisconnectReason, UnixSocketClientState } from "./types.js"

// Re-export state types for convenience
export type { DisconnectReason, UnixSocketClientState }

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
export type UnixSocketClientStateTransition =
  StateTransition<UnixSocketClientState>

// ---------------------------------------------------------------------------
// UnixSocketClientTransport
// ---------------------------------------------------------------------------

/**
 * Unix socket client transport for @kyneta/exchange.
 *
 * Connects to a unix domain socket path and manages a single connection.
 * Uses `UnixSocketConnection` for stream framing and backpressure-aware
 * writes. Reconnects with exponential backoff via a pure Mealy machine
 * program (`client-program.ts`).
 *
 * Internally, the connection lifecycle is a `Program<Msg, Model, Fx>` —
 * a pure Mealy machine whose transitions are deterministically testable.
 * This class is the imperative shell that interprets data effects as I/O.
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

  // Observable program handle — created in constructor, drives all state
  #handle: ObservableHandle<UnixSocketClientMsg, UnixSocketClientState>

  // Executor-local I/O state — not in the program model
  #connection?: UnixSocketConnection
  #serverChannel?: Channel
  #reconnectTimer?: ReturnType<typeof setTimeout>

  constructor(options: UnixSocketClientOptions) {
    super({ transportType: "unix-socket-client" })

    const program = createUnixSocketClientProgram({
      path: options.path,
      reconnect: options.reconnect,
    })

    this.#handle = createObservableProgram(program, (effect, dispatch) => {
      this.#executeEffect(effect, dispatch)
    })
  }

  // ==========================================================================
  // Effect executor — interprets data effects as I/O
  // ==========================================================================

  #executeEffect(
    effect: UnixSocketClientEffect,
    dispatch: (msg: UnixSocketClientMsg) => void,
  ): void {
    switch (effect.type) {
      case "connect": {
        void this.#doConnect(effect.path, dispatch)
        break
      }

      case "close-connection": {
        if (this.#connection) {
          this.#connection.close()
          this.#connection = undefined
        }
        break
      }

      case "add-channel-and-establish": {
        this.#serverChannel = this.addChannel()

        this.#connection = new UnixSocketConnection(
          this.#peerId ?? "unknown",
          this.#serverChannel.channelId,
          // The socket is stored transiently on the instance during #doConnect.
          // By the time this effect runs, #pendingSocket is set.
          this.#pendingSocket!,
        )
        this.#connection._setChannel(this.#serverChannel)
        this.#connection.start()
        this.#pendingSocket = undefined

        // No "ready" handshake — establish immediately
        this.establishChannel(this.#serverChannel.channelId)
        break
      }

      case "remove-channel": {
        if (this.#serverChannel) {
          this.removeChannel(this.#serverChannel.channelId)
          this.#serverChannel = undefined
        }
        // Also clean up the connection reference
        if (this.#connection) {
          this.#connection = undefined
        }
        break
      }

      case "start-reconnect-timer": {
        this.#reconnectTimer = setTimeout(() => {
          this.#reconnectTimer = undefined
          dispatch({ type: "reconnect-timer-fired" })
        }, effect.delayMs)
        break
      }

      case "cancel-reconnect-timer": {
        if (this.#reconnectTimer !== undefined) {
          clearTimeout(this.#reconnectTimer)
          this.#reconnectTimer = undefined
        }
        break
      }
    }
  }

  // Transient socket storage — set during #doConnect, consumed by add-channel-and-establish effect
  #pendingSocket?: import("./types.js").UnixSocket

  /**
   * Perform the actual socket connection (async I/O).
   * On success, dispatches connection-opened.
   * On failure, dispatches connection-error.
   */
  async #doConnect(
    path: string,
    dispatch: (msg: UnixSocketClientMsg) => void,
  ): Promise<void> {
    try {
      const socket = await connect(path)

      // Store the socket for the add-channel-and-establish effect
      this.#pendingSocket = socket

      // Set up error and close handlers
      socket.onClose(() => {
        dispatch({ type: "connection-closed" })
      })

      socket.onError((error: Error) => {
        const errno = (error as NodeJS.ErrnoException).code
        dispatch({ type: "connection-error", error, errno })
      })

      dispatch({ type: "connection-opened" })
    } catch (error) {
      const wrappedError =
        error instanceof Error ? error : new Error(String(error))
      const errno = (error as NodeJS.ErrnoException).code
      dispatch({ type: "connection-error", error: wrappedError, errno })
    }
  }

  // ==========================================================================
  // State observation — delegated to the observable handle
  // ==========================================================================

  /**
   * Get the current connection state.
   */
  getState(): UnixSocketClientState {
    return this.#handle.getState()
  }

  /**
   * Subscribe to state transitions.
   */
  subscribeToTransitions(
    listener: TransitionListener<UnixSocketClientState>,
  ): () => void {
    return this.#handle.subscribeToTransitions(listener)
  }

  /**
   * Wait for a specific state.
   */
  waitForState(
    predicate: (state: UnixSocketClientState) => boolean,
    options?: { timeoutMs?: number },
  ): Promise<UnixSocketClientState> {
    return this.#handle.waitForState(predicate, options)
  }

  /**
   * Wait for a specific status.
   */
  waitForStatus(
    status: UnixSocketClientState["status"],
    options?: { timeoutMs?: number },
  ): Promise<UnixSocketClientState> {
    return this.#handle.waitForStatus(status, options)
  }

  /**
   * Whether the client is connected and ready to send/receive.
   */
  get isConnected(): boolean {
    return this.#handle.getState().status === "connected"
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
        // Don't call disconnect here — channel.stop() is called when
        // the channel is removed, which can happen during effect execution.
        // The actual disconnect is handled by onStop() or the program.
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
    this.#handle.dispatch({ type: "start" })
  }

  async onStop(): Promise<void> {
    this.#handle.dispatch({ type: "stop" })
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

// client-transport — Websocket client transport for @kyneta/exchange.
//
// Thin imperative shell around the pure client program (client-program.ts).
// The program produces data effects; this module interprets them as I/O.
//
// FC/IS design:
// - client-program.ts: pure Mealy machine (functional core)
// - client-transport.ts: effect executor (imperative shell)
//
// Uses the kyneta wire format (CBOR codec + framing + fragmentation)
// for binary messages. Text frames carry the "ready" handshake and
// keepalive ping/pong.

import type { ObservableHandle, TransitionListener } from "@kyneta/machine"
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
  decodeBinaryMessages,
  encodeBinaryAndSend,
  FragmentReassembler,
} from "@kyneta/wire"
import {
  createWsClientProgram,
  type WsClientEffect,
  type WsClientMsg,
} from "./client-program.js"
import type {
  DisconnectReason,
  WebsocketClientState,
  WebsocketClientStateTransition,
} from "./types.js"

// Re-export state types for convenience
export type {
  DisconnectReason,
  WebsocketClientState,
  WebsocketClientStateTransition,
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Default fragment threshold in bytes.
 * AWS API Gateway has a 128KB limit, so 100KB provides a safe margin.
 */
export const DEFAULT_FRAGMENT_THRESHOLD = 100 * 1024

/**
 * Options for the Websocket client transport (browser connections).
 */
export interface WebsocketClientOptions {
  /** Websocket URL to connect to. Can be a string or a function of peerId. */
  url: string | ((peerId: PeerId) => string)

  /** Optional custom WebSocket implementation (for Node.js or testing). */
  WebSocket?: typeof globalThis.WebSocket

  /** Reconnection options. */
  reconnect?: {
    enabled?: boolean
    maxAttempts?: number
    baseDelay?: number
    maxDelay?: number
  }

  /** Keepalive interval in ms (default: 30000). */
  keepaliveInterval?: number

  /**
   * Fragment threshold in bytes. Messages larger than this are fragmented.
   * Set to 0 to disable fragmentation (not recommended for cloud deployments).
   * Default: 100KB
   */
  fragmentThreshold?: number

  /** Lifecycle event callbacks. */
  lifecycle?: WebsocketClientLifecycleEvents
}

/**
 * Lifecycle event callbacks for the Websocket client.
 */
export interface WebsocketClientLifecycleEvents {
  /** Called on every state transition (delivered async via microtask). */
  onStateChange?: (transition: WebsocketClientStateTransition) => void

  /** Called when the connection is lost. */
  onDisconnect?: (reason: DisconnectReason) => void

  /** Called when a reconnection attempt is scheduled. */
  onReconnecting?: (attempt: number, nextAttemptMs: number) => void

  /** Called when reconnection succeeds after a previous connection. */
  onReconnected?: () => void

  /** Called when the server sends the "ready" signal. */
  onReady?: () => void
}

/**
 * Options for service-to-service Websocket connections.
 * Extends WebsocketClientOptions with header support for authentication.
 *
 * Note: Headers are a Bun/Node-specific extension. The browser WebSocket API
 * does not support custom headers per the WHATWG spec.
 */
export interface ServiceWebsocketClientOptions extends WebsocketClientOptions {
  /**
   * Headers to send during Websocket upgrade.
   * Used for authentication in service-to-service communication.
   */
  headers?: Record<string, string>
}

// ---------------------------------------------------------------------------
// WebsocketClientTransport
// ---------------------------------------------------------------------------

/**
 * Websocket client network transport for @kyneta/exchange.
 *
 * Connects to a Websocket server, sends and receives ChannelMsg via
 * the kyneta wire format (CBOR codec + framing + fragmentation).
 *
 * Internally, the connection lifecycle is a `Program<Msg, Model, Fx>` —
 * a pure Mealy machine whose transitions are deterministically testable.
 * This class is the imperative shell that interprets data effects as I/O.
 *
 * Prefer the factory functions for construction:
 * - `createWebsocketClient()` — browser-to-server
 * - `createServiceWebsocketClient()` — service-to-service (with headers)
 */
export class WebsocketClientTransport extends Transport<void> {
  #peerId?: PeerId
  #options: ServiceWebsocketClientOptions
  #WebSocketImpl: typeof globalThis.WebSocket

  // Observable program handle — created in constructor, drives all state
  #handle: ObservableHandle<WsClientMsg, WebsocketClientState>

  // Executor-local I/O state — not in the program model
  #socket?: WebSocket
  #serverChannel?: Channel
  #keepaliveTimer?: ReturnType<typeof setInterval>
  #reconnectTimer?: ReturnType<typeof setTimeout>

  // Fragmentation
  readonly #fragmentThreshold: number
  readonly #reassembler: FragmentReassembler

  constructor(options: ServiceWebsocketClientOptions) {
    super({ transportType: "websocket-client" })
    this.#options = options
    this.#WebSocketImpl = options.WebSocket ?? globalThis.WebSocket
    this.#fragmentThreshold =
      options.fragmentThreshold ?? DEFAULT_FRAGMENT_THRESHOLD
    this.#reassembler = new FragmentReassembler({
      timeoutMs: 10_000,
    })

    const program = createWsClientProgram({
      reconnect: options.reconnect,
    })

    this.#handle = createObservableProgram(program, (effect, dispatch) => {
      this.#executeEffect(effect, dispatch)
    })

    // Set up lifecycle event forwarding
    this.#setupLifecycleEvents()
  }

  // ==========================================================================
  // Effect executor — interprets data effects as I/O
  // ==========================================================================

  #executeEffect(
    effect: WsClientEffect,
    dispatch: (msg: WsClientMsg) => void,
  ): void {
    switch (effect.type) {
      case "create-websocket": {
        this.#doCreateWebsocket(dispatch)
        break
      }

      case "close-websocket": {
        if (this.#socket) {
          this.#socket.close(1000, "Client disconnecting")
          this.#socket = undefined
        }
        break
      }

      case "add-channel-and-establish": {
        // Clean up previous channel if it exists (e.g. after reconnect)
        if (this.#serverChannel) {
          this.removeChannel(this.#serverChannel.channelId)
          this.#serverChannel = undefined
        }

        this.#serverChannel = this.addChannel()

        // Establish immediately — the server already signaled ready
        this.establishChannel(this.#serverChannel.channelId)
        break
      }

      case "remove-channel": {
        if (this.#serverChannel) {
          this.removeChannel(this.#serverChannel.channelId)
          this.#serverChannel = undefined
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

      case "start-keepalive": {
        this.#startKeepalive()
        break
      }

      case "stop-keepalive": {
        this.#stopKeepalive()
        break
      }
    }
  }

  // ==========================================================================
  // WebSocket creation — the core I/O operation
  // ==========================================================================

  /**
   * Create a WebSocket and wire up event handlers to dispatch messages.
   *
   * The message handler is set up IMMEDIATELY after creation (before
   * the open event) to handle the race condition where the server sends
   * "ready" before the client's open promise resolves.
   */
  #doCreateWebsocket(dispatch: (msg: WsClientMsg) => void): void {
    const peerId = this.#peerId
    if (!peerId) {
      dispatch({
        type: "socket-error",
        error: new Error("Cannot connect: peerId not set"),
      })
      return
    }

    // Resolve URL
    const url =
      typeof this.#options.url === "function"
        ? this.#options.url(peerId)
        : this.#options.url

    try {
      // Create WebSocket with optional headers (Bun-specific extension)
      if (
        this.#options.headers &&
        Object.keys(this.#options.headers).length > 0
      ) {
        type BunWebSocketConstructor = new (
          url: string,
          options: { headers: Record<string, string> },
        ) => WebSocket
        const BunWebSocket = this
          .#WebSocketImpl as unknown as BunWebSocketConstructor
        this.#socket = new BunWebSocket(url, {
          headers: this.#options.headers,
        })
      } else {
        this.#socket = new this.#WebSocketImpl(url)
      }
      this.#socket.binaryType = "arraybuffer"

      const socket = this.#socket

      // Set up message handler IMMEDIATELY to handle the "ready" race condition.
      // The server may send "ready" before the open event fires.
      socket.addEventListener("message", (event: MessageEvent) => {
        this.#handleMessage(event, dispatch)
      })

      // Track whether we've dispatched a terminal event for this connection attempt
      let settled = false

      const onOpen = () => {
        cleanup()
        settled = true
        dispatch({ type: "socket-opened" })

        // After open, set up permanent close handler for post-connection closes
        socket.addEventListener("close", (event: CloseEvent) => {
          dispatch({
            type: "socket-closed",
            code: event.code,
            reason: event.reason,
          })
        })
      }

      const onError = () => {
        if (settled) return
        cleanup()
        settled = true
        dispatch({
          type: "socket-error",
          error: new Error("WebSocket connection failed"),
        })
      }

      const onClose = () => {
        if (settled) return
        cleanup()
        settled = true
        dispatch({
          type: "socket-error",
          error: new Error("WebSocket closed during connection"),
        })
      }

      const cleanup = () => {
        socket.removeEventListener("open", onOpen)
        socket.removeEventListener("error", onError)
        socket.removeEventListener("close", onClose)
      }

      socket.addEventListener("open", onOpen)
      socket.addEventListener("error", onError)
      socket.addEventListener("close", onClose)
    } catch (error) {
      dispatch({
        type: "socket-error",
        error: error instanceof Error ? error : new Error(String(error)),
      })
    }
  }

  // ==========================================================================
  // Message handling — I/O parsing logic
  // ==========================================================================

  /**
   * Handle incoming Websocket messages.
   *
   * Text frames carry the "ready" handshake and keepalive pong.
   * Binary frames carry CBOR-encoded ChannelMsg.
   */
  #handleMessage(
    event: MessageEvent,
    dispatch: (msg: WsClientMsg) => void,
  ): void {
    const data = event.data

    // Handle text messages (keepalive and ready signal)
    if (typeof data === "string") {
      if (data === "ready") {
        dispatch({ type: "server-ready" })
      }
      // Ignore pong responses and other text
      return
    }

    // Handle binary messages through shared decode pipeline
    if (data instanceof ArrayBuffer) {
      try {
        const messages = decodeBinaryMessages(
          new Uint8Array(data),
          this.#reassembler,
        )
        if (messages) {
          for (const msg of messages) {
            this.#handleChannelMessage(msg)
          }
        }
      } catch (error) {
        console.error("Failed to decode message:", error)
      }
    }
  }

  /**
   * Handle a decoded channel message.
   */
  #handleChannelMessage(msg: ChannelMsg): void {
    if (!this.#serverChannel) {
      return
    }

    // Deliver synchronously — the Synchronizer's receive queue prevents recursion
    this.#serverChannel.onReceive(msg)
  }

  // ==========================================================================
  // Keepalive
  // ==========================================================================

  #startKeepalive(): void {
    this.#stopKeepalive()

    const interval = this.#options.keepaliveInterval ?? 30_000

    this.#keepaliveTimer = setInterval(() => {
      if (this.#socket?.readyState === WebSocket.OPEN) {
        this.#socket.send("ping")
      }
    }, interval)
  }

  #stopKeepalive(): void {
    if (this.#keepaliveTimer) {
      clearInterval(this.#keepaliveTimer)
      this.#keepaliveTimer = undefined
    }
  }

  // ==========================================================================
  // Lifecycle event forwarding
  // ==========================================================================

  #setupLifecycleEvents(): void {
    // wasConnectedBefore is observer-local state, not in the program model
    let wasConnectedBefore = false

    this.#handle.subscribeToTransitions(transition => {
      // Forward to onStateChange callback
      this.#options.lifecycle?.onStateChange?.(transition)

      const { from, to } = transition

      // onDisconnect: transitioning TO disconnected
      if (to.status === "disconnected" && to.reason) {
        this.#options.lifecycle?.onDisconnect?.(to.reason)
      }

      // onReconnecting: transitioning TO reconnecting
      if (to.status === "reconnecting") {
        this.#options.lifecycle?.onReconnecting?.(to.attempt, to.nextAttemptMs)
      }

      // onReconnected: from reconnecting/connecting TO connected/ready (after prior connection)
      if (
        wasConnectedBefore &&
        (from.status === "reconnecting" || from.status === "connecting") &&
        (to.status === "connected" || to.status === "ready")
      ) {
        this.#options.lifecycle?.onReconnected?.()
      }

      // onReady: transitioning TO ready
      if (to.status === "ready") {
        this.#options.lifecycle?.onReady?.()
        wasConnectedBefore = true
      }
    })
  }

  // ==========================================================================
  // State observation — delegated to the observable handle
  // ==========================================================================

  /**
   * Get the current connection state.
   */
  getState(): WebsocketClientState {
    return this.#handle.getState()
  }

  /**
   * Subscribe to state transitions.
   */
  subscribeToTransitions(
    listener: TransitionListener<WebsocketClientState>,
  ): () => void {
    return this.#handle.subscribeToTransitions(listener)
  }

  /**
   * Wait for a specific state.
   */
  waitForState(
    predicate: (state: WebsocketClientState) => boolean,
    options?: { timeoutMs?: number },
  ): Promise<WebsocketClientState> {
    return this.#handle.waitForState(predicate, options)
  }

  /**
   * Wait for a specific status.
   */
  waitForStatus(
    status: WebsocketClientState["status"],
    options?: { timeoutMs?: number },
  ): Promise<WebsocketClientState> {
    return this.#handle.waitForStatus(status, options)
  }

  /**
   * Whether the client is ready (server ready signal received).
   */
  get isReady(): boolean {
    return this.#handle.getState().status === "ready"
  }

  // ==========================================================================
  // Transport abstract method implementations
  // ==========================================================================

  protected generate(): GeneratedChannel {
    return {
      transportType: this.transportType,
      send: (msg: ChannelMsg) => {
        const socket = this.#socket
        if (!socket || socket.readyState !== WebSocket.OPEN) {
          return
        }

        encodeBinaryAndSend(msg, this.#fragmentThreshold, data =>
          socket.send(new Uint8Array(data).buffer),
        )
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
        "Transport not properly initialized — identity not available",
      )
    }
    this.#peerId = this.identity.peerId
    this.#handle.dispatch({ type: "start" })
  }

  async onStop(): Promise<void> {
    this.#reassembler.dispose()
    this.#handle.dispatch({ type: "stop" })
  }
}

// ---------------------------------------------------------------------------
// Factory functions
// ---------------------------------------------------------------------------

/**
 * Create a Websocket client transport factory for browser-to-server
 * connections.
 *
 * Returns an `TransportFactory` — a closure that creates a fresh transport
 * instance when called. Pass directly to `Exchange({ transports: [...] })`.
 *
 * @example
 * ```typescript
 * import { createWebsocketClient } from "@kyneta/websocket-transport/client"
 *
 * const exchange = new Exchange({
 *   transports: [createWebsocketClient({
 *     url: "ws://localhost:3000/ws",
 *     reconnect: { enabled: true },
 *   })],
 * })
 * ```
 */
export function createWebsocketClient(
  options: WebsocketClientOptions,
): TransportFactory {
  return () => new WebsocketClientTransport(options)
}

/**
 * Create a Websocket client transport for service-to-service connections.
 *
 * This factory is for backend environments (Bun, Node.js) where you need
 * to pass authentication headers during the Websocket upgrade.
 *
 * Note: Headers are a Bun/Node-specific extension. The browser WebSocket API
 * does not support custom headers. For browser clients, use
 * `createWebsocketClient()` and authenticate via URL query parameters.
 *
 * @example
 * ```typescript
 * import { createServiceWebsocketClient } from "@kyneta/websocket-transport/client"
 *
 * const exchange = new Exchange({
 *   transports: [createServiceWebsocketClient({
 *     url: "ws://primary-server:3000/ws",
 *     headers: { Authorization: "Bearer token" },
 *     reconnect: { enabled: true },
 *   })],
 * })
 * ```
 */
export function createServiceWebsocketClient(
  options: ServiceWebsocketClientOptions,
): TransportFactory {
  return () => new WebsocketClientTransport(options)
}

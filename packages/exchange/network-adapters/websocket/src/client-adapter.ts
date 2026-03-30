// client-adapter — Websocket client adapter for @kyneta/exchange.
//
// Connects to a Websocket server and handles bidirectional communication
// using the kyneta wire format (CBOR codec + framing + fragmentation).
//
// Features:
// - State machine with validated transitions (disconnected → connecting → connected → ready)
// - Exponential backoff reconnection with jitter
// - Keepalive ping/pong (text frames, default 30s)
// - Transport-level fragmentation for large payloads
// - Observable connection state via subscribeToTransitions()
//
// The connection handshake:
// 1. Client creates Websocket, waits for open
// 2. Server sends text "ready" signal
// 3. Client creates channel + calls establishChannel()
// 4. Synchronizer exchanges establish-request / establish-response
//
// Ported from @loro-extended/adapter-websocket's WsClientNetworkAdapter
// with kyneta naming conventions and the kyneta 5-message protocol.

import { Adapter } from "@kyneta/exchange"
import type {
  Channel,
  ChannelMsg,
  GeneratedChannel,
  PeerId,
} from "@kyneta/exchange"
import {
  cborCodec,
  encodeComplete,
  decodeBinaryFrame,
  FragmentReassembler,
  fragmentPayload,
  wrapCompleteMessage,
} from "@kyneta/wire"
import { WebsocketClientStateMachine } from "./client-state-machine.js"
import type {
  DisconnectReason,
  WebsocketClientState,
  WebsocketClientStateTransition,
  TransitionListener,
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
 * Options for the Websocket client adapter (browser connections).
 */
export interface WebsocketClientOptions {
  /** Websocket URL to connect to. Can be a string or a function of peerId. */
  url: string | ((peerId: PeerId) => string)

  /** Optional custom WebSocket implementation (for Node.js or testing). */
  WebSocket?: typeof globalThis.WebSocket

  /** Reconnection options. */
  reconnect?: {
    enabled: boolean
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

/**
 * Default reconnection options.
 */
const DEFAULT_RECONNECT = {
  enabled: true,
  maxAttempts: 10,
  baseDelay: 1000,
  maxDelay: 30000,
}

// ---------------------------------------------------------------------------
// WebsocketClientAdapter
// ---------------------------------------------------------------------------

/**
 * Websocket client network adapter for @kyneta/exchange.
 *
 * Connects to a Websocket server, sends and receives ChannelMsg via
 * the kyneta wire format (CBOR codec + framing + fragmentation).
 *
 * Prefer the factory functions for construction:
 * - `createWebsocketClient()` — browser-to-server
 * - `createServiceWebsocketClient()` — service-to-service (with headers)
 */
export class WebsocketClientAdapter extends Adapter<void> {
  #peerId?: PeerId
  #socket?: WebSocket
  #serverChannel?: Channel
  #keepaliveTimer?: ReturnType<typeof setInterval>
  #reconnectTimer?: ReturnType<typeof setTimeout>
  #options: ServiceWebsocketClientOptions
  #WebSocketImpl: typeof globalThis.WebSocket
  #shouldReconnect = true
  #wasConnectedBefore = false

  // State machine
  readonly #stateMachine = new WebsocketClientStateMachine()

  // Fragmentation
  readonly #fragmentThreshold: number
  readonly #reassembler: FragmentReassembler

  constructor(options: ServiceWebsocketClientOptions) {
    super({ adapterType: "websocket-client" })
    this.#options = options
    this.#WebSocketImpl = options.WebSocket ?? globalThis.WebSocket
    this.#fragmentThreshold =
      options.fragmentThreshold ?? DEFAULT_FRAGMENT_THRESHOLD
    this.#reassembler = new FragmentReassembler({
      timeoutMs: 10_000,
    })

    // Set up lifecycle event forwarding
    this.#setupLifecycleEvents()
  }

  // ==========================================================================
  // Lifecycle event forwarding
  // ==========================================================================

  #setupLifecycleEvents(): void {
    this.#stateMachine.subscribeToTransitions(transition => {
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
        this.#wasConnectedBefore &&
        (from.status === "reconnecting" || from.status === "connecting") &&
        (to.status === "connected" || to.status === "ready")
      ) {
        this.#options.lifecycle?.onReconnected?.()
      }

      // onReady: transitioning TO ready
      if (to.status === "ready") {
        this.#options.lifecycle?.onReady?.()
      }
    })
  }

  // ==========================================================================
  // State observation API
  // ==========================================================================

  /**
   * Get the current state of the connection.
   */
  getState(): WebsocketClientState {
    return this.#stateMachine.getState()
  }

  /**
   * Subscribe to state transitions.
   * @returns Unsubscribe function
   */
  subscribeToTransitions(listener: TransitionListener): () => void {
    return this.#stateMachine.subscribeToTransitions(listener)
  }

  /**
   * Wait for a specific state.
   */
  waitForState(
    predicate: (state: WebsocketClientState) => boolean,
    options?: { timeoutMs?: number },
  ): Promise<WebsocketClientState> {
    return this.#stateMachine.waitForState(predicate, options)
  }

  /**
   * Wait for a specific status.
   */
  waitForStatus(
    status: WebsocketClientState["status"],
    options?: { timeoutMs?: number },
  ): Promise<WebsocketClientState> {
    return this.#stateMachine.waitForStatus(status, options)
  }

  /**
   * Check if the client is ready (server ready signal received).
   */
  get isReady(): boolean {
    return this.#stateMachine.isReady()
  }

  // ==========================================================================
  // Adapter abstract method implementations
  // ==========================================================================

  protected generate(): GeneratedChannel {
    return {
      kind: "network",
      adapterType: this.adapterType,
      send: (msg: ChannelMsg) => {
        if (!this.#socket || this.#socket.readyState !== WebSocket.OPEN) {
          return
        }

        const frame = encodeComplete(cborCodec, msg)

        // Fragment large payloads for cloud infrastructure compatibility
        if (
          this.#fragmentThreshold > 0 &&
          frame.length > this.#fragmentThreshold
        ) {
          const fragments = fragmentPayload(frame, this.#fragmentThreshold)
          for (const fragment of fragments) {
            this.#socket.send(fragment)
          }
        } else {
          // Wrap with MESSAGE_COMPLETE prefix for transport layer consistency
          this.#socket.send(wrapCompleteMessage(frame))
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
    this.#shouldReconnect = true
    this.#wasConnectedBefore = false
    await this.#connect()
  }

  async onStop(): Promise<void> {
    this.#shouldReconnect = false
    this.#reassembler.dispose()
    this.#disconnect({ type: "intentional" })
  }

  // ==========================================================================
  // Connection management
  // ==========================================================================

  /**
   * Connect to the Websocket server.
   */
  async #connect(): Promise<void> {
    const currentState = this.#stateMachine.getState()
    if (currentState.status === "connecting") {
      return
    }

    if (!this.#peerId) {
      throw new Error("Cannot connect: peerId not set")
    }

    // Determine attempt number
    const attempt =
      currentState.status === "reconnecting" ? currentState.attempt : 1

    this.#stateMachine.transition({ status: "connecting", attempt })

    // Resolve URL
    const url =
      typeof this.#options.url === "function"
        ? this.#options.url(this.#peerId)
        : this.#options.url

    try {
      // Create WebSocket with optional headers (Bun-specific extension)
      if (
        this.#options.headers &&
        Object.keys(this.#options.headers).length > 0
      ) {
        // Bun extends the standard WebSocket API with a non-standard constructor
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

      // IMPORTANT: Set up message handler IMMEDIATELY after creating the socket.
      // This must happen BEFORE waiting for the open event to avoid a race
      // condition where the server sends "ready" before the handler is attached.
      this.#socket.addEventListener("message", event => {
        this.#handleMessage(event)
      })

      await new Promise<void>((resolve, reject) => {
        if (!this.#socket) {
          reject(new Error("Socket not created"))
          return
        }

        const onOpen = () => {
          cleanup()
          resolve()
        }

        const onError = (event: Event) => {
          cleanup()
          reject(new Error(`WebSocket connection failed: ${event}`))
        }

        const onClose = () => {
          cleanup()
          reject(new Error("WebSocket closed during connection"))
        }

        const cleanup = () => {
          this.#socket?.removeEventListener("open", onOpen)
          this.#socket?.removeEventListener("error", onError)
          this.#socket?.removeEventListener("close", onClose)
        }

        this.#socket.addEventListener("open", onOpen)
        this.#socket.addEventListener("error", onError)
        this.#socket.addEventListener("close", onClose)
      })

      // Socket is now open — transition to connected
      this.#stateMachine.transition({ status: "connected" })

      // Set up close handler for disconnections after connection is established
      this.#socket.addEventListener("close", event => {
        this.#handleClose(event.code, event.reason)
      })

      // Start keepalive
      this.#startKeepalive()

      // Note: Channel creation is deferred until we receive the "ready" signal
      // from the server. This ensures the server is fully set up before we
      // start sending messages.
    } catch (error) {
      // Transition to reconnecting or disconnected
      this.#scheduleReconnect({
        type: "error",
        error: error instanceof Error ? error : new Error(String(error)),
      })
    }
  }

  /**
   * Disconnect from the Websocket server.
   */
  #disconnect(reason: DisconnectReason): void {
    this.#stopKeepalive()
    this.#clearReconnectTimer()

    if (this.#socket) {
      this.#socket.close(1000, "Client disconnecting")
      this.#socket = undefined
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
  // Message handling
  // ==========================================================================

  /**
   * Handle incoming Websocket messages.
   */
  #handleMessage(event: MessageEvent): void {
    const data = event.data

    // Handle text messages (keepalive and ready signal)
    if (typeof data === "string") {
      if (data === "ready") {
        this.#handleServerReady()
      }
      // Ignore pong responses
      return
    }

    // Handle binary messages through reassembler
    if (data instanceof ArrayBuffer) {
      const result = this.#reassembler.receiveRaw(new Uint8Array(data))

      if (result.status === "complete") {
        try {
          const frame = decodeBinaryFrame(result.data)
          const messages = cborCodec.decode(frame.content.payload)
          for (const msg of messages) {
            this.#handleChannelMessage(msg)
          }
        } catch (error) {
          console.error("Failed to decode message:", error)
        }
      } else if (result.status === "error") {
        console.error("Fragment reassembly error:", result.error)
      }
      // "pending" status means we're waiting for more fragments — nothing to do
    }
  }

  /**
   * Handle the "ready" signal from the server.
   *
   * Creates the channel and starts the establishment handshake.
   * The "ready" signal is a transport-level indicator that the server's
   * Websocket handler is ready. After receiving it, we create our channel
   * and send a real establish-request.
   */
  #handleServerReady(): void {
    const currentState = this.#stateMachine.getState()
    if (currentState.status === "ready") {
      // Already received ready signal, ignore duplicate
      return
    }

    // Handle race condition: if we receive "ready" while still in "connecting" state,
    // the server sent the ready signal before our open promise resolved.
    // Transition through "connected" first to maintain valid state machine transitions.
    if (currentState.status === "connecting") {
      this.#stateMachine.transition({ status: "connected" })
    }

    // Transition to ready state
    this.#stateMachine.transition({ status: "ready" })
    this.#wasConnectedBefore = true

    // Create channel if not exists
    if (this.#serverChannel) {
      this.removeChannel(this.#serverChannel.channelId)
      this.#serverChannel = undefined
    }

    this.#serverChannel = this.addChannel()

    // Send real establish-request over the wire
    // The server will respond with establish-response containing its actual identity
    this.establishChannel(this.#serverChannel.channelId)
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

  /**
   * Handle Websocket close.
   */
  #handleClose(code: number, reason: string): void {
    this.#stopKeepalive()

    if (this.#serverChannel) {
      this.removeChannel(this.#serverChannel.channelId)
      this.#serverChannel = undefined
    }

    // Schedule reconnect or transition to disconnected
    this.#scheduleReconnect({ type: "closed", code, reason })
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
  // Reconnection
  // ==========================================================================

  /**
   * Schedule a reconnection attempt or transition to disconnected.
   */
  #scheduleReconnect(reason: DisconnectReason): void {
    const currentState = this.#stateMachine.getState()

    // If already disconnected, don't transition again
    if (currentState.status === "disconnected") {
      return
    }

    const reconnectOpts = {
      ...DEFAULT_RECONNECT,
      ...this.#options.reconnect,
    }

    if (!this.#shouldReconnect || !reconnectOpts.enabled) {
      this.#stateMachine.transition({ status: "disconnected", reason })
      return
    }

    // Get current attempt count from state
    const currentAttempt =
      currentState.status === "reconnecting"
        ? currentState.attempt
        : currentState.status === "connecting"
          ? (currentState as { attempt: number }).attempt
          : 0

    if (currentAttempt >= reconnectOpts.maxAttempts) {
      this.#stateMachine.transition({
        status: "disconnected",
        reason: { type: "max-retries-exceeded", attempts: currentAttempt },
      })
      return
    }

    const nextAttempt = currentAttempt + 1

    // Exponential backoff with jitter
    const delay = Math.min(
      reconnectOpts.baseDelay * 2 ** (nextAttempt - 1) + Math.random() * 1000,
      reconnectOpts.maxDelay,
    )

    this.#stateMachine.transition({
      status: "reconnecting",
      attempt: nextAttempt,
      nextAttemptMs: delay,
    })

    this.#reconnectTimer = setTimeout(() => {
      this.#connect()
    }, delay)
  }

  #clearReconnectTimer(): void {
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer)
      this.#reconnectTimer = undefined
    }
  }
}

// ---------------------------------------------------------------------------
// Factory functions
// ---------------------------------------------------------------------------

/**
 * Create a Websocket client adapter for browser-to-server connections.
 *
 * @example
 * ```typescript
 * import { createWebsocketClient } from "@kyneta/websocket-network-adapter/client"
 *
 * const adapter = createWebsocketClient({
 *   url: "ws://localhost:3000/ws",
 *   reconnect: { enabled: true },
 * })
 *
 * const exchange = new Exchange({
 *   identity: { peerId: "browser-client" },
 *   adapters: [adapter],
 * })
 * ```
 */
export function createWebsocketClient(
  options: WebsocketClientOptions,
): WebsocketClientAdapter {
  return new WebsocketClientAdapter(options)
}

/**
 * Create a Websocket client adapter for service-to-service connections.
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
 * import { createServiceWebsocketClient } from "@kyneta/websocket-network-adapter/client"
 *
 * const adapter = createServiceWebsocketClient({
 *   url: "ws://primary-server:3000/ws",
 *   headers: { Authorization: "Bearer token" },
 *   reconnect: { enabled: true },
 * })
 * ```
 */
export function createServiceWebsocketClient(
  options: ServiceWebsocketClientOptions,
): WebsocketClientAdapter {
  return new WebsocketClientAdapter(options)
}
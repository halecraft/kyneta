// server-adapter — Websocket server adapter for @kyneta/exchange.
//
// Manages Websocket connections from clients, encoding/decoding via the
// kyneta wire format. Framework-agnostic — works with any Websocket
// library through the Socket interface.
//
// Usage with Bun:
//   import { WebsocketServerTransport } from "@kyneta/websocket-transport/server"
//   import { createBunWebsocketHandlers } from "@kyneta/websocket-transport/bun"
//
//   const serverAdapter = new WebsocketServerTransport()
//   Bun.serve({
//     websocket: createBunWebsocketHandlers(serverAdapter),
//     fetch(req, server) { server.upgrade(req); return new Response("", { status: 101 }) },
//   })
//
// Usage with Node.js `ws`:
//   import { WebsocketServerTransport, wrapNodeWebsocket } from "@kyneta/websocket-transport/server"
//   import { WebSocketServer } from "ws"
//
//   const serverAdapter = new WebsocketServerTransport()
//   const wss = new WebSocketServer({ server })
//   wss.on("connection", (ws) => {
//     const { start } = serverAdapter.handleConnection({ socket: wrapNodeWebsocket(ws) })
//     start()
//   })
//
// Ported from @loro-extended/adapter-websocket's WsServerNetworkAdapter with
// kyneta naming conventions and the kyneta 5-message protocol.

import type { ChannelMsg, GeneratedChannel, PeerId } from "@kyneta/transport"
import { randomPeerId, Transport } from "@kyneta/transport"
import {
  DEFAULT_FRAGMENT_THRESHOLD,
  WebsocketConnection,
} from "./connection.js"
import {
  DEFAULT_DRAIN,
  type DrainOptions,
  type DrainResult,
  planDrainSchedule,
  type ResolvedDrainOptions,
  resolveDrainOptions,
} from "./drain.js"
import type {
  WebsocketConnectionOptions,
  WebsocketConnectionResult,
} from "./types.js"

// Re-export the drain types so consumers can import them from `./server`.
export type { DrainOptions, DrainResult } from "./drain.js"

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Options for the Websocket server adapter.
 */
export interface WebsocketServerTransportOptions {
  /**
   * Fragment threshold in bytes. Messages larger than this are fragmented.
   * Set to 0 to disable fragmentation (not recommended for cloud deployments).
   * Default: 100KB (safe for AWS API Gateway's 128KB limit)
   */
  fragmentThreshold?: number

  /**
   * Default options for {@link WebsocketServerTransport.drainConnections}.
   * Configure the jitter window / close code / deadline once here so the
   * deploy-time call can be a bare `await transport.drainConnections()`.
   * Per-call options passed to `drainConnections` override these.
   */
  drain?: DrainOptions
}

// ---------------------------------------------------------------------------
// WebsocketServerTransport
// ---------------------------------------------------------------------------

/**
 * Websocket server network adapter.
 *
 * Framework-agnostic — works with any Websocket library through the
 * `Socket` interface. Use `handleConnection()` to integrate with your
 * framework's Websocket upgrade handler.
 *
 * Each client connection is tracked as a `WebsocketConnection` keyed
 * by peer ID. The adapter creates a channel per connection and routes
 * outbound messages through the connection's send method.
 *
 * The connection handshake follows a two-phase protocol:
 * 1. Server sends text `"ready"` signal (transport-level)
 * 2. Client sends `establish` (protocol-level)
 * 3. Server upgrades channel and sends present (handled by Synchronizer)
 *
 * The server does NOT call `establishChannel()` — it waits for the
 * client's establish to avoid a race condition where the binary
 * establish could arrive before the client has processed "ready".
 */
export class WebsocketServerTransport extends Transport<PeerId> {
  #connections = new Map<PeerId, WebsocketConnection>()
  readonly #fragmentThreshold: number
  readonly #drainDefaults: DrainOptions

  // Drain state. `#draining` is one-way (set true by drainConnections, reset
  // only by onStop so a re-initialized transport accepts again). `#resolvedDrain`
  // holds the close code/reason so the stop-accepting guard in handleConnection
  // can refuse new sockets with the same code. `#onDrainComplete` is the
  // map-empty signal an active drain awaits — fired from unregisterConnection.
  #draining = false
  #resolvedDrain: ResolvedDrainOptions | null = null
  #onDrainComplete: (() => void) | undefined

  constructor(options?: WebsocketServerTransportOptions) {
    super({ transportType: "websocket-server" })
    this.#fragmentThreshold =
      options?.fragmentThreshold ?? DEFAULT_FRAGMENT_THRESHOLD
    this.#drainDefaults = options?.drain ?? {}
  }

  // ==========================================================================
  // Adapter abstract method implementations
  // ==========================================================================

  protected generate(peerId: PeerId): GeneratedChannel {
    return {
      transportType: this.transportType,
      send: (msg: ChannelMsg) => {
        const connection = this.#connections.get(peerId)
        if (connection) {
          connection.send(msg)
        }
      },
      stop: () => {
        this.unregisterConnection(peerId)
      },
    }
  }

  async onStart(): Promise<void> {
    // Server adapter starts passively — connections arrive via handleConnection()
  }

  async onStop(): Promise<void> {
    // Immediate hard-close fallback. The graceful path is drainConnections();
    // after a drain this loop is a near-no-op because the map is already empty.
    for (const connection of this.#connections.values()) {
      connection.close(1001, "Server shutting down")
    }
    this.#connections.clear()
    // Reset drain state so a re-initialized transport (e.g. HMR re-init, which
    // routes through onStop) accepts connections again instead of refusing them.
    this.#draining = false
    this.#resolvedDrain = null
  }

  // ==========================================================================
  // Graceful drain
  // ==========================================================================

  /** Whether a drain is in progress (new connections are being refused). */
  get isDraining(): boolean {
    return this.#draining
  }

  /**
   * Gracefully drain all connections for a rolling deploy.
   *
   * Stops accepting new connections (see {@link handleConnection}), then closes
   * each open connection at a jittered offset in `[0, windowMs)` so clients
   * reconnect staggered rather than stampeding the next instance. Resolves when
   * every socket has closed **or** the deadline elapses — the imperative shell
   * around the pure {@link planDrainSchedule}.
   *
   * Call this in a SIGTERM handler *after* stopping the HTTP-layer upgrade and
   * *before* `exchange.shutdown()`. Per-call `options` override the constructor
   * `drain` defaults.
   *
   * @example
   * ```typescript
   * process.once("SIGTERM", async () => {
   *   wss.close()                            // stop accepting (optional; guarded)
   *   await transport.drainConnections()     // staggered close + await drain
   *   await exchange.shutdown()
   *   httpServer.close(() => process.exit(0))
   * })
   * ```
   */
  async drainConnections(options?: DrainOptions): Promise<DrainResult> {
    const resolved = resolveDrainOptions(options, this.#drainDefaults)
    this.#draining = true
    this.#resolvedDrain = resolved

    const snapshot = Array.from(this.#connections.keys())
    if (snapshot.length === 0) {
      return { closed: 0, remaining: 0, timedOut: false }
    }

    const schedule = planDrainSchedule(
      snapshot,
      resolved.windowMs,
      resolved.randomFn,
    )
    const timers: ReturnType<typeof setTimeout>[] = []

    return await new Promise<DrainResult>(resolve => {
      let settled = false
      const finish = (timedOut: boolean): void => {
        if (settled) return
        settled = true
        for (const timer of timers) clearTimeout(timer)
        this.#onDrainComplete = undefined
        const remaining = this.#connections.size
        resolve({ closed: snapshot.length - remaining, remaining, timedOut })
      }

      // Completion signal: each socket's onClose → unregisterConnection; when
      // the connection map empties, this fires (no busy-polling).
      this.#onDrainComplete = () => finish(false)

      // Staggered closes — re-read the map at fire time in case the connection
      // already departed on its own.
      for (const step of schedule) {
        timers.push(
          setTimeout(() => {
            this.#connections
              .get(step.peerId)
              ?.close(resolved.closeCode, resolved.closeReason)
          }, step.delayMs),
        )
      }

      // A half-open socket may never fire onClose, so the completion signal
      // alone could hang forever — bound the wait with a deadline.
      timers.push(setTimeout(() => finish(true), resolved.deadlineMs))
    })
  }

  // ==========================================================================
  // Connection management
  // ==========================================================================

  /**
   * Handle a new Websocket connection.
   *
   * Call this from your framework's Websocket upgrade handler.
   * Returns a connection handle and a `start()` function that begins
   * message processing and sends the "ready" signal.
   *
   * @param options - Connection options including the Socket and optional peer ID
   * @returns A connection handle and start function
   *
   * @example Bun
   * ```typescript
   * const { start } = serverAdapter.handleConnection({
   *   socket: wrapBunWebsocket(ws),
   * })
   * start()
   * ```
   *
   * @example Node.js ws
   * ```typescript
   * wss.on("connection", (ws) => {
   *   const { start } = serverAdapter.handleConnection({
   *     socket: wrapNodeWebsocket(ws),
   *   })
   *   start()
   * })
   * ```
   */
  handleConnection(
    options: WebsocketConnectionOptions,
  ): WebsocketConnectionResult {
    const { socket, peerId: providedPeerId } = options

    // Stop-accepting backstop: once draining, refuse new connections at the
    // transport layer even if the app's HTTP upgrade handler keeps accepting.
    // This makes app-level stop-accepting an optimization, not a correctness
    // requirement — no new sync channel is established, so the herd can't reform.
    if (this.#draining) {
      const code = this.#resolvedDrain?.closeCode ?? DEFAULT_DRAIN.closeCode
      const reason =
        this.#resolvedDrain?.closeReason ?? DEFAULT_DRAIN.closeReason
      socket.close(code, reason)
      return {
        connection: {
          peerId: providedPeerId ?? ("ws-refused" as PeerId),
          channelId: -1,
          close: () => {},
        },
        start: () => {},
      }
    }

    // Generate peer ID if not provided
    const peerId = providedPeerId ?? (`ws-${randomPeerId()}` as PeerId)

    // Check for existing connection with same peer ID
    const existingConnection = this.#connections.get(peerId)
    if (existingConnection) {
      existingConnection.close(1000, "Replaced by new connection")
      this.unregisterConnection(peerId)
    }

    // Create channel for this peer
    const channel = this.addChannel(peerId)

    // Create connection object with fragmentation config
    const connection = new WebsocketConnection(
      peerId,
      channel.channelId,
      socket,
      {
        fragmentThreshold: this.#fragmentThreshold,
        onFrame: ev => this.frameObserver?.(ev),
      },
    )
    connection._setChannel(channel)

    // Store connection
    this.#connections.set(peerId, connection)

    // Set up close handler
    socket.onClose((_code, _reason) => {
      this.unregisterConnection(peerId)
    })

    socket.onError(_error => {
      this.unregisterConnection(peerId)
    })

    return {
      connection,
      start: () => {
        connection.start()

        // Send ready signal to client so it knows the server is ready
        // This is a transport-level signal, separate from protocol-level establishment
        connection.sendReady()

        // NOTE: We do NOT call establishChannel() here.
        // The client will send establish after receiving "ready".
        // Our channel gets established when the Synchronizer receives
        // and processes that establish message.
        //
        // This prevents a race condition where our binary establish
        // could arrive before the client has processed "ready" and created
        // its channel.
      },
    }
  }

  /**
   * Get an active connection by peer ID.
   */
  getConnection(peerId: PeerId): WebsocketConnection | undefined {
    return this.#connections.get(peerId)
  }

  /**
   * Get all active connections.
   */
  getAllConnections(): WebsocketConnection[] {
    return Array.from(this.#connections.values())
  }

  /**
   * Check if a peer is connected.
   */
  isConnected(peerId: PeerId): boolean {
    return this.#connections.has(peerId)
  }

  /**
   * Unregister a connection, removing its channel and cleaning up state.
   */
  unregisterConnection(peerId: PeerId): void {
    const connection = this.#connections.get(peerId)
    if (connection) {
      this.removeChannel(connection.channelId)
      this.#connections.delete(peerId)
    }

    // Signal an active drain once the last connection is gone. The finish()
    // guard makes a redundant call (e.g. deadline racing the final close) inert.
    if (
      this.#draining &&
      this.#onDrainComplete &&
      this.#connections.size === 0
    ) {
      this.#onDrainComplete()
    }
  }

  /**
   * Broadcast a message to all connected peers.
   */
  broadcast(msg: ChannelMsg): void {
    for (const connection of this.#connections.values()) {
      connection.send(msg)
    }
  }

  /**
   * Get the number of connected peers.
   */
  get connectionCount(): number {
    return this.#connections.size
  }
}

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
import { Transport } from "@kyneta/transport"
import {
  DEFAULT_FRAGMENT_THRESHOLD,
  WebsocketConnection,
} from "./connection.js"
import type {
  WebsocketConnectionOptions,
  WebsocketConnectionResult,
} from "./types.js"

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
}

// ---------------------------------------------------------------------------
// Peer ID generation
// ---------------------------------------------------------------------------

/**
 * Generate a random peer ID for connections that don't provide one.
 */
function generatePeerId(): PeerId {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
  let result = "ws-"
  for (let i = 0; i < 12; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return result
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

  constructor(options?: WebsocketServerTransportOptions) {
    super({ transportType: "websocket-server" })
    this.#fragmentThreshold =
      options?.fragmentThreshold ?? DEFAULT_FRAGMENT_THRESHOLD
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
    // Disconnect all active connections
    for (const connection of this.#connections.values()) {
      connection.close(1001, "Server shutting down")
    }
    this.#connections.clear()
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

    // Generate peer ID if not provided
    const peerId = providedPeerId ?? generatePeerId()

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

// server-adapter — SSE server adapter for @kyneta/exchange.
//
// Manages SSE connections from clients, encoding/decoding via the
// kyneta text wire format. Framework-agnostic — works with any HTTP
// framework through the SseConnection's setSendFunction() callback.
//
// Usage with Express:
//   import { SseServerAdapter } from "@kyneta/sse-network-adapter/server"
//   import { createSseExpressRouter } from "@kyneta/sse-network-adapter/express"
//
//   const serverAdapter = new SseServerAdapter()
//   app.use("/sse", createSseExpressRouter(serverAdapter))
//
// Usage with Hono:
//   import { SseServerAdapter } from "@kyneta/sse-network-adapter/server"
//   import { parseTextPostBody } from "@kyneta/sse-network-adapter/express"
//
//   const serverAdapter = new SseServerAdapter()
//   // Wire up GET /events and POST /sync manually using
//   // serverAdapter.registerConnection() and parseTextPostBody()

import { Adapter } from "@kyneta/exchange"
import type {
  ChannelMsg,
  GeneratedChannel,
  PeerId,
} from "@kyneta/exchange"
import {
  SseConnection,
  DEFAULT_FRAGMENT_THRESHOLD,
  type SseConnectionConfig,
} from "./connection.js"

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Options for the SSE server adapter.
 */
export interface SseServerAdapterOptions {
  /**
   * Fragment threshold in characters. Messages larger than this are fragmented
   * into multiple SSE events.
   * Set to 0 to disable fragmentation.
   * Default: 60000 (60K chars)
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
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
  let result = "sse-"
  for (let i = 0; i < 12; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return result
}

// ---------------------------------------------------------------------------
// SseServerAdapter
// ---------------------------------------------------------------------------

/**
 * SSE server network adapter.
 *
 * Framework-agnostic — works with any HTTP framework through the
 * `SseConnection.setSendFunction()` callback. Use `registerConnection()`
 * to integrate with your framework's SSE endpoint handler.
 *
 * Each client connection is tracked as an `SseConnection` keyed by peer ID.
 * The adapter creates a channel per connection and routes outbound messages
 * through the connection's send method (which encodes to text wire format
 * and calls the injected sendFn).
 *
 * The connection handshake:
 * 1. Client opens EventSource (GET /events)
 * 2. Server calls `registerConnection(peerId)` → creates channel
 * 3. Client's EventSource.onopen fires → client sends establish-request (POST)
 * 4. Server receives establish-request → Synchronizer responds with establish-response (SSE)
 *
 * The server does NOT call `establishChannel()` — it waits for the client's
 * establish-request, which arrives via POST after the EventSource is open.
 */
export class SseServerAdapter extends Adapter<PeerId> {
  #connections = new Map<PeerId, SseConnection>()
  readonly #fragmentThreshold: number

  constructor(options?: SseServerAdapterOptions) {
    super({ adapterType: "sse-server" })
    this.#fragmentThreshold =
      options?.fragmentThreshold ?? DEFAULT_FRAGMENT_THRESHOLD
  }

  // ==========================================================================
  // Adapter abstract method implementations
  // ==========================================================================

  protected generate(peerId: PeerId): GeneratedChannel {
    return {
      kind: "network",
      adapterType: this.adapterType,
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
    // Server adapter starts passively — connections arrive via registerConnection()
  }

  async onStop(): Promise<void> {
    // Disconnect all active connections
    for (const connection of this.#connections.values()) {
      connection.disconnect()
    }
    this.#connections.clear()
  }

  // ==========================================================================
  // Connection management
  // ==========================================================================

  /**
   * Register a new peer connection.
   *
   * Call this from your framework's SSE endpoint handler when a client
   * connects via EventSource. Returns an `SseConnection` that you wire
   * up with `setSendFunction()` and `setDisconnectHandler()`.
   *
   * @param peerId The unique identifier for the peer (from query param or header)
   * @returns An SseConnection object for managing the connection
   *
   * @example Express
   * ```typescript
   * const connection = serverAdapter.registerConnection(peerId)
   * connection.setSendFunction((textFrame) => {
   *   res.write(`data: ${textFrame}\n\n`)
   * })
   * ```
   *
   * @example Hono
   * ```typescript
   * const connection = serverAdapter.registerConnection(peerId)
   * connection.setSendFunction((textFrame) => {
   *   stream.writeSSE({ data: textFrame })
   * })
   * ```
   */
  registerConnection(peerId?: PeerId): SseConnection {
    const resolvedPeerId = peerId ?? generatePeerId()

    // Check for existing connection and clean it up
    const existingConnection = this.#connections.get(resolvedPeerId)
    if (existingConnection) {
      existingConnection.dispose()
      this.unregisterConnection(resolvedPeerId)
    }

    // Create channel for this peer
    const channel = this.addChannel(resolvedPeerId)

    // Create connection object with fragmentation config
    const connection = new SseConnection(
      resolvedPeerId,
      channel.channelId,
      { fragmentThreshold: this.#fragmentThreshold },
    )
    connection._setChannel(channel)

    // Store connection
    this.#connections.set(resolvedPeerId, connection)

    return connection
  }

  /**
   * Unregister a peer connection.
   *
   * Removes the channel, disposes the connection's reassembler,
   * and cleans up tracking state. Called automatically when the
   * client disconnects (via req.on("close")) or manually.
   *
   * @param peerId The unique identifier for the peer
   */
  unregisterConnection(peerId: PeerId): void {
    const connection = this.#connections.get(peerId)
    if (connection) {
      connection.dispose()
      this.removeChannel(connection.channelId)
      this.#connections.delete(peerId)
    }
  }

  /**
   * Get an active connection by peer ID.
   */
  getConnection(peerId: PeerId): SseConnection | undefined {
    return this.#connections.get(peerId)
  }

  /**
   * Get all active connections.
   */
  getAllConnections(): SseConnection[] {
    return Array.from(this.#connections.values())
  }

  /**
   * Check if a peer is connected.
   */
  isConnected(peerId: PeerId): boolean {
    return this.#connections.has(peerId)
  }

  /**
   * Get the number of connected peers.
   */
  get connectionCount(): number {
    return this.#connections.size
  }
}
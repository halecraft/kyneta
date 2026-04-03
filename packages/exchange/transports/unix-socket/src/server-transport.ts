// server-transport — Unix socket server transport for @kyneta/exchange.
//
// Listens on a unix domain socket path, accepts incoming connections,
// and manages the socket file lifecycle (stale cleanup on start,
// unlink on stop).
//
// Each connected client is tracked as a `UnixSocketConnection` keyed
// by a generated peer ID. The transport creates a channel per connection
// and routes outbound messages through the connection's send method.
//
// No "ready" handshake — UDS connections are bidirectionally ready
// immediately. The client calls `establishChannel` directly after connect.

import type { ChannelMsg, GeneratedChannel, PeerId } from "@kyneta/exchange"
import { Transport } from "@kyneta/exchange"
import { UnixSocketConnection } from "./connection.js"
import type { UnixSocket } from "./types.js"

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Options for the unix socket server transport.
 */
export interface UnixSocketServerOptions {
  /** Path to the unix socket file. */
  path: string
  /** Remove stale socket file on start. Default: true. */
  cleanup?: boolean
}

// ---------------------------------------------------------------------------
// Listener interface
// ---------------------------------------------------------------------------

/**
 * Platform-abstracted listener handle.
 *
 * Returned by the `listen()` function. Call `stop()` to close the
 * listening socket.
 */
export interface UnixSocketListener {
  stop(): void
}

/**
 * Callback invoked when a new client connects.
 */
export type OnConnectionCallback = (socket: UnixSocket) => void

// ---------------------------------------------------------------------------
// Peer ID generation
// ---------------------------------------------------------------------------

/**
 * Generate a random peer ID for connections that don't provide one.
 */
function generatePeerId(): PeerId {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
  let result = "uds-"
  for (let i = 0; i < 12; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return result
}

// ---------------------------------------------------------------------------
// UnixSocketServerTransport
// ---------------------------------------------------------------------------

/**
 * Unix socket server transport for @kyneta/exchange.
 *
 * Listens on a unix domain socket path and accepts incoming connections.
 * Each connection is wrapped in a `UnixSocketConnection` with stream
 * framing (StreamFrameParser) and backpressure-aware writes.
 *
 * Socket file lifecycle:
 * - `onStart()`: if `cleanup` is true and the socket file exists,
 *   removes the stale file before listening.
 * - `onStop()`: closes all connections, stops the listener, and
 *   unlinks the socket file.
 *
 * No fragmentation — uses `encodeComplete(cborCodec, msg)` directly.
 * No "ready" handshake — UDS connections are bidirectionally ready
 * immediately (unlike WebSocket which needs a text "ready" signal).
 */
export class UnixSocketServerTransport extends Transport<PeerId> {
  readonly #options: UnixSocketServerOptions
  #connections = new Map<PeerId, UnixSocketConnection>()
  #listener: UnixSocketListener | null = null

  constructor(options: UnixSocketServerOptions) {
    super({ transportType: "unix-socket-server" })
    this.#options = options
  }

  // ==========================================================================
  // Transport abstract method implementations
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
    const { path, cleanup = true } = this.#options

    // Clean up stale socket file if requested
    if (cleanup) {
      await this.#cleanupStaleSocket(path)
    }

    // Start listening
    this.#listener = await listen(path, socket => {
      this.#handleConnection(socket)
    })
  }

  async onStop(): Promise<void> {
    // Close all active connections
    for (const connection of this.#connections.values()) {
      connection.close()
    }
    this.#connections.clear()

    // Stop listener
    if (this.#listener) {
      this.#listener.stop()
      this.#listener = null
    }

    // Remove socket file
    await this.#unlinkSocket(this.#options.path)
  }

  // ==========================================================================
  // Connection management
  // ==========================================================================

  /**
   * Handle a new incoming connection.
   *
   * Generates a peer ID, wraps the socket in a UnixSocketConnection,
   * creates a channel, and starts processing messages.
   */
  #handleConnection(socket: UnixSocket): void {
    const peerId = generatePeerId()

    // Create channel for this peer
    const channel = this.addChannel(peerId)

    // Create connection
    const connection = new UnixSocketConnection(peerId, channel.channelId, socket)
    connection._setChannel(channel)

    // Store connection
    this.#connections.set(peerId, connection)

    // Set up close handler
    socket.onClose(() => {
      this.unregisterConnection(peerId)
    })

    socket.onError(_error => {
      this.unregisterConnection(peerId)
    })

    // Start processing messages
    connection.start()

    // No "ready" handshake — the client will send establish-request
    // directly after connect. Our channel gets established when the
    // Synchronizer receives and processes that establish-request.
  }

  /**
   * Get an active connection by peer ID.
   */
  getConnection(peerId: PeerId): UnixSocketConnection | undefined {
    return this.#connections.get(peerId)
  }

  /**
   * Get all active connections.
   */
  getAllConnections(): UnixSocketConnection[] {
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

  // ==========================================================================
  // INTERNAL — socket file lifecycle
  // ==========================================================================

  /**
   * Remove a stale socket file if it exists.
   *
   * Handles `EADDRINUSE` prevention on restart: if the previous process
   * crashed without cleaning up, the socket file remains. We check if
   * it exists and remove it. If it's actively in use (a running server),
   * this will not prevent `EADDRINUSE` — the listen call will fail,
   * which is the correct behavior.
   */
  async #cleanupStaleSocket(path: string): Promise<void> {
    try {
      const { unlink, stat } = await import("node:fs/promises")
      const stats = await stat(path)
      if (stats.isSocket()) {
        await unlink(path)
      }
    } catch (error: unknown) {
      // ENOENT means the file doesn't exist — that's fine
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error
      }
    }
  }

  /**
   * Unlink the socket file on stop.
   */
  async #unlinkSocket(path: string): Promise<void> {
    try {
      const { unlink } = await import("node:fs/promises")
      await unlink(path)
    } catch (error: unknown) {
      // ENOENT means the file was already removed — that's fine
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        // Log but don't throw — stop should be as graceful as possible
        console.warn(
          `[UnixSocketServerTransport] Failed to unlink socket file ${path}:`,
          error,
        )
      }
    }
  }
}

// ---------------------------------------------------------------------------
// listen — platform-abstracted server listener
// ---------------------------------------------------------------------------

/**
 * Create a unix socket server listener.
 *
 * Uses runtime detection to select between Node.js `net.createServer`
 * and Bun's `Bun.listen`. Both paths are server-side only — tree-
 * shakeability is irrelevant.
 *
 * @param path - Path to the unix socket file
 * @param onConnection - Callback invoked for each new connection
 * @returns A listener handle with a `stop()` method
 */
async function listen(
  path: string,
  onConnection: OnConnectionCallback,
): Promise<UnixSocketListener> {
  // Bun runtime detection
  if (typeof (globalThis as any).Bun !== "undefined") {
    return listenBun(path, onConnection)
  }

  return listenNode(path, onConnection)
}

/**
 * Node.js listener implementation using `net.createServer`.
 */
async function listenNode(
  path: string,
  onConnection: OnConnectionCallback,
): Promise<UnixSocketListener> {
  const { wrapNodeUnixSocket } = await import("./types.js")
  const { createServer } = await import("node:net")

  return new Promise((resolve, reject) => {
    const server = createServer(rawSocket => {
      onConnection(wrapNodeUnixSocket(rawSocket))
    })

    server.on("error", reject)

    server.listen(path, () => {
      // Remove the error handler used during startup
      server.removeListener("error", reject)

      resolve({
        stop() {
          server.close()
        },
      })
    })
  })
}

/**
 * Bun listener implementation using `Bun.listen`.
 */
async function listenBun(
  path: string,
  onConnection: OnConnectionCallback,
): Promise<UnixSocketListener> {
  const { wrapBunUnixSocket } = await import("./types.js")

  const server = (globalThis as any).Bun.listen({
    unix: path,
    socket: {
      open(rawSocket: any) {
        const { unixSocket, handlers } = wrapBunUnixSocket(rawSocket)
        // Store handlers on the Bun socket's data property for event dispatch
        rawSocket.data = handlers
        onConnection(unixSocket)
      },
      data(rawSocket: any, data: Uint8Array) {
        rawSocket.data?.onData?.(data)
      },
      close(rawSocket: any) {
        rawSocket.data?.onClose?.()
      },
      error(rawSocket: any, error: Error) {
        rawSocket.data?.onError?.(error)
      },
      drain(rawSocket: any) {
        rawSocket.data?.onDrain?.()
      },
    },
  })

  return {
    stop() {
      server.stop()
    },
  }
}
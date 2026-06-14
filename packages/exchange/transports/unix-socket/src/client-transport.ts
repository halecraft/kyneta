// client-transport — fixed-role Unix socket client transport.
//
// A thin `SocketTransport` shell over a `ConnectorDriver`: it connects to a
// socket path and maintains one channel, reconnecting with backoff. All the
// socket/channel/reconnect mechanics live in the driver (shared with the
// leaderless peer); this class only wires the Transport lifecycle and exposes
// connection-state observation.

import {
  type ConnectorDriver,
  createConnectorDriver,
} from "./connector-driver.js"
import { SocketTransport } from "./socket-transport.js"
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
// UnixSocketClientTransport
// ---------------------------------------------------------------------------

/**
 * Fixed-role Unix socket client transport for `@kyneta/exchange`.
 *
 * Connects to a unix domain socket path and maintains a single channel,
 * reconnecting with exponential backoff. Pass via
 * `new Exchange({ transports: [createUnixSocketClient({ path })] })`.
 */
export class UnixSocketClientTransport extends SocketTransport {
  readonly #driver: ConnectorDriver

  constructor(options: UnixSocketClientOptions) {
    super("unix-socket-client")
    this.#driver = createConnectorDriver({
      path: options.path,
      reconnect: options.reconnect,
      sink: this.sink,
    })
  }

  async onStart(): Promise<void> {
    this.#driver.start()
  }

  async onStop(): Promise<void> {
    await this.#driver.stop()
  }

  // ==========================================================================
  // State observation — delegated to the connector driver
  // ==========================================================================

  /** Current connection state. */
  getState(): UnixSocketClientState {
    return this.#driver.getState()
  }

  /** Wait for a specific connection status. */
  waitForStatus(
    status: UnixSocketClientState["status"],
    options?: { timeoutMs?: number },
  ): Promise<UnixSocketClientState> {
    return this.#driver.waitForStatus(status, options)
  }

  /** Whether the client is connected and ready to send/receive. */
  get isConnected(): boolean {
    return this.#driver.connected
  }
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

/**
 * Create a unix socket client transport factory for use with `Exchange`.
 *
 * @example
 * ```typescript
 * import { Exchange } from "@kyneta/exchange"
 * import { createUnixSocketClient } from "@kyneta/unix-socket-transport"
 *
 * const exchange = new Exchange({
 *   id: { peerId: "service-a", name: "Service A" },
 *   transports: [createUnixSocketClient({ path: "/tmp/kyneta.sock" })],
 * })
 * ```
 */
export function createUnixSocketClient(
  options: UnixSocketClientOptions,
): UnixSocketClientTransport {
  return new UnixSocketClientTransport(options)
}

// server-transport — fixed-role Unix socket server transport.
//
// A thin `SocketTransport` shell over a `ListenerDriver`: it binds a socket
// path, accepts inbound connections, and turns each into a channel. All the
// socket/channel mechanics live in the driver (shared with the leaderless
// peer); this class only wires the Transport lifecycle to the driver.
//
// No "ready" handshake — UDS connections are bidirectionally ready
// immediately; the connecting side sends `establish` directly.

import { createListenerDriver, type ListenerDriver } from "./listener-driver.js"
import { SocketTransport } from "./socket-transport.js"

// Re-export listener types for convenience
export type { OnConnectionCallback, UnixSocketListener } from "./listen.js"

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface UnixSocketServerOptions {
  /** Path to the unix socket file. */
  path: string
  /** Remove a stale socket file on start. Default: true. */
  cleanup?: boolean
}

// ---------------------------------------------------------------------------
// UnixSocketServerTransport
// ---------------------------------------------------------------------------

/**
 * Fixed-role Unix socket server transport for `@kyneta/exchange`.
 *
 * Listens on a unix domain socket path and hosts one channel per accepted
 * connection. Pass via `new Exchange({ transports: [() => server] })`.
 */
export function createUnixSocketServer(
  options: UnixSocketServerOptions,
): UnixSocketServerTransport {
  return new UnixSocketServerTransport(options)
}

export class UnixSocketServerTransport extends SocketTransport {
  readonly #driver: ListenerDriver

  constructor(options: UnixSocketServerOptions) {
    super("unix-socket-server")
    this.#driver = createListenerDriver({
      path: options.path,
      cleanup: options.cleanup,
      sink: this.sink,
    })
  }

  async onStart(): Promise<void> {
    await this.#driver.start()
  }

  async onStop(): Promise<void> {
    await this.#driver.stop()
  }

  /** Number of currently-connected peers. */
  get connectionCount(): number {
    return this.#driver.connectionCount
  }
}

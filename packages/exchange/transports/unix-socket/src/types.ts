// types — framework-agnostic unix socket abstractions for @kyneta/unix-socket-transport.
//
// The `UnixSocket` interface decouples the transport from any specific
// runtime (Node.js `net.Socket`, Bun unix socket). Platform-specific
// wrappers (`wrapNodeUnixSocket`, `wrapBunUnixSocket`) adapt concrete
// implementations to this interface.
//
// Unlike the WebSocket transport's `Socket` interface (message-oriented),
// `UnixSocket` is stream-oriented: `write()` returns a boolean backpressure
// signal, and `onDrain` notifies when the kernel buffer is available again.

// ---------------------------------------------------------------------------
// UnixSocket interface
// ---------------------------------------------------------------------------

/**
 * Framework-agnostic unix socket interface.
 *
 * Abstracts Node.js `net.Socket` and Bun's unix socket API behind
 * a minimal interface. The transport never touches runtime-specific
 * APIs directly.
 *
 * Stream-oriented: unlike WebSocket's `send()`, `write()` returns
 * `false` when the kernel buffer is full (backpressure). The caller
 * must wait for `onDrain` before writing again.
 */
export interface UnixSocket {
  /** Write binary data. Returns false if the kernel buffer is full (backpressure). */
  write(data: Uint8Array): boolean
  /** Signal end-of-stream and close gracefully. */
  end(): void
  /** Register handler for incoming data. */
  onData(handler: (data: Uint8Array) => void): void
  /** Register handler for connection close. */
  onClose(handler: () => void): void
  /** Register handler for errors. */
  onError(handler: (error: Error) => void): void
  /** Register handler for backpressure drain (kernel buffer available again). */
  onDrain(handler: () => void): void
}

// ---------------------------------------------------------------------------
// Client state
// ---------------------------------------------------------------------------

/**
 * All possible states of the unix socket client.
 *
 * 4-state machine (same as SSE, no "ready" phase — UDS connections
 * are bidirectionally ready immediately):
 *
 * ```
 * disconnected → connecting → connected
 *                    ↓            ↓
 *               reconnecting ← ─ ─┘
 *                    ↓
 *               connecting (retry)
 *                    ↓
 *               disconnected (max retries)
 * ```
 */
export type UnixSocketClientState =
  | { status: "disconnected"; reason?: DisconnectReason }
  | { status: "connecting"; attempt: number }
  | { status: "connected" }
  | { status: "reconnecting"; attempt: number; nextAttemptMs: number }

// ---------------------------------------------------------------------------
// Disconnect reason
// ---------------------------------------------------------------------------

/**
 * Discriminated union describing why a unix socket connection was lost.
 *
 * The `errno` field on the error variant carries socket-specific failure
 * codes (`ENOENT`, `ECONNREFUSED`, `EADDRINUSE`, `EACCES`), enabling
 * callers to distinguish socket-specific failures.
 */
export type DisconnectReason =
  | { type: "intentional" }
  | { type: "error"; error: Error; errno?: string }
  | { type: "closed" }
  | { type: "max-retries-exceeded"; attempts: number }

// ---------------------------------------------------------------------------
// Node.js wrapper
// ---------------------------------------------------------------------------

/**
 * The minimal interface we need from Node.js `net.Socket`.
 *
 * Using a structural type rather than importing `net` — consumers
 * provide the actual socket instance, we just need these methods.
 */
export interface NodeUnixSocketLike {
  write(data: Uint8Array): boolean
  end(): void
  on(event: "data", handler: (data: Buffer) => void): void
  on(event: "close", handler: () => void): void
  on(event: "error", handler: (error: Error) => void): void
  on(event: "drain", handler: () => void): void
}

/**
 * Wrap a Node.js `net.Socket` into the `UnixSocket` interface.
 *
 * Handles `Buffer` → `Uint8Array` conversion for incoming data.
 *
 * @param socket - A Node.js `net.Socket` (or anything matching `NodeUnixSocketLike`)
 */
export function wrapNodeUnixSocket(socket: NodeUnixSocketLike): UnixSocket {
  return {
    write(data: Uint8Array): boolean {
      return socket.write(data)
    },

    end(): void {
      socket.end()
    },

    onData(handler: (data: Uint8Array) => void): void {
      socket.on("data", (data: Buffer) => {
        handler(new Uint8Array(data))
      })
    },

    onClose(handler: () => void): void {
      socket.on("close", handler)
    },

    onError(handler: (error: Error) => void): void {
      socket.on("error", handler)
    },

    onDrain(handler: () => void): void {
      socket.on("drain", handler)
    },
  }
}

// ---------------------------------------------------------------------------
// Bun wrapper
// ---------------------------------------------------------------------------

/**
 * The minimal interface we need from Bun's socket.
 *
 * Bun's socket API is callback-based (set at `Bun.listen`/`Bun.connect` time),
 * not event-based. The wrapper captures handlers set via `onData`/`onClose`/etc.
 * and the caller wires them into the Bun callback structure.
 *
 * Using a structural type to avoid importing Bun types.
 */
export interface BunUnixSocketLike {
  write(data: Uint8Array): number
  end(): void
  /** Bun's data property for attaching arbitrary data to a socket. */
  data?: unknown
}

/**
 * Handler set that a Bun socket wrapper captures.
 *
 * The caller (the server listener or client connect function) reads
 * these handlers and wires them into `Bun.listen`/`Bun.connect`
 * socket callbacks (`open`, `data`, `close`, `error`, `drain`).
 */
export interface BunSocketHandlers {
  onData?: (data: Uint8Array) => void
  onClose?: () => void
  onError?: (error: Error) => void
  onDrain?: () => void
}

/**
 * Wrap a Bun unix socket into the `UnixSocket` interface.
 *
 * Because Bun's socket API is callback-based, the wrapper captures
 * handlers into a `BunSocketHandlers` object. The caller must read
 * these handlers and wire them into the Bun callback structure.
 *
 * Returns both the `UnixSocket` and the `handlers` object for wiring.
 *
 * @param socket - A Bun socket (or anything matching `BunUnixSocketLike`)
 */
export function wrapBunUnixSocket(socket: BunUnixSocketLike): {
  unixSocket: UnixSocket
  handlers: BunSocketHandlers
} {
  const handlers: BunSocketHandlers = {}

  const unixSocket: UnixSocket = {
    write(data: Uint8Array): boolean {
      // Bun's write returns the number of bytes written.
      // Returns 0 when the buffer is full (backpressure).
      const written = socket.write(data)
      return written > 0
    },

    end(): void {
      socket.end()
    },

    onData(handler: (data: Uint8Array) => void): void {
      handlers.onData = handler
    },

    onClose(handler: () => void): void {
      handlers.onClose = handler
    },

    onError(handler: (error: Error) => void): void {
      handlers.onError = handler
    },

    onDrain(handler: () => void): void {
      handlers.onDrain = handler
    },
  }

  return { unixSocket, handlers }
}
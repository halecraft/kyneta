// types — framework-agnostic Websocket abstractions for @kyneta/websocket-network-adapter.
//
// The `Socket` interface decouples the adapter from any specific Websocket
// library (browser WebSocket, Node `ws`, Bun ServerWebSocket). Platform-
// specific wrappers (`wrapStandardWebsocket`, `wrapNodeWebsocket`,
// `wrapBunWebsocket`) adapt concrete implementations to this interface.
//
// Ported from @loro-extended/adapter-websocket's WsSocket with kyneta
// naming conventions applied.

import type {
  TransitionListener as GenericTransitionListener,
  PeerId,
  StateTransition,
} from "@kyneta/exchange"

// ---------------------------------------------------------------------------
// Socket ready states
// ---------------------------------------------------------------------------

/**
 * Websocket ready states — mirrors the standard WebSocket readyState
 * values as human-readable strings.
 */
export type SocketReadyState = "connecting" | "open" | "closing" | "closed"

// ---------------------------------------------------------------------------
// Socket interface
// ---------------------------------------------------------------------------

/**
 * Framework-agnostic Websocket interface.
 *
 * This allows the adapter to work with any Websocket library:
 * - Browser `WebSocket` via `wrapStandardWebsocket()`
 * - Node.js `ws` library via `wrapNodeWebsocket()`
 * - Bun `ServerWebSocket` via `wrapBunWebsocket()`
 *
 * The interface is intentionally minimal — only the operations the
 * adapter needs are exposed.
 */
export interface Socket {
  /** Send binary or text data through the Websocket. */
  send(data: Uint8Array | string): void

  /** Close the Websocket connection. */
  close(code?: number, reason?: string): void

  /** Register a handler for incoming messages (binary or text). */
  onMessage(handler: (data: Uint8Array | string) => void): void

  /** Register a handler for connection close. */
  onClose(handler: (code: number, reason: string) => void): void

  /** Register a handler for errors. */
  onError(handler: (error: Error) => void): void

  /** The current ready state of the Websocket. */
  readonly readyState: SocketReadyState
}

// ---------------------------------------------------------------------------
// Connection types — used by server adapter
// ---------------------------------------------------------------------------

/**
 * Options for handling a new Websocket connection on the server.
 */
export interface WebsocketConnectionOptions {
  /** The Websocket instance, wrapped in the Socket interface. */
  socket: Socket

  /** Optional peer ID extracted from the upgrade request. */
  peerId?: PeerId

  /** Optional authentication token from the upgrade request. */
  authToken?: string
}

/**
 * Handle for an active Websocket connection.
 */
export interface WebsocketConnectionHandle {
  /** The peer ID for this connection. */
  readonly peerId: PeerId

  /** The channel ID for this connection. */
  readonly channelId: number

  /** Close the connection. */
  close(code?: number, reason?: string): void
}

/**
 * Result of handling a Websocket connection on the server.
 */
export interface WebsocketConnectionResult {
  /** The connection handle for managing this peer. */
  connection: WebsocketConnectionHandle

  /** Call this to start processing messages. */
  start(): void
}

// ---------------------------------------------------------------------------
// Disconnect reason
// ---------------------------------------------------------------------------

/**
 * Discriminated union describing why a Websocket connection was lost.
 */
export type DisconnectReason =
  | { type: "intentional" }
  | { type: "error"; error: Error }
  | { type: "closed"; code: number; reason: string }
  | { type: "max-retries-exceeded"; attempts: number }
  | { type: "not-started" }

// ---------------------------------------------------------------------------
// Connection state (for client adapter observability)
// ---------------------------------------------------------------------------

/**
 * All possible states of the Websocket client.
 *
 * State machine transitions:
 * ```
 * disconnected → connecting → connected → ready
 *                    ↓            ↓         ↓
 *               reconnecting ← ─ ┴ ─ ─ ─ ─ ┘
 *                    ↓
 *               connecting (retry)
 *                    ↓
 *               disconnected (max retries)
 * ```
 */
export type WebsocketClientState =
  | { status: "disconnected"; reason?: DisconnectReason }
  | { status: "connecting"; attempt: number }
  | { status: "connected" }
  | { status: "ready" }
  | { status: "reconnecting"; attempt: number; nextAttemptMs: number }

/**
 * A state transition event for websocket client states.
 * Specialized from the generic `StateTransition<S>`.
 */
export type WebsocketClientStateTransition =
  StateTransition<WebsocketClientState>

/**
 * Listener for websocket client state transitions.
 * Specialized from the generic `TransitionListener<S>`.
 */
export type TransitionListener = GenericTransitionListener<WebsocketClientState>

// ---------------------------------------------------------------------------
// Socket wrapper — standard WebSocket API (browser + Node ws)
// ---------------------------------------------------------------------------

/**
 * Wrap a standard `WebSocket` (browser or Node.js `ws` via `ws` package
 * in `WebSocket`-compatible mode) into the `Socket` interface.
 *
 * Handles `ArrayBuffer`, `Blob`, and string messages.
 */
export function wrapStandardWebsocket(ws: WebSocket): Socket {
  return {
    send(data: Uint8Array | string): void {
      ws.send(data)
    },

    close(code?: number, reason?: string): void {
      ws.close(code, reason)
    },

    onMessage(handler: (data: Uint8Array | string) => void): void {
      ws.addEventListener("message", event => {
        if (event.data instanceof ArrayBuffer) {
          handler(new Uint8Array(event.data))
        } else if (typeof Blob !== "undefined" && event.data instanceof Blob) {
          // Handle Blob data (browser)
          event.data.arrayBuffer().then(buffer => {
            handler(new Uint8Array(buffer))
          })
        } else {
          handler(event.data as string)
        }
      })
    },

    onClose(handler: (code: number, reason: string) => void): void {
      ws.addEventListener("close", event => {
        handler(event.code, event.reason)
      })
    },

    onError(handler: (error: Error) => void): void {
      ws.addEventListener("error", _event => {
        handler(new Error("WebSocket error"))
      })
    },

    get readyState(): SocketReadyState {
      switch (ws.readyState) {
        case WebSocket.CONNECTING:
          return "connecting"
        case WebSocket.OPEN:
          return "open"
        case WebSocket.CLOSING:
          return "closing"
        case WebSocket.CLOSED:
          return "closed"
        default:
          return "closed"
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Socket wrapper — Node.js `ws` library (raw API, not WebSocket-compat)
// ---------------------------------------------------------------------------

/**
 * The minimal interface we need from the Node.js `ws` library's `WebSocket`.
 *
 * Using a structural type rather than importing `ws` — consumers provide
 * the actual `ws` instance, we just need these methods.
 */
export interface NodeWebsocketLike {
  send(data: Uint8Array | string): void
  close(code?: number, reason?: string): void
  on(
    event: "message",
    handler: (data: Buffer | ArrayBuffer | string, isBinary: boolean) => void,
  ): void
  on(event: "close", handler: (code: number, reason: Buffer) => void): void
  on(event: "error", handler: (error: Error) => void): void
  readyState: number
}

/**
 * Wrap a Node.js `ws` library WebSocket into the `Socket` interface.
 *
 * Handles `Buffer` → `Uint8Array` conversion for binary messages.
 */
export function wrapNodeWebsocket(ws: NodeWebsocketLike): Socket {
  const CONNECTING = 0
  const OPEN = 1
  const CLOSING = 2

  return {
    send(data: Uint8Array | string): void {
      ws.send(data)
    },

    close(code?: number, reason?: string): void {
      ws.close(code, reason)
    },

    onMessage(handler: (data: Uint8Array | string) => void): void {
      ws.on(
        "message",
        (data: Buffer | ArrayBuffer | string, isBinary: boolean) => {
          if (isBinary) {
            if (data instanceof ArrayBuffer) {
              handler(new Uint8Array(data))
            } else if (typeof Buffer !== "undefined" && Buffer.isBuffer(data)) {
              handler(new Uint8Array(data))
            } else {
              handler(new Uint8Array(data as unknown as ArrayBuffer))
            }
          } else {
            if (typeof Buffer !== "undefined" && Buffer.isBuffer(data)) {
              handler(data.toString("utf-8"))
            } else {
              handler(data as string)
            }
          }
        },
      )
    },

    onClose(handler: (code: number, reason: string) => void): void {
      ws.on("close", (code: number, reason: Buffer) => {
        handler(code, reason.toString())
      })
    },

    onError(handler: (error: Error) => void): void {
      ws.on("error", handler)
    },

    get readyState(): SocketReadyState {
      switch (ws.readyState) {
        case CONNECTING:
          return "connecting"
        case OPEN:
          return "open"
        case CLOSING:
          return "closing"
        default:
          return "closed"
      }
    },
  }
}

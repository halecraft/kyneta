// types — framework-agnostic Websocket abstractions for @kyneta/websocket-transport.
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
} from "@kyneta/transport"

// ---------------------------------------------------------------------------
// WebSocket readyState constants (spec values, no global dependency)
// ---------------------------------------------------------------------------

/**
 * WebSocket readyState constants per the WHATWG WebSocket spec.
 * Replaces references to `WebSocket.CONNECTING`, `WebSocket.OPEN`, etc.
 * so that shared code never depends on the browser global.
 */
export const READY_STATE = {
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3,
} as const

// ---------------------------------------------------------------------------
// Structural event types (replace DOM MessageEvent / CloseEvent)
// ---------------------------------------------------------------------------

/** Minimal message event — only the fields the transport accesses. */
export interface WebSocketMessageEvent {
  readonly data: string | ArrayBuffer
}

/** Minimal close event — only the fields the transport accesses. */
export interface WebSocketCloseEvent {
  readonly code: number
  readonly reason: string
}

// ---------------------------------------------------------------------------
// WebSocket instance and constructor structural types
// ---------------------------------------------------------------------------

/**
 * Structural type for a constructed WebSocket instance.
 *
 * Covers the browser's `WebSocket`, the `ws` library's `WebSocket`,
 * and Bun's client `WebSocket` — all satisfy this interface without casting.
 *
 * The client transport uses `addEventListener`/`removeEventListener` for
 * one-shot connection handlers with explicit cleanup during the connect
 * phase. This is why `WebSocketLike` exists alongside the server-side
 * `Socket` interface (which uses single-callback registration).
 */
export interface WebSocketLike {
  readonly readyState: number
  binaryType: string
  send(data: string | ArrayBuffer): void
  close(code?: number, reason?: string): void
  addEventListener(type: string, listener: (event: any) => void): void
  removeEventListener(type: string, listener: (event: any) => void): void
}

/**
 * Structural type for a WebSocket constructor.
 *
 * Type safety for constructor arguments is intentionally at the options
 * layer (`WebsocketClientOptions.headers`), not here. The `...rest: any[]`
 * absorbs both the browser's `protocols` arg and backend's `{ headers }`
 * arg without requiring the transport to know which runtime it's in.
 */
export type WebSocketConstructor = new (
  url: string,
  ...rest: any[]
) => WebSocketLike

// ---------------------------------------------------------------------------
// Socket ready states (string enum for server-side Socket interface)
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
  /**
   * Narrowed to `Uint8Array<ArrayBuffer>` because the strictest downstream
   * runtimes reject `SharedArrayBuffer`-backed views: Bun's `BufferSource`
   * resolves to `ArrayBufferView<ArrayBuffer> | ArrayBuffer`, and Hono's
   * `WSContext.send` takes `Uint8Array<ArrayBuffer>` directly. The wire
   * pipeline allocates with `new Uint8Array(n)`, so producers satisfy this
   * without changes.
   */
  send(data: Uint8Array<ArrayBuffer> | string): void

  /** Close the Websocket connection. */
  close(code?: number, reason?: string): void

  /** Register a handler for incoming messages (binary or text). */
  onMessage(handler: (data: Uint8Array<ArrayBuffer> | string) => void): void

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
    send(data: Uint8Array<ArrayBuffer> | string): void {
      ws.send(data)
    },

    close(code?: number, reason?: string): void {
      ws.close(code, reason)
    },

    onMessage(handler: (data: Uint8Array<ArrayBuffer> | string) => void): void {
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
        case READY_STATE.CONNECTING:
          return "connecting"
        case READY_STATE.OPEN:
          return "open"
        case READY_STATE.CLOSING:
          return "closing"
        case READY_STATE.CLOSED:
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
  send(data: Uint8Array<ArrayBuffer> | string): void
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
    send(data: Uint8Array<ArrayBuffer> | string): void {
      ws.send(data)
    },

    close(code?: number, reason?: string): void {
      ws.close(code, reason)
    },

    onMessage(handler: (data: Uint8Array<ArrayBuffer> | string) => void): void {
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

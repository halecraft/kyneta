// bun-websocket — Bun-specific Websocket wrapper for @kyneta/websocket-transport.
//
// Provides a wrapper to adapt Bun's ServerWebSocket to the Socket interface
// expected by WebsocketServerAdapter.
//
// Bun's WebSocket API is callback-based at the server level (not per-socket),
// so we bridge that gap by storing handlers in ws.data.
//
// Ported from @loro-extended/adapter-websocket's bun.ts with kyneta
// naming conventions applied.

/// <reference types="bun-types" />

import type { ServerWebSocket } from "bun"
import type { Socket, SocketReadyState } from "./types.js"

// ---------------------------------------------------------------------------
// BunWebsocketData — stored in ws.data for per-socket handler callbacks
// ---------------------------------------------------------------------------

/**
 * Data structure stored in `ws.data` for handler callbacks.
 * Use this type when defining your `Bun.serve()` generic.
 *
 * @example
 * ```typescript
 * Bun.serve<BunWebsocketData>({
 *   websocket: { ... }
 * })
 * ```
 */
export type BunWebsocketData = {
  handlers: {
    onMessage?: (data: Uint8Array | string) => void
    onClose?: (code: number, reason: string) => void
  }
}

// ---------------------------------------------------------------------------
// wrapBunWebsocket
// ---------------------------------------------------------------------------

/**
 * Wrap Bun's `ServerWebSocket` to match the `Socket` interface.
 *
 * Bun's WebSocket API uses server-level callbacks (`websocket: { message, close }`)
 * rather than per-socket event handlers. This wrapper bridges that gap by
 * storing handlers in `ws.data` and having the server-level callbacks delegate
 * to them.
 *
 * @example
 * ```typescript
 * import { WebsocketServerAdapter } from "@kyneta/websocket-transport/server"
 * import { wrapBunWebsocket, type BunWebsocketData } from "@kyneta/websocket-transport/bun"
 *
 * const serverAdapter = new WebsocketServerAdapter()
 *
 * Bun.serve<BunWebsocketData>({
 *   websocket: {
 *     open(ws) {
 *       const socket = wrapBunWebsocket(ws)
 *       serverAdapter.handleConnection({ socket }).start()
 *     },
 *     message(ws, msg) {
 *       const data = msg instanceof ArrayBuffer ? new Uint8Array(msg) : msg
 *       ws.data?.handlers?.onMessage?.(data)
 *     },
 *     close(ws, code, reason) {
 *       ws.data?.handlers?.onClose?.(code, reason)
 *     },
 *   },
 * })
 * ```
 */
export function wrapBunWebsocket(
  ws: ServerWebSocket<BunWebsocketData>,
): Socket {
  ws.data = { handlers: {} }

  return {
    send(data: Uint8Array | string): void {
      ws.send(data)
    },

    close(code?: number, reason?: string): void {
      ws.close(code, reason)
    },

    onMessage(handler: (data: Uint8Array | string) => void): void {
      ws.data.handlers.onMessage = handler
    },

    onClose(handler: (code: number, reason: string) => void): void {
      ws.data.handlers.onClose = handler
    },

    onError(_handler: (error: Error) => void): void {
      // Bun handles errors at the server level, not per-socket
    },

    get readyState(): SocketReadyState {
      const states: SocketReadyState[] = [
        "connecting",
        "open",
        "closing",
        "closed",
      ]
      return states[ws.readyState] ?? "closed"
    },
  }
}

// ---------------------------------------------------------------------------
// createBunWebsocketHandlers
// ---------------------------------------------------------------------------

/**
 * Create Bun Websocket handlers that integrate with `WebsocketServerAdapter`.
 *
 * This helper eliminates boilerplate by providing pre-configured handlers
 * for `open`, `message`, and `close` events that automatically wire up
 * to the adapter's `handleConnection()` method.
 *
 * @example
 * ```typescript
 * import { WebsocketServerAdapter } from "@kyneta/websocket-transport/server"
 * import { createBunWebsocketHandlers, type BunWebsocketData } from "@kyneta/websocket-transport/bun"
 *
 * const serverAdapter = new WebsocketServerAdapter()
 *
 * Bun.serve<BunWebsocketData>({
 *   fetch(req, server) {
 *     server.upgrade(req)
 *     return new Response("upgrade failed", { status: 400 })
 *   },
 *   websocket: createBunWebsocketHandlers(serverAdapter),
 * })
 * ```
 */
export function createBunWebsocketHandlers(wsAdapter: {
  handleConnection: (opts: { socket: Socket }) => { start: () => void }
}) {
  return {
    open(ws: ServerWebSocket<BunWebsocketData>) {
      wsAdapter.handleConnection({ socket: wrapBunWebsocket(ws) }).start()
    },
    message(
      ws: ServerWebSocket<BunWebsocketData>,
      msg: string | ArrayBuffer | Buffer,
    ) {
      const data =
        msg instanceof ArrayBuffer
          ? new Uint8Array(msg)
          : Buffer.isBuffer(msg)
            ? new Uint8Array(msg)
            : msg
      ws.data.handlers.onMessage?.(data)
    },
    close(
      ws: ServerWebSocket<BunWebsocketData>,
      code: number,
      reason: string,
    ) {
      ws.data.handlers.onClose?.(code, reason)
    },
  }
}
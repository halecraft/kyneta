// express-router — Express integration for @kyneta/sse-network-adapter.
//
// Creates Express routes that integrate with SseServerTransport:
// - GET endpoint for clients to establish SSE connections
// - POST endpoint for clients to send text wire frame messages
//
// The POST endpoint accepts text/plain bodies containing text wire frames.
// The GET endpoint sends text wire frames as SSE data events.
//
// Design: Imperative Shell — delegates parsing to parseTextPostBody()
// (functional core) and message delivery to SseConnection.

import type { PeerId } from "@kyneta/transport"
import type { Request, Response, Router } from "express"
import express from "express"
import type { SseServerTransport } from "./server-transport.js"
import { parseTextPostBody } from "./sse-handler.js"

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface SseExpressRouterOptions {
  /**
   * Path for the sync endpoint where clients POST messages.
   * @default "/sync"
   */
  syncPath?: string

  /**
   * Path for the events endpoint where clients connect via SSE.
   * @default "/events"
   */
  eventsPath?: string

  /**
   * Interval in milliseconds for sending heartbeat comments to keep connections alive.
   * @default 30000 (30 seconds)
   */
  heartbeatInterval?: number

  /**
   * Custom function to extract peerId from the sync request.
   * By default, reads from the "x-peer-id" header.
   */
  getPeerIdFromSyncRequest?: (req: Request) => PeerId | undefined

  /**
   * Custom function to extract peerId from the events request.
   * By default, reads from the "peerId" query parameter.
   */
  getPeerIdFromEventsRequest?: (req: Request) => PeerId | undefined
}

// ---------------------------------------------------------------------------
// createSseExpressRouter
// ---------------------------------------------------------------------------

/**
 * Create an Express router for SSE server adapter.
 *
 * This factory function creates Express routes that integrate with the
 * SseServerTransport. It handles:
 * - POST endpoint for clients to send text wire frame messages to the server
 * - GET endpoint for clients to establish SSE connections
 * - Heartbeat mechanism to detect stale connections
 *
 * ## Wire Format
 *
 * The POST endpoint accepts text/plain bodies containing text wire frames
 * (JSON arrays with "0c"/"0f" prefix). The SSE endpoint sends text wire
 * frames as `data:` events. Both directions use the same encoding.
 *
 * @param adapter The SseServerTransport instance
 * @param options Configuration options for the router
 * @returns An Express Router ready to be mounted
 *
 * @example
 * ```typescript
 * import { SseServerTransport } from "@kyneta/sse-network-adapter/server"
 * import { createSseExpressRouter } from "@kyneta/sse-network-adapter/express"
 * import { Exchange } from "@kyneta/exchange"
 *
 * const serverAdapter = new SseServerTransport()
 * const exchange = new Exchange({
 *   identity: { peerId: "server", name: "server", type: "service" },
 *   transports: [() => serverAdapter],
 * })
 *
 * app.use("/sse", createSseExpressRouter(serverAdapter, {
 *   syncPath: "/sync",
 *   eventsPath: "/events",
 *   heartbeatInterval: 30000,
 * }))
 * ```
 */
export function createSseExpressRouter(
  adapter: SseServerTransport,
  options: SseExpressRouterOptions = {},
): Router {
  const {
    syncPath = "/sync",
    eventsPath = "/events",
    heartbeatInterval = 30000,
    getPeerIdFromSyncRequest = req => req.headers["x-peer-id"] as PeerId,
    getPeerIdFromEventsRequest = req => req.query.peerId as PeerId,
  } = options

  const router = express.Router()
  const heartbeats = new Map<PeerId, NodeJS.Timeout>()

  // ---------------------------------------------------------------------------
  // POST /sync — clients send text wire frame messages TO the server
  // ---------------------------------------------------------------------------

  router.post(
    syncPath,
    express.text({ type: "text/plain", limit: "1mb" }),
    (req: Request, res: Response) => {
      // Extract peerId from request
      const peerId = getPeerIdFromSyncRequest(req)

      if (!peerId) {
        res.status(400).json({ error: "Missing peer ID" })
        return
      }

      // Get connection for this peer
      const connection = adapter.getConnection(peerId)

      if (!connection) {
        res.status(404).json({ error: "Peer not connected" })
        return
      }

      // Ensure we have text data
      if (typeof req.body !== "string") {
        res.status(400).json({ error: "Expected text body" })
        return
      }

      // Functional core: parse body through reassembler
      const result = parseTextPostBody(connection.reassembler, req.body)

      // Imperative shell: execute side effects based on result
      if (result.type === "messages") {
        for (const msg of result.messages) {
          connection.receive(msg)
        }
      }
      // "pending" type means fragment received, waiting for more — no action needed
      // "error" type is logged implicitly by the response status

      res.status(result.response.status).json(result.response.body)
    },
  )

  // ---------------------------------------------------------------------------
  // GET /events — clients connect and listen for events FROM the server
  // ---------------------------------------------------------------------------

  router.get(eventsPath, (req: Request, res: Response) => {
    const peerId = getPeerIdFromEventsRequest(req)
    if (!peerId) {
      res.status(400).end("peerId is required")
      return
    }

    // Set headers for SSE
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    })
    res.flushHeaders()
    // Send initial comment to ensure headers are flushed and connection is established
    res.write(": ok\n\n")

    // Register connection with adapter
    const connection = adapter.registerConnection(peerId)

    // Set up send function to write pre-encoded text frames to SSE stream.
    // The connection's send() method handles encoding and fragmentation —
    // the sendFn just wraps the text frame in SSE data syntax.
    connection.setSendFunction((textFrame: string) => {
      res.write(`data: ${textFrame}\n\n`)
      // Flush the response buffer to ensure immediate delivery
      // Note: 'flush' is added by compression middleware or some environments
      if (typeof (res as any).flush === "function") {
        ;(res as any).flush()
      }
    })

    // Set up disconnect handler
    connection.setDisconnectHandler(() => {
      const hb = heartbeats.get(peerId)
      if (hb) {
        clearInterval(hb)
        heartbeats.delete(peerId)
      }
      res.end()
    })

    // Setup heartbeat to detect stale connections
    const hb = setInterval(() => {
      try {
        // Send a heartbeat comment (SSE comments are ignored by EventSource clients)
        res.write(": heartbeat\n\n")
      } catch (_err) {
        // If we can't write to the response, the connection is dead
        adapter.unregisterConnection(peerId)
        clearInterval(hb)
        heartbeats.delete(peerId)
      }
    }, heartbeatInterval)

    heartbeats.set(peerId, hb)

    // Handle client disconnect
    req.on("close", () => {
      adapter.unregisterConnection(peerId)
      const existingHb = heartbeats.get(peerId)
      if (existingHb) {
        clearInterval(existingHb)
        heartbeats.delete(peerId)
      }
    })
  })

  return router
}

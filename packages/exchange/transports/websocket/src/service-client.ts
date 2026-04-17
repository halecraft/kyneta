// service-client — service-to-service WebSocket client factory.
//
// Extracted from client-transport.ts so that the service client factory
// lives in the `./server` entry point (where it belongs) rather than
// the `./browser` entry point. Backend code imports from `./server`;
// browser code imports from `./browser`.

import type { TransportFactory } from "@kyneta/transport"
import {
  type WebsocketClientOptions,
  WebsocketClientTransport,
} from "./client-transport.js"

/**
 * Options for service-to-service Websocket connections.
 *
 * Identical to `WebsocketClientOptions` — the `headers` field is always
 * available on the base options. This alias exists for API clarity:
 * importing `ServiceWebsocketClientOptions` from `./server` signals
 * intent and pairs with `createServiceWebsocketClient`.
 */
export type ServiceWebsocketClientOptions = WebsocketClientOptions

/**
 * Create a Websocket client transport for service-to-service connections.
 *
 * This factory is for backend environments (Bun, Node.js) where you need
 * to pass authentication headers during the Websocket upgrade.
 *
 * Note: Headers are a Bun/Node-specific extension. The browser WebSocket API
 * does not support custom headers. For browser clients, use
 * `createWebsocketClient()` and authenticate via URL query parameters.
 *
 * @example
 * ```typescript
 * import { createServiceWebsocketClient } from "@kyneta/websocket-transport/server"
 *
 * const exchange = new Exchange({
 *   transports: [createServiceWebsocketClient({
 *     url: "ws://primary-server:3000/ws",
 *     WebSocket,
 *     headers: { Authorization: "Bearer token" },
 *     reconnect: { enabled: true },
 *   })],
 * })
 * ```
 */
export function createServiceWebsocketClient(
  options: ServiceWebsocketClientOptions,
): TransportFactory {
  return () => new WebsocketClientTransport(options)
}

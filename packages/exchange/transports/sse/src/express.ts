// express — barrel export for @kyneta/sse-network-adapter/express.
//
// This is the Express integration entry point. It exports everything
// needed to integrate SseServerTransport with Express.

// ---------------------------------------------------------------------------
// Express router factory
// ---------------------------------------------------------------------------

export {
  createSseExpressRouter,
  type SseExpressRouterOptions,
} from "./express-router.js"

// ---------------------------------------------------------------------------
// Server adapter (re-exported for convenience)
// ---------------------------------------------------------------------------

export { SseServerTransport } from "./server-transport.js"

// ---------------------------------------------------------------------------
// Connection (for custom framework integration)
// ---------------------------------------------------------------------------

export {
  SseConnection,
  type SseConnectionConfig,
  type SsePostResponse,
  type SsePostResult,
} from "./connection.js"

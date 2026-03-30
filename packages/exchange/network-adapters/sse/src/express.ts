// express — barrel export for @kyneta/sse-network-adapter/express.
//
// This is the Express integration entry point. It exports everything
// needed to integrate SseServerAdapter with Express.

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

export { SseServerAdapter } from "./server-adapter.js"

// ---------------------------------------------------------------------------
// Handler (for custom framework integration)
// ---------------------------------------------------------------------------

export {
  parseTextPostBody,
  type SsePostResponse,
  type SsePostResult,
} from "./sse-handler.js"
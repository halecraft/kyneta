// sse-handler — framework-agnostic SSE POST handler (Functional Core).
//
// This module provides pure functions for handling text POST requests
// in SSE adapters. Framework-specific adapters (Express, Hono, etc.)
// use these functions and handle the HTTP-specific concerns.
//
// Design: Functional Core / Imperative Shell
// - This module parses and decodes, returning a result describing what to do
// - Framework adapters execute side effects (delivering messages, sending responses)
//
// The POST body is a text wire frame string (JSON array with "0c"/"0f" prefix).
// Decoding is two-step:
//   1. TextReassembler.receive(body) → Frame<string>
//   2. JSON.parse(frame.content.payload) → textCodec.decode(parsed) → ChannelMsg[]

import type { ChannelMsg } from "@kyneta/exchange"
import { type TextReassembler, textCodec } from "@kyneta/wire"

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/**
 * Response to send back to the client after processing a POST.
 */
export interface SsePostResponse {
  status: 200 | 202 | 400
  body: { ok: true } | { pending: true } | { error: string }
}

/**
 * Result of parsing a text POST body.
 *
 * Discriminated union describing what happened:
 * - "messages": Complete message(s) decoded, ready to deliver
 * - "pending": Fragment received, waiting for more
 * - "error": Decode/reassembly error
 */
export type SsePostResult =
  | { type: "messages"; messages: ChannelMsg[]; response: SsePostResponse }
  | { type: "pending"; response: SsePostResponse }
  | { type: "error"; response: SsePostResponse }

// ---------------------------------------------------------------------------
// parseTextPostBody
// ---------------------------------------------------------------------------

/**
 * Parse a text POST body through the reassembler.
 *
 * This is the functional core of POST handling. It:
 * 1. Passes the body through the reassembler (handles fragmentation)
 * 2. If complete, decodes the text frame payload to ChannelMsg(s)
 * 3. Returns a result describing what happened
 *
 * The caller (framework adapter) executes side effects based on the result.
 *
 * @param reassembler - The connection's text fragment reassembler
 * @param body - Text wire frame string (JSON array with "0c"/"0f" prefix)
 * @returns Result describing what to do
 *
 * @example
 * ```typescript
 * // In Express router (imperative shell)
 * const result = parseTextPostBody(connection.reassembler, req.body)
 *
 * if (result.type === "messages") {
 *   for (const msg of result.messages) {
 *     connection.receive(msg)
 *   }
 * }
 *
 * res.status(result.response.status).json(result.response.body)
 * ```
 */
export function parseTextPostBody(
  reassembler: TextReassembler,
  body: string,
): SsePostResult {
  const result = reassembler.receive(body)

  if (result.status === "complete") {
    try {
      // Two-step decode:
      // 1. Frame<string> → extract payload string
      // 2. JSON.parse → textCodec.decode → ChannelMsg[]
      const parsed = JSON.parse(result.frame.content.payload)
      const messages = textCodec.decode(parsed)
      return {
        type: "messages",
        messages,
        response: { status: 200, body: { ok: true } },
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "decode_failed"
      return {
        type: "error",
        response: { status: 400, body: { error: errorMessage } },
      }
    }
  } else if (result.status === "pending") {
    return {
      type: "pending",
      response: { status: 202, body: { pending: true } },
    }
  } else {
    // result.status === "error"
    return {
      type: "error",
      response: {
        status: 400,
        body: { error: result.error.type },
      },
    }
  }
}

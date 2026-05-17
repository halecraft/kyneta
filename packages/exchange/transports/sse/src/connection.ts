// connection — SseConnection for server-side peer connections.
//
// Wraps a Pipeline<"text", "binary"> to provide send/receive
// for ChannelMsg over a single SSE connection.
//
// Used by SseServerTransport to manage individual client connections.
// The client adapter handles its own encoding/decoding inline since it
// manages a single EventSource with reconnection logic.
//
// The sendFn receives pre-encoded text frame strings. Framework
// integrations just wrap them in SSE syntax:
//   Express: res.write(`data: ${textFrame}\n\n`)
//   Hono:    stream.writeSSE({ data: textFrame })
//
// Asymmetric encoding:
//   send direction: text (SSE data events → EventSource)
//   receive direction: binary (POST body → Uint8Array)

import type { Channel, ChannelMsg, PeerId } from "@kyneta/transport"
import { Pipeline } from "@kyneta/transport"

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
 * Result of parsing a POST body.
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

/**
 * Default fragment threshold in characters for outbound SSE messages.
 * 60K chars provides a safety margin below typical infrastructure limits.
 */
export const DEFAULT_FRAGMENT_THRESHOLD = 60_000

/**
 * Configuration for creating an SseConnection.
 */
export interface SseConnectionConfig {
  /**
   * Fragment threshold in characters. Messages larger than this are fragmented.
   * Set to 0 to disable fragmentation.
   * Default: 60000 (60K chars)
   */
  fragmentThreshold?: number
}

/**
 * Represents a single SSE connection to a peer (server-side).
 *
 * Manages encoding, framing, fragmentation, reassembly, and alias
 * resolution for one connected client. Created by
 * `SseServerTransport.registerConnection()`.
 *
 * Uses Pipeline<"text", "binary"> — asymmetric encoding:
 * - Send (text): ChannelMsg → text frame → SSE data event
 * - Receive (binary): POST body (Uint8Array) → ChannelMsg
 */
export class SseConnection {
  readonly peerId: PeerId
  readonly channelId: number

  #channel: Channel | null = null
  #sendFn: ((textFrame: string) => void) | null = null
  #onDisconnect: (() => void) | null = null

  // Asymmetric wire pipeline: send text, receive binary
  #pipeline: Pipeline<"text", "binary">

  constructor(peerId: PeerId, channelId: number, config?: SseConnectionConfig) {
    this.peerId = peerId
    this.channelId = channelId
    this.#pipeline = new Pipeline({
      send: "text",
      receive: "binary",
      opts: {
        threshold: config?.fragmentThreshold ?? DEFAULT_FRAGMENT_THRESHOLD,
        reassemblyTimeoutMs: 10_000,
        onError: (e, dir) =>
          console.warn(
            `[SseConnection] wire error (${dir}) for peer ${peerId}:`,
            e,
          ),
      },
    })
  }

  // ==========================================================================
  // INTERNAL API — for adapter use
  // ==========================================================================

  /**
   * Set the channel reference.
   * Called by the adapter when the channel is created.
   * @internal
   */
  _setChannel(channel: Channel): void {
    this.#channel = channel
  }

  // ==========================================================================
  // PUBLIC API
  // ==========================================================================

  /**
   * Set the function to call when sending messages to this peer.
   *
   * The function receives a fully encoded text frame string.
   * The framework integration just wraps it in SSE syntax:
   * - Express: `res.write(\`data: \${textFrame}\\n\\n\`)`
   * - Hono: `stream.writeSSE({ data: textFrame })`
   *
   * @param sendFn Function that writes a text frame string to the SSE stream
   */
  setSendFunction(sendFn: (textFrame: string) => void): void {
    this.#sendFn = sendFn
  }

  /**
   * Set the function to call when this connection is disconnected.
   */
  setDisconnectHandler(handler: () => void): void {
    this.#onDisconnect = handler
  }

  /**
   * Send a ChannelMsg to the peer through the SSE stream.
   *
   * Runs the Pipeline<"text"> send path:
   *   ChannelMsg → Pipeline.send() → text frame(s) → sendFn()
   *
   * Fragmentation is transparent to callers — the pipeline splits
   * large frames into multiple sendFn calls automatically.
   */
  send(msg: ChannelMsg): void {
    if (!this.#sendFn) {
      throw new Error(
        `Cannot send message: send function not set for peer ${this.peerId}`,
      )
    }

    for (const r of this.#pipeline.send(msg)) {
      if (r.ok) this.#sendFn(r.value)
    }
  }

  /**
   * Handle an inbound POST body through the Pipeline<"binary"> receive path.
   *
   * Pipeline: Uint8Array → Pipeline.receive() → ChannelMsg[]
   *
   * Messages that fail alias resolution or wire-message validation are
   * surfaced as `type: "error"` results — the connection continues
   * processing remaining messages. This matches the error-dropping
   * behavior of every other transport.
   *
   * @param body - Binary POST body (Uint8Array)
   * @returns Discriminated result: `"messages"`, `"pending"`, or `"error"`
   */
  handlePostBody(body: Uint8Array<ArrayBuffer>): SsePostResult {
    try {
      const messages: ChannelMsg[] = []
      let hadError = false
      for (const r of this.#pipeline.receive(body)) {
        if (r.ok) messages.push(r.value)
        else hadError = true
      }

      if (hadError && messages.length === 0) {
        return {
          type: "error",
          response: { status: 400, body: { error: "decode_failed" } },
        }
      }

      if (messages.length === 0) {
        return {
          type: "pending",
          response: { status: 202, body: { pending: true } },
        }
      }

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
  }

  /**
   * Receive a message from the peer and route it to the channel.
   *
   * Called by the framework integration after processing a POST body
   * through `handlePostBody`.
   */
  receive(msg: ChannelMsg): void {
    if (!this.#channel) {
      throw new Error(
        `Cannot receive message: channel not set for peer ${this.peerId}`,
      )
    }
    this.#channel.onReceive(msg)
  }

  /**
   * Disconnect this connection.
   */
  disconnect(): void {
    this.#onDisconnect?.()
  }

  /**
   * Dispose of resources held by this connection.
   * Must be called when the connection is closed to prevent timer leaks.
   */
  dispose(): void {
    this.#pipeline.dispose()
  }
}

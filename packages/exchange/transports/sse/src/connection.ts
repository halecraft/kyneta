// connection — SseConnection for server-side peer connections.
//
// Wraps a TextReassembler + alias-aware pipeline to provide send/receive
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

import type { Channel, ChannelMsg, PeerId } from "@kyneta/transport"
import {
  type AliasState,
  applyInboundAliasing,
  applyOutboundAliasing,
  complete,
  createFrameIdCounter,
  decodeTextWires,
  emptyAliasState,
  encodeTextFrame,
  encodeTextWireMessage,
  fragmentTextPayload,
  TEXT_WIRE_VERSION,
  TextReassembler,
} from "@kyneta/wire"

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
 * The connection uses the alias-aware text pipeline — the same
 * `applyOutboundAliasing` / `applyInboundAliasing` transformer that
 * every other transport uses. This means SSE now participates in
 * docId/schemaHash aliasing just like binary transports.
 */
export class SseConnection {
  readonly peerId: PeerId
  readonly channelId: number

  #channel: Channel | null = null
  #sendFn: ((textFrame: string) => void) | null = null
  #onDisconnect: (() => void) | null = null

  // Fragmentation support
  readonly #fragmentThreshold: number
  #nextFrameId = createFrameIdCounter()

  // Alias-aware pipeline state
  #aliasState: AliasState = emptyAliasState()

  /**
   * Text reassembler for handling fragmented POST bodies.
   * Each connection has its own reassembler to track in-flight fragment batches.
   */
  readonly reassembler: TextReassembler

  constructor(peerId: PeerId, channelId: number, config?: SseConnectionConfig) {
    this.peerId = peerId
    this.channelId = channelId
    this.#fragmentThreshold =
      config?.fragmentThreshold ?? DEFAULT_FRAGMENT_THRESHOLD
    this.reassembler = new TextReassembler({
      timeoutMs: 10_000,
      onTimeout: (frameId: number) => {
        console.warn(
          `[SseConnection] Fragment batch timed out for peer ${peerId}: ${frameId}`,
        )
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
   * Runs the alias-aware outbound pipeline:
   *   ChannelMsg → applyOutboundAliasing → WireMessage → encodeTextWireMessage → text frame → sendFn()
   *
   * Fragmentation is transparent to callers — the connection splits
   * large frames into multiple sendFn calls automatically.
   */
  send(msg: ChannelMsg): void {
    if (!this.#sendFn) {
      throw new Error(
        `Cannot send message: send function not set for peer ${this.peerId}`,
      )
    }

    const { state, wire } = applyOutboundAliasing(this.#aliasState, msg)
    this.#aliasState = state

    const payload = JSON.stringify(encodeTextWireMessage(wire))

    const textFrame = encodeTextFrame(complete(TEXT_WIRE_VERSION, payload))

    if (
      this.#fragmentThreshold > 0 &&
      textFrame.length > this.#fragmentThreshold
    ) {
      const fragments = fragmentTextPayload(
        payload,
        this.#fragmentThreshold,
        this.#nextFrameId(),
      )
      for (const fragment of fragments) {
        this.#sendFn(fragment)
      }
    } else {
      this.#sendFn(textFrame)
    }
  }

  /**
   * Handle an inbound POST body through the full alias-aware inbound pipeline.
   *
   * Pipeline: text frame → TextReassembler → decodeTextWireMessage → applyInboundAliasing → ChannelMsg
   *
   * Messages that fail alias resolution are silently skipped (logged and
   * dropped) — the connection continues processing remaining messages.
   * This matches the error-dropping behavior of every other transport.
   *
   * @param body - Text wire frame string (JSON array with "1c"/"1f" prefix)
   * @returns Result describing what happened
   */
  handlePostBody(body: string): SsePostResult {
    try {
      const wires = decodeTextWires(this.reassembler, body)
      if (wires === null) {
        return {
          type: "pending",
          response: { status: 202, body: { pending: true } },
        }
      }

      const messages: ChannelMsg[] = []
      for (const wire of wires) {
        const result = applyInboundAliasing(this.#aliasState, wire)
        this.#aliasState = result.state
        if (result.error) {
          console.warn(
            `[SseConnection] alias resolution failed for peer ${this.peerId}:`,
            result.error,
          )
          continue
        }
        if (result.msg) {
          messages.push(result.msg)
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
    this.reassembler.dispose()
  }
}

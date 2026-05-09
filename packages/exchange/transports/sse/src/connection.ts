// connection — SseConnection for server-side peer connections.
//
// Wraps a TextReassembler + textCodec to provide send/receive for
// ChannelMsg over a single SSE connection.
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
  createFrameIdCounter,
  encodeTextComplete,
  fragmentTextPayload,
  TextReassembler,
  textCodec,
} from "@kyneta/wire"

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
 * Manages encoding, framing, fragmentation, and reassembly for one
 * connected client. Created by `SseServerTransport.registerConnection()`.
 *
 * The connection uses the text codec for transport — this is the natural
 * choice for SSE's text-only protocol.
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
   * Encodes via textCodec → text frame → fragment if needed → sendFn().
   * Encoding and fragmentation are the connection's concern — the
   * framework integration only needs to write strings.
   *
   * SSE does not yet run the alias transformer; outbound `establish`
   * messages have `features.alias` stripped so peers do not negotiate
   * alias support over SSE channels. Other features are preserved.
   */
  send(msg: ChannelMsg): void {
    if (!this.#sendFn) {
      throw new Error(
        `Cannot send message: send function not set for peer ${this.peerId}`,
      )
    }

    // Strip alias feature from outbound establish — see comment above.
    if (msg.type === "establish" && msg.features?.alias) {
      msg = {
        ...msg,
        features: { ...msg.features, alias: false },
      }
    }

    // Encode to text wire format
    const textFrame = encodeTextComplete(textCodec, msg)

    // Fragment large payloads
    if (
      this.#fragmentThreshold > 0 &&
      textFrame.length > this.#fragmentThreshold
    ) {
      const payload = JSON.stringify(textCodec.encode(msg))
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
   * Receive a message from the peer and route it to the channel.
   *
   * Called by the framework integration after parsing a POST body
   * through `parseTextPostBody`.
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

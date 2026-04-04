// connection — UnixSocketConnection for stream-oriented peer connections.
//
// Wraps a UnixSocket + CBOR codec + StreamFrameParser to provide
// send/receive for ChannelMsg over a single unix socket connection.
//
// Unlike WebsocketConnection (message-oriented), this connection uses:
// - Send: encodeComplete(cborCodec, msg) → socket.write(frameBytes) with backpressure queue
// - Receive: feedBytes(parserState, chunk) → decodeBinaryFrame → cborCodec.decode
//
// No fragmentation layer — UDS has no message size limits.
// No transport prefix bytes — stream framing handles message boundaries.
// No "ready" handshake — UDS connections are bidirectionally ready immediately.
//
// FC/IS boundary:
// - feedBytes (pure) produces frames from the byte stream
// - connection.#handleData (imperative) dispatches decoded messages
// - The write queue is imperative state; encoding is pure

import type { Channel, ChannelMsg } from "@kyneta/transport"
import {
  cborCodec,
  decodeBinaryFrame,
  encodeComplete,
  feedBytes,
  initialParserState,
  type StreamParserState,
} from "@kyneta/wire"
import type { UnixSocket } from "./types.js"

// ---------------------------------------------------------------------------
// UnixSocketConnection
// ---------------------------------------------------------------------------

/**
 * Represents a single unix socket connection to a peer.
 *
 * Manages encoding, stream framing, and backpressure-aware writing
 * for one connected peer. Created by `UnixSocketServerTransport` on
 * incoming connections and by `UnixSocketClientTransport` on connect.
 *
 * The connection uses the CBOR codec for binary transport and the
 * StreamFrameParser for extracting frames from the byte stream.
 */
export class UnixSocketConnection {
  readonly peerId: string
  readonly channelId: number

  #socket: UnixSocket
  #channel: Channel | null = null
  #started = false
  #closed = false

  // Stream frame parser state (functional core)
  #parserState: StreamParserState = initialParserState()

  // Backpressure write queue
  #writeQueue: Uint8Array[] = []
  #draining = false

  constructor(peerId: string, channelId: number, socket: UnixSocket) {
    this.peerId = peerId
    this.channelId = channelId
    this.#socket = socket
  }

  // ==========================================================================
  // INTERNAL API — for transport use
  // ==========================================================================

  /**
   * Set the channel reference.
   * Called by the transport when the channel is created.
   * @internal
   */
  _setChannel(channel: Channel): void {
    this.#channel = channel
  }

  // ==========================================================================
  // PUBLIC API
  // ==========================================================================

  /**
   * Start processing messages on this connection.
   *
   * Sets up the data, close, error, and drain handlers on the socket.
   * Must be called after the connection is fully set up (channel assigned,
   * stored in transport).
   */
  start(): void {
    if (this.#started) {
      return
    }
    this.#started = true

    this.#socket.onData(data => {
      this.#handleData(data)
    })

    this.#socket.onDrain(() => {
      this.#flushWriteQueue()
    })
  }

  /**
   * Send a ChannelMsg through the unix socket.
   *
   * Encodes via CBOR codec → binary frame → socket.write().
   * If socket.write() returns false (backpressure), the frame is queued
   * and flushed when the drain event fires.
   */
  send(msg: ChannelMsg): void {
    if (this.#closed) {
      return
    }

    const frameBytes = encodeComplete(cborCodec, msg)

    if (this.#draining) {
      // Already under backpressure — queue the frame
      this.#writeQueue.push(frameBytes)
      return
    }

    const ok = this.#socket.write(frameBytes)
    if (!ok) {
      // Kernel buffer is full — enter draining mode
      // The frame was accepted by the OS but the buffer is now full.
      // Queue subsequent frames until drain fires.
      this.#draining = true
    }
  }

  /**
   * Close the connection and clean up resources.
   */
  close(): void {
    if (this.#closed) {
      return
    }
    this.#closed = true
    this.#writeQueue = []
    this.#draining = false
    this.#socket.end()
  }

  // ==========================================================================
  // INTERNAL — data handling (imperative shell)
  // ==========================================================================

  /**
   * Handle incoming data from the socket.
   *
   * Feeds raw bytes through the StreamFrameParser (pure step function),
   * then decodes each extracted frame via decodeBinaryFrame + cborCodec.
   */
  #handleData(chunk: Uint8Array): void {
    if (this.#closed) {
      return
    }

    const result = feedBytes(this.#parserState, chunk)
    this.#parserState = result.state

    for (const frame of result.frames) {
      try {
        const decoded = decodeBinaryFrame(frame)
        if (decoded.content.kind !== "complete") {
          // Stream transports don't use fragmentation — ignore fragment frames
          console.warn(
            `[UnixSocketConnection] Unexpected fragment frame from peer ${this.peerId}`,
          )
          continue
        }

        const messages = cborCodec.decode(decoded.content.payload)
        for (const msg of messages) {
          this.#handleChannelMessage(msg)
        }
      } catch (error) {
        console.error(
          `[UnixSocketConnection] Failed to decode frame from peer ${this.peerId}:`,
          error,
        )
      }
    }
  }

  /**
   * Handle a decoded channel message.
   *
   * Delivers messages synchronously. The Synchronizer's receive queue
   * handles recursion prevention by queuing messages and processing
   * them iteratively.
   */
  #handleChannelMessage(msg: ChannelMsg): void {
    if (!this.#channel) {
      console.error(
        `[UnixSocketConnection] Cannot handle message: channel not set for peer ${this.peerId}`,
      )
      return
    }

    // Deliver synchronously — the Synchronizer's receive queue prevents recursion
    this.#channel.onReceive(msg)
  }

  // ==========================================================================
  // INTERNAL — backpressure write queue
  // ==========================================================================

  /**
   * Flush queued frames after a drain event.
   *
   * Writes queued frames in order. If any write returns false
   * (backpressure again), stops and waits for the next drain.
   */
  #flushWriteQueue(): void {
    while (this.#writeQueue.length > 0) {
      const frame = this.#writeQueue[0]!
      const ok = this.#socket.write(frame)
      if (!ok) {
        // Still under backpressure — wait for next drain
        return
      }
      this.#writeQueue.shift()
    }

    // All queued frames flushed — exit draining mode
    this.#draining = false
  }
}

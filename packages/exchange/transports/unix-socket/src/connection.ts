// connection — UnixSocketConnection for stream-oriented peer connections.
//
// Wraps a Pipeline<"binary"> + FrameStreamParser to provide
// send/receive for ChannelMsg over a single unix socket connection.
//
// Unlike WebsocketConnection (message-oriented), this connection uses:
// - Send: Pipeline.send(msg) → socket.write(frameBytes) with backpressure queue
// - Receive: FrameStreamParser.feed(chunk) → Pipeline.receive(frame) → ChannelMsg
//
// No fragmentation layer — UDS has no message size limits (threshold: Infinity).
// No transport prefix bytes — stream framing handles message boundaries.
// No "ready" handshake — UDS connections are bidirectionally ready immediately.
//
// FC/IS boundary:
// - FrameStreamParser (imperative wrapper) produces frames from the byte stream
// - Pipeline (imperative wrapper) handles aliasing + encode/decode
// - connection.#handleData (imperative) dispatches decoded messages
// - The write queue is imperative state; encoding is pure

import type { Channel, ChannelMsg } from "@kyneta/transport"
import { FrameStreamParser, Pipeline } from "@kyneta/transport"
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
 * The connection uses Pipeline<"binary"> for the full wire pipeline
 * (alias resolution, CBOR encoding, framing) and FrameStreamParser
 * for extracting frames from the byte stream.
 */
export class UnixSocketConnection {
  readonly peerId: string
  readonly channelId: number

  #socket: UnixSocket
  #channel: Channel | null = null
  #started = false
  #closed = false

  // Wire pipeline (alias + CBOR + framing)
  #pipeline: Pipeline<"binary">

  // Stream frame parser (byte stream → frames)
  #parser: FrameStreamParser

  // Backpressure write queue
  #writeQueue: Uint8Array[] = []
  #draining = false

  constructor(peerId: string, channelId: number, socket: UnixSocket) {
    this.peerId = peerId
    this.channelId = channelId
    this.#socket = socket
    this.#pipeline = new Pipeline({
      send: "binary",
      opts: { threshold: Infinity },
    })
    this.#parser = new FrameStreamParser()
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
   * Encodes via Pipeline<"binary"> → socket.write().
   * If socket.write() returns false (backpressure), the frame is queued
   * and flushed when the drain event fires.
   */
  send(msg: ChannelMsg): void {
    if (this.#closed) {
      return
    }

    for (const r of this.#pipeline.send(msg)) {
      if (!r.ok) continue

      // Write the framed bytes with backpressure handling
      if (this.#draining) {
        this.#writeQueue.push(r.value)
        return
      }

      const ok = this.#socket.write(r.value)
      if (!ok) {
        // Kernel buffer is full — enter draining mode
        // The frame was accepted by the OS but the buffer is now full.
        // Queue subsequent frames until drain fires.
        this.#draining = true
      }
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
    this.#pipeline.dispose()
    this.#socket.end()
  }

  // ==========================================================================
  // INTERNAL — data handling (imperative shell)
  // ==========================================================================

  /**
   * Handle incoming data from the socket.
   *
   * Feeds raw bytes through the FrameStreamParser, then each extracted
   * frame through Pipeline.receive() to decode and resolve aliases.
   */
  #handleData(chunk: Uint8Array): void {
    if (this.#closed) {
      return
    }

    for (const frame of this.#parser.feed(chunk)) {
      if (!frame.ok) continue

      for (const r of this.#pipeline.receive(frame.value)) {
        if (r.ok) this.#handleChannelMessage(r.value)
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
      const frame = this.#writeQueue[0]
      if (!frame) continue

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

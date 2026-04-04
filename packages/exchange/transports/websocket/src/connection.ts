// connection — WebsocketConnection for server-side peer connections.
//
// Wraps a Socket + CBOR codec + FragmentReassembler to provide
// send/receive for ChannelMsg over a single Websocket connection.
//
// Used by WebsocketServerTransport to manage individual client connections.
// The client adapter handles its own encoding/decoding inline since it
// manages a single socket with reconnection logic.
//
// Ported from @loro-extended/adapter-websocket's WsConnection with
// kyneta naming conventions and the kyneta wire format.

import type { Channel, ChannelMsg, PeerId } from "@kyneta/transport"
import {
  decodeBinaryMessages,
  encodeBinaryAndSend,
  FragmentReassembler,
} from "@kyneta/wire"
import type { Socket } from "./types.js"

/**
 * Default fragment threshold in bytes.
 * Messages larger than this are fragmented for cloud infrastructure compatibility.
 * AWS API Gateway has a 128KB limit, so 100KB provides a safe margin.
 */
export const DEFAULT_FRAGMENT_THRESHOLD = 100 * 1024

/**
 * Configuration for creating a WebsocketConnection.
 */
export interface WebsocketConnectionConfig {
  /**
   * Fragment threshold in bytes. Messages larger than this are fragmented.
   * Set to 0 to disable fragmentation (not recommended for cloud deployments).
   * Default: 100KB (safe for AWS API Gateway's 128KB limit)
   */
  fragmentThreshold?: number
}

/**
 * Represents a single Websocket connection to a peer (server-side).
 *
 * Manages encoding, framing, fragmentation, and reassembly for one
 * connected client. Created by `WebsocketServerTransport.handleConnection()`.
 *
 * The connection uses the CBOR codec for binary transport — this is
 * the natural choice for Websocket's binary frame support.
 */
export class WebsocketConnection {
  readonly peerId: PeerId
  readonly channelId: number

  #socket: Socket
  #channel: Channel | null = null
  #started = false

  // Fragmentation support
  readonly #fragmentThreshold: number
  readonly #reassembler: FragmentReassembler

  constructor(
    peerId: PeerId,
    channelId: number,
    socket: Socket,
    config?: WebsocketConnectionConfig,
  ) {
    this.peerId = peerId
    this.channelId = channelId
    this.#socket = socket
    this.#fragmentThreshold =
      config?.fragmentThreshold ?? DEFAULT_FRAGMENT_THRESHOLD
    this.#reassembler = new FragmentReassembler({
      timeoutMs: 10_000,
      onTimeout: (frameId: string) => {
        console.warn(
          `[WebsocketConnection] Fragment batch timed out: ${frameId}`,
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
   * Start processing messages on this connection.
   *
   * Sets up the message handler on the socket. Must be called after
   * the connection is fully set up (channel assigned, stored in adapter).
   */
  start(): void {
    if (this.#started) {
      return
    }
    this.#started = true

    this.#socket.onMessage(data => {
      this.#handleMessage(data)
    })
  }

  /**
   * Send a ChannelMsg through the Websocket.
   *
   * Encodes via CBOR codec → frame → fragment if needed → socket.send().
   */
  send(msg: ChannelMsg): void {
    if (this.#socket.readyState !== "open") {
      return
    }

    encodeBinaryAndSend(msg, this.#fragmentThreshold, data =>
      this.#socket.send(data),
    )
  }

  /**
   * Send a "ready" signal to the client.
   *
   * This is a transport-level text message that tells the client the
   * server is ready to receive protocol messages. The client creates
   * its channel and sends establish-request after receiving this.
   */
  sendReady(): void {
    if (this.#socket.readyState !== "open") {
      return
    }
    this.#socket.send("ready")
  }

  /**
   * Close the connection and clean up resources.
   */
  close(code?: number, reason?: string): void {
    this.#reassembler.dispose()
    this.#socket.close(code, reason)
  }

  // ==========================================================================
  // INTERNAL — message handling
  // ==========================================================================

  /**
   * Handle an incoming message from the Websocket.
   */
  #handleMessage(data: Uint8Array | string): void {
    // Handle keepalive ping/pong (text frames)
    if (typeof data === "string") {
      this.#handleKeepalive(data)
      return
    }

    // Handle binary protocol messages through shared decode pipeline
    try {
      const messages = decodeBinaryMessages(data, this.#reassembler)
      if (messages) {
        for (const msg of messages) {
          this.#handleChannelMessage(msg)
        }
      }
    } catch (error) {
      console.error("Failed to decode wire message:", error)
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
      console.error("Cannot handle message: channel not set")
      return
    }

    // Deliver synchronously — the Synchronizer's receive queue prevents recursion
    this.#channel.onReceive(msg)
  }

  /**
   * Handle keepalive ping/pong messages.
   */
  #handleKeepalive(text: string): void {
    if (text === "ping") {
      this.#socket.send("pong")
    }
    // Ignore "pong" and "ready" responses
  }
}

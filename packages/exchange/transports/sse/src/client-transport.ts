// client-transport — SSE client transport for @kyneta/exchange.
//
// Thin imperative shell around the pure client program (client-program.ts).
// The program produces data effects; this module interprets them as I/O.
//
// FC/IS design:
// - client-program.ts: pure Mealy machine (functional core)
// - client-transport.ts: effect executor (imperative shell)
//
// Uses two HTTP channels:
// - EventSource (GET) for server→client messages
// - fetch POST for client→server messages
//
// Both directions use the text wire format (textCodec + text framing).
//
// Features:
// - Pure Mealy machine for connection lifecycle (client-program.ts)
// - Exponential backoff reconnection with jitter
// - POST retry with exponential backoff
// - Text-level fragmentation for large payloads
// - Inbound TextReassembler for fragmented SSE messages
// - Observable connection state via subscribeToTransitions()
//
// The connection handshake:
// 1. Client creates EventSource, waits for open
// 2. EventSource.onopen fires → client creates channel + calls establishChannel()
// 3. Synchronizer exchanges establish messages via POST + SSE
//
// On EventSource.onerror, the adapter closes the EventSource immediately and
// takes over reconnection via the program's backoff logic, rather than
// letting the browser's built-in EventSource reconnection run.

import type {
  ObservableHandle,
  StateTransition,
  TransitionListener,
} from "@kyneta/machine"
import { createObservableProgram } from "@kyneta/machine"
import type {
  Channel,
  ChannelMsg,
  GeneratedChannel,
  PeerId,
  TransportFactory,
} from "@kyneta/transport"
import { Transport } from "@kyneta/transport"
import {
  encodeTextComplete,
  fragmentTextPayload,
  TextReassembler,
  textCodec,
} from "@kyneta/wire"
import {
  createSseClientProgram,
  type SseClientEffect,
  type SseClientMsg,
} from "./client-program.js"
import type {
  DisconnectReason,
  SseClientLifecycleEvents,
  SseClientState,
} from "./types.js"

// Re-export state types for convenience
export type { DisconnectReason, SseClientLifecycleEvents, SseClientState }

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Default fragment threshold in characters.
 * 60K chars provides a safety margin below typical 100KB body-parser limits,
 * accounting for JSON overhead and potential base64 expansion.
 */
export const DEFAULT_FRAGMENT_THRESHOLD = 60_000

/**
 * Options for the SSE client adapter.
 */
export interface SseClientOptions {
  /** URL for POST requests (client→server). String or function of peerId. */
  postUrl: string | ((peerId: PeerId) => string)

  /** URL for SSE EventSource (server→client). String or function of peerId. */
  eventSourceUrl: string | ((peerId: PeerId) => string)

  /** Reconnection options for EventSource. */
  reconnect?: {
    enabled?: boolean
    maxAttempts?: number
    baseDelay?: number
    maxDelay?: number
  }

  /** POST retry options. */
  postRetry?: {
    maxAttempts?: number
    baseDelay?: number
    maxDelay?: number
  }

  /** Fragment threshold in characters. Default: 60000 (60K chars). */
  fragmentThreshold?: number

  /** Lifecycle event callbacks. */
  lifecycle?: SseClientLifecycleEvents
}

/**
 * Default POST retry options.
 */
const DEFAULT_POST_RETRY = {
  maxAttempts: 3,
  baseDelay: 1000,
  maxDelay: 10000,
}

// ---------------------------------------------------------------------------
// State transition type alias
// ---------------------------------------------------------------------------

/**
 * State transition event for SSE client states.
 */
export type SseClientStateTransition = StateTransition<SseClientState>

// ---------------------------------------------------------------------------
// SseClientTransport
// ---------------------------------------------------------------------------

/**
 * SSE client network adapter for @kyneta/exchange.
 *
 * Uses two HTTP channels:
 * - **EventSource** (GET, long-lived) for server→client messages
 * - **fetch POST** for client→server messages
 *
 * Both directions use the text wire format (`textCodec` + text framing).
 *
 * Internally, the connection lifecycle is a `Program<Msg, Model, Fx>` —
 * a pure Mealy machine whose transitions are deterministically testable.
 * This class is the imperative shell that interprets data effects as I/O.
 *
 * @example
 * ```typescript
 * import { createSseClient } from "@kyneta/sse-transport/client"
 *
 * const exchange = new Exchange({
 *   identity: { peerId: "browser-client" },
 *   transports: [createSseClient({
 *     postUrl: "/sync",
 *     eventSourceUrl: (peerId) => `/events?peerId=${peerId}`,
 *     reconnect: { enabled: true },
 *   })],
 * })
 * ```
 */
export class SseClientTransport extends Transport<void> {
  #peerId?: PeerId
  #options: SseClientOptions

  // Observable program handle — created in onStart(), drives all state
  #handle: ObservableHandle<SseClientMsg, SseClientState>

  // Executor-local I/O state — not in the program model
  #eventSource?: EventSource
  #serverChannel?: Channel
  #reconnectTimer?: ReturnType<typeof setTimeout>

  // Fragmentation
  readonly #fragmentThreshold: number

  // Inbound reassembly for fragmented SSE messages from server
  readonly #reassembler: TextReassembler

  // POST retry
  #currentRetryAbortController?: AbortController

  constructor(options: SseClientOptions) {
    super({ transportType: "sse-client" })
    this.#options = options
    this.#fragmentThreshold =
      options.fragmentThreshold ?? DEFAULT_FRAGMENT_THRESHOLD
    this.#reassembler = new TextReassembler({
      timeoutMs: 10_000,
    })

    // Create the program with a placeholder URL — the executor resolves the
    // real eventSourceUrl (which may be a function of peerId) at effect time.
    // The URL in the program is used only as a marker; the executor overrides it.
    const program = createSseClientProgram({
      url: "__deferred__",
      reconnect: options.reconnect,
    })

    this.#handle = createObservableProgram(program, (effect, dispatch) => {
      this.#executeEffect(effect, dispatch)
    })

    // Set up lifecycle event forwarding
    this.#setupLifecycleEvents()
  }

  // ==========================================================================
  // Lifecycle event forwarding
  // ==========================================================================

  /**
   * Subscribe to the observable handle's transitions and forward them to
   * the lifecycle callbacks. `wasConnectedBefore` is observer-local state,
   * not in the program model.
   */
  #setupLifecycleEvents(): void {
    let wasConnectedBefore = false

    this.#handle.subscribeToTransitions(transition => {
      // Forward to onStateChange callback
      this.#options.lifecycle?.onStateChange?.(transition)

      const { from, to } = transition

      // onDisconnect: transitioning TO disconnected
      if (to.status === "disconnected" && to.reason) {
        this.#options.lifecycle?.onDisconnect?.(to.reason)
      }

      // onReconnecting: transitioning TO reconnecting
      if (to.status === "reconnecting") {
        this.#options.lifecycle?.onReconnecting?.(to.attempt, to.nextAttemptMs)
      }

      // onReconnected: from reconnecting/connecting TO connected (after prior connection)
      if (
        wasConnectedBefore &&
        (from.status === "reconnecting" || from.status === "connecting") &&
        to.status === "connected"
      ) {
        this.#options.lifecycle?.onReconnected?.()
      }

      // Track whether we've ever been connected
      if (to.status === "connected") {
        wasConnectedBefore = true
      }

      // Reset on intentional disconnect (stop)
      if (to.status === "disconnected" && to.reason?.type === "intentional") {
        wasConnectedBefore = false
      }
    })
  }

  // ==========================================================================
  // Effect executor — interprets data effects as I/O
  // ==========================================================================

  #executeEffect(
    effect: SseClientEffect,
    dispatch: (msg: SseClientMsg) => void,
  ): void {
    switch (effect.type) {
      case "create-event-source": {
        this.#doCreateEventSource(dispatch)
        break
      }

      case "close-event-source": {
        if (this.#eventSource) {
          this.#eventSource.onopen = null
          this.#eventSource.onmessage = null
          this.#eventSource.onerror = null
          this.#eventSource.close()
          this.#eventSource = undefined
        }
        break
      }

      case "add-channel-and-establish": {
        // Remove any stale channel from a previous connection
        if (this.#serverChannel) {
          this.removeChannel(this.#serverChannel.channelId)
          this.#serverChannel = undefined
        }

        this.#serverChannel = this.addChannel()

        // No "ready" handshake — establish immediately
        this.establishChannel(this.#serverChannel.channelId)
        break
      }

      case "remove-channel": {
        if (this.#serverChannel) {
          this.removeChannel(this.#serverChannel.channelId)
          this.#serverChannel = undefined
        }
        break
      }

      case "start-reconnect-timer": {
        this.#reconnectTimer = setTimeout(() => {
          this.#reconnectTimer = undefined
          dispatch({ type: "reconnect-timer-fired" })
        }, effect.delayMs)
        break
      }

      case "cancel-reconnect-timer": {
        if (this.#reconnectTimer !== undefined) {
          clearTimeout(this.#reconnectTimer)
          this.#reconnectTimer = undefined
        }
        break
      }

      case "abort-pending-posts": {
        if (this.#currentRetryAbortController) {
          this.#currentRetryAbortController.abort()
          this.#currentRetryAbortController = undefined
        }
        break
      }
    }
  }

  /**
   * Create an EventSource and wire up event handlers.
   * The URL is resolved here (may be a function of peerId).
   */
  #doCreateEventSource(dispatch: (msg: SseClientMsg) => void): void {
    if (!this.#peerId) {
      throw new Error("Cannot connect: peerId not set")
    }

    // Resolve URL — may be a string or function of peerId
    const url =
      typeof this.#options.eventSourceUrl === "function"
        ? this.#options.eventSourceUrl(this.#peerId)
        : this.#options.eventSourceUrl

    try {
      this.#eventSource = new EventSource(url)

      this.#eventSource.onopen = () => {
        dispatch({ type: "event-source-opened" })
      }

      this.#eventSource.onmessage = (event: MessageEvent) => {
        this.#handleMessage(event)
      }

      this.#eventSource.onerror = () => {
        dispatch({ type: "event-source-error" })
      }
    } catch (_error) {
      // EventSource constructor threw (e.g. invalid URL) — treat as error
      dispatch({ type: "event-source-error" })
    }
  }

  // ==========================================================================
  // State observation — delegated to the observable handle
  // ==========================================================================

  /**
   * Get the current connection state.
   */
  getState(): SseClientState {
    return this.#handle.getState()
  }

  /**
   * Subscribe to state transitions.
   */
  subscribeToTransitions(
    listener: TransitionListener<SseClientState>,
  ): () => void {
    return this.#handle.subscribeToTransitions(listener)
  }

  /**
   * Wait for a specific state.
   */
  waitForState(
    predicate: (state: SseClientState) => boolean,
    options?: { timeoutMs?: number },
  ): Promise<SseClientState> {
    return this.#handle.waitForState(predicate, options)
  }

  /**
   * Wait for a specific status.
   */
  waitForStatus(
    status: SseClientState["status"],
    options?: { timeoutMs?: number },
  ): Promise<SseClientState> {
    return this.#handle.waitForStatus(status, options)
  }

  /**
   * Whether the client is connected and ready to send/receive.
   */
  get isConnected(): boolean {
    return this.#handle.getState().status === "connected"
  }

  // ==========================================================================
  // Transport abstract method implementations
  // ==========================================================================

  protected generate(): GeneratedChannel {
    return {
      transportType: this.transportType,
      send: (msg: ChannelMsg) => {
        if (!this.#peerId) {
          return
        }

        // Check if EventSource is closed before sending
        // readyState: 0=CONNECTING, 1=OPEN, 2=CLOSED
        if (!this.#eventSource || this.#eventSource.readyState === 2) {
          return
        }

        // Resolve the postUrl with the peerId
        const resolvedPostUrl =
          typeof this.#options.postUrl === "function"
            ? this.#options.postUrl(this.#peerId)
            : this.#options.postUrl

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
          )
          for (const fragment of fragments) {
            void this.#sendTextWithRetry(resolvedPostUrl, fragment)
          }
        } else {
          void this.#sendTextWithRetry(resolvedPostUrl, textFrame)
        }
      },
      stop: () => {
        // Don't call disconnect here — channel.stop() is called when
        // the channel is removed, which can happen during effect execution.
        // The actual disconnect is handled by onStop() or the program.
      },
    }
  }

  async onStart(): Promise<void> {
    if (!this.identity) {
      throw new Error(
        "Adapter not properly initialized — identity not available",
      )
    }
    this.#peerId = this.identity.peerId
    this.#handle.dispatch({ type: "start" })
  }

  async onStop(): Promise<void> {
    this.#reassembler.dispose()
    this.#handle.dispatch({ type: "stop" })
  }

  // ==========================================================================
  // Inbound message handling
  // ==========================================================================

  /**
   * Handle incoming SSE message.
   *
   * Each SSE `data:` event contains a text wire frame string.
   * Feed it through the TextReassembler to handle both complete
   * and fragmented frames.
   */
  #handleMessage(event: MessageEvent): void {
    if (!this.#serverChannel) {
      return
    }

    const data = event.data
    if (typeof data !== "string") {
      return
    }

    // Feed through reassembler (handles both complete and fragment frames)
    const result = this.#reassembler.receive(data)

    if (result.status === "complete") {
      try {
        // Two-step decode: Frame<string> → JSON.parse → textCodec.decode
        const parsed = JSON.parse(result.frame.content.payload)
        const messages = textCodec.decode(parsed)
        for (const msg of messages) {
          this.#serverChannel.onReceive(msg)
        }
      } catch (error) {
        console.error("Failed to decode SSE message:", error)
      }
    } else if (result.status === "error") {
      console.error("SSE message reassembly error:", result.error)
    }
    // "pending" status means we're waiting for more fragments — nothing to do
  }

  // ==========================================================================
  // POST sending with retry
  // ==========================================================================

  /**
   * Send a text frame via POST with retry logic.
   */
  async #sendTextWithRetry(url: string, textFrame: string): Promise<void> {
    let attempt = 0
    const postRetryOpts = {
      ...DEFAULT_POST_RETRY,
      ...this.#options.postRetry,
    }
    const { maxAttempts, baseDelay, maxDelay } = postRetryOpts

    while (attempt < maxAttempts) {
      try {
        if (!this.#currentRetryAbortController) {
          this.#currentRetryAbortController = new AbortController()
        }

        if (!this.#peerId) {
          throw new Error("PeerId not available for retry")
        }

        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "text/plain",
            "X-Peer-Id": this.#peerId,
          },
          body: textFrame,
          signal: this.#currentRetryAbortController.signal,
        })

        if (!response.ok) {
          // Don't retry on client errors (4xx)
          if (response.status >= 400 && response.status < 500) {
            throw new Error(`Failed to send message: ${response.statusText}`)
          }
          throw new Error(`Server error: ${response.statusText}`)
        }

        // Success
        this.#currentRetryAbortController = undefined
        return
      } catch (error: unknown) {
        attempt++

        const err = error as Error

        // If aborted, stop retrying
        if (err.name === "AbortError") {
          throw error
        }

        // If controller was cleared (e.g. by abort-pending-posts effect), stop retrying
        if (!this.#currentRetryAbortController) {
          const abortError = new Error("Retry aborted by connection reset")
          abortError.name = "AbortError"
          throw abortError
        }

        // If max attempts reached, throw the last error
        if (attempt >= maxAttempts) {
          this.#currentRetryAbortController = undefined
          throw error
        }

        // Calculate delay with exponential backoff and jitter
        const delay = Math.min(
          baseDelay * 2 ** (attempt - 1) + Math.random() * 100,
          maxDelay,
        )

        // Wait for delay or abort signal
        await new Promise<void>((resolve, reject) => {
          if (this.#currentRetryAbortController?.signal.aborted) {
            const error = new Error("Retry aborted")
            error.name = "AbortError"
            reject(error)
            return
          }

          const timer = setTimeout(() => {
            cleanup()
            resolve()
          }, delay)

          const onAbort = () => {
            clearTimeout(timer)
            cleanup()
            const error = new Error("Retry aborted")
            error.name = "AbortError"
            reject(error)
          }

          const cleanup = () => {
            this.#currentRetryAbortController?.signal.removeEventListener(
              "abort",
              onAbort,
            )
          }

          this.#currentRetryAbortController?.signal.addEventListener(
            "abort",
            onAbort,
          )
        })
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

/**
 * Create an SSE client adapter for browser-to-server connections.
 *
 * @example
 * ```typescript
 * import { createSseClient } from "@kyneta/sse-transport/client"
 *
 * const exchange = new Exchange({
 *   transports: [createSseClient({
 *     postUrl: "/sync",
 *     eventSourceUrl: (peerId) => `/events?peerId=${peerId}`,
 *     reconnect: { enabled: true },
 *   })],
 * })
 * ```
 */
export function createSseClient(options: SseClientOptions): TransportFactory {
  return () => new SseClientTransport(options)
}

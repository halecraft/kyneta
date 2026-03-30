// client-adapter — SSE client adapter for @kyneta/exchange.
//
// Connects to an SSE server using two HTTP channels:
// - EventSource (GET) for server→client messages
// - fetch POST for client→server messages
//
// Both directions use the text wire format (textCodec + text framing).
//
// Features:
// - State machine with validated transitions (disconnected → connecting → connected)
// - Exponential backoff reconnection with jitter
// - POST retry with exponential backoff
// - Text-level fragmentation for large payloads
// - Inbound TextReassembler for fragmented SSE messages
// - Observable connection state via subscribeToTransitions()
//
// The connection handshake:
// 1. Client creates EventSource, waits for open
// 2. EventSource.onopen fires → client creates channel + calls establishChannel()
// 3. Synchronizer exchanges establish-request / establish-response via POST + SSE
//
// On EventSource.onerror, the adapter closes the EventSource immediately and
// takes over reconnection via the state machine's backoff logic, rather than
// letting the browser's built-in EventSource reconnection run.

import { Adapter } from "@kyneta/exchange"
import type {
  AdapterFactory,
  Channel,
  ChannelMsg,
  GeneratedChannel,
  PeerId,
  TransitionListener,
  StateTransition,
} from "@kyneta/exchange"
import {
  textCodec,
  encodeTextComplete,
  fragmentTextPayload,
  TextReassembler,
} from "@kyneta/wire"
import { SseClientStateMachine } from "./client-state-machine.js"
import type {
  DisconnectReason,
  SseClientState,
  SseClientLifecycleEvents,
} from "./types.js"

// Re-export state types for convenience
export type { DisconnectReason, SseClientState, SseClientLifecycleEvents }

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
 * Default reconnection options.
 */
const DEFAULT_RECONNECT = {
  enabled: true,
  maxAttempts: 10,
  baseDelay: 1000,
  maxDelay: 30000,
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
// SseClientAdapter
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
 * @example
 * ```typescript
 * import { createSseClient } from "@kyneta/sse-network-adapter/client"
 *
 * const adapter = createSseClient({
 *   postUrl: "/sync",
 *   eventSourceUrl: (peerId) => `/events?peerId=${peerId}`,
 *   reconnect: { enabled: true },
 * })
 *
 * const exchange = new Exchange({
 *   identity: { peerId: "browser-client" },
 *   adapters: [adapter],
 * })
 * ```
 */
export class SseClientAdapter extends Adapter<void> {
  #peerId?: PeerId
  #eventSource?: EventSource
  #serverChannel?: Channel
  #reconnectTimer?: ReturnType<typeof setTimeout>
  #options: SseClientOptions
  #shouldReconnect = true
  #wasConnectedBefore = false

  // State machine
  readonly #stateMachine = new SseClientStateMachine()

  // Fragmentation
  readonly #fragmentThreshold: number

  // Inbound reassembly for fragmented SSE messages from server
  readonly #reassembler: TextReassembler

  // POST retry
  #currentRetryAbortController?: AbortController

  constructor(options: SseClientOptions) {
    super({ adapterType: "sse-client" })
    this.#options = options
    this.#fragmentThreshold =
      options.fragmentThreshold ?? DEFAULT_FRAGMENT_THRESHOLD
    this.#reassembler = new TextReassembler({
      timeoutMs: 10_000,
    })

    // Set up lifecycle event forwarding
    this.#setupLifecycleEvents()
  }

  // ==========================================================================
  // Lifecycle event forwarding
  // ==========================================================================

  #setupLifecycleEvents(): void {
    this.#stateMachine.subscribeToTransitions(transition => {
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
        this.#wasConnectedBefore &&
        (from.status === "reconnecting" || from.status === "connecting") &&
        to.status === "connected"
      ) {
        this.#options.lifecycle?.onReconnected?.()
      }
    })
  }

  // ==========================================================================
  // State observation API
  // ==========================================================================

  /**
   * Get the current state of the connection.
   */
  getState(): SseClientState {
    return this.#stateMachine.getState()
  }

  /**
   * Subscribe to state transitions.
   * @returns Unsubscribe function
   */
  subscribeToTransitions(
    listener: TransitionListener<SseClientState>,
  ): () => void {
    return this.#stateMachine.subscribeToTransitions(listener)
  }

  /**
   * Wait for a specific state.
   */
  waitForState(
    predicate: (state: SseClientState) => boolean,
    options?: { timeoutMs?: number },
  ): Promise<SseClientState> {
    return this.#stateMachine.waitForState(predicate, options)
  }

  /**
   * Wait for a specific status.
   */
  waitForStatus(
    status: SseClientState["status"],
    options?: { timeoutMs?: number },
  ): Promise<SseClientState> {
    return this.#stateMachine.waitForStatus(status, options)
  }

  /**
   * Check if the client is connected (EventSource open, channel established).
   */
  get isConnected(): boolean {
    return this.#stateMachine.isConnected()
  }

  // ==========================================================================
  // Adapter abstract method implementations
  // ==========================================================================

  protected generate(): GeneratedChannel {
    return {
      kind: "network",
      adapterType: this.adapterType,
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
          const fragments = fragmentTextPayload(payload, this.#fragmentThreshold)
          for (const fragment of fragments) {
            void this.#sendTextWithRetry(resolvedPostUrl, fragment)
          }
        } else {
          void this.#sendTextWithRetry(resolvedPostUrl, textFrame)
        }
      },
      stop: () => {
        // Don't call disconnect() here — channel.stop() is called when
        // the channel is removed, which can happen during handleClose().
        // The actual disconnect is handled by onStop() or handleClose().
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
    this.#shouldReconnect = true
    this.#wasConnectedBefore = false
    this.#connect()
  }

  async onStop(): Promise<void> {
    this.#shouldReconnect = false
    this.#reassembler.dispose()
    this.#currentRetryAbortController?.abort()
    this.#currentRetryAbortController = undefined
    this.#disconnect({ type: "intentional" })
  }

  // ==========================================================================
  // Connection management
  // ==========================================================================

  /**
   * Connect to the SSE server by creating an EventSource.
   */
  #connect(): void {
    const currentState = this.#stateMachine.getState()
    if (currentState.status === "connecting") {
      return
    }

    if (!this.#peerId) {
      throw new Error("Cannot connect: peerId not set")
    }

    // Determine attempt number
    const attempt =
      currentState.status === "reconnecting" ? currentState.attempt : 1

    this.#stateMachine.transition({ status: "connecting", attempt })

    // Resolve URL
    const url =
      typeof this.#options.eventSourceUrl === "function"
        ? this.#options.eventSourceUrl(this.#peerId)
        : this.#options.eventSourceUrl

    try {
      this.#eventSource = new EventSource(url)

      this.#eventSource.onopen = () => {
        this.#handleOpen()
      }

      this.#eventSource.onmessage = (event: MessageEvent) => {
        this.#handleMessage(event)
      }

      this.#eventSource.onerror = () => {
        this.#handleError()
      }
    } catch (error) {
      // EventSource constructor threw (e.g. invalid URL)
      this.#scheduleReconnect({
        type: "error",
        error: error instanceof Error ? error : new Error(String(error)),
      })
    }
  }

  /**
   * Disconnect from the SSE server.
   */
  #disconnect(reason: DisconnectReason): void {
    this.#clearReconnectTimer()

    if (this.#eventSource) {
      this.#eventSource.onopen = null
      this.#eventSource.onmessage = null
      this.#eventSource.onerror = null
      this.#eventSource.close()
      this.#eventSource = undefined
    }

    if (this.#serverChannel) {
      this.removeChannel(this.#serverChannel.channelId)
      this.#serverChannel = undefined
    }

    // Only transition if not already disconnected
    const currentState = this.#stateMachine.getState()
    if (currentState.status !== "disconnected") {
      this.#stateMachine.transition({ status: "disconnected", reason })
    }
  }

  // ==========================================================================
  // Event handlers
  // ==========================================================================

  /**
   * Handle EventSource open event.
   *
   * The SSE connection is usable immediately — no "ready" signal needed.
   * Create the channel and initiate establishment.
   */
  #handleOpen(): void {
    const currentState = this.#stateMachine.getState()

    // Handle potential race: onopen before state machine caught up
    if (
      currentState.status !== "connecting" &&
      currentState.status !== "connected"
    ) {
      // Might be in reconnecting → connecting path; just ignore
      return
    }

    if (currentState.status === "connecting") {
      this.#stateMachine.transition({ status: "connected" })
    }

    this.#wasConnectedBefore = true

    // Cancel any pending POST retries from previous connection
    if (this.#currentRetryAbortController) {
      this.#currentRetryAbortController.abort()
      this.#currentRetryAbortController = undefined
    }

    // Create channel if not exists
    if (this.#serverChannel) {
      this.removeChannel(this.#serverChannel.channelId)
      this.#serverChannel = undefined
    }

    this.#serverChannel = this.addChannel()

    // Initiate establishment handshake
    this.establishChannel(this.#serverChannel.channelId)
  }

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

  /**
   * Handle EventSource error.
   *
   * Closes the EventSource immediately and takes over reconnection
   * via the state machine's backoff logic. This prevents the browser's
   * built-in EventSource reconnection from running.
   */
  #handleError(): void {
    // Close immediately to prevent browser auto-reconnect
    if (this.#eventSource) {
      this.#eventSource.onopen = null
      this.#eventSource.onmessage = null
      this.#eventSource.onerror = null
      this.#eventSource.close()
      this.#eventSource = undefined
    }

    if (this.#serverChannel) {
      this.removeChannel(this.#serverChannel.channelId)
      this.#serverChannel = undefined
    }

    // Schedule reconnect or transition to disconnected
    this.#scheduleReconnect({
      type: "error",
      error: new Error("EventSource connection error"),
    })
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

        // If controller was cleared (e.g. by onopen), stop retrying
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

  // ==========================================================================
  // Reconnection
  // ==========================================================================

  /**
   * Schedule a reconnection attempt or transition to disconnected.
   */
  #scheduleReconnect(reason: DisconnectReason): void {
    const currentState = this.#stateMachine.getState()

    // If already disconnected, don't transition again
    if (currentState.status === "disconnected") {
      return
    }

    const reconnectOpts = {
      ...DEFAULT_RECONNECT,
      ...this.#options.reconnect,
    }

    if (!this.#shouldReconnect || !reconnectOpts.enabled) {
      this.#stateMachine.transition({ status: "disconnected", reason })
      return
    }

    // Get current attempt count from state
    const currentAttempt =
      currentState.status === "reconnecting"
        ? currentState.attempt
        : currentState.status === "connecting"
          ? (currentState as { attempt: number }).attempt
          : 0

    if (currentAttempt >= reconnectOpts.maxAttempts) {
      this.#stateMachine.transition({
        status: "disconnected",
        reason: { type: "max-retries-exceeded", attempts: currentAttempt },
      })
      return
    }

    const nextAttempt = currentAttempt + 1

    // Exponential backoff with jitter
    const delay = Math.min(
      reconnectOpts.baseDelay * 2 ** (nextAttempt - 1) + Math.random() * 1000,
      reconnectOpts.maxDelay,
    )

    this.#stateMachine.transition({
      status: "reconnecting",
      attempt: nextAttempt,
      nextAttemptMs: delay,
    })

    this.#reconnectTimer = setTimeout(() => {
      this.#connect()
    }, delay)
  }

  #clearReconnectTimer(): void {
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer)
      this.#reconnectTimer = undefined
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
 * import { createSseClient } from "@kyneta/sse-network-adapter/client"
 *
 * const exchange = new Exchange({
 *   adapters: [createSseClient({
 *     postUrl: "/sync",
 *     eventSourceUrl: (peerId) => `/events?peerId=${peerId}`,
 *     reconnect: { enabled: true },
 *   })],
 * })
 * ```
 */
export function createSseClient(options: SseClientOptions): AdapterFactory {
  return () => new SseClientAdapter(options)
}
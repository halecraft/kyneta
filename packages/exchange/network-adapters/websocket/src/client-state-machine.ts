// client-state-machine — observable state machine for Websocket client lifecycle.
//
// Provides validated state transitions with async delivery via microtask queue.
// All transitions are delivered asynchronously to ensure observers can reliably
// see all states, even when multiple transitions happen in the same synchronous
// call stack.
//
// States: disconnected → connecting → connected → ready
//                            ↓            ↓         ↓
//                       reconnecting ← ─ ┴ ─ ─ ─ ─ ┘
//                            ↓
//                       connecting (retry)
//                            ↓
//                       disconnected (max retries)
//
// Ported from @loro-extended/adapter-websocket's WsClientStateMachine with
// kyneta naming conventions applied. Legacy backward-compat APIs removed.

import type {
  TransitionListener,
  WebsocketClientState,
  WebsocketClientStateTransition,
} from "./types.js"

// ---------------------------------------------------------------------------
// Valid transitions
// ---------------------------------------------------------------------------

/**
 * Map of valid state transitions.
 * Key is the "from" status, value is array of valid "to" statuses.
 */
const VALID_TRANSITIONS: Record<
  WebsocketClientState["status"],
  WebsocketClientState["status"][]
> = {
  disconnected: ["connecting"],
  connecting: ["connected", "disconnected", "reconnecting"],
  connected: ["ready", "disconnected", "reconnecting"],
  ready: ["disconnected", "reconnecting"],
  reconnecting: ["connecting", "disconnected"],
}

/**
 * Check if a transition is valid.
 */
function isValidTransition(
  from: WebsocketClientState["status"],
  to: WebsocketClientState["status"],
): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false
}

// ---------------------------------------------------------------------------
// WebsocketClientStateMachine
// ---------------------------------------------------------------------------

/**
 * Observable state machine for Websocket client connection lifecycle.
 *
 * Manages connection state with guaranteed observable transitions.
 * All transitions are delivered asynchronously via microtask queue,
 * ensuring listeners see every state even during rapid transitions.
 *
 * Usage:
 * ```typescript
 * const sm = new WebsocketClientStateMachine()
 *
 * sm.subscribeToTransitions(({ from, to }) => {
 *   console.log(`${from.status} → ${to.status}`)
 * })
 *
 * sm.transition({ status: "connecting", attempt: 1 })
 * sm.transition({ status: "connected" })
 * sm.transition({ status: "ready" })
 *
 * // Transitions are delivered asynchronously via microtask
 * // Listener will see: disconnected → connecting, connecting → connected, connected → ready
 * ```
 */
export class WebsocketClientStateMachine {
  #currentState: WebsocketClientState = { status: "disconnected" }
  #transitionListeners = new Set<TransitionListener>()
  #pendingTransitions: WebsocketClientStateTransition[] = []
  #isProcessingQueue = false

  // ==========================================================================
  // STATE ACCESS
  // ==========================================================================

  /**
   * Get the current state synchronously.
   */
  getState(): WebsocketClientState {
    return this.#currentState
  }

  /**
   * Get the current status string.
   */
  getStatus(): WebsocketClientState["status"] {
    return this.#currentState.status
  }

  /**
   * Check if the client is in a "connected" state (either connected or ready).
   */
  isConnectedOrReady(): boolean {
    return (
      this.#currentState.status === "connected" ||
      this.#currentState.status === "ready"
    )
  }

  /**
   * Check if the client is ready (server ready signal received).
   */
  isReady(): boolean {
    return this.#currentState.status === "ready"
  }

  // ==========================================================================
  // STATE TRANSITIONS
  // ==========================================================================

  /**
   * Transition to a new state.
   *
   * The transition is validated against the allowed transition map.
   * The state is updated synchronously, but listeners are notified
   * asynchronously via microtask queue.
   *
   * @param newState The new state to transition to
   * @param options Options for the transition
   * @throws Error if the transition is invalid (unless `force: true`)
   */
  transition(
    newState: WebsocketClientState,
    options?: { force?: boolean },
  ): void {
    const fromStatus = this.#currentState.status
    const toStatus = newState.status

    // Validate transition unless forced
    if (!options?.force && !isValidTransition(fromStatus, toStatus)) {
      throw new Error(
        `Invalid state transition: ${fromStatus} -> ${toStatus}. ` +
          `Valid transitions from ${fromStatus}: ${VALID_TRANSITIONS[fromStatus]?.join(", ") ?? "none"}`,
      )
    }

    const transition: WebsocketClientStateTransition = {
      from: this.#currentState,
      to: newState,
      timestamp: Date.now(),
    }

    // Update current state immediately (synchronous)
    this.#currentState = newState

    // Queue transition for async delivery
    this.#pendingTransitions.push(transition)
    this.#scheduleDelivery()
  }

  /**
   * Reset the state machine to initial disconnected state.
   * Clears all pending transitions.
   */
  reset(): void {
    this.#currentState = { status: "disconnected" }
    this.#pendingTransitions = []
  }

  // ==========================================================================
  // OBSERVATION
  // ==========================================================================

  /**
   * Subscribe to state transitions.
   *
   * Transitions are delivered asynchronously via microtask queue.
   * Multiple transitions that happen in the same synchronous call stack
   * are batched and delivered together.
   *
   * @param listener Callback that receives transition events
   * @returns Unsubscribe function
   */
  subscribeToTransitions(listener: TransitionListener): () => void {
    this.#transitionListeners.add(listener)
    return () => {
      this.#transitionListeners.delete(listener)
    }
  }

  /**
   * Wait for a specific state.
   *
   * Resolves immediately if the current state matches the predicate.
   * Otherwise waits for a transition that matches.
   *
   * @param predicate Function that returns true when the desired state is reached
   * @param options Options including timeout
   * @returns Promise that resolves with the matching state
   */
  waitForState(
    predicate: (state: WebsocketClientState) => boolean,
    options?: { timeoutMs?: number },
  ): Promise<WebsocketClientState> {
    // Check if already in desired state
    if (predicate(this.#currentState)) {
      return Promise.resolve(this.#currentState)
    }

    return new Promise((resolve, reject) => {
      let timeoutId: ReturnType<typeof setTimeout> | undefined

      const unsubscribe = this.subscribeToTransitions(transition => {
        if (predicate(transition.to)) {
          cleanup()
          resolve(transition.to)
        }
      })

      const cleanup = () => {
        unsubscribe()
        if (timeoutId) {
          clearTimeout(timeoutId)
        }
      }

      if (options?.timeoutMs) {
        timeoutId = setTimeout(() => {
          cleanup()
          reject(
            new Error(
              `Timeout waiting for state after ${options.timeoutMs}ms`,
            ),
          )
        }, options.timeoutMs)
      }
    })
  }

  /**
   * Wait for a specific status.
   *
   * Convenience wrapper around `waitForState()`.
   *
   * @param status The status to wait for
   * @param options Options including timeout
   * @returns Promise that resolves with the matching state
   */
  waitForStatus(
    status: WebsocketClientState["status"],
    options?: { timeoutMs?: number },
  ): Promise<WebsocketClientState> {
    return this.waitForState(state => state.status === status, options)
  }

  // ==========================================================================
  // INTERNAL — async delivery
  // ==========================================================================

  /**
   * Schedule delivery of pending transitions via microtask queue.
   */
  #scheduleDelivery(): void {
    if (this.#isProcessingQueue) {
      return
    }

    this.#isProcessingQueue = true
    queueMicrotask(() => {
      this.#deliverPendingTransitions()
    })
  }

  /**
   * Deliver all pending transitions to listeners.
   */
  #deliverPendingTransitions(): void {
    // Take all pending transitions
    const transitions = this.#pendingTransitions
    this.#pendingTransitions = []
    this.#isProcessingQueue = false

    // Deliver each transition to all listeners
    for (const transition of transitions) {
      for (const listener of this.#transitionListeners) {
        try {
          listener(transition)
        } catch (error) {
          console.error("Error in transition listener:", error)
        }
      }
    }
  }
}
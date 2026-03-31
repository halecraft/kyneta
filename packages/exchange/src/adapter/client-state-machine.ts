// client-state-machine — generic observable state machine for network adapter clients.
//
// Provides validated state transitions with async delivery via microtask queue.
// All transitions are delivered asynchronously to ensure observers can reliably
// see all states, even when multiple transitions happen in the same synchronous
// call stack.
//
// This is the transport-independent core. Adapters instantiate it with their
// specific state types and transition maps:
//
//   - WebsocketClientStateMachine: 5 states (disconnected, connecting, connected, ready, reconnecting)
//   - SseClientStateMachine: 4 states (disconnected, connecting, connected, reconnecting)
//
// Extracted from WebsocketClientStateMachine to eliminate duplication across
// network adapters.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A state transition event, parameterized on the state type.
 */
export type StateTransition<S> = {
  from: S
  to: S
  timestamp: number
}

/**
 * Listener for state transitions.
 */
export type TransitionListener<S> = (transition: StateTransition<S>) => void

/**
 * Configuration for constructing a `ClientStateMachine`.
 *
 * @typeParam S - The state type. Must have a `status` string discriminant.
 */
export interface ClientStateMachineConfig<S extends { status: string }> {
  /** The initial state of the machine. */
  initialState: S
  /**
   * Map of valid transitions. Key is the "from" status string,
   * value is an array of valid "to" status strings.
   */
  validTransitions: Record<string, string[]>
}

// ---------------------------------------------------------------------------
// ClientStateMachine<S>
// ---------------------------------------------------------------------------

/**
 * Generic observable state machine for network adapter client lifecycle.
 *
 * Manages connection state with guaranteed observable transitions.
 * All transitions are delivered asynchronously via microtask queue,
 * ensuring listeners see every state even during rapid transitions.
 *
 * @typeParam S - The state type. Must have a `status` string discriminant.
 *
 * @example
 * ```typescript
 * type MyState =
 *   | { status: "off" }
 *   | { status: "on"; brightness: number }
 *
 * const sm = new ClientStateMachine<MyState>({
 *   initialState: { status: "off" },
 *   validTransitions: {
 *     off: ["on"],
 *     on: ["off"],
 *   },
 * })
 *
 * sm.subscribeToTransitions(({ from, to }) => {
 *   console.log(`${from.status} → ${to.status}`)
 * })
 *
 * sm.transition({ status: "on", brightness: 100 })
 * ```
 */
export class ClientStateMachine<S extends { status: string }> {
  readonly #initialState: S
  readonly #validTransitions: Record<string, string[]>

  #currentState: S
  #transitionListeners = new Set<TransitionListener<S>>()
  #pendingTransitions: StateTransition<S>[] = []
  #isProcessingQueue = false

  constructor(config: ClientStateMachineConfig<S>) {
    this.#initialState = config.initialState
    this.#validTransitions = config.validTransitions
    this.#currentState = config.initialState
  }

  // ==========================================================================
  // STATE ACCESS
  // ==========================================================================

  /**
   * Get the current state synchronously.
   */
  getState(): S {
    return this.#currentState
  }

  /**
   * Get the current status string.
   */
  getStatus(): S["status"] {
    return this.#currentState.status
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
  transition(newState: S, options?: { force?: boolean }): void {
    const fromStatus = this.#currentState.status
    const toStatus = newState.status

    // Validate transition unless forced
    if (!options?.force && !this.#isValidTransition(fromStatus, toStatus)) {
      const valid = this.#validTransitions[fromStatus]
      throw new Error(
        `Invalid state transition: ${fromStatus} -> ${toStatus}. ` +
          `Valid transitions from ${fromStatus}: ${valid?.join(", ") ?? "none"}`,
      )
    }

    const transition: StateTransition<S> = {
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
   * Reset the state machine to its initial state.
   * Clears all pending transitions.
   */
  reset(): void {
    this.#currentState = this.#initialState
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
  subscribeToTransitions(listener: TransitionListener<S>): () => void {
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
    predicate: (state: S) => boolean,
    options?: { timeoutMs?: number },
  ): Promise<S> {
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
            new Error(`Timeout waiting for state after ${options.timeoutMs}ms`),
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
    status: S["status"],
    options?: { timeoutMs?: number },
  ): Promise<S> {
    return this.waitForState(state => state.status === status, options)
  }

  // ==========================================================================
  // INTERNAL — validation
  // ==========================================================================

  /**
   * Check if a transition is valid according to the transition map.
   */
  #isValidTransition(from: string, to: string): boolean {
    return this.#validTransitions[from]?.includes(to) ?? false
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

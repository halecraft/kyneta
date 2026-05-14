// observable — data-effect runtime with state observation.
//
// createObservableProgram() is the data-effect counterpart to runtime().
// Where runtime() executes closure effects (Effect<Msg>), this function
// accepts a custom executor for data effects (Fx). It also provides
// state observation: subscribeToTransitions, waitForState, waitForStatus.
//
// This subsumes ClientStateMachine's observation API and the peer program's
// hand-rolled dispatch loop. Transition delivery is synchronous — the
// listener fires after each update. The microtask-batched delivery from
// ClientStateMachine is unnecessary complexity that no consumer depends on.

import { createDispatcher, type Lease } from "./dispatcher.js"
import type { Dispatch, Program } from "./machine.js"

// ---------------------------------------------------------------------------
// Ambient declarations for timer APIs (not in lib: ["ESNext"])
// ---------------------------------------------------------------------------

declare function setTimeout(callback: () => void, ms: number): unknown
declare function clearTimeout(id: unknown): void

// ---------------------------------------------------------------------------
// Observation types
// ---------------------------------------------------------------------------

/**
 * A state transition event — from one model to another.
 *
 * Generic over the model type. This is the machine-level primitive;
 * transport packages re-export or alias it for their specific state types.
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

// ---------------------------------------------------------------------------
// ObservableHandle
// ---------------------------------------------------------------------------

/**
 * Handle for a running observable program.
 *
 * Provides dispatch, state access, transition observation, and disposal.
 * The observation API (`subscribeToTransitions`, `waitForState`, `waitForStatus`)
 * matches the surface of the former `ClientStateMachine<S>`.
 */
export interface ObservableHandle<Msg, Model> {
  /** Dispatch a message into the program. */
  dispatch: Dispatch<Msg>

  /** Get the current model synchronously. */
  getState(): Model

  /**
   * Subscribe to state transitions.
   *
   * Transitions are delivered synchronously after each update.
   * Returns an unsubscribe function.
   */
  subscribeToTransitions(listener: TransitionListener<Model>): () => void

  /**
   * Wait for a specific state.
   *
   * Resolves immediately if the current state matches the predicate.
   * Otherwise waits for a transition that matches.
   */
  waitForState(
    predicate: (state: Model) => boolean,
    options?: { timeoutMs?: number },
  ): Promise<Model>

  /**
   * Wait for a specific status string on a model with a `status` discriminant.
   *
   * Convenience wrapper around `waitForState()`.
   */
  waitForStatus<S extends { status: string }>(
    this: ObservableHandle<Msg, S>,
    status: S["status"],
    options?: { timeoutMs?: number },
  ): Promise<S>

  /**
   * Dispose the program — stops dispatch and calls `program.done`.
   */
  dispose(): void
}

// ---------------------------------------------------------------------------
// createObservableProgram
// ---------------------------------------------------------------------------

/**
 * Run a program with data effects and state observation.
 *
 * Like `runtime()`, but instead of executing closure effects directly,
 * it delegates to a custom `executor` for each data effect. This enables
 * programs whose effects are inspectable data types (not opaque closures).
 *
 * The runtime:
 * 1. Extracts `[model, ...effects]` from `program.init`.
 * 2. Executes each initial effect via `executor(effect, dispatch)`.
 * 3. On `dispatch(msg)`: calls `update(msg, state)`, updates state,
 *    notifies transition listeners, executes effects.
 * 4. Re-entrant dispatch (effect calls dispatch) is queued and processed
 *    after the current dispatch cycle completes.
 * 5. `dispose()` stops dispatch and calls `program.done`.
 *
 * @param program - The program algebra: init, update, done.
 * @param executor - Interprets data effects as I/O.
 * @returns An observable handle for the running program.
 */
export function createObservableProgram<Msg, Model, Fx>(
  program: Program<Msg, Model, Fx>,
  executor: (effect: Fx, dispatch: Dispatch<Msg>) => void,
  options?: { lease?: Lease; label?: string },
): ObservableHandle<Msg, Model> {
  let state: Model
  let isRunning = true
  const listeners = new Set<TransitionListener<Model>>()

  // --------------------------------------------------------------------------
  // Transition notification
  // --------------------------------------------------------------------------

  function notifyTransition(from: Model, to: Model): void {
    if (from === to) return

    const transition: StateTransition<Model> = {
      from,
      to,
      timestamp: Date.now(),
    }

    for (const listener of listeners) {
      try {
        listener(transition)
      } catch {
        // Swallow listener errors — observers must not break dispatch.
      }
    }
  }

  // --------------------------------------------------------------------------
  // Dispatch
  // --------------------------------------------------------------------------

  const handle = createDispatcher<Msg>(
    (msg, redispatch) => {
      if (!isRunning) return
      const prev = state
      const [newModel, ...effects] = program.update(msg, state)
      state = newModel
      notifyTransition(prev, state)
      for (const effect of effects) {
        executor(effect, redispatch)
      }
    },
    { lease: options?.lease, label: options?.label ?? "observable" },
  )

  function dispatch(msg: Msg): void {
    if (!isRunning) return
    handle.dispatch(msg)
  }

  // --------------------------------------------------------------------------
  // Observation
  // --------------------------------------------------------------------------

  function getState(): Model {
    return state
  }

  function subscribeToTransitions(
    listener: TransitionListener<Model>,
  ): () => void {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }

  function waitForState(
    predicate: (state: Model) => boolean,
    options?: { timeoutMs?: number },
  ): Promise<Model> {
    // Resolve immediately if already matching
    if (predicate(state)) {
      return Promise.resolve(state)
    }

    return new Promise((resolve, reject) => {
      let timeoutId: unknown

      const unsubscribe = subscribeToTransitions(transition => {
        if (predicate(transition.to)) {
          cleanup()
          resolve(transition.to)
        }
      })

      const cleanup = () => {
        unsubscribe()
        if (timeoutId !== undefined) {
          clearTimeout(timeoutId)
        }
      }

      if (options?.timeoutMs !== undefined) {
        timeoutId = setTimeout(() => {
          cleanup()
          reject(
            new Error(`Timeout waiting for state after ${options.timeoutMs}ms`),
          )
        }, options.timeoutMs)
      }
    })
  }

  function waitForStatus<S extends { status: string }>(
    this: ObservableHandle<Msg, S>,
    status: S["status"],
    options?: { timeoutMs?: number },
  ): Promise<S> {
    return this.waitForState((s: S) => s.status === status, options)
  }

  function dispose(): void {
    if (!isRunning) return
    isRunning = false
    program.done?.(state)
  }

  // --------------------------------------------------------------------------
  // Initialize
  // --------------------------------------------------------------------------

  const [initialModel, ...initialEffects] = program.init
  state = initialModel
  for (const effect of initialEffects) {
    executor(effect, dispatch)
  }

  // --------------------------------------------------------------------------
  // Return handle
  // --------------------------------------------------------------------------

  return {
    dispatch,
    getState,
    subscribeToTransitions,
    waitForState,
    waitForStatus,
    dispose,
  }
}

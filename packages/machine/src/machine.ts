/** Dispatch a message into a running program. */
export type Dispatch<Msg> = (msg: Msg) => void

/** An effect is a continuation that may dispatch messages. */
export type Effect<Msg> = (dispatch: Dispatch<Msg>) => void

/**
 * A Mealy machine — pure state transitions with effect outputs.
 *
 * `Fx` defaults to `Effect<Msg>` (closure effects) but can be any
 * data type for programs with custom effect executors.
 *
 * - `init`: initial state and zero or more effects to execute at startup.
 * - `update`: pure transition — given a message and the current state,
 *   return the new state and zero or more effects.
 * - `done`: optional teardown hook, called with the final state when
 *   the runtime is disposed.
 */
export type Program<Msg, Model, Fx = Effect<Msg>> = {
  init: [Model, ...Fx[]]
  update(msg: Msg, model: Model): [Model, ...Fx[]]
  done?(model: Model): void
}

/** Dispose a running program — stops message processing and calls `done`. */
export type Disposer = () => void

/**
 * Run a program whose effects are `Effect<Msg>` closures.
 *
 * The runtime:
 * 1. Extracts `[model, ...effects]` from `program.init`.
 * 2. Executes each initial effect with `dispatch`.
 * 3. Calls `view(model, dispatch)` if provided.
 * 4. On `dispatch(msg)`: calls `update(msg, state)`, updates state,
 *    executes effects, calls `view`.
 * 5. Returns a `Disposer` that stops dispatch and calls `program.done`.
 *
 * Effects are executed synchronously in order. An effect may call
 * `dispatch` re-entrantly — the runtime processes re-entrant messages
 * after the current dispatch cycle completes (queue-based).
 */
export function runtime<Msg, Model>(
  program: Program<Msg, Model>,
  view?: (model: Model, dispatch: Dispatch<Msg>) => void,
): Disposer {
  let state: Model
  let isRunning = true
  const pending: Msg[] = []
  let isDispatching = false

  function dispatch(msg: Msg): void {
    if (!isRunning) return

    pending.push(msg)
    if (isDispatching) return

    isDispatching = true
    try {
      while (pending.length > 0) {
        const next = pending.shift()!
        const [newModel, ...effects] = program.update(next, state)
        state = newModel
        for (const effect of effects) {
          effect(dispatch)
        }
        if (view) view(state, dispatch)
      }
    } finally {
      isDispatching = false
    }
  }

  // Initialize
  const [initialModel, ...initialEffects] = program.init
  state = initialModel
  for (const effect of initialEffects) {
    effect(dispatch)
  }
  if (view) view(state, dispatch)

  // Return disposer
  return () => {
    if (!isRunning) return
    isRunning = false
    program.done?.(state)
  }
}

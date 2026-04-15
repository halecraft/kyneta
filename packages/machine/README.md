# @kyneta/machine

Universal Mealy machine algebra — pure state transitions with effect outputs.

## Overview

`@kyneta/machine` provides `Program`, a minimal algebraic type for state machines: an initial state, a pure update function, and optionally a teardown hook. Each transition returns a new state plus zero or more effects. The `runtime()` function interprets programs whose effects are closures.

This is the same architecture as [raj](https://github.com/andrejewski/raj) and the Elm Architecture, distilled to its core algebra. The key difference: `Program` is parameterized over its effect type `Fx`, so the same shape works for both closure-based effects (interpreted by `runtime()`) and data effects (interpreted by a custom executor).

## Install

```/dev/null/shell.sh#L1
pnpm add @kyneta/machine
```

## Quick Start

A counter that increments every second and stops at 5:

```/dev/null/counter.ts#L1-25
import { type Program, runtime } from "@kyneta/machine"

type Msg = "tick"
type Model = { count: number }

const tick: Program<Msg, Model> = {
  init: [
    { count: 0 },
    (dispatch) => {
      const id = setInterval(() => dispatch("tick"), 1000)
      // effect is fire-and-forget; cleanup goes in `done`
      ;(globalThis as any).__intervalId = id
    },
  ],
  update(_msg, model) {
    return [{ count: model.count + 1 }]
  },
  done() {
    clearInterval((globalThis as any).__intervalId)
  },
}

const dispose = runtime(tick, (model) => {
  console.log(`count: ${model.count}`)
  if (model.count >= 5) dispose()
})
```

## Data Effects

When `Fx` is a data type instead of a closure, `runtime()` no longer applies — you write a custom executor that pattern-matches on the effect values. This is the free monad interpreter pattern.

```/dev/null/data-effects.ts#L1-30
import type { Program } from "@kyneta/machine"

// Effects as data
type Fx =
  | { type: "http"; url: string }
  | { type: "log"; message: string }

type Msg = { type: "fetched"; data: string }
type Model = { status: string }

const app: Program<Msg, Model, Fx> = {
  init: [{ status: "loading" }, { type: "http", url: "/api" }],
  update(msg, _model) {
    return [{ status: msg.data }, { type: "log", message: "done" }]
  },
}

// Custom executor — you control how effects are interpreted
function run(program: Program<Msg, Model, Fx>) {
  let [state, ...effects] = program.init
  function dispatch(msg: Msg) {
    const [next, ...fxs] = program.update(msg, state)
    state = next
    fxs.forEach(execute)
  }
  function execute(fx: Fx) {
    if (fx.type === "http") fetch(fx.url).then((r) => r.text()).then((data) => dispatch({ type: "fetched", data }))
    if (fx.type === "log") console.log(fx.message)
  }
  effects.forEach(execute)
}
```

The Synchronizer in `@kyneta/exchange` uses exactly this pattern: `Program<SynchronizerMessage, SynchronizerModel, Command>` with a batched interpreter that coalesces network sends.

## API Reference

### `Program<Msg, Model, Fx = Effect<Msg>>`

```/dev/null/types.ts#L1-5
type Program<Msg, Model, Fx = Effect<Msg>> = {
  init: [Model, ...Fx[]]
  update(msg: Msg, model: Model): [Model, ...Fx[]]
  done?(model: Model): void
}
```

The universal Mealy machine algebra. `init` provides the initial state and startup effects. `update` is a pure transition function. `done` is an optional teardown hook called when the runtime is disposed.

### `Effect<Msg>`

```/dev/null/types.ts#L1
type Effect<Msg> = (dispatch: Dispatch<Msg>) => void
```

A continuation that may asynchronously dispatch messages back into the program. This is the default `Fx` type — opaque closures executed by `runtime()`.

### `Dispatch<Msg>`

```/dev/null/types.ts#L1
type Dispatch<Msg> = (msg: Msg) => void
```

### `Disposer`

```/dev/null/types.ts#L1
type Disposer = () => void
```

Returned by `runtime()`. Calling it stops message processing and invokes `program.done`.

### `StateTransition<S>`

```/dev/null/types.ts#L1-5
type StateTransition<S> = {
  from: S
  to: S
  timestamp: number
}
```

A state transition event emitted after each `update` call. `from` and `to` are the model before and after the transition. `timestamp` is `Date.now()` at the moment of transition. Transitions where `from === to` (referential identity) are suppressed.

### `TransitionListener<S>`

```/dev/null/types.ts#L1
type TransitionListener<S> = (transition: StateTransition<S>) => void
```

Callback type for `subscribeToTransitions`. Listeners fire synchronously after each state transition. Listener exceptions are swallowed — observers must not break dispatch.

### `ObservableHandle<Msg, Model>`

```/dev/null/types.ts#L1-8
interface ObservableHandle<Msg, Model> {
  dispatch: Dispatch<Msg>
  getState(): Model
  subscribeToTransitions(listener: TransitionListener<Model>): () => void
  waitForState(predicate: (state: Model) => boolean, options?: { timeoutMs?: number }): Promise<Model>
  waitForStatus(status: string, options?: { timeoutMs?: number }): Promise<Model>
  dispose(): void
}
```

Handle returned by `createObservableProgram`. Methods:

- **`dispatch(msg)`** — send a message into the program. Re-entrant dispatches (effects calling dispatch) are queued and processed after the current cycle.
- **`getState()`** — synchronous access to the current model.
- **`subscribeToTransitions(listener)`** — register a `TransitionListener`. Returns an unsubscribe function.
- **`waitForState(predicate, options?)`** — returns a `Promise` that resolves with the first model matching `predicate`. Resolves immediately if the current state matches. Rejects on timeout if `timeoutMs` is set.
- **`waitForStatus(status, options?)`** — convenience wrapper for models with a `status` discriminant. Equivalent to `waitForState(s => s.status === status)`.
- **`dispose()`** — stops dispatch and calls `program.done`.

### `runtime(program, view?)`

```/dev/null/types.ts#L1-4
function runtime<Msg, Model>(
  program: Program<Msg, Model>,
  view?: (model: Model, dispatch: Dispatch<Msg>) => void,
): Disposer
```

Interprets a program whose effects are `Effect<Msg>` closures. Dispatch is synchronous; re-entrant dispatches are queued and processed in order. Effects execute immediately after each state transition. The optional `view` callback fires after every transition (including init).

### `createObservableProgram(program, executor)`

```/dev/null/types.ts#L1-4
function createObservableProgram<Msg, Model, Fx>(
  program: Program<Msg, Model, Fx>,
  executor: (effect: Fx, dispatch: Dispatch<Msg>) => void,
): ObservableHandle<Msg, Model>
```

The data-effect counterpart to `runtime()`. Where `runtime()` executes closure effects (`Effect<Msg>`) directly, `createObservableProgram` delegates each effect to a custom `executor` — enabling programs whose effects are inspectable data types rather than opaque closures. It also provides state observation via `subscribeToTransitions`, `waitForState`, and `waitForStatus`.

The runtime lifecycle:
1. Extracts `[model, ...effects]` from `program.init`.
2. Executes each initial effect via `executor(effect, dispatch)`.
3. On `dispatch(msg)`: calls `update(msg, state)`, updates state, notifies transition listeners, executes effects.
4. Re-entrant dispatch is queued and processed after the current cycle.
5. `dispose()` stops dispatch and calls `program.done`.

```/dev/null/observable-example.ts#L1-42
import { type Program, createObservableProgram } from "@kyneta/machine"

// Effects as data
type Fx =
  | { type: "http"; url: string }
  | { type: "log"; message: string }

type Msg = { type: "loaded"; data: string }
type Model = { status: "loading" | "ready"; data?: string }

const app: Program<Msg, Model, Fx> = {
  init: [{ status: "loading" }, { type: "http", url: "/api" }],
  update(msg, _model) {
    return [
      { status: "ready", data: msg.data },
      { type: "log", message: "done" },
    ]
  },
}

// Executor interprets data effects as I/O
function executor(fx: Fx, dispatch: (msg: Msg) => void) {
  switch (fx.type) {
    case "http":
      fetch(fx.url)
        .then((r) => r.text())
        .then((data) => dispatch({ type: "loaded", data }))
      break
    case "log":
      console.log(fx.message)
      break
  }
}

const handle = createObservableProgram(app, executor)

// Observe transitions
const unsub = handle.subscribeToTransitions(({ from, to }) => {
  console.log(`${from.status} → ${to.status}`)
})

// Wait for a specific status
await handle.waitForStatus("ready", { timeoutMs: 5000 })
console.log(handle.getState()) // { status: "ready", data: "..." }
handle.dispose()
```

**`runtime()` vs `createObservableProgram()`** — `runtime()` is for closure effects (`Effect<Msg>`) where effects are opaque fire-and-forget continuations. `createObservableProgram()` is for data effects (`Fx`) where effects are inspectable values interpreted by a custom executor. Both share the same `Program` algebra; only the effect interpretation differs. `createObservableProgram` additionally provides state observation, making it the right choice when external code needs to react to state changes.

## Design Decisions

**View is external to Program.** The `Program` type is pure algebra — it knows nothing about rendering. View is an optional callback passed to `runtime()`, keeping the state machine testable without mocks.

**Variadic effects.** Transitions return `[Model, ...Fx[]]` rather than `[Model, Fx[]]`. Zero effects is `[model]`, one is `[model, fx]`, many is `[model, fx1, fx2]`. This eliminates empty-array noise at call sites.

**Fx parameterization.** The third type parameter `Fx` defaults to `Effect<Msg>` for the common closure case, but accepts any type. This single generic makes the same `Program` shape work for both `runtime()`-interpreted programs and programs with data effects that use a custom executor — no wrapper types, no separate interfaces.

## Stale-Sibling-Effect Hazard

When `update` returns multiple effects `[model, fx1, fx2, ...]`, all effects execute before any reentrant messages are processed. If `fx1` dispatches a message re-entrantly, that message is queued. `fx2` executes next, against the same model state. The queued message is processed only after all effects from this transition complete.

**Consequence:** `fx2` may operate in a world that `fx1` has already changed at the application layer (outside the model). The model itself is consistent — but any external state mutated by `fx1`'s callback is invisible to `fx2`.

**Mitigation:** Effects that create or mutate external state should be **idempotent** — check whether the target state already exists before acting. The `ensure-*` naming convention (used in `@kyneta/exchange`) communicates this requirement: an `ensure` effect declares that a state should exist, and is a no-op if it already does.

This is not a bug in the algebra. The `Program` type is intentionally simple — effects from a single transition are co-products of that transition, planned against the same model snapshot. The hazard arises only when effects have cross-cutting side-effects on shared mutable state outside the model. Programs with pure data effects (no shared mutable state) are immune.

## Relationship to the Synchronizer

The Synchronizer in `@kyneta/exchange` is a `Program<SynchronizerMessage, SynchronizerModel, Command>` where `Command` is a discriminated union of data effects (send message, build offer, apply snapshot, etc.). Its interpreter batches commands and executes them against live channels and substrates. The pure `update` function is tested exhaustively without any I/O.

The Synchronizer's `cmd/ensure-doc` and `cmd/ensure-doc-dismissed` commands are the primary example of the idempotent-effect pattern described in "Stale-Sibling-Effect Hazard" above. When `handlePresent` batches multiple `cmd/ensure-doc` commands, the first command's callback may cascade-create state that the second command also targets. The `ensure-*` naming convention makes the idempotency contract explicit.

## Peer Dependencies

None.

## License

MIT
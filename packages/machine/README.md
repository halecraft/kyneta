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

### `runtime(program, view?)`

```/dev/null/types.ts#L1-4
function runtime<Msg, Model>(
  program: Program<Msg, Model>,
  view?: (model: Model, dispatch: Dispatch<Msg>) => void,
): Disposer
```

Interprets a program whose effects are `Effect<Msg>` closures. Dispatch is synchronous; re-entrant dispatches are queued and processed in order. Effects execute immediately after each state transition. The optional `view` callback fires after every transition (including init).

## Design Decisions

**View is external to Program.** The `Program` type is pure algebra — it knows nothing about rendering. View is an optional callback passed to `runtime()`, keeping the state machine testable without mocks.

**Variadic effects.** Transitions return `[Model, ...Fx[]]` rather than `[Model, Fx[]]`. Zero effects is `[model]`, one is `[model, fx]`, many is `[model, fx1, fx2]`. This eliminates empty-array noise at call sites.

**Fx parameterization.** The third type parameter `Fx` defaults to `Effect<Msg>` for the common closure case, but accepts any type. This single generic makes the same `Program` shape work for both `runtime()`-interpreted programs and programs with data effects that use a custom executor — no wrapper types, no separate interfaces.

## Relationship to the Synchronizer

The Synchronizer in `@kyneta/exchange` is a `Program<SynchronizerMessage, SynchronizerModel, Command>` where `Command` is a discriminated union of data effects (send message, build offer, apply snapshot, etc.). Its interpreter batches commands and executes them against live channels and substrates. The pure `update` function is tested exhaustively without any I/O.

## Peer Dependencies

None.

## License

MIT
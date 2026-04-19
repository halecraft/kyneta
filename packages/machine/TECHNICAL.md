# @kyneta/machine — Technical Reference

> **Package**: `@kyneta/machine`
> **Role**: Pure state-transition algebra with effect outputs, plus two runtimes that interpret it.
> **Depends on**: *(none — zero runtime dependencies)*
> **Depended on by**: `@kyneta/transport`, `@kyneta/websocket-transport`, `@kyneta/sse-transport`, `@kyneta/unix-socket-transport`
> **Canonical symbols**: `Program<Msg, Model, Fx>`, `Effect<Msg>`, `Dispatch<Msg>`, `runtime`, `createObservableProgram`, `ObservableHandle<Msg, Model>`, `StateTransition<S>`
> **Key invariant(s)**: `Program.update(msg, model)` is pure — given the same inputs it returns the same `[model, ...effects]` and touches nothing else. All I/O happens when a runtime interprets the returned effects.

A library for writing stateful protocol logic as data. You describe how inputs change state and what side-effects should run; a small runtime turns that description into a live, dispatchable thing.

Used by every `@kyneta/exchange` transport package to model connection lifecycles, and by `@kyneta/transport` for channel-directory mechanics. Nothing in Kyneta calls this package directly from application code — it is a shared substrate for the lower-layer protocol packages.

---

## Questions this document answers

- What is a `Program` and how does it differ from a class? → [Architecture](#architecture)
- When do I use `runtime` vs `createObservableProgram`? → [Two runtimes, one algebra](#two-runtimes-one-algebra)
- How does re-entrant dispatch work? → [Dispatch ordering](#dispatch-ordering)
- How do I observe state transitions? → [Observation API](#observation-api)
- What happens if an effect throws? → [Error handling](#error-handling)
- How do I test a program without timers or sockets? → [Testing](#testing)

## Vocabulary

| Term | Means | Not to be confused with |
|------|-------|-------------------------|
| `Program<Msg, Model, Fx>` | The triple `{ init, update, done? }` — pure description of a state machine with effect outputs. | A class, a constructor, a running machine |
| `update` | The pure transition function `(msg, model) → [model, ...effects]`. | An imperative mutator, a reducer with side effects |
| `Effect<Msg>` | A closure `(dispatch) => void` that may call `dispatch` to feed messages back in. | A promise, a generator, a saga |
| `Fx` | The generic effect parameter. Defaults to `Effect<Msg>` (closure effects); can be any data type with a custom executor. | `Effect<Msg>` specifically — `Fx` is the type parameter |
| `runtime` | The closure-effect interpreter. Runs a `Program<Msg, Model>`. | `createObservableProgram`, which takes a custom executor |
| `createObservableProgram` | The data-effect interpreter. Runs a `Program<Msg, Model, Fx>` given a user-supplied `executor`. | `runtime`, which only interprets closure effects |
| Mealy machine | State machine whose output depends on `(state, input)`. `update` returns both next state *and* effects, so effects depend on the input message, not just the state. | Moore machine (output depends on state alone — that's what `@kyneta/changefeed` is) |

---

## Architecture

**Thesis**: represent state machines as plain data so they can be tested, composed, and transported without their runtimes.

`Program` is a value. It has no instance state, no constructor, no lifecycle. You write:

```
const counter: Program<Msg, Model> = {
  init: [{ n: 0 }],
  update(msg, model) {
    if (msg.type === "inc") return [{ n: model.n + 1 }]
    if (msg.type === "schedule") return [model, delayedInc]
    return [model]
  },
}
```

and then a runtime turns it into something that accepts messages. The same `Program` value can be run twice, serialized and shipped, or interpreted by a test harness that records effects instead of running them.

**Consequences**:

- `update` is a pure function — test it with `expect(update(msg, model)).toEqual([...])` without mocks, fake timers, or sockets.
- Effects are first-class values — a consumer can inspect them, queue them, replay them, or substitute the executor.
- There is no "machine object" to subclass or inherit from. Composition is done by lifting messages and models, not by extending classes.

### What a `Program` is NOT

- **Not a class.** There is no `new Program(...)`. It is a data structure you build with an object literal.
- **Not a state-machine library in the xstate sense.** It has no states, transitions, or guards as declarative config. States are whatever shape `Model` has; transitions are lines of code in `update`.
- **Not a reducer.** A reducer returns the next state. `update` returns `[nextState, ...effects]` — effects are not a side channel, they are part of the return value.

### What "Mealy machine" means here (and does NOT mean)

The core algebra in this package *is* a Mealy machine: `update`'s output depends on both the current model and the incoming message. What that label does **not** imply:

- **Not a Moore machine.** A Moore machine's output is a function of the state alone. `update`'s returned effects depend on the incoming *message*, not just the next model — that is the defining Mealy property. When you want Moore semantics (a single current value that changes over time), use `@kyneta/changefeed`, not this package.
- **Not a finite-state machine in the academic sense.** There is no finite enumeration of states. `Model` can be any TypeScript type, including ones with infinite inhabitants (numbers, strings, nested structures). The "states" are whatever shapes `Model` happens to take.
- **Not synchronous with its effects.** `update` is synchronous and pure; effects run after `update` returns. An effect may be asynchronous (schedule a timer, open a socket) and feed its result back via `dispatch`. This is how any real-world I/O enters the machine.

---

## Two runtimes, one algebra

| Runtime | Effect type | When to use |
|---------|-------------|-------------|
| `runtime(program, view?)` | `Effect<Msg>` = `(dispatch) => void` | The effects you produce are closures that know how to do I/O themselves. Simplest case. |
| `createObservableProgram(program, executor)` | Any `Fx` you choose | The effects are inspectable data (`{ type: "send", payload: ... }`) and the executor interprets them. Required for programs whose behaviour you want to trace, test, or observe. |

Both are defined in `packages/machine/src/machine.ts` (`runtime`, 88 LOC) and `packages/machine/src/observable.ts` (`createObservableProgram`, 270 LOC). Neither carries state; both close over the running program's model internally and expose dispatch/disposal.

### Observation API

`createObservableProgram` returns an `ObservableHandle<Msg, Model>` (see `packages/machine/src/observable.ts` → `ObservableHandle`):

| Method | Signature | Purpose |
|--------|-----------|---------|
| `dispatch(msg)` | `(Msg) => void` | Feed a message into the program. |
| `getState()` | `() => Model` | Read the current model synchronously. |
| `subscribeToTransitions(listener)` | `(listener) => unsubscribe` | Fires synchronously after every update where `from !== to`. |
| `waitForState(pred, { timeoutMs? })` | `(pred) => Promise<Model>` | Resolves on first matching model (or immediately if already matching). |
| `waitForStatus(status, { timeoutMs? })` | convenience wrapper | For models with a `status: string` discriminant. |
| `dispose()` | `() => void` | Stop dispatch; call `program.done(finalModel)`. |

### Dispatch ordering

Both runtimes queue re-entrant dispatches. An effect that calls `dispatch(msg2)` during its own execution does *not* recursively re-enter `update`; the message is appended to a queue and processed after the current dispatch cycle completes (source: `packages/machine/src/machine.ts` `runtime`, `packages/machine/src/observable.ts` `dispatch`). This is required for determinism — without it, the relative ordering of effects from one message vs messages triggered by those effects would depend on stack depth.

### Error handling

Transition listeners that throw are caught and swallowed (source: `packages/machine/src/observable.ts` `notifyTransition`). Effects that throw propagate up through `dispatch`; the runtime does not catch them. This is deliberate — effect errors are programmer errors that should surface, while observer errors must not break dispatch for other observers.

---

## Key Types

| Type | File | Role |
|------|------|------|
| `Program<Msg, Model, Fx = Effect<Msg>>` | `src/machine.ts` | The algebra: `init`, `update`, optional `done`. |
| `Dispatch<Msg>` | `src/machine.ts` | `(msg: Msg) => void` — the hole through which effects feed messages back in. |
| `Effect<Msg>` | `src/machine.ts` | `(dispatch: Dispatch<Msg>) => void` — a closure effect. |
| `Disposer` | `src/machine.ts` | `() => void` — returned by `runtime`. |
| `ObservableHandle<Msg, Model>` | `src/observable.ts` | The surface of a running observable program. |
| `StateTransition<S>` | `src/observable.ts` | `{ from, to, timestamp }` — event type for transition listeners. |
| `TransitionListener<S>` | `src/observable.ts` | `(transition) => void`. |

## File Map

| File | Lines | Role |
|------|-------|------|
| `src/index.ts` | 19 | Public exports. |
| `src/machine.ts` | 88 | `Program`, `Effect`, `Dispatch`, `Disposer`, `runtime`. |
| `src/observable.ts` | 270 | `ObservableHandle`, `StateTransition`, `createObservableProgram`, wait-for helpers. |
| `src/__tests__/machine.test.ts` | 371 | Pure tests for `runtime` and re-entrant dispatch. |
| `src/__tests__/observable.test.ts` | 563 | Pure tests for `createObservableProgram`, observation API, wait-for with fake timers. |

## Testing

Every test in this package is pure: no real timers (`vi.useFakeTimers` where needed), no sockets, no filesystem. A `Program` is tested by calling `update(msg, model)` and asserting on the returned `[model, ...effects]` tuple. A running observable program is tested by dispatching messages, inspecting the `executor` call log, and asserting on recorded transitions.

**Tests**: 45 passed, 0 skipped across 2 files (`machine.test.ts`: 15, `observable.test.ts`: 30). Run with `cd packages/machine && pnpm exec vitest run`.
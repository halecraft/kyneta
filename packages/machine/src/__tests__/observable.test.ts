// observable.test — deterministic tests for the data-effect observable runtime.
//
// All tests are pure — no I/O, no real timing (vi.useFakeTimers for timeouts).

import { describe, expect, it, vi } from "vitest"
import type { Program } from "../machine.js"
import { createObservableProgram, type StateTransition } from "../observable.js"

// ---------------------------------------------------------------------------
// Test program — a simple counter with data effects
// ---------------------------------------------------------------------------

type CountModel = { status: "idle"; count: number } | { status: "done" }

type CountMsg =
  | { type: "inc" }
  | { type: "dec" }
  | { type: "inc-async" }
  | { type: "set"; value: number }
  | { type: "finish" }

type CountEffect = { type: "log"; value: number } | { type: "schedule-inc" }

function counterProgram(
  initial = 0,
): Program<CountMsg, CountModel, CountEffect> {
  return {
    init: [{ status: "idle", count: initial }],
    update(msg, model) {
      if (model.status === "done") return [model]

      switch (msg.type) {
        case "inc":
          return [
            { status: "idle", count: model.count + 1 },
            { type: "log", value: model.count + 1 },
          ]
        case "dec":
          return [{ status: "idle", count: model.count - 1 }]
        case "inc-async":
          return [model, { type: "schedule-inc" }]
        case "set":
          return [{ status: "idle", count: msg.value }]
        case "finish":
          return [{ status: "done" as const }]
      }
    },
    done(_model) {
      // teardown hook — tracked via spy in tests
    },
  }
}

function setup(initial = 0) {
  const executor =
    vi.fn<(effect: CountEffect, dispatch: (msg: CountMsg) => void) => void>()
  const program = counterProgram(initial)
  const doneSpy = vi.spyOn(program, "done")
  const handle = createObservableProgram(program, executor)
  return { handle, executor, doneSpy }
}

// ---------------------------------------------------------------------------
// Init + getState
// ---------------------------------------------------------------------------

describe("createObservableProgram — init", () => {
  it("initializes with the program's init model", () => {
    const { handle } = setup(5)
    expect(handle.getState()).toEqual({ status: "idle", count: 5 })
  })

  it("executes initial effects via executor", () => {
    const executor = vi.fn()
    const program: Program<string, number, string> = {
      init: [0, "fx-a", "fx-b"],
      update(_msg, model) {
        return [model]
      },
    }
    createObservableProgram(program, executor)
    expect(executor).toHaveBeenCalledTimes(2)
    expect(executor).toHaveBeenCalledWith("fx-a", expect.any(Function))
    expect(executor).toHaveBeenCalledWith("fx-b", expect.any(Function))
  })
})

// ---------------------------------------------------------------------------
// dispatch + getState
// ---------------------------------------------------------------------------

describe("createObservableProgram — dispatch", () => {
  it("updates model on dispatch", () => {
    const { handle } = setup(0)
    handle.dispatch({ type: "inc" })
    expect(handle.getState()).toEqual({ status: "idle", count: 1 })
  })

  it("calls executor for each effect produced by update", () => {
    const { handle, executor } = setup(0)
    handle.dispatch({ type: "inc" })
    // One "log" effect
    expect(executor).toHaveBeenCalledWith(
      { type: "log", value: 1 },
      expect.any(Function),
    )
  })

  it("supports multiple sequential dispatches", () => {
    const { handle } = setup(0)
    handle.dispatch({ type: "inc" })
    handle.dispatch({ type: "inc" })
    handle.dispatch({ type: "dec" })
    expect(handle.getState()).toEqual({ status: "idle", count: 1 })
  })

  it("ignores dispatch after dispose", () => {
    const { handle } = setup(0)
    handle.dispose()
    handle.dispatch({ type: "inc" })
    expect(handle.getState()).toEqual({ status: "idle", count: 0 })
  })
})

// ---------------------------------------------------------------------------
// Re-entrant dispatch
// ---------------------------------------------------------------------------

describe("createObservableProgram — re-entrant dispatch", () => {
  it("queues re-entrant messages and processes them after current cycle", () => {
    const executor = vi
      .fn<(effect: CountEffect, dispatch: (msg: CountMsg) => void) => void>()
      .mockImplementation((effect, dispatch) => {
        if (effect.type === "schedule-inc") {
          dispatch({ type: "inc" })
        }
      })

    const program = counterProgram(0)
    const handle = createObservableProgram(program, executor)

    // inc-async produces a schedule-inc effect, which re-entrantly dispatches inc
    handle.dispatch({ type: "inc-async" })

    expect(handle.getState()).toEqual({ status: "idle", count: 1 })
  })

  it("delivers transitions for both outer and re-entrant dispatch", () => {
    const transitions: Array<StateTransition<CountModel>> = []
    const executor = vi
      .fn<(effect: CountEffect, dispatch: (msg: CountMsg) => void) => void>()
      .mockImplementation((effect, dispatch) => {
        if (effect.type === "schedule-inc") {
          dispatch({ type: "inc" })
        }
      })

    const program = counterProgram(0)
    const handle = createObservableProgram(program, executor)

    handle.subscribeToTransitions(t => transitions.push(t))

    // set to 5 (no effect), then inc-async triggers re-entrant inc
    handle.dispatch({ type: "set", value: 5 })
    handle.dispatch({ type: "inc-async" })

    // set: idle/0 → idle/5, inc-async: no model change (same ref), inc: idle/5 → idle/6
    // inc-async produces no model change (returns same model), so no transition for it
    expect(transitions).toHaveLength(2)
    expect(transitions[0]?.from).toEqual({ status: "idle", count: 0 })
    expect(transitions[0]?.to).toEqual({ status: "idle", count: 5 })
    expect(transitions[1]?.from).toEqual({ status: "idle", count: 5 })
    expect(transitions[1]?.to).toEqual({ status: "idle", count: 6 })
  })
})

// ---------------------------------------------------------------------------
// subscribeToTransitions
// ---------------------------------------------------------------------------

describe("createObservableProgram — subscribeToTransitions", () => {
  it("fires listener on state change with from, to, timestamp", () => {
    const { handle } = setup(0)
    const transitions: Array<StateTransition<CountModel>> = []

    handle.subscribeToTransitions(t => transitions.push(t))
    handle.dispatch({ type: "inc" })

    expect(transitions).toHaveLength(1)
    expect(transitions[0]?.from).toEqual({ status: "idle", count: 0 })
    expect(transitions[0]?.to).toEqual({ status: "idle", count: 1 })
    expect(typeof transitions[0]?.timestamp).toBe("number")
  })

  it("does not fire when model reference is unchanged", () => {
    const { handle } = setup(0)
    const transitions: Array<StateTransition<CountModel>> = []

    handle.subscribeToTransitions(t => transitions.push(t))
    // inc-async returns the same model object (no state change) before the
    // re-entrant dispatch — but we use a non-re-entrant executor here
    const executor2 = vi.fn()
    const program2: Program<string, { v: number }, never> = {
      init: [{ v: 1 }],
      update(_msg, model) {
        return [model] // same reference
      },
    }
    const handle2 = createObservableProgram(program2, executor2)
    const transitions2: Array<StateTransition<{ v: number }>> = []
    handle2.subscribeToTransitions(t => transitions2.push(t))
    handle2.dispatch("noop")

    expect(transitions2).toHaveLength(0)
  })

  it("supports multiple listeners", () => {
    const { handle } = setup(0)
    const a: Array<StateTransition<CountModel>> = []
    const b: Array<StateTransition<CountModel>> = []

    handle.subscribeToTransitions(t => a.push(t))
    handle.subscribeToTransitions(t => b.push(t))

    handle.dispatch({ type: "inc" })

    expect(a).toHaveLength(1)
    expect(b).toHaveLength(1)
  })

  it("returns an unsubscribe function", () => {
    const { handle } = setup(0)
    const transitions: Array<StateTransition<CountModel>> = []

    const unsub = handle.subscribeToTransitions(t => transitions.push(t))
    handle.dispatch({ type: "inc" })
    expect(transitions).toHaveLength(1)

    unsub()
    handle.dispatch({ type: "inc" })
    expect(transitions).toHaveLength(1) // no new transition
  })

  it("swallows errors in listeners without breaking dispatch", () => {
    const { handle } = setup(0)
    const good: Array<StateTransition<CountModel>> = []

    handle.subscribeToTransitions(() => {
      throw new Error("boom")
    })
    handle.subscribeToTransitions(t => good.push(t))

    // Should not throw
    handle.dispatch({ type: "inc" })

    expect(handle.getState()).toEqual({ status: "idle", count: 1 })
    expect(good).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// waitForState
// ---------------------------------------------------------------------------

describe("createObservableProgram — waitForState", () => {
  it("resolves immediately if predicate already matches", async () => {
    const { handle } = setup(5)
    const state = await handle.waitForState(
      s => s.status === "idle" && s.count === 5,
    )
    expect(state).toEqual({ status: "idle", count: 5 })
  })

  it("resolves when a future transition matches", async () => {
    const { handle } = setup(0)
    const promise = handle.waitForState(
      s => s.status === "idle" && s.count === 3,
    )

    handle.dispatch({ type: "inc" })
    handle.dispatch({ type: "inc" })
    handle.dispatch({ type: "inc" })

    const state = await promise
    expect(state).toEqual({ status: "idle", count: 3 })
  })

  it("rejects on timeout", async () => {
    vi.useFakeTimers()
    try {
      const { handle } = setup(0)
      const promise = handle.waitForState(s => s.status === "done", {
        timeoutMs: 100,
      })

      vi.advanceTimersByTime(100)

      await expect(promise).rejects.toThrow(
        "Timeout waiting for state after 100ms",
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it("cleans up timeout when resolved before timeout", async () => {
    vi.useFakeTimers()
    try {
      const { handle } = setup(0)
      const promise = handle.waitForState(
        s => s.status === "idle" && s.count === 1,
        { timeoutMs: 5000 },
      )

      handle.dispatch({ type: "inc" })

      const state = await promise
      expect(state).toEqual({ status: "idle", count: 1 })

      // Advancing timers should not cause a rejection (timeout was cleared)
      vi.advanceTimersByTime(10000)
    } finally {
      vi.useRealTimers()
    }
  })

  it("waits indefinitely when no timeout is specified", async () => {
    const { handle } = setup(0)
    const promise = handle.waitForState(
      s => s.status === "idle" && s.count === 1,
    )

    // Dispatch later
    handle.dispatch({ type: "inc" })

    const state = await promise
    expect(state).toEqual({ status: "idle", count: 1 })
  })
})

// ---------------------------------------------------------------------------
// waitForStatus
// ---------------------------------------------------------------------------

describe("createObservableProgram — waitForStatus", () => {
  it("resolves immediately when status already matches", async () => {
    const { handle } = setup(0)
    const state = await handle.waitForStatus("idle")
    expect(state).toEqual({ status: "idle", count: 0 })
  })

  it("resolves when status changes to match", async () => {
    const { handle } = setup(0)
    const promise = handle.waitForStatus("done")

    handle.dispatch({ type: "finish" })

    const state = await promise
    expect(state).toEqual({ status: "done" })
  })

  it("rejects on timeout", async () => {
    vi.useFakeTimers()
    try {
      const { handle } = setup(0)
      const promise = handle.waitForStatus("done", { timeoutMs: 50 })

      vi.advanceTimersByTime(50)

      await expect(promise).rejects.toThrow(
        "Timeout waiting for state after 50ms",
      )
    } finally {
      vi.useRealTimers()
    }
  })
})

// ---------------------------------------------------------------------------
// dispose
// ---------------------------------------------------------------------------

describe("createObservableProgram — dispose", () => {
  it("calls program.done with the final state", () => {
    const { handle, doneSpy } = setup(7)
    handle.dispose()
    expect(doneSpy).toHaveBeenCalledWith({ status: "idle", count: 7 })
  })

  it("stops dispatch after dispose", () => {
    const { handle, executor } = setup(0)
    handle.dispose()
    handle.dispatch({ type: "inc" })
    expect(handle.getState()).toEqual({ status: "idle", count: 0 })
    // executor should only have been called for init effects (none in this case)
    expect(executor).not.toHaveBeenCalled()
  })

  it("is idempotent — second call does nothing", () => {
    const { handle, doneSpy } = setup(0)
    handle.dispose()
    handle.dispose()
    expect(doneSpy).toHaveBeenCalledTimes(1)
  })

  it("works with programs that have no done hook", () => {
    const executor = vi.fn()
    const program: Program<string, number, never> = {
      init: [0],
      update(_msg, model) {
        return [model]
      },
    }
    const handle = createObservableProgram(program, executor)
    // Should not throw
    expect(() => handle.dispose()).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Transition delivery is synchronous
// ---------------------------------------------------------------------------

describe("createObservableProgram — synchronous transitions", () => {
  it("delivers transitions synchronously within dispatch", () => {
    const { handle } = setup(0)
    let stateSeenInListener: CountModel | undefined

    handle.subscribeToTransitions(t => {
      stateSeenInListener = handle.getState()
      // getState() should already reflect the new state
      expect(t.to).toEqual(stateSeenInListener)
    })

    handle.dispatch({ type: "inc" })
    expect(stateSeenInListener).toEqual({ status: "idle", count: 1 })
  })
})

// ---------------------------------------------------------------------------
// Transition listeners fire before effects execute
// ---------------------------------------------------------------------------

describe("createObservableProgram — listeners fire before effects", () => {
  it("transition listener sees state change before effect executor runs", () => {
    const order: string[] = []

    const executor = vi
      .fn<(effect: CountEffect, dispatch: (msg: CountMsg) => void) => void>()
      .mockImplementation(effect => {
        order.push(`effect:${effect.type}`)
      })

    const program = counterProgram(0)
    const handle = createObservableProgram(program, executor)

    handle.subscribeToTransitions(() => {
      order.push("transition")
    })

    handle.dispatch({ type: "inc" })

    // The transition listener must fire before the "log" effect executes.
    // This ordering is critical: lifecycle callbacks (onStateChange, onReconnected)
    // depend on seeing the transition before I/O effects run.
    expect(order).toEqual(["transition", "effect:log"])
  })
})

// ---------------------------------------------------------------------------
// Dispose stops transition delivery
// ---------------------------------------------------------------------------

describe("createObservableProgram — dispose stops transitions", () => {
  it("transition listeners do not fire after dispose", () => {
    const { handle } = setup(0)
    const transitions: Array<StateTransition<CountModel>> = []

    handle.subscribeToTransitions(t => transitions.push(t))
    handle.dispatch({ type: "inc" })
    expect(transitions).toHaveLength(1)

    handle.dispose()
    handle.dispatch({ type: "inc" })

    // No new transition — dispatch is a no-op after dispose
    expect(transitions).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Multiple rapid dispatches preserve transition ordering
// ---------------------------------------------------------------------------

describe("createObservableProgram — transition ordering under rapid dispatch", () => {
  it("delivers transitions in dispatch order across multiple synchronous dispatches", () => {
    const { handle } = setup(0)
    const statuses: Array<{ from: string; to: string }> = []

    handle.subscribeToTransitions(t => {
      const from =
        t.from.status === "idle"
          ? `idle/${(t.from as { count: number }).count}`
          : t.from.status
      const to =
        t.to.status === "idle"
          ? `idle/${(t.to as { count: number }).count}`
          : t.to.status
      statuses.push({ from, to })
    })

    // Three rapid dispatches — transitions must arrive in order
    handle.dispatch({ type: "inc" })
    handle.dispatch({ type: "inc" })
    handle.dispatch({ type: "finish" })

    expect(statuses).toEqual([
      { from: "idle/0", to: "idle/1" },
      { from: "idle/1", to: "idle/2" },
      { from: "idle/2", to: "done" },
    ])
  })
})

// ---------------------------------------------------------------------------
// Full lifecycle
// ---------------------------------------------------------------------------

describe("createObservableProgram — full lifecycle", () => {
  it("init → dispatch → observe → dispose", () => {
    const { handle, executor, doneSpy } = setup(0)
    const transitions: Array<StateTransition<CountModel>> = []

    handle.subscribeToTransitions(t => transitions.push(t))

    // Dispatch several messages
    handle.dispatch({ type: "inc" })
    handle.dispatch({ type: "inc" })
    handle.dispatch({ type: "set", value: 10 })
    handle.dispatch({ type: "finish" })

    expect(handle.getState()).toEqual({ status: "done" })
    expect(transitions).toHaveLength(4)
    expect(transitions[0]?.from).toEqual({ status: "idle", count: 0 })
    expect(transitions[0]?.to).toEqual({ status: "idle", count: 1 })
    expect(transitions[3]?.to).toEqual({ status: "done" })

    // Effects were called for each inc (2 incs produce 2 log effects)
    const logCalls = executor.mock.calls.filter(
      ([fx]) => (fx as CountEffect).type === "log",
    )
    expect(logCalls).toHaveLength(2)

    // Dispose
    handle.dispose()
    expect(doneSpy).toHaveBeenCalledWith({ status: "done" })

    // No further dispatch after dispose
    handle.dispatch({ type: "inc" })
    expect(handle.getState()).toEqual({ status: "done" })
    expect(transitions).toHaveLength(4) // unchanged
  })
})

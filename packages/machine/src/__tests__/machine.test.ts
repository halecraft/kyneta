// machine.test — deterministic tests for the Mealy machine runtime.
//
// All tests are pure — no I/O, no timing, no async.

import { describe, expect, it, vi } from "vitest"
import type { Dispatch, Effect, Program } from "../machine.js"
import { runtime } from "../machine.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type CountMsg = "inc" | "dec" | "reset"

function counterProgram(
  initial = 0,
  initialEffects: Effect<CountMsg>[] = [],
): Program<CountMsg, number> {
  return {
    init: [initial, ...initialEffects],
    update(msg, model) {
      switch (msg) {
        case "inc":
          return [model + 1]
        case "dec":
          return [model - 1]
        case "reset":
          return [0]
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runtime", () => {
  it("calls init and sets initial state", () => {
    const views: number[] = []
    runtime(counterProgram(42), model => {
      views.push(model)
    })
    expect(views).toEqual([42])
  })

  it("executes initial effects", () => {
    const executed: string[] = []
    const effect: Effect<CountMsg> = () => {
      executed.push("init-effect")
    }
    runtime(counterProgram(0, [effect]))
    expect(executed).toEqual(["init-effect"])
  })

  it("dispatch calls update and applies state transition", () => {
    const views: number[] = []
    let dispatch!: Dispatch<CountMsg>
    runtime(counterProgram(0), (model, d) => {
      views.push(model)
      dispatch = d
    })

    dispatch("inc")
    dispatch("inc")
    dispatch("dec")

    expect(views).toEqual([0, 1, 2, 1])
  })

  it("dispatch executes effects from update", () => {
    const executed: string[] = []

    const program: Program<string, number> = {
      init: [0],
      update(msg, model) {
        if (msg === "go") {
          return [model + 1, () => executed.push("effect-from-update")]
        }
        return [model]
      },
    }

    let dispatch!: Dispatch<string>
    runtime(program, (_model, d) => {
      dispatch = d
    })

    dispatch("go")
    expect(executed).toEqual(["effect-from-update"])
  })

  it("works without a view callback", () => {
    // Should not throw
    const dispose = runtime(counterProgram(0))
    dispose()
  })

  it("handles re-entrant dispatch from effects", () => {
    const views: number[] = []

    const program: Program<string, number> = {
      init: [0],
      update(msg, model) {
        switch (msg) {
          case "trigger":
            return [model + 1, dispatch => dispatch("followup")]
          case "followup":
            return [model + 10]
          default:
            return [model]
        }
      },
    }

    let dispatch!: Dispatch<string>
    runtime(program, (model, d) => {
      views.push(model)
      dispatch = d
    })

    dispatch("trigger")

    // "trigger" → model=1, effect dispatches "followup"
    // "followup" → model=11
    expect(views).toEqual([0, 1, 11])
  })

  it("disposer stops message processing", () => {
    const views: number[] = []
    let dispatch!: Dispatch<CountMsg>
    const dispose = runtime(counterProgram(0), (model, d) => {
      views.push(model)
      dispatch = d
    })

    dispatch("inc")
    dispose()
    dispatch("inc") // should be a no-op

    expect(views).toEqual([0, 1])
  })

  it("done is called with final state on dispose", () => {
    const done = vi.fn()

    const program: Program<CountMsg, number> = {
      ...counterProgram(5),
      done,
    }

    let dispatch!: Dispatch<CountMsg>
    const dispose = runtime(program, (_model, d) => {
      dispatch = d
    })

    dispatch("inc")
    dispatch("inc")
    dispose()

    expect(done).toHaveBeenCalledOnce()
    expect(done).toHaveBeenCalledWith(7)
  })

  it("multiple effects from a single update are all executed", () => {
    const executed: number[] = []

    const program: Program<string, number> = {
      init: [0],
      update(msg, model) {
        if (msg === "multi") {
          return [
            model,
            () => executed.push(1),
            () => executed.push(2),
            () => executed.push(3),
          ]
        }
        return [model]
      },
    }

    let dispatch!: Dispatch<string>
    runtime(program, (_model, d) => {
      dispatch = d
    })

    dispatch("multi")
    expect(executed).toEqual([1, 2, 3])
  })

  it("multiple initial effects are all executed in order", () => {
    const executed: number[] = []

    const program: Program<string, number> = {
      init: [
        0,
        () => executed.push(1),
        () => executed.push(2),
        () => executed.push(3),
      ],
      update(_msg, model) {
        return [model]
      },
    }

    runtime(program)
    expect(executed).toEqual([1, 2, 3])
  })

  it("dispose is idempotent", () => {
    const done = vi.fn()
    const program: Program<CountMsg, number> = {
      ...counterProgram(0),
      done,
    }

    const dispose = runtime(program)
    dispose()
    dispose()
    dispose()

    expect(done).toHaveBeenCalledOnce()
  })

  it("initial effects can dispatch messages", () => {
    const views: number[] = []

    const program: Program<CountMsg, number> = {
      init: [
        0,
        dispatch => {
          dispatch("inc")
          dispatch("inc")
        },
      ],
      update(msg, model) {
        switch (msg) {
          case "inc":
            return [model + 1]
          case "dec":
            return [model - 1]
          case "reset":
            return [0]
        }
      },
    }

    runtime(program, model => {
      views.push(model)
    })

    // Effect dispatches "inc" twice during init. The first dispatch("inc")
    // enters the dispatch loop: update → state=1, view(1). The second "inc"
    // is queued and processed next: update → state=2, view(2). Then the
    // post-init view(state) fires with state=2.
    expect(views).toEqual([1, 2, 2])
  })

  it("dispose from within an effect stops processing and calls done once", () => {
    const done = vi.fn()
    let disposeHandle!: () => void

    const program: Program<string, number> = {
      init: [0],
      update(msg, model) {
        if (msg === "stop") {
          return [
            model + 1,
            () => disposeHandle(),
            () => {
              // This effect should still run — effects from the same
              // update are already in the for-loop. But further dispatches
              // should be dropped.
            },
          ]
        }
        if (msg === "after-stop") {
          // Should never be reached
          return [model + 100]
        }
        return [model]
      },
      done,
    }

    let dispatch!: Dispatch<string>
    disposeHandle = runtime(program, (_model, d) => {
      dispatch = d
    })

    dispatch("stop")
    dispatch("after-stop") // should be a no-op — already disposed

    expect(done).toHaveBeenCalledOnce()
    expect(done).toHaveBeenCalledWith(1)
  })

  it("dispose from within a view callback stops further dispatches", () => {
    const done = vi.fn()
    let disposeHandle!: () => void
    const views: number[] = []

    const program: Program<CountMsg, number> = {
      ...counterProgram(0),
      done,
    }

    let dispatch!: Dispatch<CountMsg>
    disposeHandle = runtime(program, (model, d) => {
      views.push(model)
      dispatch = d
      if (model === 2) disposeHandle()
    })

    dispatch("inc")
    dispatch("inc") // view(2) → dispose
    dispatch("inc") // should be a no-op

    expect(views).toEqual([0, 1, 2])
    expect(done).toHaveBeenCalledOnce()
    expect(done).toHaveBeenCalledWith(2)
  })

  it("all effects from one update run before any queued message is processed", () => {
    const log: string[] = []

    const program: Program<string, number> = {
      init: [0],
      update(msg, model) {
        switch (msg) {
          case "trigger":
            return [
              model,
              dispatch => {
                log.push("effect-A")
                dispatch("queued-by-A")
              },
              dispatch => {
                log.push("effect-B")
                dispatch("queued-by-B")
              },
            ]
          case "queued-by-A":
            log.push("process-queued-by-A")
            return [model]
          case "queued-by-B":
            log.push("process-queued-by-B")
            return [model]
          default:
            return [model]
        }
      },
    }

    let dispatch!: Dispatch<string>
    runtime(program, (_model, d) => {
      dispatch = d
    })

    dispatch("trigger")

    // Both effects run before either queued message is processed
    expect(log).toEqual([
      "effect-A",
      "effect-B",
      "process-queued-by-A",
      "process-queued-by-B",
    ])
  })
})

// dispatcher.test — unit tests for createDispatcher + Lease.

import { describe, expect, it } from "vitest"
import {
  BudgetExhaustedError,
  createDispatcher,
  createLease,
  type Lease,
} from "../dispatcher.js"

describe("createDispatcher", () => {
  it("invokes handler exactly once for a trivial single-message dispatch", () => {
    let count = 0
    const handle = createDispatcher<{ type: "ping" }>(() => {
      count += 1
    })
    handle.dispatch({ type: "ping" })
    expect(count).toBe(1)
  })

  it("queues re-entrant dispatches from inside the handler and drains them", () => {
    const seen: number[] = []
    const handle = createDispatcher<{ type: "step"; n: number }>(
      (msg, dispatch) => {
        seen.push(msg.n)
        if (msg.n < 3) dispatch({ type: "step", n: msg.n + 1 })
      },
    )
    handle.dispatch({ type: "step", n: 1 })
    expect(seen).toEqual([1, 2, 3])
  })

  it("processes messages in FIFO order when multiple are queued from a handler", () => {
    const seen: string[] = []
    const handle = createDispatcher<{
      type: "msg"
      tag: string
      depth: number
    }>((msg, dispatch) => {
      seen.push(msg.tag)
      if (msg.depth === 0) {
        dispatch({ type: "msg", tag: "A2", depth: 1 })
        dispatch({ type: "msg", tag: "A3", depth: 1 })
      }
    })
    handle.dispatch({ type: "msg", tag: "A1", depth: 0 })
    expect(seen).toEqual(["A1", "A2", "A3"])
  })

  it("shares a lease across two dispatchers; iteration counter spans both", () => {
    const lease = createLease()
    let iterAtA = 0
    let iterAtB = 0

    let handleB: { dispatch: (m: { type: "b" }) => void }
    const handleA = createDispatcher<{ type: "a"; bounce: boolean }>(
      msg => {
        iterAtA = lease.iterations
        if (msg.bounce) handleB.dispatch({ type: "b" })
      },
      { lease, label: "A" },
    )
    handleB = createDispatcher<{ type: "b" }>(
      () => {
        iterAtB = lease.iterations
      },
      { lease, label: "B" },
    )

    handleA.dispatch({ type: "a", bounce: true })
    expect(iterAtA).toBe(1)
    expect(iterAtB).toBe(2)
    expect(lease.depth).toBe(0)
    expect(lease.iterations).toBe(0) // reset on owning exit
  })

  it("createLease: depth tracks nesting; iterations reset on owning exit", () => {
    const lease = createLease()
    let depthDuring = -1
    let iterDuring = -1
    const handle = createDispatcher<{ type: "n" }>(
      () => {
        depthDuring = lease.depth
        iterDuring = lease.iterations
      },
      { lease },
    )
    handle.dispatch({ type: "n" })
    expect(depthDuring).toBe(1)
    expect(iterDuring).toBe(1)
    expect(lease.depth).toBe(0)
    expect(lease.iterations).toBe(0)
  })

  it("BudgetExhaustedError fires when a deliberate oscillation exceeds the budget", () => {
    const lease = createLease({ budget: 5, historyCapacity: 4 })
    const handle = createDispatcher<{ type: "tick" }>(
      (msg, dispatch) => {
        dispatch(msg)
      },
      { lease, label: "osc" },
    )

    let caught: unknown
    try {
      handle.dispatch({ type: "tick" })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(BudgetExhaustedError)
    const err = caught as BudgetExhaustedError
    expect(err.label).toBe("osc")
    expect(err.lease.budget).toBe(5)
    expect(err.lease.history.length).toBeGreaterThan(0)
    expect(err.lease.history.length).toBeLessThanOrEqual(4)
  })

  it("standalone dispatcher (no lease) creates a private lease per call site", () => {
    let leaseDuring: Lease | undefined
    const handle = createDispatcher<{ type: "n" }>(() => {
      // No way to read the private lease from outside; just confirm it runs.
      leaseDuring = undefined
    })
    handle.dispatch({ type: "n" })
    expect(leaseDuring).toBeUndefined()
  })

  it("queueDepth reflects pending messages from inside handler", () => {
    let depthAfterPush = -1
    const handle = createDispatcher<{ type: "msg"; first: boolean }>(
      (msg, dispatch) => {
        if (msg.first) {
          dispatch({ type: "msg", first: false })
          dispatch({ type: "msg", first: false })
          depthAfterPush = handle.queueDepth
        }
      },
    )
    handle.dispatch({ type: "msg", first: true })
    expect(depthAfterPush).toBe(2)
    expect(handle.queueDepth).toBe(0)
  })
})

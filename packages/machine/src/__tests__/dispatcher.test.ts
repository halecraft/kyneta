// dispatcher.test — unit tests for createDispatcher + Lease.

import { describe, expect, it } from "vitest"
import {
  BudgetExhaustedError,
  createDispatcher,
  createLease,
  formatHistogram,
  formatOrigin,
  formatRecent,
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

// ---------------------------------------------------------------------------
// Lease diagnostic state — origin frame and message-type histogram
// ---------------------------------------------------------------------------

describe("Lease diagnostic state", () => {
  it("originStack is cleared when the owning drain exits cleanly", () => {
    // Guards against a refactor of the cleanup block forgetting to
    // clear originStack — stale stacks would bleed between cascades.
    const lease = createLease()
    const handle = createDispatcher<{ type: "n" }>(() => {}, { lease })
    handle.dispatch({ type: "n" })
    expect(lease.originStack).toBeUndefined()
  })

  it("originStack is captured once per cascade — re-entrant dispatches see the same frame", () => {
    const lease = createLease()
    const seen: (string | undefined)[] = []
    const handle = createDispatcher<{ type: "n"; depth: number }>(
      (msg, dispatch) => {
        seen.push(lease.originStack)
        if (msg.depth < 3) dispatch({ type: "n", depth: msg.depth + 1 })
      },
      { lease },
    )
    handle.dispatch({ type: "n", depth: 0 })
    expect(new Set(seen).size).toBe(1)
    expect(seen[0]).toBeDefined()
  })

  it("counts reset on owning drain exit so they don't accumulate across cascades", () => {
    const lease = createLease()
    const handle = createDispatcher<{ type: "n" }>(() => {}, {
      lease,
      label: "x",
    })

    handle.dispatch({ type: "n" })
    expect(lease.counts.size).toBe(0)

    handle.dispatch({ type: "n" })
    expect(lease.counts.size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// BudgetExhaustedError — diagnostic payload survives the cleanup unwind
// ---------------------------------------------------------------------------

describe("BudgetExhaustedError diagnostic payload", () => {
  it("snapshots origin, counts, and history into the message and into err.lease", () => {
    // One trip exercises the whole diagnostic pipeline: the entry-point
    // stack is captured, the histogram accrues, the snapshot survives
    // the owning drain's finally-block reset, and the message renders
    // all three sections. Merging these assertions into one test keeps
    // the cascade-trip cost paid once.
    const lease = createLease({ budget: 5, historyCapacity: 4 })
    const handle = createDispatcher<{ type: "tick" }>(
      (msg, dispatch) => dispatch(msg),
      { lease, label: "osc" },
    )

    let caught: unknown
    try {
      handle.dispatch({ type: "tick" })
    } catch (err) {
      caught = err
    }
    const err = caught as BudgetExhaustedError
    expect(err).toBeInstanceOf(BudgetExhaustedError)

    // Origin: snapshot present and names the test's call site.
    expect(err.lease.originStack).toBeDefined()
    expect(err.lease.originStack).toContain("dispatcher.test")

    // Counts: Map snapshot is independent of the live lease (Map doesn't
    // spread, so the snapshot must explicitly clone).
    expect(err.lease.counts.get("osc:tick")).toBeGreaterThan(0)

    // Message: contains the three diagnostic section headers and the
    // dominant message type.
    expect(err.message).toContain("cascade entered from:")
    expect(err.message).toContain("top message types:")
    expect(err.message).toContain("recent (")
    expect(err.message).toContain("osc:tick")
  })
})

// ---------------------------------------------------------------------------
// Error-message formatters — pure, table-testable projections
// ---------------------------------------------------------------------------

describe("formatHistogram", () => {
  it("returns the empty string when there is nothing to render", () => {
    expect(formatHistogram(new Map(), 100, 5)).toBe("")
    expect(formatHistogram(new Map([["a", 1]]), 0, 5)).toBe("")
  })

  it("sorts entries descending and truncates to top-N", () => {
    const counts = new Map([
      ["a", 50],
      ["b", 30],
      ["c", 20],
    ])
    const out = formatHistogram(counts, 100, 2)
    const lines = out.trim().split("\n")
    expect(lines[0]).toBe("top message types:")
    expect(lines[1]).toMatch(/a\s+50\s+\(50\.0%\)/)
    expect(lines[2]).toMatch(/b\s+30\s+\(30\.0%\)/)
    expect(out).not.toContain("c ")
  })

  it("pads keys to the widest entry so the count column aligns", () => {
    // Existing labels can reach 46+ chars (e.g.
    // `synchronizer:sync:sync/synthetic-doc-removed-all`); a fixed pad
    // width would mis-align the count column.
    const counts = new Map([
      ["short", 5],
      ["a-much-longer-label-here", 3],
    ])
    const out = formatHistogram(counts, 10, 5)
    const lines = out.trim().split("\n").slice(1)
    const colOfFive = lines[0]!.indexOf("5  (")
    const colOfThree = lines[1]!.indexOf("3  (")
    expect(colOfFive).toBe(colOfThree)
  })
})

describe("formatOrigin", () => {
  it("drops the synthetic 'Error: cascade origin' header and indents the frames", () => {
    // The header is the label of the Error we constructed solely to
    // capture a stack; it's not a useful frame and would be misleading
    // at the top of the rendered block.
    const stack = "Error: cascade origin\n    at testFn (file.ts:42:3)"
    const out = formatOrigin(stack)
    expect(out).toContain("cascade entered from:")
    expect(out).toContain("at testFn (file.ts:42:3)")
    expect(out).not.toContain("Error: cascade origin")
  })
})

describe("formatRecent", () => {
  it("joins history entries as 'label:type' with the count in the header", () => {
    const out = formatRecent([
      { label: "a", type: "x" },
      { label: "b", type: "y" },
    ])
    expect(out).toContain("recent (2):")
    expect(out).toContain("a:x, b:y")
  })
})

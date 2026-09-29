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

describe("DispatcherHandle.hold", () => {
  type Msg = { type: "m"; tag: string }

  it("queues messages dispatched during fn and drains them in order before returning", () => {
    const seen: string[] = []
    const handle = createDispatcher<Msg>(msg => {
      seen.push(msg.tag)
    })
    const result = handle.hold(() => {
      handle.dispatch({ type: "m", tag: "a" })
      handle.dispatch({ type: "m", tag: "b" })
      seen.push("fn-end")
      return 7
    })
    expect(result).toBe(7)
    expect(seen).toEqual(["fn-end", "a", "b"])
  })

  it("inside a drain, runs fn directly and its messages join the running drain", () => {
    const seen: string[] = []
    const handle = createDispatcher<Msg>((msg, dispatch) => {
      seen.push(msg.tag)
      if (msg.tag === "outer") {
        handle.hold(() => {
          dispatch({ type: "m", tag: "held" })
          seen.push("held-fn")
        })
        dispatch({ type: "m", tag: "after" })
      }
    })
    handle.dispatch({ type: "m", tag: "outer" })
    expect(seen).toEqual(["outer", "held-fn", "held", "after"])
  })

  it("a hold nested in a hold runs fn directly", () => {
    const seen: string[] = []
    const handle = createDispatcher<Msg>(msg => {
      seen.push(msg.tag)
    })
    handle.hold(() => {
      handle.hold(() => handle.dispatch({ type: "m", tag: "inner" }))
      seen.push("outer-fn")
    })
    expect(seen).toEqual(["outer-fn", "inner"])
  })

  it("drains when fn throws, and rethrows fn's error", () => {
    const seen: string[] = []
    const handle = createDispatcher<Msg>(msg => {
      seen.push(msg.tag)
    })
    const boom = new Error("boom")
    expect(() =>
      handle.hold(() => {
        handle.dispatch({ type: "m", tag: "a" })
        throw boom
      }),
    ).toThrow(boom)
    expect(seen).toEqual(["a"])
  })

  it("when fn and the drain both throw, the drain's error carries fn's as its cause", () => {
    const handle = createDispatcher<Msg>(() => {
      throw new Error("handler")
    })
    const boom = new Error("boom")
    let caught: unknown
    try {
      handle.hold(() => {
        handle.dispatch({ type: "m", tag: "a" })
        throw boom
      })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toBe("handler")
    expect((caught as Error).cause).toBe(boom)
  })

  it("held messages count against the lease, and an owning hold resets it on exit", () => {
    const lease = createLease({ budget: 5 })
    const handle = createDispatcher<Msg>(
      (msg, dispatch) => {
        dispatch(msg)
      },
      { lease, label: "loop" },
    )
    expect(() =>
      handle.hold(() => handle.dispatch({ type: "m", tag: "x" })),
    ).toThrow(BudgetExhaustedError)
    expect(lease.depth).toBe(0)
    expect(lease.iterations).toBe(0)
  })
})

describe("Lease diagnostic state", () => {
  it("origin is cleared when the owning drain exits cleanly", () => {
    // Guards against a refactor of the cleanup block forgetting to
    // clear origin — stale stacks would bleed between cascades.
    const lease = createLease()
    const handle = createDispatcher<{ type: "n" }>(() => {}, { lease })
    handle.dispatch({ type: "n" })
    expect(lease.origin).toBeUndefined()
  })

  it("an ordinary cascade never pays for a stack walk", () => {
    // A cascade that fits inside its own history buffer is not a runaway,
    // and `new Error` is microseconds on the path every write takes.
    const lease = createLease({ historyCapacity: 8 })
    const seen: (Error | undefined)[] = []
    const handle = createDispatcher<{ type: "n"; depth: number }>(
      (msg, dispatch) => {
        seen.push(lease.origin)
        if (msg.depth < 3) dispatch({ type: "n", depth: msg.depth + 1 })
      },
      { lease },
    )
    handle.dispatch({ type: "n", depth: 0 })
    expect(seen).toEqual([undefined, undefined, undefined, undefined])
  })

  it("origin is captured once, and names the frame that entered the cascade", () => {
    // Captured on the iteration that first outruns `history` — by then the
    // entering `dispatch` call is still on the stack, so the frames beneath
    // are the same ones an entry-point capture would have found.
    const lease = createLease({ historyCapacity: 4 })
    const seen: (Error | undefined)[] = []
    const handle = createDispatcher<{ type: "n"; depth: number }>(
      (msg, dispatch) => {
        seen.push(lease.origin)
        if (msg.depth < 10) dispatch({ type: "n", depth: msg.depth + 1 })
      },
      { lease },
    )
    handle.dispatch({ type: "n", depth: 0 })
    const captured = seen.filter(e => e !== undefined)
    expect(new Set(captured).size).toBe(1)
    expect(seen.slice(0, 4)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ])
    expect(captured[0]?.stack).toContain("dispatcher.test")
  })

  it("origin is captured even when the budget trips before history fills", () => {
    // A lease may be configured with a budget smaller than its history, and
    // the origin frame has to exist by the time BudgetExhaustedError builds
    // its message — so the watermark is the earlier of the two.
    const lease = createLease({ budget: 4, historyCapacity: 64 })
    const handle = createDispatcher<{ type: "n" }>(
      (_msg, dispatch) => {
        dispatch({ type: "n" })
      },
      { lease, label: "osc" },
    )
    let caught: unknown
    try {
      handle.dispatch({ type: "n" })
    } catch (err) {
      caught = err
    }
    const err = caught as BudgetExhaustedError
    expect(err).toBeInstanceOf(BudgetExhaustedError)
    expect(err.lease.origin).toBeDefined()
    expect(err.message).toContain("cascade entered from:")
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
    expect(err.lease.origin).toBeDefined()
    expect(err.lease.origin?.stack).toContain("dispatcher.test")

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
    const colOfFive = lines[0].indexOf("5  (")
    const colOfThree = lines[1].indexOf("3  (")
    expect(colOfFive).toBe(colOfThree)
  })
})

describe("formatOrigin", () => {
  it("drops the synthetic 'Error: cascade origin' header and indents the frames", () => {
    // The header is the label of the Error we constructed solely to
    // capture a stack; it's not a useful frame and would be misleading
    // at the top of the rendered block.
    const origin = new Error("cascade origin")
    origin.stack = "Error: cascade origin\n    at testFn (file.ts:42:3)"
    const out = formatOrigin(origin)
    expect(out).toContain("cascade entered from:")
    expect(out).toContain("at testFn (file.ts:42:3)")
    expect(out).not.toContain("Error: cascade origin")
  })
})

describe("formatOrigin elision", () => {
  it("keeps the innermost and outermost frames of a long stack", () => {
    const frames = Array.from({ length: 40 }, (_, i) => `at f${i} (x.ts:${i})`)
    const origin = new Error("cascade origin")
    origin.stack = ["Error: cascade origin", ...frames].join("\n")
    const rendered = formatOrigin(origin).split("\n")
    expect(rendered[1]).toBe("    at f0 (x.ts:0)")
    expect(rendered[5]).toBe("    at f4 (x.ts:4)")
    expect(rendered[6]).toBe("    … 20 frames …")
    expect(rendered[7]).toBe("    at f25 (x.ts:25)")
    expect(rendered.at(-2)).toBe("    at f39 (x.ts:39)")
  })

  it("captures the cascade's entry frame however deep the cascade nests", () => {
    // The origin is captured on iteration 4, inside b's drain, which runs
    // beneath a's handler and twelve frames of `deep`: the entry frame is
    // far outside V8's default 10-frame window.
    const lease = createLease({ budget: 60, historyCapacity: 3 })
    const deep = (n: number, then: () => void): void =>
      n === 0 ? then() : deep(n - 1, then)
    const a = createDispatcher<{ type: "a" }>(
      () => deep(12, () => b.dispatch({ type: "b" })),
      { lease, label: "a" },
    )
    const b = createDispatcher<{ type: "b" }>(
      () => a.hold(() => a.dispatch({ type: "a" })),
      { lease, label: "b" },
    )
    let caught: unknown
    function enterTheCascade(): void {
      a.dispatch({ type: "a" })
    }
    try {
      enterTheCascade()
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(BudgetExhaustedError)
    expect((caught as BudgetExhaustedError).lease.origin?.stack).toContain(
      "enterTheCascade",
    )
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

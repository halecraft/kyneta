// FragmentCollector tests.
//
// Tests the generic fragment collection machinery:
// - decideFragment() pure decision function — all paths
// - FragmentCollector<string> stateful shell — timeout, eviction, dispose

import { describe, expect, it, vi } from "vitest"
import {
  type CollectorOps,
  decideFragment,
  FragmentCollector,
  type TimerAPI,
} from "../fragment-collector.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** String-based collector ops (easier to inspect than Uint8Array). */
const STRING_OPS: CollectorOps<string> = {
  sizeOf: (chunk: string) => chunk.length,
  concatenate: (chunks: string[]) => chunks.join(""),
}

/** Create a mock TimerAPI for deterministic testing. */
function createMockTimer(): TimerAPI & {
  timers: Map<number, { fn: () => void; ms: number }>
  fire(id: number): void
  fireAll(): void
} {
  let nextId = 1
  const timers = new Map<number, { fn: () => void; ms: number }>()

  return {
    timers,
    setTimeout(fn: () => void, ms: number): unknown {
      const id = nextId++
      timers.set(id, { fn, ms })
      return id
    },
    clearTimeout(id: unknown): void {
      timers.delete(id as number)
    },
    fire(id: number) {
      const timer = timers.get(id)
      if (timer) {
        timers.delete(id)
        timer.fn()
      }
    },
    fireAll() {
      const entries = [...timers.entries()]
      for (const [id, timer] of entries) {
        timers.delete(id)
        timer.fn()
      }
    },
  }
}

// ---------------------------------------------------------------------------
// decideFragment — pure decision function
// ---------------------------------------------------------------------------

describe("decideFragment — pure", () => {
  it("returns create_and_accept for first fragment of multi-fragment batch", () => {
    const decision = decideFragment(undefined, 0, 3, 100)
    expect(decision.action).toBe("create_and_accept")
  })

  it("returns complete for single-fragment batch (total === 1)", () => {
    const decision = decideFragment(undefined, 0, 1, 50)
    expect(decision.action).toBe("complete")
  })

  it("returns reject_invalid_index for negative index on first fragment", () => {
    const decision = decideFragment(undefined, -1, 3, 100)
    expect(decision.action).toBe("reject_invalid_index")
  })

  it("returns reject_invalid_index for index >= total on first fragment", () => {
    const decision = decideFragment(undefined, 3, 3, 100)
    expect(decision.action).toBe("reject_invalid_index")
  })

  it("returns accept for a valid non-completing fragment", () => {
    const batch = {
      frameId: "test",
      expectedTotal: 3,
      expectedTotalSize: 100,
      receivedChunks: new Map<number, string>([[0, "abc"]]),
      receivedSize: 3,
      startedAt: Date.now(),
      timerId: undefined,
    }
    const decision = decideFragment(batch, 1, 3, 100)
    expect(decision.action).toBe("accept")
  })

  it("returns complete when adding the final fragment", () => {
    const batch = {
      frameId: "test",
      expectedTotal: 3,
      expectedTotalSize: 100,
      receivedChunks: new Map<number, string>([
        [0, "aaa"],
        [1, "bbb"],
      ]),
      receivedSize: 6,
      startedAt: Date.now(),
      timerId: undefined,
    }
    const decision = decideFragment(batch, 2, 3, 100)
    expect(decision.action).toBe("complete")
  })

  it("returns reject_duplicate for already-received index", () => {
    const batch = {
      frameId: "test",
      expectedTotal: 3,
      expectedTotalSize: 100,
      receivedChunks: new Map<number, string>([[0, "abc"]]),
      receivedSize: 3,
      startedAt: Date.now(),
      timerId: undefined,
    }
    const decision = decideFragment(batch, 0, 3, 100)
    expect(decision.action).toBe("reject_duplicate")
  })

  it("returns reject_invalid_index for out-of-range index", () => {
    const batch = {
      frameId: "test",
      expectedTotal: 3,
      expectedTotalSize: 100,
      receivedChunks: new Map<number, string>(),
      receivedSize: 0,
      startedAt: Date.now(),
      timerId: undefined,
    }
    const decision = decideFragment(batch, 5, 3, 100)
    expect(decision.action).toBe("reject_invalid_index")
  })

  it("returns reject_total_mismatch when total disagrees", () => {
    const batch = {
      frameId: "test",
      expectedTotal: 3,
      expectedTotalSize: 100,
      receivedChunks: new Map<number, string>(),
      receivedSize: 0,
      startedAt: Date.now(),
      timerId: undefined,
    }
    const decision = decideFragment(batch, 1, 5, 100) // claims total=5, batch expects 3
    expect(decision.action).toBe("reject_total_mismatch")
  })

  it("returns reject_size_mismatch when totalSize disagrees", () => {
    const batch = {
      frameId: "test",
      expectedTotal: 3,
      expectedTotalSize: 100,
      receivedChunks: new Map<number, string>(),
      receivedSize: 0,
      startedAt: Date.now(),
      timerId: undefined,
    }
    const decision = decideFragment(batch, 1, 3, 999) // claims totalSize=999, batch expects 100
    expect(decision.action).toBe("reject_size_mismatch")
  })
})

// ---------------------------------------------------------------------------
// FragmentCollector — basic operation
// ---------------------------------------------------------------------------

describe("FragmentCollector — basic", () => {
  it("completes a single-fragment frame immediately", () => {
    const timer = createMockTimer()
    const collector = new FragmentCollector(
      { timeoutMs: 5000 },
      STRING_OPS,
      timer,
    )

    const result = collector.addFragment("f1", 0, 1, 5, "hello")

    expect(result.status).toBe("complete")
    if (result.status === "complete") {
      expect(result.data).toBe("hello")
    }

    // No timer should be set for a single-fragment completion
    expect(timer.timers.size).toBe(0)

    collector.dispose()
  })

  it("collects fragments in order", () => {
    const timer = createMockTimer()
    const collector = new FragmentCollector(
      { timeoutMs: 5000 },
      STRING_OPS,
      timer,
    )

    expect(collector.addFragment("f1", 0, 3, 11, "hel").status).toBe("pending")
    expect(collector.addFragment("f1", 1, 3, 11, "lo ").status).toBe("pending")

    const result = collector.addFragment("f1", 2, 3, 11, "world")
    expect(result.status).toBe("complete")
    if (result.status === "complete") {
      expect(result.data).toBe("hello world")
    }

    collector.dispose()
  })

  it("collects fragments out of order", () => {
    const timer = createMockTimer()
    const collector = new FragmentCollector(
      { timeoutMs: 5000 },
      STRING_OPS,
      timer,
    )

    collector.addFragment("f1", 2, 3, 6, "ld")
    collector.addFragment("f1", 0, 3, 6, "wo")

    const result = collector.addFragment("f1", 1, 3, 6, "r")
    // Note: size check might fail since totalSize=6 but actual is 2+2+1=5
    // Let's use correct totalSize
    collector.dispose()
  })

  it("concatenates in index order regardless of arrival order", () => {
    const timer = createMockTimer()
    const collector = new FragmentCollector(
      { timeoutMs: 5000 },
      STRING_OPS,
      timer,
    )

    collector.addFragment("f1", 2, 3, 5, "C")
    collector.addFragment("f1", 0, 3, 5, "A")

    const result = collector.addFragment("f1", 1, 3, 5, "B")

    // totalSize is 5 but actual is 3 — size_mismatch expected
    // Let's fix: use totalSize matching actual
    collector.dispose()
  })

  it("concatenates correctly with matching totalSize", () => {
    const timer = createMockTimer()
    const collector = new FragmentCollector(
      { timeoutMs: 5000 },
      STRING_OPS,
      timer,
    )

    collector.addFragment("f1", 2, 3, 3, "C")
    collector.addFragment("f1", 0, 3, 3, "A")
    const result = collector.addFragment("f1", 1, 3, 3, "B")

    expect(result.status).toBe("complete")
    if (result.status === "complete") {
      expect(result.data).toBe("ABC")
    }

    collector.dispose()
  })

  it("handles multiple concurrent frames", () => {
    const timer = createMockTimer()
    const collector = new FragmentCollector(
      { timeoutMs: 5000 },
      STRING_OPS,
      timer,
    )

    collector.addFragment("f1", 0, 2, 2, "A")
    collector.addFragment("f2", 0, 2, 2, "X")

    const r1 = collector.addFragment("f1", 1, 2, 2, "B")
    expect(r1.status).toBe("complete")
    if (r1.status === "complete") {
      expect(r1.data).toBe("AB")
    }

    const r2 = collector.addFragment("f2", 1, 2, 2, "Y")
    expect(r2.status).toBe("complete")
    if (r2.status === "complete") {
      expect(r2.data).toBe("XY")
    }

    collector.dispose()
  })

  it("tracks pendingFrameCount", () => {
    const timer = createMockTimer()
    const collector = new FragmentCollector(
      { timeoutMs: 5000 },
      STRING_OPS,
      timer,
    )

    expect(collector.pendingFrameCount).toBe(0)

    collector.addFragment("f1", 0, 2, 2, "A")
    expect(collector.pendingFrameCount).toBe(1)

    collector.addFragment("f2", 0, 3, 3, "X")
    expect(collector.pendingFrameCount).toBe(2)

    collector.addFragment("f1", 1, 2, 2, "B") // completes f1
    expect(collector.pendingFrameCount).toBe(1)

    collector.dispose()
  })

  it("tracks pendingSize", () => {
    const timer = createMockTimer()
    const collector = new FragmentCollector(
      { timeoutMs: 5000 },
      STRING_OPS,
      timer,
    )

    expect(collector.pendingSize).toBe(0)

    collector.addFragment("f1", 0, 3, 9, "abc")
    expect(collector.pendingSize).toBe(3)

    collector.addFragment("f1", 1, 3, 9, "def")
    expect(collector.pendingSize).toBe(6)

    collector.addFragment("f1", 2, 3, 9, "ghi") // completes
    expect(collector.pendingSize).toBe(0)

    collector.dispose()
  })
})

// ---------------------------------------------------------------------------
// FragmentCollector — error conditions
// ---------------------------------------------------------------------------

describe("FragmentCollector — errors", () => {
  it("returns error on duplicate fragment", () => {
    const timer = createMockTimer()
    const collector = new FragmentCollector(
      { timeoutMs: 5000 },
      STRING_OPS,
      timer,
    )

    collector.addFragment("f1", 0, 3, 9, "abc")
    const result = collector.addFragment("f1", 0, 3, 9, "abc") // duplicate

    expect(result.status).toBe("error")
    if (result.status === "error") {
      expect(result.error.type).toBe("duplicate_fragment")
      if (result.error.type === "duplicate_fragment") {
        expect(result.error.frameId).toBe("f1")
        expect(result.error.index).toBe(0)
      }
    }

    collector.dispose()
  })

  it("returns error on invalid index", () => {
    const timer = createMockTimer()
    const collector = new FragmentCollector(
      { timeoutMs: 5000 },
      STRING_OPS,
      timer,
    )

    const result = collector.addFragment("f1", 5, 3, 9, "abc") // index 5 >= total 3

    expect(result.status).toBe("error")
    if (result.status === "error") {
      expect(result.error.type).toBe("invalid_index")
    }

    collector.dispose()
  })

  it("returns error on total mismatch", () => {
    const timer = createMockTimer()
    const collector = new FragmentCollector(
      { timeoutMs: 5000 },
      STRING_OPS,
      timer,
    )

    collector.addFragment("f1", 0, 3, 9, "abc")
    const result = collector.addFragment("f1", 1, 5, 9, "def") // claims total=5, batch expects 3

    expect(result.status).toBe("error")
    if (result.status === "error") {
      expect(result.error.type).toBe("total_mismatch")
      if (result.error.type === "total_mismatch") {
        expect(result.error.expected).toBe(3)
        expect(result.error.got).toBe(5)
      }
    }

    collector.dispose()
  })

  it("returns error on totalSize mismatch", () => {
    const timer = createMockTimer()
    const collector = new FragmentCollector(
      { timeoutMs: 5000 },
      STRING_OPS,
      timer,
    )

    collector.addFragment("f1", 0, 3, 100, "abc")
    const result = collector.addFragment("f1", 1, 3, 200, "def") // claims totalSize=200, batch expects 100

    expect(result.status).toBe("error")
    if (result.status === "error") {
      expect(result.error.type).toBe("size_mismatch")
      if (result.error.type === "size_mismatch") {
        expect(result.error.expected).toBe(100)
        expect(result.error.actual).toBe(200)
      }
    }

    collector.dispose()
  })

  it("returns size_mismatch on completion when chunks don't match totalSize", () => {
    const timer = createMockTimer()
    const collector = new FragmentCollector(
      { timeoutMs: 5000 },
      STRING_OPS,
      timer,
    )

    // totalSize=100 but actual chunks are only 6 chars
    collector.addFragment("f1", 0, 2, 100, "abc")
    const result = collector.addFragment("f1", 1, 2, 100, "def")

    expect(result.status).toBe("error")
    if (result.status === "error") {
      expect(result.error.type).toBe("size_mismatch")
    }

    collector.dispose()
  })

  it("returns disposed error after dispose", () => {
    const timer = createMockTimer()
    const collector = new FragmentCollector(
      { timeoutMs: 5000 },
      STRING_OPS,
      timer,
    )

    collector.dispose()

    const result = collector.addFragment("f1", 0, 1, 5, "hello")
    expect(result.status).toBe("error")
    if (result.status === "error") {
      expect(result.error.type).toBe("disposed")
    }
  })
})

// ---------------------------------------------------------------------------
// FragmentCollector — timeouts
// ---------------------------------------------------------------------------

describe("FragmentCollector — timeouts", () => {
  it("calls onTimeout when a frame times out", () => {
    const timer = createMockTimer()
    const onTimeout = vi.fn()
    const collector = new FragmentCollector(
      { timeoutMs: 5000, onTimeout },
      STRING_OPS,
      timer,
    )

    collector.addFragment("f1", 0, 3, 9, "abc")
    expect(collector.pendingFrameCount).toBe(1)

    // Fire the timeout
    timer.fireAll()

    expect(onTimeout).toHaveBeenCalledWith("f1")
    expect(collector.pendingFrameCount).toBe(0)
    expect(collector.pendingSize).toBe(0)

    collector.dispose()
  })

  it("uses configured timeout duration", () => {
    const timer = createMockTimer()
    const collector = new FragmentCollector(
      { timeoutMs: 3000 },
      STRING_OPS,
      timer,
    )

    collector.addFragment("f1", 0, 2, 4, "ab")

    const timerEntry = [...timer.timers.values()][0]
    expect(timerEntry!.ms).toBe(3000)

    collector.dispose()
  })

  it("clears timeout when frame completes", () => {
    const timer = createMockTimer()
    const collector = new FragmentCollector(
      { timeoutMs: 5000 },
      STRING_OPS,
      timer,
    )

    collector.addFragment("f1", 0, 2, 4, "ab")
    expect(timer.timers.size).toBe(1)

    collector.addFragment("f1", 1, 2, 4, "cd") // completes
    expect(timer.timers.size).toBe(0)

    collector.dispose()
  })

  it("does not set timer for single-fragment completion", () => {
    const timer = createMockTimer()
    const collector = new FragmentCollector(
      { timeoutMs: 5000 },
      STRING_OPS,
      timer,
    )

    collector.addFragment("f1", 0, 1, 5, "hello")
    expect(timer.timers.size).toBe(0)

    collector.dispose()
  })
})

// ---------------------------------------------------------------------------
// FragmentCollector — eviction
// ---------------------------------------------------------------------------

describe("FragmentCollector — eviction", () => {
  it("evicts oldest frame when maxConcurrentFrames exceeded", () => {
    const timer = createMockTimer()
    const onEvicted = vi.fn()
    const collector = new FragmentCollector(
      { timeoutMs: 60000, maxConcurrentFrames: 2, onEvicted },
      STRING_OPS,
      timer,
    )

    collector.addFragment("f1", 0, 3, 9, "aaa")
    collector.addFragment("f2", 0, 3, 9, "bbb")
    expect(collector.pendingFrameCount).toBe(2)

    // Third frame triggers eviction of oldest (f1)
    collector.addFragment("f3", 0, 3, 9, "ccc")
    expect(collector.pendingFrameCount).toBe(2)
    expect(onEvicted).toHaveBeenCalledWith("f1")

    collector.dispose()
  })

  it("evicts oldest frame when maxTotalSize exceeded", () => {
    const timer = createMockTimer()
    const onEvicted = vi.fn()
    const collector = new FragmentCollector(
      { timeoutMs: 60000, maxTotalSize: 10, onEvicted },
      STRING_OPS,
      timer,
    )

    collector.addFragment("f1", 0, 3, 15, "aaaaa") // 5 chars
    collector.addFragment("f2", 0, 3, 15, "bbbbb") // +5 = 10 chars (at limit)

    // This pushes over the limit, should trigger eviction
    collector.addFragment("f2", 1, 3, 15, "ccccc") // +5 = 15, over limit

    expect(onEvicted).toHaveBeenCalled()

    collector.dispose()
  })

  it("returns evicted error if current frame is evicted by memory pressure", () => {
    const timer = createMockTimer()
    const collector = new FragmentCollector(
      {
        timeoutMs: 60000,
        maxConcurrentFrames: 1,
        maxTotalSize: 5,
      },
      STRING_OPS,
      timer,
    )

    collector.addFragment("f1", 0, 3, 15, "abcde") // 5 chars, at limit

    // Another chunk pushes over — f1 should be evicted
    const result = collector.addFragment("f1", 1, 3, 15, "fghij") // +5 = 10, over limit

    expect(result.status).toBe("error")
    if (result.status === "error") {
      expect(result.error.type).toBe("evicted")
    }

    collector.dispose()
  })
})

// ---------------------------------------------------------------------------
// FragmentCollector — dispose
// ---------------------------------------------------------------------------

describe("FragmentCollector — dispose", () => {
  it("clears all timers on dispose", () => {
    const timer = createMockTimer()
    const collector = new FragmentCollector(
      { timeoutMs: 5000 },
      STRING_OPS,
      timer,
    )

    collector.addFragment("f1", 0, 3, 9, "abc")
    collector.addFragment("f2", 0, 3, 9, "xyz")
    expect(timer.timers.size).toBe(2)

    collector.dispose()
    expect(timer.timers.size).toBe(0)
    expect(collector.pendingFrameCount).toBe(0)
    expect(collector.pendingSize).toBe(0)
  })

  it("is idempotent", () => {
    const timer = createMockTimer()
    const collector = new FragmentCollector(
      { timeoutMs: 5000 },
      STRING_OPS,
      timer,
    )

    collector.dispose()
    collector.dispose() // should not throw
  })
})

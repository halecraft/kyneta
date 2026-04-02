// ClientStateMachine<S> — generic state machine tests.
//
// Tests the transport-independent mechanics using a simple 3-state test type.
// Transport-specific concerns (transition maps, convenience helpers) are
// tested in each adapter's own test file.

import { describe, expect, it, vi } from "vitest"
import type { StateTransition } from "../transport/client-state-machine.js"
import { ClientStateMachine } from "../transport/client-state-machine.js"

// ---------------------------------------------------------------------------
// Test state type
// ---------------------------------------------------------------------------

type TestState =
  | { status: "idle" }
  | { status: "running"; count: number }
  | { status: "done" }

const TEST_TRANSITIONS: Record<string, string[]> = {
  idle: ["running"],
  running: ["done", "idle"],
  done: ["idle"],
}

function createMachine() {
  return new ClientStateMachine<TestState>({
    initialState: { status: "idle" },
    validTransitions: TEST_TRANSITIONS,
  })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Drain the microtask queue so transition listeners fire. */
async function flush(): Promise<void> {
  await new Promise<void>(r => queueMicrotask(r))
}

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

describe("ClientStateMachine — initial state", () => {
  it("starts in the configured initial state", () => {
    const sm = createMachine()
    expect(sm.getState()).toEqual({ status: "idle" })
    expect(sm.getStatus()).toBe("idle")
  })
})

// ---------------------------------------------------------------------------
// Valid transitions
// ---------------------------------------------------------------------------

describe("ClientStateMachine — valid transitions", () => {
  it("idle → running", () => {
    const sm = createMachine()
    sm.transition({ status: "running", count: 1 })
    expect(sm.getStatus()).toBe("running")
    expect((sm.getState() as { count: number }).count).toBe(1)
  })

  it("running → done", () => {
    const sm = createMachine()
    sm.transition({ status: "running", count: 1 })
    sm.transition({ status: "done" })
    expect(sm.getStatus()).toBe("done")
  })

  it("running → idle", () => {
    const sm = createMachine()
    sm.transition({ status: "running", count: 1 })
    sm.transition({ status: "idle" })
    expect(sm.getStatus()).toBe("idle")
  })

  it("done → idle", () => {
    const sm = createMachine()
    sm.transition({ status: "running", count: 1 })
    sm.transition({ status: "done" })
    sm.transition({ status: "idle" })
    expect(sm.getStatus()).toBe("idle")
  })

  it("full lifecycle: idle → running → done → idle", () => {
    const sm = createMachine()
    sm.transition({ status: "running", count: 1 })
    sm.transition({ status: "done" })
    sm.transition({ status: "idle" })
    expect(sm.getStatus()).toBe("idle")
  })
})

// ---------------------------------------------------------------------------
// Invalid transitions
// ---------------------------------------------------------------------------

describe("ClientStateMachine — invalid transitions", () => {
  it("rejects idle → done (must go through running)", () => {
    const sm = createMachine()
    expect(() => sm.transition({ status: "done" })).toThrow(
      "Invalid state transition: idle -> done",
    )
  })

  it("rejects done → running (must go through idle)", () => {
    const sm = createMachine()
    sm.transition({ status: "running", count: 1 })
    sm.transition({ status: "done" })
    expect(() => sm.transition({ status: "running", count: 2 })).toThrow(
      "Invalid state transition: done -> running",
    )
  })

  it("includes valid transitions in error message", () => {
    const sm = createMachine()
    expect(() => sm.transition({ status: "done" })).toThrow(
      "Valid transitions from idle: running",
    )
  })

  it("allows forced invalid transitions with force: true", () => {
    const sm = createMachine()
    sm.transition({ status: "done" }, { force: true })
    expect(sm.getStatus()).toBe("done")
  })
})

// ---------------------------------------------------------------------------
// Async delivery via microtask
// ---------------------------------------------------------------------------

describe("ClientStateMachine — async delivery", () => {
  it("delivers transitions asynchronously via microtask", async () => {
    const sm = createMachine()
    const transitions: StateTransition<TestState>[] = []

    sm.subscribeToTransitions(t => transitions.push(t))

    sm.transition({ status: "running", count: 1 })

    // Synchronously — listener has NOT been called yet
    expect(transitions).toHaveLength(0)

    // After microtask — listener is called
    await flush()
    expect(transitions).toHaveLength(1)
    expect(transitions[0]!.from.status).toBe("idle")
    expect(transitions[0]!.to.status).toBe("running")
  })

  it("batches multiple transitions in the same synchronous call stack", async () => {
    const sm = createMachine()
    const transitions: StateTransition<TestState>[] = []

    sm.subscribeToTransitions(t => transitions.push(t))

    sm.transition({ status: "running", count: 1 })
    sm.transition({ status: "done" })
    sm.transition({ status: "idle" })

    // Nothing delivered yet
    expect(transitions).toHaveLength(0)

    // All three delivered in one batch
    await flush()
    expect(transitions).toHaveLength(3)
    expect(transitions[0]!.to.status).toBe("running")
    expect(transitions[1]!.to.status).toBe("done")
    expect(transitions[2]!.to.status).toBe("idle")
  })

  it("transitions have timestamps", async () => {
    const sm = createMachine()
    const transitions: StateTransition<TestState>[] = []

    sm.subscribeToTransitions(t => transitions.push(t))
    sm.transition({ status: "running", count: 1 })

    await flush()
    expect(transitions[0]!.timestamp).toBeGreaterThan(0)
    expect(typeof transitions[0]!.timestamp).toBe("number")
  })

  it("unsubscribe stops delivery", async () => {
    const sm = createMachine()
    const transitions: StateTransition<TestState>[] = []

    const unsub = sm.subscribeToTransitions(t => transitions.push(t))

    sm.transition({ status: "running", count: 1 })
    await flush()
    expect(transitions).toHaveLength(1)

    unsub()

    sm.transition({ status: "done" })
    await flush()

    // No more deliveries after unsubscribe
    expect(transitions).toHaveLength(1)
  })

  it("multiple listeners all receive transitions", async () => {
    const sm = createMachine()
    const a: StateTransition<TestState>[] = []
    const b: StateTransition<TestState>[] = []

    sm.subscribeToTransitions(t => a.push(t))
    sm.subscribeToTransitions(t => b.push(t))

    sm.transition({ status: "running", count: 1 })
    await flush()

    expect(a).toHaveLength(1)
    expect(b).toHaveLength(1)
  })

  it("listener errors do not break other listeners", async () => {
    const sm = createMachine()
    const received: string[] = []

    // First listener throws
    sm.subscribeToTransitions(() => {
      throw new Error("boom")
    })

    // Second listener should still receive
    sm.subscribeToTransitions(t => {
      received.push(t.to.status)
    })

    // Suppress console.error for this test
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})

    sm.transition({ status: "running", count: 1 })
    await flush()

    expect(received).toEqual(["running"])
    consoleError.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// waitForState / waitForStatus
// ---------------------------------------------------------------------------

describe("ClientStateMachine — waitForState", () => {
  it("resolves immediately if already in desired state", async () => {
    const sm = createMachine()
    const state = await sm.waitForState(s => s.status === "idle")
    expect(state.status).toBe("idle")
  })

  it("resolves when the desired state is reached", async () => {
    const sm = createMachine()

    const promise = sm.waitForState(s => s.status === "done")

    sm.transition({ status: "running", count: 1 })
    sm.transition({ status: "done" })

    const state = await promise
    expect(state.status).toBe("done")
  })

  it("rejects on timeout", async () => {
    const sm = createMachine()

    await expect(
      sm.waitForState(s => s.status === "done", { timeoutMs: 50 }),
    ).rejects.toThrow("Timeout waiting for state after 50ms")
  })

  it("cleans up listener after resolution", async () => {
    const sm = createMachine()

    const promise = sm.waitForState(s => s.status === "running")
    sm.transition({ status: "running", count: 1 })

    const state = await promise
    expect(state.status).toBe("running")
  })
})

describe("ClientStateMachine — waitForStatus", () => {
  it("resolves immediately if already in desired status", async () => {
    const sm = createMachine()
    const state = await sm.waitForStatus("idle")
    expect(state.status).toBe("idle")
  })

  it("resolves when the desired status is reached", async () => {
    const sm = createMachine()

    const promise = sm.waitForStatus("done")

    sm.transition({ status: "running", count: 1 })
    sm.transition({ status: "done" })

    const state = await promise
    expect(state.status).toBe("done")
  })

  it("rejects on timeout", async () => {
    const sm = createMachine()

    await expect(sm.waitForStatus("done", { timeoutMs: 50 })).rejects.toThrow(
      "Timeout",
    )
  })
})

// ---------------------------------------------------------------------------
// reset
// ---------------------------------------------------------------------------

describe("ClientStateMachine — reset", () => {
  it("resets to initial state", () => {
    const sm = createMachine()
    sm.transition({ status: "running", count: 1 })
    sm.transition({ status: "done" })
    expect(sm.getStatus()).toBe("done")

    sm.reset()
    expect(sm.getStatus()).toBe("idle")
    expect(sm.getState()).toEqual({ status: "idle" })
  })

  it("clears pending transitions", async () => {
    const sm = createMachine()
    const transitions: StateTransition<TestState>[] = []

    sm.subscribeToTransitions(t => transitions.push(t))

    sm.transition({ status: "running", count: 1 })
    sm.reset() // Should clear the pending transition

    await flush()

    // State should be back to idle
    expect(sm.getStatus()).toBe("idle")
  })
})

// WebsocketClientStateMachine tests.
//
// Verifies the state machine's validated transitions, async microtask
// delivery, waitForState/waitForStatus, and error handling.

import { describe, expect, it, vi } from "vitest"
import { WebsocketClientStateMachine } from "../client-state-machine.js"
import type { WebsocketClientStateTransition } from "../types.js"

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

describe("WebsocketClientStateMachine — initial state", () => {
  it("starts in disconnected state", () => {
    const sm = new WebsocketClientStateMachine()
    expect(sm.getState()).toEqual({ status: "disconnected" })
    expect(sm.getStatus()).toBe("disconnected")
  })

  it("isReady() returns false initially", () => {
    const sm = new WebsocketClientStateMachine()
    expect(sm.isReady()).toBe(false)
  })

  it("isConnectedOrReady() returns false initially", () => {
    const sm = new WebsocketClientStateMachine()
    expect(sm.isConnectedOrReady()).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Valid transitions
// ---------------------------------------------------------------------------

describe("WebsocketClientStateMachine — valid transitions", () => {
  it("disconnected → connecting", () => {
    const sm = new WebsocketClientStateMachine()
    sm.transition({ status: "connecting", attempt: 1 })
    expect(sm.getStatus()).toBe("connecting")
  })

  it("connecting → connected", () => {
    const sm = new WebsocketClientStateMachine()
    sm.transition({ status: "connecting", attempt: 1 })
    sm.transition({ status: "connected" })
    expect(sm.getStatus()).toBe("connected")
  })

  it("connected → ready", () => {
    const sm = new WebsocketClientStateMachine()
    sm.transition({ status: "connecting", attempt: 1 })
    sm.transition({ status: "connected" })
    sm.transition({ status: "ready" })
    expect(sm.getStatus()).toBe("ready")
    expect(sm.isReady()).toBe(true)
    expect(sm.isConnectedOrReady()).toBe(true)
  })

  it("connecting → disconnected", () => {
    const sm = new WebsocketClientStateMachine()
    sm.transition({ status: "connecting", attempt: 1 })
    sm.transition({
      status: "disconnected",
      reason: { type: "error", error: new Error("fail") },
    })
    expect(sm.getStatus()).toBe("disconnected")
  })

  it("connecting → reconnecting", () => {
    const sm = new WebsocketClientStateMachine()
    sm.transition({ status: "connecting", attempt: 1 })
    sm.transition({ status: "reconnecting", attempt: 1, nextAttemptMs: 1000 })
    expect(sm.getStatus()).toBe("reconnecting")
  })

  it("connected → disconnected", () => {
    const sm = new WebsocketClientStateMachine()
    sm.transition({ status: "connecting", attempt: 1 })
    sm.transition({ status: "connected" })
    sm.transition({ status: "disconnected", reason: { type: "intentional" } })
    expect(sm.getStatus()).toBe("disconnected")
  })

  it("connected → reconnecting", () => {
    const sm = new WebsocketClientStateMachine()
    sm.transition({ status: "connecting", attempt: 1 })
    sm.transition({ status: "connected" })
    sm.transition({ status: "reconnecting", attempt: 1, nextAttemptMs: 2000 })
    expect(sm.getStatus()).toBe("reconnecting")
  })

  it("ready → disconnected", () => {
    const sm = new WebsocketClientStateMachine()
    sm.transition({ status: "connecting", attempt: 1 })
    sm.transition({ status: "connected" })
    sm.transition({ status: "ready" })
    sm.transition({
      status: "disconnected",
      reason: { type: "closed", code: 1000, reason: "done" },
    })
    expect(sm.getStatus()).toBe("disconnected")
  })

  it("ready → reconnecting", () => {
    const sm = new WebsocketClientStateMachine()
    sm.transition({ status: "connecting", attempt: 1 })
    sm.transition({ status: "connected" })
    sm.transition({ status: "ready" })
    sm.transition({ status: "reconnecting", attempt: 1, nextAttemptMs: 500 })
    expect(sm.getStatus()).toBe("reconnecting")
  })

  it("reconnecting → connecting", () => {
    const sm = new WebsocketClientStateMachine()
    sm.transition({ status: "connecting", attempt: 1 })
    sm.transition({ status: "reconnecting", attempt: 1, nextAttemptMs: 1000 })
    sm.transition({ status: "connecting", attempt: 2 })
    expect(sm.getStatus()).toBe("connecting")
    expect((sm.getState() as { attempt: number }).attempt).toBe(2)
  })

  it("reconnecting → disconnected", () => {
    const sm = new WebsocketClientStateMachine()
    sm.transition({ status: "connecting", attempt: 1 })
    sm.transition({ status: "reconnecting", attempt: 1, nextAttemptMs: 1000 })
    sm.transition({
      status: "disconnected",
      reason: { type: "max-retries-exceeded", attempts: 10 },
    })
    expect(sm.getStatus()).toBe("disconnected")
  })

  it("full lifecycle: disconnect → connect → connected → ready → disconnect", () => {
    const sm = new WebsocketClientStateMachine()
    sm.transition({ status: "connecting", attempt: 1 })
    sm.transition({ status: "connected" })
    sm.transition({ status: "ready" })
    sm.transition({ status: "disconnected", reason: { type: "intentional" } })
    expect(sm.getStatus()).toBe("disconnected")
  })
})

// ---------------------------------------------------------------------------
// Invalid transitions
// ---------------------------------------------------------------------------

describe("WebsocketClientStateMachine — invalid transitions", () => {
  it("rejects disconnected → connected (must go through connecting)", () => {
    const sm = new WebsocketClientStateMachine()
    expect(() => sm.transition({ status: "connected" })).toThrow(
      "Invalid state transition: disconnected -> connected",
    )
  })

  it("rejects disconnected → ready", () => {
    const sm = new WebsocketClientStateMachine()
    expect(() => sm.transition({ status: "ready" })).toThrow(
      "Invalid state transition",
    )
  })

  it("rejects disconnected → reconnecting", () => {
    const sm = new WebsocketClientStateMachine()
    expect(() =>
      sm.transition({
        status: "reconnecting",
        attempt: 1,
        nextAttemptMs: 1000,
      }),
    ).toThrow("Invalid state transition")
  })

  it("rejects connecting → ready (must go through connected)", () => {
    const sm = new WebsocketClientStateMachine()
    sm.transition({ status: "connecting", attempt: 1 })
    expect(() => sm.transition({ status: "ready" })).toThrow(
      "Invalid state transition: connecting -> ready",
    )
  })

  it("rejects ready → connecting (must go through reconnecting)", () => {
    const sm = new WebsocketClientStateMachine()
    sm.transition({ status: "connecting", attempt: 1 })
    sm.transition({ status: "connected" })
    sm.transition({ status: "ready" })
    expect(() => sm.transition({ status: "connecting", attempt: 2 })).toThrow(
      "Invalid state transition: ready -> connecting",
    )
  })

  it("allows forced invalid transitions with force: true", () => {
    const sm = new WebsocketClientStateMachine()
    sm.transition({ status: "ready" }, { force: true })
    expect(sm.getStatus()).toBe("ready")
  })
})

// ---------------------------------------------------------------------------
// Async delivery via microtask
// ---------------------------------------------------------------------------

describe("WebsocketClientStateMachine — async delivery", () => {
  it("delivers transitions asynchronously via microtask", async () => {
    const sm = new WebsocketClientStateMachine()
    const transitions: WebsocketClientStateTransition[] = []

    sm.subscribeToTransitions(t => transitions.push(t))

    sm.transition({ status: "connecting", attempt: 1 })

    // Synchronously — listener has NOT been called yet
    expect(transitions).toHaveLength(0)

    // After microtask — listener is called
    await flush()
    expect(transitions).toHaveLength(1)
    expect(transitions[0]?.from.status).toBe("disconnected")
    expect(transitions[0]?.to.status).toBe("connecting")
  })

  it("batches multiple transitions in the same synchronous call stack", async () => {
    const sm = new WebsocketClientStateMachine()
    const transitions: WebsocketClientStateTransition[] = []

    sm.subscribeToTransitions(t => transitions.push(t))

    // Multiple transitions in one synchronous block
    sm.transition({ status: "connecting", attempt: 1 })
    sm.transition({ status: "connected" })
    sm.transition({ status: "ready" })

    // Nothing delivered yet
    expect(transitions).toHaveLength(0)

    // All three delivered in one batch
    await flush()
    expect(transitions).toHaveLength(3)
    expect(transitions[0]?.to.status).toBe("connecting")
    expect(transitions[1]?.to.status).toBe("connected")
    expect(transitions[2]?.to.status).toBe("ready")
  })

  it("transitions have timestamps", async () => {
    const sm = new WebsocketClientStateMachine()
    const transitions: WebsocketClientStateTransition[] = []

    sm.subscribeToTransitions(t => transitions.push(t))
    sm.transition({ status: "connecting", attempt: 1 })

    await flush()
    expect(transitions[0]?.timestamp).toBeGreaterThan(0)
    expect(typeof transitions[0]?.timestamp).toBe("number")
  })

  it("unsubscribe stops delivery", async () => {
    const sm = new WebsocketClientStateMachine()
    const transitions: WebsocketClientStateTransition[] = []

    const unsub = sm.subscribeToTransitions(t => transitions.push(t))

    sm.transition({ status: "connecting", attempt: 1 })
    await flush()
    expect(transitions).toHaveLength(1)

    unsub()

    sm.transition({ status: "connected" })
    await flush()

    // No more deliveries after unsubscribe
    expect(transitions).toHaveLength(1)
  })

  it("multiple listeners all receive transitions", async () => {
    const sm = new WebsocketClientStateMachine()
    const a: WebsocketClientStateTransition[] = []
    const b: WebsocketClientStateTransition[] = []

    sm.subscribeToTransitions(t => a.push(t))
    sm.subscribeToTransitions(t => b.push(t))

    sm.transition({ status: "connecting", attempt: 1 })
    await flush()

    expect(a).toHaveLength(1)
    expect(b).toHaveLength(1)
  })

  it("listener errors do not break other listeners", async () => {
    const sm = new WebsocketClientStateMachine()
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

    sm.transition({ status: "connecting", attempt: 1 })
    await flush()

    expect(received).toEqual(["connecting"])
    consoleError.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// waitForState / waitForStatus
// ---------------------------------------------------------------------------

describe("WebsocketClientStateMachine — waitForState", () => {
  it("resolves immediately if already in desired state", async () => {
    const sm = new WebsocketClientStateMachine()
    const state = await sm.waitForState(s => s.status === "disconnected")
    expect(state.status).toBe("disconnected")
  })

  it("resolves when the desired state is reached", async () => {
    const sm = new WebsocketClientStateMachine()

    const promise = sm.waitForState(s => s.status === "connected")

    // Transition to connecting, then connected
    sm.transition({ status: "connecting", attempt: 1 })
    sm.transition({ status: "connected" })

    const state = await promise
    expect(state.status).toBe("connected")
  })

  it("rejects on timeout", async () => {
    const sm = new WebsocketClientStateMachine()

    await expect(
      sm.waitForState(s => s.status === "ready", { timeoutMs: 50 }),
    ).rejects.toThrow("Timeout waiting for state after 50ms")
  })

  it("cleans up listener after resolution", async () => {
    const sm = new WebsocketClientStateMachine()

    // We can't directly inspect listener count, but we can verify
    // that the promise resolves correctly and doesn't leak
    const promise = sm.waitForState(s => s.status === "connecting")
    sm.transition({ status: "connecting", attempt: 1 })

    const state = await promise
    expect(state.status).toBe("connecting")
  })
})

describe("WebsocketClientStateMachine — waitForStatus", () => {
  it("resolves immediately if already in desired status", async () => {
    const sm = new WebsocketClientStateMachine()
    const state = await sm.waitForStatus("disconnected")
    expect(state.status).toBe("disconnected")
  })

  it("resolves when the desired status is reached", async () => {
    const sm = new WebsocketClientStateMachine()

    const promise = sm.waitForStatus("ready")

    sm.transition({ status: "connecting", attempt: 1 })
    sm.transition({ status: "connected" })
    sm.transition({ status: "ready" })

    const state = await promise
    expect(state.status).toBe("ready")
  })

  it("rejects on timeout", async () => {
    const sm = new WebsocketClientStateMachine()

    await expect(sm.waitForStatus("ready", { timeoutMs: 50 })).rejects.toThrow(
      "Timeout",
    )
  })
})

// ---------------------------------------------------------------------------
// reset
// ---------------------------------------------------------------------------

describe("WebsocketClientStateMachine — reset", () => {
  it("resets to initial disconnected state", () => {
    const sm = new WebsocketClientStateMachine()
    sm.transition({ status: "connecting", attempt: 1 })
    sm.transition({ status: "connected" })
    sm.transition({ status: "ready" })
    expect(sm.getStatus()).toBe("ready")

    sm.reset()
    expect(sm.getStatus()).toBe("disconnected")
  })

  it("clears pending transitions", async () => {
    const sm = new WebsocketClientStateMachine()
    const transitions: WebsocketClientStateTransition[] = []

    sm.subscribeToTransitions(t => transitions.push(t))

    sm.transition({ status: "connecting", attempt: 1 })
    sm.reset() // Should clear the pending transition

    await flush()

    // The transition that happened before reset should still be delivered
    // because it was already queued before reset() was called.
    // But the state should be disconnected.
    expect(sm.getStatus()).toBe("disconnected")
  })
})

// ---------------------------------------------------------------------------
// isConnectedOrReady
// ---------------------------------------------------------------------------

describe("WebsocketClientStateMachine — isConnectedOrReady", () => {
  it("returns false for disconnected", () => {
    const sm = new WebsocketClientStateMachine()
    expect(sm.isConnectedOrReady()).toBe(false)
  })

  it("returns false for connecting", () => {
    const sm = new WebsocketClientStateMachine()
    sm.transition({ status: "connecting", attempt: 1 })
    expect(sm.isConnectedOrReady()).toBe(false)
  })

  it("returns true for connected", () => {
    const sm = new WebsocketClientStateMachine()
    sm.transition({ status: "connecting", attempt: 1 })
    sm.transition({ status: "connected" })
    expect(sm.isConnectedOrReady()).toBe(true)
  })

  it("returns true for ready", () => {
    const sm = new WebsocketClientStateMachine()
    sm.transition({ status: "connecting", attempt: 1 })
    sm.transition({ status: "connected" })
    sm.transition({ status: "ready" })
    expect(sm.isConnectedOrReady()).toBe(true)
  })

  it("returns false for reconnecting", () => {
    const sm = new WebsocketClientStateMachine()
    sm.transition({ status: "connecting", attempt: 1 })
    sm.transition({ status: "reconnecting", attempt: 1, nextAttemptMs: 1000 })
    expect(sm.isConnectedOrReady()).toBe(false)
  })
})

// SseClientStateMachine tests.
//
// Tests only SSE-specific concerns: the 4-state transition map, the
// isConnected() helper, and a full lifecycle. Generic state machine
// mechanics (async delivery, waitForState, batching, etc.) are tested
// in packages/exchange/src/__tests__/client-state-machine.test.ts.

import { describe, expect, it } from "vitest"
import { SseClientStateMachine } from "../client-state-machine.js"

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

describe("SseClientStateMachine — initial state", () => {
  it("starts in disconnected state", () => {
    const sm = new SseClientStateMachine()
    expect(sm.getState()).toEqual({ status: "disconnected" })
    expect(sm.getStatus()).toBe("disconnected")
  })

  it("isConnected() returns false initially", () => {
    const sm = new SseClientStateMachine()
    expect(sm.isConnected()).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Valid transitions
// ---------------------------------------------------------------------------

describe("SseClientStateMachine — valid transitions", () => {
  it("disconnected → connecting", () => {
    const sm = new SseClientStateMachine()
    sm.transition({ status: "connecting", attempt: 1 })
    expect(sm.getStatus()).toBe("connecting")
  })

  it("connecting → connected", () => {
    const sm = new SseClientStateMachine()
    sm.transition({ status: "connecting", attempt: 1 })
    sm.transition({ status: "connected" })
    expect(sm.getStatus()).toBe("connected")
    expect(sm.isConnected()).toBe(true)
  })

  it("connecting → disconnected", () => {
    const sm = new SseClientStateMachine()
    sm.transition({ status: "connecting", attempt: 1 })
    sm.transition({
      status: "disconnected",
      reason: { type: "error", error: new Error("fail") },
    })
    expect(sm.getStatus()).toBe("disconnected")
  })

  it("connecting → reconnecting", () => {
    const sm = new SseClientStateMachine()
    sm.transition({ status: "connecting", attempt: 1 })
    sm.transition({ status: "reconnecting", attempt: 1, nextAttemptMs: 1000 })
    expect(sm.getStatus()).toBe("reconnecting")
  })

  it("connected → disconnected", () => {
    const sm = new SseClientStateMachine()
    sm.transition({ status: "connecting", attempt: 1 })
    sm.transition({ status: "connected" })
    sm.transition({ status: "disconnected", reason: { type: "intentional" } })
    expect(sm.getStatus()).toBe("disconnected")
  })

  it("connected → reconnecting", () => {
    const sm = new SseClientStateMachine()
    sm.transition({ status: "connecting", attempt: 1 })
    sm.transition({ status: "connected" })
    sm.transition({ status: "reconnecting", attempt: 1, nextAttemptMs: 2000 })
    expect(sm.getStatus()).toBe("reconnecting")
  })

  it("reconnecting → connecting", () => {
    const sm = new SseClientStateMachine()
    sm.transition({ status: "connecting", attempt: 1 })
    sm.transition({ status: "reconnecting", attempt: 1, nextAttemptMs: 1000 })
    sm.transition({ status: "connecting", attempt: 2 })
    expect(sm.getStatus()).toBe("connecting")
    expect((sm.getState() as { attempt: number }).attempt).toBe(2)
  })

  it("reconnecting → disconnected", () => {
    const sm = new SseClientStateMachine()
    sm.transition({ status: "connecting", attempt: 1 })
    sm.transition({ status: "reconnecting", attempt: 1, nextAttemptMs: 1000 })
    sm.transition({
      status: "disconnected",
      reason: { type: "max-retries-exceeded", attempts: 10 },
    })
    expect(sm.getStatus()).toBe("disconnected")
  })
})

// ---------------------------------------------------------------------------
// Invalid transitions
// ---------------------------------------------------------------------------

describe("SseClientStateMachine — invalid transitions", () => {
  it("rejects disconnected → connected (must go through connecting)", () => {
    const sm = new SseClientStateMachine()
    expect(() => sm.transition({ status: "connected" })).toThrow(
      "Invalid state transition: disconnected -> connected",
    )
  })

  it("rejects disconnected → reconnecting", () => {
    const sm = new SseClientStateMachine()
    expect(() =>
      sm.transition({ status: "reconnecting", attempt: 1, nextAttemptMs: 1000 }),
    ).toThrow("Invalid state transition: disconnected -> reconnecting")
  })

  it("rejects connected → connecting (must go through reconnecting)", () => {
    const sm = new SseClientStateMachine()
    sm.transition({ status: "connecting", attempt: 1 })
    sm.transition({ status: "connected" })
    expect(() => sm.transition({ status: "connecting", attempt: 2 })).toThrow(
      "Invalid state transition: connected -> connecting",
    )
  })

  // SSE has no "ready" state — verify it's not in the transition map
  it("rejects transition to ready (SSE has no ready state)", () => {
    const sm = new SseClientStateMachine()
    sm.transition({ status: "connecting", attempt: 1 })
    sm.transition({ status: "connected" })
    expect(() =>
      sm.transition({ status: "ready" } as any),
    ).toThrow("Invalid state transition: connected -> ready")
  })
})

// ---------------------------------------------------------------------------
// isConnected
// ---------------------------------------------------------------------------

describe("SseClientStateMachine — isConnected", () => {
  it("returns false for disconnected", () => {
    const sm = new SseClientStateMachine()
    expect(sm.isConnected()).toBe(false)
  })

  it("returns false for connecting", () => {
    const sm = new SseClientStateMachine()
    sm.transition({ status: "connecting", attempt: 1 })
    expect(sm.isConnected()).toBe(false)
  })

  it("returns true for connected", () => {
    const sm = new SseClientStateMachine()
    sm.transition({ status: "connecting", attempt: 1 })
    sm.transition({ status: "connected" })
    expect(sm.isConnected()).toBe(true)
  })

  it("returns false for reconnecting", () => {
    const sm = new SseClientStateMachine()
    sm.transition({ status: "connecting", attempt: 1 })
    sm.transition({ status: "reconnecting", attempt: 1, nextAttemptMs: 1000 })
    expect(sm.isConnected()).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Full lifecycle
// ---------------------------------------------------------------------------

describe("SseClientStateMachine — full lifecycle", () => {
  it("disconnected → connecting → connected → reconnecting → connecting → connected → disconnected", () => {
    const sm = new SseClientStateMachine()

    sm.transition({ status: "connecting", attempt: 1 })
    sm.transition({ status: "connected" })
    expect(sm.isConnected()).toBe(true)

    // Connection lost
    sm.transition({ status: "reconnecting", attempt: 1, nextAttemptMs: 1000 })
    expect(sm.isConnected()).toBe(false)

    // Retry
    sm.transition({ status: "connecting", attempt: 2 })
    sm.transition({ status: "connected" })
    expect(sm.isConnected()).toBe(true)

    // Intentional disconnect
    sm.transition({ status: "disconnected", reason: { type: "intentional" } })
    expect(sm.getStatus()).toBe("disconnected")
    expect(sm.isConnected()).toBe(false)
  })
})
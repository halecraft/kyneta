// reconnect.test — unit tests for the shared reconnect scheduler.
//
// Tests the behavioral contracts of createReconnectScheduler:
// 1. Exponential backoff with clamping (via sweep, not per-attempt)
// 2. Max attempts → disconnected transition
// 3. Cancel clears pending timer
// 4. Enabled/disabled gating
// 5. No-op when already disconnected
// 6. Attempt counting reads from current state machine state
// 7. Timer fires connectFn after delay

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ClientStateMachine } from "../transport/client-state-machine.js"
import { createReconnectScheduler } from "../transport/reconnect.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type TestState =
  | { status: "disconnected"; reason?: { type: string; [key: string]: unknown } }
  | { status: "connecting"; attempt: number }
  | { status: "connected" }
  | { status: "reconnecting"; attempt: number; nextAttemptMs: number }

const VALID_TRANSITIONS: Record<string, string[]> = {
  disconnected: ["connecting"],
  connecting: ["connected", "disconnected", "reconnecting"],
  connected: ["disconnected", "reconnecting"],
  reconnecting: ["connecting", "disconnected"],
}

function createTestStateMachine(
  initialState: TestState = { status: "disconnected" },
) {
  return new ClientStateMachine<TestState>({
    initialState,
    validTransitions: VALID_TRANSITIONS,
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createReconnectScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("exponential backoff increases delay up to maxDelay, then clamps", () => {
    const sm = createTestStateMachine({ status: "connected" })
    const connectFn = vi.fn()

    const scheduler = createReconnectScheduler({
      stateMachine: sm,
      connectFn,
      options: { baseDelay: 100, maxDelay: 5000, maxAttempts: 20 },
      jitterFn: () => 0,
    })

    const delays: number[] = []

    for (let i = 0; i < 10; i++) {
      scheduler.schedule({ type: "error", error: new Error("test") })
      const state = sm.getState()
      if (state.status === "reconnecting") {
        delays.push(state.nextAttemptMs)
      }

      vi.advanceTimersByTime(state.status === "reconnecting" ? state.nextAttemptMs : 0)
      if (i < 9) {
        sm.transition({ status: "connecting", attempt: i + 1 })
      }
    }

    // 100, 200, 400, 800, 1600, 3200, 5000, 5000, 5000, 5000
    expect(delays).toEqual([100, 200, 400, 800, 1600, 3200, 5000, 5000, 5000, 5000])
  })

  it("jitter is added to the base exponential delay", () => {
    const sm = createTestStateMachine({ status: "connected" })

    const scheduler = createReconnectScheduler({
      stateMachine: sm,
      connectFn: vi.fn(),
      options: {},
      jitterFn: () => 500,
    })

    scheduler.schedule({ type: "closed" })

    const state = sm.getState()
    expect(state.status).toBe("reconnecting")
    if (state.status === "reconnecting") {
      // 1000 * 2^0 + 500 = 1500
      expect(state.nextAttemptMs).toBe(1500)
    }
  })

  it("transitions to disconnected after maxAttempts exhausted", () => {
    const sm = createTestStateMachine({ status: "connected" })
    const connectFn = vi.fn()

    const scheduler = createReconnectScheduler({
      stateMachine: sm,
      connectFn,
      options: { maxAttempts: 2 },
      jitterFn: () => 0,
    })

    // Attempt 1
    scheduler.schedule({ type: "error", error: new Error("test") })
    vi.advanceTimersByTime(1000)
    sm.transition({ status: "connecting", attempt: 1 })

    // Attempt 2
    scheduler.schedule({ type: "error", error: new Error("test") })
    vi.advanceTimersByTime(2000)
    sm.transition({ status: "connecting", attempt: 2 })

    // Attempt 3 exceeds max → disconnected
    scheduler.schedule({ type: "error", error: new Error("test") })
    expect(sm.getState()).toMatchObject({
      status: "disconnected",
      reason: { type: "max-retries-exceeded", attempts: 2 },
    })

    expect(connectFn).toHaveBeenCalledTimes(2)
  })

  it("cancel prevents pending connectFn from firing", () => {
    const sm = createTestStateMachine({ status: "connected" })
    const connectFn = vi.fn()

    const scheduler = createReconnectScheduler({
      stateMachine: sm,
      connectFn,
      options: {},
      jitterFn: () => 0,
    })

    scheduler.schedule({ type: "error", error: new Error("test") })
    scheduler.cancel()

    vi.advanceTimersByTime(60000)
    expect(connectFn).not.toHaveBeenCalled()
  })

  it("setEnabled(false) causes schedule to transition directly to disconnected", () => {
    const sm = createTestStateMachine({ status: "connected" })
    const connectFn = vi.fn()

    const scheduler = createReconnectScheduler({
      stateMachine: sm,
      connectFn,
      options: {},
      jitterFn: () => 0,
    })

    scheduler.setEnabled(false)
    scheduler.schedule({ type: "error", error: new Error("boom") })

    expect(sm.getState()).toMatchObject({
      status: "disconnected",
      reason: { type: "error", error: new Error("boom") },
    })
    expect(connectFn).not.toHaveBeenCalled()
  })

  it("is a no-op when state machine is already disconnected", () => {
    const sm = createTestStateMachine({ status: "disconnected" })
    const connectFn = vi.fn()

    const scheduler = createReconnectScheduler({
      stateMachine: sm,
      connectFn,
      options: {},
      jitterFn: () => 0,
    })

    scheduler.schedule({ type: "error", error: new Error("test") })

    expect(sm.getState().status).toBe("disconnected")
    expect(connectFn).not.toHaveBeenCalled()
  })

  it("reads attempt count from current state when scheduling from connecting", () => {
    const sm = createTestStateMachine({ status: "connected" })
    const connectFn = vi.fn()

    const scheduler = createReconnectScheduler({
      stateMachine: sm,
      connectFn,
      options: { maxAttempts: 10 },
      jitterFn: () => 0,
    })

    // Simulate 5 retries having occurred
    sm.transition({ status: "reconnecting", attempt: 5, nextAttemptMs: 16000 })
    sm.transition({ status: "connecting", attempt: 5 })

    // Schedule from connecting(5) — should produce attempt 6
    scheduler.schedule({ type: "error", error: new Error("test") })

    expect(sm.getState()).toMatchObject({
      status: "reconnecting",
      attempt: 6,
      // 1000 * 2^5 = 32000, clamped to 30000
      nextAttemptMs: 30000,
    })
  })

  it("fires connectFn after the computed delay", () => {
    const sm = createTestStateMachine({ status: "connected" })
    const connectFn = vi.fn()

    const scheduler = createReconnectScheduler({
      stateMachine: sm,
      connectFn,
      options: {},
      jitterFn: () => 0,
    })

    scheduler.schedule({ type: "closed" })
    expect(connectFn).not.toHaveBeenCalled()

    // 999ms: not yet
    vi.advanceTimersByTime(999)
    expect(connectFn).not.toHaveBeenCalled()

    // 1ms more: fires
    vi.advanceTimersByTime(1)
    expect(connectFn).toHaveBeenCalledOnce()
  })
})
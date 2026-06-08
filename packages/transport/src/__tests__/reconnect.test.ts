// reconnect — pure-function tests for backoff math and the reconnect
// decision function.

import { describe, expect, it } from "vitest"
import {
  computeBackoffDelay,
  type ReconnectOptions,
  shouldReconnect,
} from "../reconnect.js"

// ---------------------------------------------------------------------------
// computeBackoffDelay — proportional jitter
// ---------------------------------------------------------------------------

describe("computeBackoffDelay", () => {
  it("random=0 produces exact exponential delays", () => {
    expect(computeBackoffDelay(1, 1000, 30000, 0)).toBe(1000)
    expect(computeBackoffDelay(2, 1000, 30000, 0)).toBe(2000)
    expect(computeBackoffDelay(3, 1000, 30000, 0)).toBe(4000)
    expect(computeBackoffDelay(4, 1000, 30000, 0)).toBe(8000)
  })

  it("random=0.5 produces rawDelay × 1.1 (midpoint of 0–20% jitter)", () => {
    expect(computeBackoffDelay(1, 1000, 30000, 0.5)).toBe(1100)
    expect(computeBackoffDelay(2, 1000, 30000, 0.5)).toBe(2200)
    expect(computeBackoffDelay(3, 1000, 30000, 0.5)).toBe(4400)
  })

  it("random=1 produces rawDelay × 1.2 (upper bound of 20% jitter)", () => {
    // Math.random() never returns 1.0, but the math should still work for the boundary.
    expect(computeBackoffDelay(1, 1000, 30000, 1)).toBe(1200)
    expect(computeBackoffDelay(2, 1000, 30000, 1)).toBe(2400)
    expect(computeBackoffDelay(3, 1000, 30000, 1)).toBe(4800)
  })

  it("clamps to maxDelay after jitter application", () => {
    // attempt=10, baseDelay=1000: raw = 1000 × 2^9 = 512000
    // with random=0.5: jittered = 512000 × 1.1 = 563200, clamped to 30000
    expect(computeBackoffDelay(10, 1000, 30000, 0.5)).toBe(30000)
    // attempt=6, baseDelay=1000: raw = 32000
    // with random=0, jittered = 32000, clamped to 30000
    expect(computeBackoffDelay(6, 1000, 30000, 0)).toBe(30000)
    // attempt=5, baseDelay=1000: raw = 16000
    // with random=1, jittered = 19200, well below 30000 — no clamp
    expect(computeBackoffDelay(5, 1000, 30000, 1)).toBe(19200)
  })

  it("additive default is unchanged when fullJitter is passed as false", () => {
    // Regression guard: the opt-in must not alter the default path.
    expect(computeBackoffDelay(1, 1000, 30000, 0, false)).toBe(1000)
    expect(computeBackoffDelay(2, 1000, 30000, 0.5, false)).toBe(2200)
    expect(computeBackoffDelay(10, 1000, 30000, 0.5, false)).toBe(30000)
  })
})

// ---------------------------------------------------------------------------
// computeBackoffDelay — full jitter (opt-in)
// ---------------------------------------------------------------------------

describe("computeBackoffDelay — fullJitter", () => {
  it("random=0 produces 0 (the whole point — spread can start at zero)", () => {
    expect(computeBackoffDelay(1, 1000, 30000, 0, true)).toBe(0)
    expect(computeBackoffDelay(4, 1000, 30000, 0, true)).toBe(0)
  })

  it("delay is random × min(raw, maxDelay), so always < cap and >= 0", () => {
    // attempt=3: raw = 4000 (below cap). random=0.5 → 2000.
    expect(computeBackoffDelay(3, 1000, 30000, 0.5, true)).toBe(2000)
    // attempt=1: raw = 1000. random=0.99 → 990 (< baseDelay — intended).
    expect(computeBackoffDelay(1, 1000, 30000, 0.99, true)).toBeCloseTo(990)
  })

  it("caps the raw delay before jitter so the spread never exceeds maxDelay", () => {
    // attempt=10: raw = 512000, capped to 30000. random=1 → 30000.
    expect(computeBackoffDelay(10, 1000, 30000, 1, true)).toBe(30000)
    // random just below 1 stays under the cap.
    expect(computeBackoffDelay(10, 1000, 30000, 0.5, true)).toBe(15000)
  })
})

// ---------------------------------------------------------------------------
// shouldReconnect — decision branches
// ---------------------------------------------------------------------------

describe("shouldReconnect", () => {
  const baseOpts: ReconnectOptions = {
    enabled: true,
    maxAttempts: 10,
    baseDelay: 1000,
    maxDelay: 30000,
    fullJitter: false,
  }

  it("returns { reconnect: false, cause: 'disabled' } when not enabled", () => {
    const opts: ReconnectOptions = { ...baseOpts, enabled: false }
    expect(shouldReconnect(opts, 0, () => 0)).toEqual({
      reconnect: false,
      cause: "disabled",
    })
    // currentAttempt is irrelevant when disabled — still disabled at the cap.
    expect(shouldReconnect(opts, 5, () => 0)).toEqual({
      reconnect: false,
      cause: "disabled",
    })
  })

  it("returns max-attempts-exceeded with the attempt count when capped", () => {
    expect(shouldReconnect(baseOpts, 10, () => 0)).toEqual({
      reconnect: false,
      cause: "max-attempts-exceeded",
      attempts: 10,
    })
    expect(shouldReconnect(baseOpts, 12, () => 0)).toEqual({
      reconnect: false,
      cause: "max-attempts-exceeded",
      attempts: 12,
    })
  })

  it("returns reconnect: true with attempt+1 and computed delay in the normal branch", () => {
    expect(shouldReconnect(baseOpts, 0, () => 0)).toEqual({
      reconnect: true,
      attempt: 1,
      delayMs: 1000,
    })
    expect(shouldReconnect(baseOpts, 1, () => 0)).toEqual({
      reconnect: true,
      attempt: 2,
      delayMs: 2000,
    })
    expect(shouldReconnect(baseOpts, 2, () => 0)).toEqual({
      reconnect: true,
      attempt: 3,
      delayMs: 4000,
    })
  })

  it("threads randomFn output through to the delay calculation", () => {
    // Guards against a future refactor that calls Math.random internally
    // instead of using the injected randomFn — would silently pass with a
    // looser check that only verifies the structure.
    const d = shouldReconnect(baseOpts, 0, () => 0.5)
    expect(d).toEqual({ reconnect: true, attempt: 1, delayMs: 1100 })
  })

  it("threads fullJitter through to the delay calculation", () => {
    const opts: ReconnectOptions = { ...baseOpts, fullJitter: true }
    // attempt=1, random=0.5 → 0.5 × min(1000, 30000) = 500 (additive would be 1100).
    expect(shouldReconnect(opts, 0, () => 0.5)).toEqual({
      reconnect: true,
      attempt: 1,
      delayMs: 500,
    })
  })
})

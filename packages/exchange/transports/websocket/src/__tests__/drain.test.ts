// drain — tests for the pure scheduling core.
//
// No timers, no sockets — `planDrainSchedule` and `resolveDrainOptions` are
// pure, so we assert directly on their return values.

import type { PeerId } from "@kyneta/transport"
import { describe, expect, it } from "vitest"
import {
  DEFAULT_DRAIN,
  planDrainSchedule,
  resolveDrainOptions,
} from "../drain.js"

const peers = (...ids: string[]) => ids as PeerId[]

describe("planDrainSchedule", () => {
  it("empty input → []", () => {
    expect(planDrainSchedule([], 5000, () => 0)).toEqual([])
  })

  it("preserves order and peer IDs", () => {
    const schedule = planDrainSchedule(peers("a", "b", "c"), 1000, () => 0.5)
    expect(schedule.map(s => s.peerId)).toEqual(["a", "b", "c"])
  })

  it("windowMs <= 0 → every step delayMs 0", () => {
    expect(planDrainSchedule(peers("a", "b"), 0, () => 0.9)).toEqual([
      { peerId: "a", delayMs: 0 },
      { peerId: "b", delayMs: 0 },
    ])
    expect(planDrainSchedule(peers("a"), -100, () => 0.9)).toEqual([
      { peerId: "a", delayMs: 0 },
    ])
  })

  it("delays are deterministic and within [0, windowMs) under a pinned randomFn", () => {
    // Cycle distinct random values so each peer gets a different offset.
    const values = [0, 0.25, 0.999]
    let i = 0
    const schedule = planDrainSchedule(
      peers("a", "b", "c"),
      4000,
      () => values[i++ % values.length] ?? 0,
    )
    expect(schedule).toEqual([
      { peerId: "a", delayMs: 0 },
      { peerId: "b", delayMs: 1000 },
      { peerId: "c", delayMs: 3996 },
    ])
    for (const step of schedule) {
      expect(step.delayMs).toBeGreaterThanOrEqual(0)
      expect(step.delayMs).toBeLessThan(4000)
    }
  })
})

describe("resolveDrainOptions", () => {
  it("falls back to DEFAULT_DRAIN when nothing is provided", () => {
    const r = resolveDrainOptions()
    expect(r.windowMs).toBe(DEFAULT_DRAIN.windowMs)
    expect(r.closeCode).toBe(DEFAULT_DRAIN.closeCode)
    expect(r.closeReason).toBe(DEFAULT_DRAIN.closeReason)
    expect(r.deadlineMs).toBe(
      DEFAULT_DRAIN.windowMs + DEFAULT_DRAIN.deadlineGraceMs,
    )
    expect(r.randomFn).toBe(Math.random)
  })

  it("merges per-call over constructor defaults over hard-coded defaults", () => {
    const r = resolveDrainOptions(
      { windowMs: 1000 },
      { windowMs: 8000, closeCode: 1012 },
    )
    expect(r.windowMs).toBe(1000) // per-call wins
    expect(r.closeCode).toBe(1012) // constructor default used
    expect(r.closeReason).toBe(DEFAULT_DRAIN.closeReason) // hard-coded fallback
  })

  it("defaults deadlineMs relative to the resolved windowMs", () => {
    const r = resolveDrainOptions({ windowMs: 2000 })
    expect(r.deadlineMs).toBe(2000 + DEFAULT_DRAIN.deadlineGraceMs)
  })
})

// === Lamport Clock Tests ===
// Tests for Lamport clock: tick monotonicity, merge takes max+1, observe.

import { describe, expect, it } from "vitest"
import {
  createLamportClock,
  createLamportClockAt,
  current,
  merge,
  observe,
  tick,
} from "../../src/kernel/lamport.js"

describe("Lamport Clock", () => {
  // -------------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------------

  describe("createLamportClock", () => {
    it("starts at 0", () => {
      const clock = createLamportClock()
      expect(current(clock)).toBe(0)
    })
  })

  describe("createLamportClockAt", () => {
    it("starts at the given value", () => {
      const clock = createLamportClockAt(42)
      expect(current(clock)).toBe(42)
    })

    it("starts at 0 if given 0", () => {
      const clock = createLamportClockAt(0)
      expect(current(clock)).toBe(0)
    })
  })

  // -------------------------------------------------------------------------
  // Tick
  // -------------------------------------------------------------------------

  describe("tick", () => {
    it("increments the clock by 1", () => {
      const clock = createLamportClock()
      const val = tick(clock)
      expect(val).toBe(1)
      expect(current(clock)).toBe(1)
    })

    it("returns the new value", () => {
      const clock = createLamportClockAt(10)
      const val = tick(clock)
      expect(val).toBe(11)
    })

    it("produces monotonically increasing values", () => {
      const clock = createLamportClock()
      const values: number[] = []
      for (let i = 0; i < 100; i++) {
        values.push(tick(clock))
      }

      // Every value is strictly greater than the previous
      for (let i = 1; i < values.length; i++) {
        expect(values[i]!).toBeGreaterThan(values[i - 1]!)
      }
    })

    it("tick values are sequential (no gaps)", () => {
      const clock = createLamportClock()
      expect(tick(clock)).toBe(1)
      expect(tick(clock)).toBe(2)
      expect(tick(clock)).toBe(3)
      expect(tick(clock)).toBe(4)
      expect(tick(clock)).toBe(5)
    })
  })

  // -------------------------------------------------------------------------
  // Merge
  // -------------------------------------------------------------------------

  describe("merge", () => {
    it("takes max(local, received) + 1 when received > local", () => {
      const clock = createLamportClockAt(3)
      const val = merge(clock, 10)
      expect(val).toBe(11) // max(3, 10) + 1
      expect(current(clock)).toBe(11)
    })

    it("takes max(local, received) + 1 when local > received", () => {
      const clock = createLamportClockAt(10)
      const val = merge(clock, 3)
      expect(val).toBe(11) // max(10, 3) + 1
      expect(current(clock)).toBe(11)
    })

    it("takes max(local, received) + 1 when local === received", () => {
      const clock = createLamportClockAt(5)
      const val = merge(clock, 5)
      expect(val).toBe(6) // max(5, 5) + 1
      expect(current(clock)).toBe(6)
    })

    it("merge with 0 increments by 1 when clock is at 0", () => {
      const clock = createLamportClock()
      const val = merge(clock, 0)
      expect(val).toBe(1) // max(0, 0) + 1
    })

    it("merge always produces a value strictly greater than both local and received", () => {
      const clock = createLamportClockAt(7)
      const received = 12
      const val = merge(clock, received)
      expect(val).toBeGreaterThan(7)
      expect(val).toBeGreaterThan(received)
    })

    it("preserves monotonicity across mixed tick and merge operations", () => {
      const clock = createLamportClock()
      const values: number[] = []

      values.push(tick(clock)) // 1
      values.push(tick(clock)) // 2
      values.push(merge(clock, 100)) // 101 = max(2, 100) + 1
      values.push(tick(clock)) // 102
      values.push(merge(clock, 50)) // 103 = max(102, 50) + 1
      values.push(tick(clock)) // 104

      for (let i = 1; i < values.length; i++) {
        expect(values[i]!).toBeGreaterThan(values[i - 1]!)
      }
    })
  })

  // -------------------------------------------------------------------------
  // Observe
  // -------------------------------------------------------------------------

  describe("observe", () => {
    it("updates to received when received > local", () => {
      const clock = createLamportClockAt(3)
      const val = observe(clock, 10)
      expect(val).toBe(10) // max(3, 10) = 10
      expect(current(clock)).toBe(10)
    })

    it("does not change clock when local > received", () => {
      const clock = createLamportClockAt(10)
      const val = observe(clock, 3)
      expect(val).toBe(10) // max(10, 3) = 10
      expect(current(clock)).toBe(10)
    })

    it("does not change clock when local === received", () => {
      const clock = createLamportClockAt(5)
      const val = observe(clock, 5)
      expect(val).toBe(5) // max(5, 5) = 5
      expect(current(clock)).toBe(5)
    })

    it("does NOT add 1 (unlike merge)", () => {
      const clock = createLamportClockAt(3)
      observe(clock, 10)
      // observe: max(3, 10) = 10 (no +1)
      expect(current(clock)).toBe(10)

      // contrast with merge which would give 11
      const clock2 = createLamportClockAt(3)
      merge(clock2, 10)
      expect(current(clock2)).toBe(11)
    })

    it("subsequent tick after observe continues from observed value", () => {
      const clock = createLamportClock()
      observe(clock, 100)
      const val = tick(clock)
      expect(val).toBe(101)
    })
  })

  // -------------------------------------------------------------------------
  // Current
  // -------------------------------------------------------------------------

  describe("current", () => {
    it("returns the current value without modifying it", () => {
      const clock = createLamportClockAt(42)
      expect(current(clock)).toBe(42)
      expect(current(clock)).toBe(42) // still 42
    })

    it("reflects changes from tick", () => {
      const clock = createLamportClock()
      tick(clock)
      tick(clock)
      expect(current(clock)).toBe(2)
    })

    it("reflects changes from merge", () => {
      const clock = createLamportClock()
      merge(clock, 50)
      expect(current(clock)).toBe(51)
    })
  })

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  describe("edge cases", () => {
    it("handles many rapid ticks", () => {
      const clock = createLamportClock()
      for (let i = 0; i < 10000; i++) {
        tick(clock)
      }
      expect(current(clock)).toBe(10000)
    })

    it("handles alternating tick and merge with increasing values", () => {
      const clock = createLamportClock()
      // Simulate receiving constraints with increasing lamport values
      // interspersed with local operations
      tick(clock) // 1
      merge(clock, 5) // 6
      tick(clock) // 7
      merge(clock, 20) // 21
      tick(clock) // 22
      expect(current(clock)).toBe(22)
    })

    it("two clocks that merge with each other converge to the same max", () => {
      const clockA = createLamportClock()
      const clockB = createLamportClock()

      // A does some work
      tick(clockA) // A=1
      tick(clockA) // A=2

      // B does some work
      tick(clockB) // B=1

      // A sends to B
      merge(clockB, current(clockA)) // B = max(1, 2) + 1 = 3

      // B does work
      tick(clockB) // B=4

      // B sends to A
      merge(clockA, current(clockB)) // A = max(2, 4) + 1 = 5

      expect(current(clockA)).toBe(5)
      expect(current(clockB)).toBe(4)
      // A > B because A merged last
    })
  })
})

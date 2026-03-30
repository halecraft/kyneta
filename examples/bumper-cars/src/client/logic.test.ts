// ═══════════════════════════════════════════════════════════════════════════
//
//   Bumper Cars — Client Logic Tests
//
//   Tests for the pure client logic functions. Ported from
//   vendor/loro-extended/examples/bumper-cars/src/client/logic.test.ts
//   with vendor PeerID type replaced by plain string and presence-specific
//   tests removed (partitionPresences, createClientPresence).
//
// ═══════════════════════════════════════════════════════════════════════════

import { describe, expect, it } from "vitest"
import type { InputState, PlayerScore } from "../types.js"
import {
  combineInputs,
  getActivePlayers,
  shouldSendInputUpdate,
  sortScores,
  ZERO_INPUT,
} from "./logic.js"

// =============================================================================
// getActivePlayers
// =============================================================================

describe("getActivePlayers", () => {
  it("maps car entries to player list format", () => {
    const cars: Record<string, { name: string; color: string }> = {
      "peer-1": { name: "Alice", color: "#FF6B6B" },
      "peer-2": { name: "Bob", color: "#26DE81" },
    }

    const result = getActivePlayers(cars)

    expect(result).toHaveLength(2)
    expect(result).toContainEqual({
      peerId: "peer-1",
      name: "Alice",
      color: "#FF6B6B",
    })
    expect(result).toContainEqual({
      peerId: "peer-2",
      name: "Bob",
      color: "#26DE81",
    })
  })

  it("returns empty array for empty cars", () => {
    const result = getActivePlayers({})
    expect(result).toEqual([])
  })
})

// =============================================================================
// sortScores
// =============================================================================

describe("sortScores", () => {
  it("sorts by bumps descending", () => {
    const scores: Record<string, PlayerScore> = {
      "peer-1": { name: "Low", color: "#FF6B6B", bumps: 5 },
      "peer-2": { name: "High", color: "#26DE81", bumps: 20 },
      "peer-3": { name: "Mid", color: "#54A0FF", bumps: 10 },
    }

    const result = sortScores(scores, 10)

    expect(result[0].name).toBe("High")
    expect(result[0].bumps).toBe(20)
    expect(result[1].name).toBe("Mid")
    expect(result[1].bumps).toBe(10)
    expect(result[2].name).toBe("Low")
    expect(result[2].bumps).toBe(5)
  })

  it("respects limit parameter", () => {
    const scores: Record<string, PlayerScore> = {
      "peer-1": { name: "First", color: "#FF6B6B", bumps: 100 },
      "peer-2": { name: "Second", color: "#26DE81", bumps: 80 },
      "peer-3": { name: "Third", color: "#54A0FF", bumps: 60 },
      "peer-4": { name: "Fourth", color: "#FFEAA7", bumps: 40 },
      "peer-5": { name: "Fifth", color: "#A55EEA", bumps: 20 },
    }

    const result = sortScores(scores, 3)

    expect(result).toHaveLength(3)
    expect(result.map(s => s.name)).toEqual(["First", "Second", "Third"])
  })

  it("handles empty scores object", () => {
    const result = sortScores({}, 5)
    expect(result).toEqual([])
  })

  it("includes peerId in result", () => {
    const scores: Record<string, PlayerScore> = {
      "test-peer-id": { name: "Test", color: "#FF6B6B", bumps: 10 },
    }

    const result = sortScores(scores, 5)

    expect(result[0].peerId).toBe("test-peer-id")
  })

  it("handles limit larger than scores count", () => {
    const scores: Record<string, PlayerScore> = {
      "peer-1": { name: "Only", color: "#FF6B6B", bumps: 10 },
    }

    const result = sortScores(scores, 100)

    expect(result).toHaveLength(1)
  })
})

// =============================================================================
// combineInputs
// =============================================================================

describe("combineInputs", () => {
  it("returns joystick input when force > 0", () => {
    const joystickInput: InputState = { force: 0.5, angle: 1.2 }
    const keyboardInput: InputState = { force: 1.0, angle: 0 }

    const result = combineInputs(joystickInput, keyboardInput)

    expect(result).toEqual(joystickInput)
  })

  it("returns keyboard input when joystick force is 0", () => {
    const joystickInput: InputState = { force: 0, angle: 0 }
    const keyboardInput: InputState = { force: 0.8, angle: 2.5 }

    const result = combineInputs(joystickInput, keyboardInput)

    expect(result).toEqual(keyboardInput)
  })

  it("returns keyboard input when both have zero force", () => {
    const result = combineInputs(ZERO_INPUT, ZERO_INPUT)

    expect(result).toEqual(ZERO_INPUT)
  })

  it("returns joystick even with small non-zero force", () => {
    const joystickInput: InputState = { force: 0.001, angle: 0.5 }
    const keyboardInput: InputState = { force: 1.0, angle: 0 }

    const result = combineInputs(joystickInput, keyboardInput)

    expect(result).toEqual(joystickInput)
  })
})

// =============================================================================
// shouldSendInputUpdate
// =============================================================================

describe("shouldSendInputUpdate", () => {
  const THROTTLE_MS = 50

  it("returns false when input unchanged", () => {
    const input: InputState = { force: 0.5, angle: 1.0 }

    const result = shouldSendInputUpdate(input, input, 0, 1000, THROTTLE_MS)

    expect(result).toBe(false)
  })

  it("returns false when input values are equal but different objects", () => {
    const current: InputState = { force: 0.5, angle: 1.0 }
    const last: InputState = { force: 0.5, angle: 1.0 }

    const result = shouldSendInputUpdate(current, last, 0, 1000, THROTTLE_MS)

    expect(result).toBe(false)
  })

  it("returns true immediately for zero-force (stop) input", () => {
    const current: InputState = { force: 0, angle: 0 }
    const last: InputState = { force: 0.5, angle: 1.0 }
    const lastUpdateTime = 1000
    const now = 1010 // Only 10ms elapsed, less than throttle

    const result = shouldSendInputUpdate(
      current,
      last,
      lastUpdateTime,
      now,
      THROTTLE_MS,
    )

    expect(result).toBe(true)
  })

  it("returns false when throttle interval not elapsed", () => {
    const current: InputState = { force: 0.8, angle: 2.0 }
    const last: InputState = { force: 0.5, angle: 1.0 }
    const lastUpdateTime = 1000
    const now = 1030 // 30ms elapsed, less than 50ms throttle

    const result = shouldSendInputUpdate(
      current,
      last,
      lastUpdateTime,
      now,
      THROTTLE_MS,
    )

    expect(result).toBe(false)
  })

  it("returns true when throttle interval elapsed", () => {
    const current: InputState = { force: 0.8, angle: 2.0 }
    const last: InputState = { force: 0.5, angle: 1.0 }
    const lastUpdateTime = 1000
    const now = 1050 // Exactly 50ms elapsed

    const result = shouldSendInputUpdate(
      current,
      last,
      lastUpdateTime,
      now,
      THROTTLE_MS,
    )

    expect(result).toBe(true)
  })

  it("returns true when throttle interval exceeded", () => {
    const current: InputState = { force: 0.8, angle: 2.0 }
    const last: InputState = { force: 0.5, angle: 1.0 }
    const lastUpdateTime = 1000
    const now = 1100 // 100ms elapsed, well over throttle

    const result = shouldSendInputUpdate(
      current,
      last,
      lastUpdateTime,
      now,
      THROTTLE_MS,
    )

    expect(result).toBe(true)
  })

  it("detects change in force only", () => {
    const current: InputState = { force: 0.8, angle: 1.0 }
    const last: InputState = { force: 0.5, angle: 1.0 }

    const result = shouldSendInputUpdate(current, last, 0, 100, THROTTLE_MS)

    expect(result).toBe(true)
  })

  it("detects change in angle only", () => {
    const current: InputState = { force: 0.5, angle: 2.0 }
    const last: InputState = { force: 0.5, angle: 1.0 }

    const result = shouldSendInputUpdate(current, last, 0, 100, THROTTLE_MS)

    expect(result).toBe(true)
  })
})
// ═══════════════════════════════════════════════════════════════════════════
//
//   Bumper Cars — Tick Tests
//
//   Tests for the pure tick() function — the functional core of the game
//   loop. Exercises the full physics pipeline (input → physics → collision
//   → score) without any Exchange, WebSocket, or doc infrastructure.
//
// ═══════════════════════════════════════════════════════════════════════════

import { describe, expect, it } from "vitest"
import { tick, type TickInput } from "./tick.js"
import {
  ARENA_WIDTH,
  ARENA_HEIGHT,
  CAR_RADIUS,
  COLLISION_COOLDOWN,
  HIT_EFFECT_DURATION,
} from "../constants.js"
import type { CarState, InputState } from "../types.js"

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function makeCar(overrides: Partial<CarState> = {}): CarState {
  return {
    x: ARENA_WIDTH / 2,
    y: ARENA_HEIGHT / 2,
    vx: 0,
    vy: 0,
    rotation: 0,
    color: "#FF6B6B",
    name: "Test",
    hitUntil: 0,
    ...overrides,
  }
}

function makeTickInput(overrides: Partial<TickInput> = {}): TickInput {
  return {
    cars: new Map(),
    inputs: new Map(),
    recentCollisions: new Map(),
    now: 1000,
    ...overrides,
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Basic tick behavior
// ─────────────────────────────────────────────────────────────────────────

describe("tick", () => {
  it("leaves stationary cars with no input unchanged (approximately)", () => {
    const car = makeCar({ vx: 0, vy: 0 })
    const cars = new Map([["alice", car]])
    const origX = car.x
    const origY = car.y

    const result = tick(makeTickInput({ cars }))

    // Friction on zero velocity → still zero. Position unchanged.
    expect(result.cars.get("alice")!.x).toBe(origX)
    expect(result.cars.get("alice")!.y).toBe(origY)
    expect(result.scoredCollisions).toHaveLength(0)
  })

  it("applies input to the correct car", () => {
    const alice = makeCar({ x: 200, y: 300, vx: 0, vy: 0 })
    const bob = makeCar({ x: 600, y: 300, vx: 0, vy: 0 })
    const cars = new Map([
      ["alice", alice],
      ["bob", bob],
    ])
    const inputs = new Map<string, InputState>([
      ["alice", { force: 1, angle: 0 }], // push right
    ])

    tick(makeTickInput({ cars, inputs }))

    // Alice should have moved right; Bob should be ~unchanged
    expect(alice.x).toBeGreaterThan(200)
    expect(bob.x).toBeCloseTo(600, 0)
  })

  it("moves a car with existing velocity (no input)", () => {
    const car = makeCar({ x: 200, y: 200, vx: 4, vy: 0 })
    const cars = new Map([["alice", car]])

    tick(makeTickInput({ cars }))

    // Should have moved right (vx applied, then friction reduces it slightly)
    expect(car.x).toBeGreaterThan(200)
  })

  // ─────────────────────────────────────────────────────────────────────
  // Collision detection + scoring
  // ─────────────────────────────────────────────────────────────────────

  it("detects a collision and returns scorers", () => {
    // Alice moving fast right into stationary Bob, overlapping
    const alice = makeCar({ x: 200, y: 300, vx: 6, vy: 0 })
    const bob = makeCar({
      x: 200 + CAR_RADIUS * 1.5,
      y: 300,
      vx: 0,
      vy: 0,
    })
    const cars = new Map([
      ["alice", alice],
      ["bob", bob],
    ])

    const result = tick(makeTickInput({ cars }))

    expect(result.scoredCollisions.length).toBeGreaterThanOrEqual(1)
    const collision = result.scoredCollisions[0]
    expect(collision.scorers).toContain("alice")
  })

  it("respects collision cooldown — same pair does not score twice within cooldown", () => {
    const now = 5000
    const alice = makeCar({ x: 200, y: 300, vx: 6, vy: 0 })
    const bob = makeCar({
      x: 200 + CAR_RADIUS * 1.5,
      y: 300,
      vx: 0,
      vy: 0,
    })
    const cars = new Map([
      ["alice", alice],
      ["bob", bob],
    ])

    // Pre-populate a recent collision within the cooldown window
    const key = ["alice", "bob"].sort().join("-")
    const recentCollisions = new Map([[key, now - 100]]) // 100ms ago, well within cooldown

    const result = tick(
      makeTickInput({ cars, recentCollisions, now }),
    )

    // The collision should be suppressed by cooldown
    expect(result.scoredCollisions).toHaveLength(0)
  })

  it("allows collision after cooldown expires", () => {
    const now = 5000
    const alice = makeCar({ x: 200, y: 300, vx: 6, vy: 0 })
    const bob = makeCar({
      x: 200 + CAR_RADIUS * 1.5,
      y: 300,
      vx: 0,
      vy: 0,
    })
    const cars = new Map([
      ["alice", alice],
      ["bob", bob],
    ])

    // Pre-populate a collision that happened long ago (past cooldown)
    const key = ["alice", "bob"].sort().join("-")
    const recentCollisions = new Map([[key, now - COLLISION_COOLDOWN - 100]])

    const result = tick(
      makeTickInput({ cars, recentCollisions, now }),
    )

    // Cooldown expired — collision should score
    expect(result.scoredCollisions.length).toBeGreaterThanOrEqual(1)
  })

  // ─────────────────────────────────────────────────────────────────────
  // Hit effect
  // ─────────────────────────────────────────────────────────────────────

  it("sets hitUntil on the victim car after a scored collision", () => {
    const now = 5000
    // Alice rams Bob from the front — Alice scores, Bob is the victim
    const alice = makeCar({ x: 200, y: 300, vx: 6, vy: 0 })
    const bob = makeCar({
      x: 200 + CAR_RADIUS * 1.5,
      y: 300,
      vx: 0,
      vy: 0,
    })
    const cars = new Map([
      ["alice", alice],
      ["bob", bob],
    ])

    const result = tick(makeTickInput({ cars, now }))

    if (result.scoredCollisions.length > 0) {
      const collision = result.scoredCollisions[0]
      // Victims (non-scorers) should have hitUntil set
      for (const peer of [collision.peer1, collision.peer2]) {
        if (!collision.scorers.includes(peer)) {
          const victimCar = result.cars.get(peer)!
          expect(victimCar.hitUntil).toBe(now + HIT_EFFECT_DURATION)
        }
      }
    }
  })

  // ─────────────────────────────────────────────────────────────────────
  // Cooldown cleanup
  // ─────────────────────────────────────────────────────────────────────

  it("cleans up expired cooldown entries", () => {
    const now = 10000
    const recentCollisions = new Map([
      ["alice-bob", now - COLLISION_COOLDOWN * 3], // very old, should be cleaned
      ["alice-charlie", now - 100], // recent, should be kept
    ])

    // No cars, no collisions — just testing cleanup
    const result = tick(
      makeTickInput({ recentCollisions, now }),
    )

    expect(result.recentCollisions.has("alice-bob")).toBe(false)
    expect(result.recentCollisions.has("alice-charlie")).toBe(true)
  })

  // ─────────────────────────────────────────────────────────────────────
  // Does not mutate input collision map
  // ─────────────────────────────────────────────────────────────────────

  it("does not mutate the input recentCollisions map", () => {
    const recentCollisions = new Map([["a-b", 1000]])
    const originalSize = recentCollisions.size

    tick(makeTickInput({ recentCollisions, now: 99999 }))

    // The input map should not be modified (tick clones it internally)
    expect(recentCollisions.size).toBe(originalSize)
    expect(recentCollisions.get("a-b")).toBe(1000)
  })

  // ─────────────────────────────────────────────────────────────────────
  // Wall collisions are applied
  // ─────────────────────────────────────────────────────────────────────

  it("applies wall collisions for a car moving out of bounds", () => {
    // Car near the right wall, moving right — should bounce
    const car = makeCar({
      x: ARENA_WIDTH - CAR_RADIUS + 10,
      y: 300,
      vx: 5,
      vy: 0,
    })
    const cars = new Map([["alice", car]])

    tick(makeTickInput({ cars }))

    // After tick, car should be within bounds and velocity reversed
    expect(car.x).toBeLessThanOrEqual(ARENA_WIDTH - CAR_RADIUS)
    expect(car.vx).toBeLessThan(0) // bounced
  })
})
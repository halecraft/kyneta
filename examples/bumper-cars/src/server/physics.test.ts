// ═══════════════════════════════════════════════════════════════════════════
//
//   Bumper Cars — Physics Tests
//
//   Unit tests for the pure physics functions. These are the highest-risk
//   functions (edge cases at boundaries, collision detection geometry)
//   and are easily testable since they're pure.
//
// ═══════════════════════════════════════════════════════════════════════════

import { describe, expect, it } from "vitest"
import {
  ARENA_HEIGHT,
  ARENA_WIDTH,
  CAR_RADIUS,
  FRICTION,
  MAX_SPEED,
  WALL_BOUNCE,
} from "../constants.js"
import type { CarState } from "../types.js"
import {
  applyFriction,
  applyInput,
  checkCarCollision,
  getSpawnPosition,
  handleWallCollisions,
  updatePosition,
} from "./physics.js"
import { makeCar } from "./test-helpers.js"

// ─────────────────────────────────────────────────────────────────────────
// applyInput
// ─────────────────────────────────────────────────────────────────────────

describe("applyInput", () => {
  it("applies force in the direction of the angle", () => {
    const next = applyInput(makeCar(), { force: 1, angle: 0 }) // right
    expect(next.vx).toBeGreaterThan(0)
    expect(next.vy).toBeCloseTo(0, 5)
  })

  it("applies force downward for angle π/2", () => {
    const next = applyInput(makeCar(), { force: 1, angle: Math.PI / 2 }) // down
    expect(next.vx).toBeCloseTo(0, 5)
    expect(next.vy).toBeGreaterThan(0)
  })

  it("does nothing when force is zero", () => {
    const car = makeCar({ vx: 3, vy: 4 })
    const next = applyInput(car, { force: 0, angle: 1.5 })
    expect(next.vx).toBe(3)
    expect(next.vy).toBe(4)
    expect(next).toBe(car) // same reference — early return
  })

  it("updates rotation to face the input angle", () => {
    const next = applyInput(makeCar({ rotation: 0 }), {
      force: 0.5,
      angle: 2.0,
    })
    expect(next.rotation).toBe(2.0)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// applyFriction
// ─────────────────────────────────────────────────────────────────────────

describe("applyFriction", () => {
  it("reduces velocity by friction factor", () => {
    const next = applyFriction(makeCar({ vx: 5, vy: 0 }))
    expect(next.vx).toBeCloseTo(5 * FRICTION)
  })

  it("clamps velocity to MAX_SPEED", () => {
    const next = applyFriction(makeCar({ vx: MAX_SPEED * 2, vy: 0 }))
    expect(next.vx).toBeLessThanOrEqual(MAX_SPEED)
  })

  it("zeroes out very slow movement", () => {
    const next = applyFriction(makeCar({ vx: 0.005, vy: -0.003 }))
    expect(next.vx).toBe(0)
    expect(next.vy).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// updatePosition
// ─────────────────────────────────────────────────────────────────────────

describe("updatePosition", () => {
  it("advances position by velocity", () => {
    const next = updatePosition(makeCar({ x: 100, y: 200, vx: 3, vy: -2 }))
    expect(next.x).toBe(103)
    expect(next.y).toBe(198)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// handleWallCollisions
// ─────────────────────────────────────────────────────────────────────────

describe("handleWallCollisions", () => {
  it("bounces off the left wall", () => {
    const next = handleWallCollisions(makeCar({ x: CAR_RADIUS - 5, vx: -3 }))
    expect(next.x).toBe(CAR_RADIUS)
    expect(next.vx).toBeCloseTo(3 * WALL_BOUNCE)
  })

  it("bounces off the right wall", () => {
    const next = handleWallCollisions(
      makeCar({ x: ARENA_WIDTH - CAR_RADIUS + 5, vx: 3 }),
    )
    expect(next.x).toBe(ARENA_WIDTH - CAR_RADIUS)
    expect(next.vx).toBeCloseTo(-3 * WALL_BOUNCE)
  })

  it("bounces off the top wall", () => {
    const next = handleWallCollisions(makeCar({ y: CAR_RADIUS - 5, vy: -4 }))
    expect(next.y).toBe(CAR_RADIUS)
    expect(next.vy).toBeCloseTo(4 * WALL_BOUNCE)
  })

  it("bounces off the bottom wall", () => {
    const next = handleWallCollisions(
      makeCar({ y: ARENA_HEIGHT - CAR_RADIUS + 5, vy: 4 }),
    )
    expect(next.y).toBe(ARENA_HEIGHT - CAR_RADIUS)
    expect(next.vy).toBeCloseTo(-4 * WALL_BOUNCE)
  })

  it("does nothing when car is inside the arena", () => {
    const car = makeCar({ x: 200, y: 200, vx: 3, vy: 4 })
    const next = handleWallCollisions(car)
    expect(next.x).toBe(200)
    expect(next.y).toBe(200)
    expect(next.vx).toBe(3)
    expect(next.vy).toBe(4)
    expect(next).toBe(car) // same reference — no wall hit
  })
})

// ─────────────────────────────────────────────────────────────────────────
// checkCarCollision
// ─────────────────────────────────────────────────────────────────────────

describe("checkCarCollision", () => {
  it("detects collision when cars overlap and approach each other", () => {
    // Two cars at the same Y, separated by less than 2*CAR_RADIUS,
    // moving toward each other
    const car1 = makeCar({ x: 200, y: 300, vx: 5, vy: 0 })
    const car2 = makeCar({ x: 200 + CAR_RADIUS * 1.5, y: 300, vx: -5, vy: 0 })

    const result = checkCarCollision("a", car1, "b", car2, 1000)
    expect(result.collision).not.toBeNull()
    expect(result.collision!.peer1).toBe("a")
    expect(result.collision!.peer2).toBe("b")
  })

  it("returns null when cars are far apart", () => {
    const car1 = makeCar({ x: 100, y: 100 })
    const car2 = makeCar({ x: 500, y: 500 })

    const result = checkCarCollision("a", car1, "b", car2, 1000)
    expect(result.collision).toBeNull()
    expect(result.car1).toBe(car1)
    expect(result.car2).toBe(car2)
  })

  it("returns null when overlapping cars are moving apart", () => {
    const car1 = makeCar({ x: 200, y: 300, vx: -5, vy: 0 })
    const car2 = makeCar({ x: 200 + CAR_RADIUS * 1.5, y: 300, vx: 5, vy: 0 })

    const result = checkCarCollision("a", car1, "b", car2, 1000)
    expect(result.collision).toBeNull()
  })

  it("separates overlapping cars after collision", () => {
    const car1 = makeCar({ x: 200, y: 300, vx: 5, vy: 0 })
    const car2 = makeCar({ x: 200 + CAR_RADIUS, y: 300, vx: -5, vy: 0 })

    const result = checkCarCollision("a", car1, "b", car2, 1000)

    // Cars should be separated by at least 2*CAR_RADIUS after resolution
    const dx = result.car2.x - result.car1.x
    const dy = result.car2.y - result.car1.y
    const distance = Math.sqrt(dx * dx + dy * dy)
    expect(distance).toBeGreaterThanOrEqual(CAR_RADIUS * 2 - 1) // allow small float error
  })

  it("identifies front-hit scorers based on velocity direction", () => {
    // car1 moving fast to the right, car2 stationary — car1 scores
    const car1 = makeCar({ x: 200, y: 300, vx: 5, vy: 0 })
    const car2 = makeCar({ x: 200 + CAR_RADIUS * 1.5, y: 300, vx: 0, vy: 0 })

    const result = checkCarCollision("a", car1, "b", car2, 1000)
    expect(result.collision).not.toBeNull()
    expect(result.collision!.scorers).toContain("a")
  })

  it("returns null for zero distance (degenerate case)", () => {
    const car1 = makeCar({ x: 200, y: 300, vx: 1, vy: 0 })
    const car2 = makeCar({ x: 200, y: 300, vx: -1, vy: 0 })

    const result = checkCarCollision("a", car1, "b", car2, 1000)
    expect(result.collision).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────
// getSpawnPosition
// ─────────────────────────────────────────────────────────────────────────

describe("getSpawnPosition", () => {
  it("returns a position inside the arena margins", () => {
    const pos = getSpawnPosition([])
    const margin = CAR_RADIUS * 3
    expect(pos.x).toBeGreaterThanOrEqual(margin)
    expect(pos.x).toBeLessThanOrEqual(ARENA_WIDTH - margin)
    expect(pos.y).toBeGreaterThanOrEqual(margin)
    expect(pos.y).toBeLessThanOrEqual(ARENA_HEIGHT - margin)
  })

  it("avoids existing cars", () => {
    // Place a car in the center — spawn should be at least 3*CAR_RADIUS away
    const existingCar = makeCar({ x: ARENA_WIDTH / 2, y: ARENA_HEIGHT / 2 })
    const pos = getSpawnPosition([existingCar])

    const dx = pos.x - existingCar.x
    const dy = pos.y - existingCar.y
    const distance = Math.sqrt(dx * dx + dy * dy)
    expect(distance).toBeGreaterThanOrEqual(CAR_RADIUS * 3)
  })

  it("returns center as fallback when arena is densely packed", () => {
    // Fill the arena with cars everywhere — should fall back to center
    const packed: CarState[] = []
    for (let x = 0; x <= ARENA_WIDTH; x += CAR_RADIUS) {
      for (let y = 0; y <= ARENA_HEIGHT; y += CAR_RADIUS) {
        packed.push(makeCar({ x, y }))
      }
    }
    const pos = getSpawnPosition(packed)
    expect(pos.x).toBe(ARENA_WIDTH / 2)
    expect(pos.y).toBe(ARENA_HEIGHT / 2)
  })
})

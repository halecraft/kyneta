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
  applyFriction,
  applyInput,
  checkCarCollision,
  getSpawnPosition,
  handleWallCollisions,
  updatePosition,
} from "./physics.js"
import {
  ARENA_HEIGHT,
  ARENA_WIDTH,
  CAR_RADIUS,
  FRICTION,
  MAX_SPEED,
  WALL_BOUNCE,
} from "../constants.js"
import type { CarState } from "../types.js"

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

// ─────────────────────────────────────────────────────────────────────────
// applyInput
// ─────────────────────────────────────────────────────────────────────────

describe("applyInput", () => {
  it("applies force in the direction of the angle", () => {
    const car = makeCar()
    applyInput(car, { force: 1, angle: 0 }) // right
    expect(car.vx).toBeGreaterThan(0)
    expect(car.vy).toBeCloseTo(0, 5)
  })

  it("applies force downward for angle π/2", () => {
    const car = makeCar()
    applyInput(car, { force: 1, angle: Math.PI / 2 }) // down
    expect(car.vx).toBeCloseTo(0, 5)
    expect(car.vy).toBeGreaterThan(0)
  })

  it("does nothing when force is zero", () => {
    const car = makeCar({ vx: 3, vy: 4 })
    applyInput(car, { force: 0, angle: 1.5 })
    expect(car.vx).toBe(3)
    expect(car.vy).toBe(4)
  })

  it("updates rotation to face the input angle", () => {
    const car = makeCar({ rotation: 0 })
    applyInput(car, { force: 0.5, angle: 2.0 })
    expect(car.rotation).toBe(2.0)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// applyFriction
// ─────────────────────────────────────────────────────────────────────────

describe("applyFriction", () => {
  it("reduces velocity by friction factor", () => {
    const car = makeCar({ vx: 5, vy: 0 })
    applyFriction(car)
    expect(car.vx).toBeCloseTo(5 * FRICTION)
  })

  it("clamps velocity to MAX_SPEED", () => {
    const car = makeCar({ vx: MAX_SPEED * 2, vy: 0 })
    applyFriction(car)
    expect(car.vx).toBeLessThanOrEqual(MAX_SPEED)
  })

  it("zeroes out very slow movement", () => {
    const car = makeCar({ vx: 0.005, vy: -0.003 })
    applyFriction(car)
    expect(car.vx).toBe(0)
    expect(car.vy).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// updatePosition
// ─────────────────────────────────────────────────────────────────────────

describe("updatePosition", () => {
  it("advances position by velocity", () => {
    const car = makeCar({ x: 100, y: 200, vx: 3, vy: -2 })
    updatePosition(car)
    expect(car.x).toBe(103)
    expect(car.y).toBe(198)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// handleWallCollisions
// ─────────────────────────────────────────────────────────────────────────

describe("handleWallCollisions", () => {
  it("bounces off the left wall", () => {
    const car = makeCar({ x: CAR_RADIUS - 5, vx: -3 })
    handleWallCollisions(car)
    expect(car.x).toBe(CAR_RADIUS)
    expect(car.vx).toBeCloseTo(3 * WALL_BOUNCE)
  })

  it("bounces off the right wall", () => {
    const car = makeCar({ x: ARENA_WIDTH - CAR_RADIUS + 5, vx: 3 })
    handleWallCollisions(car)
    expect(car.x).toBe(ARENA_WIDTH - CAR_RADIUS)
    expect(car.vx).toBeCloseTo(-3 * WALL_BOUNCE)
  })

  it("bounces off the top wall", () => {
    const car = makeCar({ y: CAR_RADIUS - 5, vy: -4 })
    handleWallCollisions(car)
    expect(car.y).toBe(CAR_RADIUS)
    expect(car.vy).toBeCloseTo(4 * WALL_BOUNCE)
  })

  it("bounces off the bottom wall", () => {
    const car = makeCar({ y: ARENA_HEIGHT - CAR_RADIUS + 5, vy: 4 })
    handleWallCollisions(car)
    expect(car.y).toBe(ARENA_HEIGHT - CAR_RADIUS)
    expect(car.vy).toBeCloseTo(-4 * WALL_BOUNCE)
  })

  it("does nothing when car is inside the arena", () => {
    const car = makeCar({ x: 200, y: 200, vx: 3, vy: 4 })
    handleWallCollisions(car)
    expect(car.x).toBe(200)
    expect(car.y).toBe(200)
    expect(car.vx).toBe(3)
    expect(car.vy).toBe(4)
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

    const result = checkCarCollision("a", car1, "b", car2)
    expect(result).not.toBeNull()
    expect(result!.peer1).toBe("a")
    expect(result!.peer2).toBe("b")
  })

  it("returns null when cars are far apart", () => {
    const car1 = makeCar({ x: 100, y: 100 })
    const car2 = makeCar({ x: 500, y: 500 })

    const result = checkCarCollision("a", car1, "b", car2)
    expect(result).toBeNull()
  })

  it("returns null when overlapping cars are moving apart", () => {
    const car1 = makeCar({ x: 200, y: 300, vx: -5, vy: 0 })
    const car2 = makeCar({ x: 200 + CAR_RADIUS * 1.5, y: 300, vx: 5, vy: 0 })

    const result = checkCarCollision("a", car1, "b", car2)
    expect(result).toBeNull()
  })

  it("separates overlapping cars after collision", () => {
    const car1 = makeCar({ x: 200, y: 300, vx: 5, vy: 0 })
    const car2 = makeCar({ x: 200 + CAR_RADIUS, y: 300, vx: -5, vy: 0 })

    checkCarCollision("a", car1, "b", car2)

    // Cars should be separated by at least 2*CAR_RADIUS after resolution
    const dx = car2.x - car1.x
    const dy = car2.y - car1.y
    const distance = Math.sqrt(dx * dx + dy * dy)
    expect(distance).toBeGreaterThanOrEqual(CAR_RADIUS * 2 - 1) // allow small float error
  })

  it("identifies front-hit scorers based on velocity direction", () => {
    // car1 moving fast to the right, car2 stationary — car1 scores
    const car1 = makeCar({ x: 200, y: 300, vx: 5, vy: 0 })
    const car2 = makeCar({ x: 200 + CAR_RADIUS * 1.5, y: 300, vx: 0, vy: 0 })

    const result = checkCarCollision("a", car1, "b", car2)
    expect(result).not.toBeNull()
    expect(result!.scorers).toContain("a")
  })

  it("returns null for zero distance (degenerate case)", () => {
    const car1 = makeCar({ x: 200, y: 300, vx: 1, vy: 0 })
    const car2 = makeCar({ x: 200, y: 300, vx: -1, vy: 0 })

    const result = checkCarCollision("a", car1, "b", car2)
    expect(result).toBeNull()
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
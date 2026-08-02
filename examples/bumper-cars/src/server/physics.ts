// ═══════════════════════════════════════════════════════════════════════════
//
//   Bumper Cars — Physics
//
//   Pure functions operating on plain types. No framework imports.
//   Every function returns a new CarState; none mutate input.
//
//   Ported from vendor/loro-extended/examples/bumper-cars/src/server/physics.ts
//   with import paths adapted to kyneta's structure.
//
// ═══════════════════════════════════════════════════════════════════════════

import {
  ARENA_HEIGHT,
  ARENA_WIDTH,
  CAR_BOUNCE,
  CAR_RADIUS,
  FRICTION,
  MAX_SPEED,
  MIN_HIT_SPEED,
  WALL_BOUNCE,
} from "../constants.js"
import type { CarState, Collision, InputState } from "../types.js"

// ─────────────────────────────────────────────────────────────────────────
// Input → Velocity
// ─────────────────────────────────────────────────────────────────────────

/** Apply joystick/keyboard input to a car's velocity. Pure — returns new CarState. */
export function applyInput(car: CarState, input: InputState): CarState {
  if (input.force <= 0) return car

  const ax = Math.cos(input.angle) * input.force * 0.5
  const ay = Math.sin(input.angle) * input.force * 0.5

  return {
    ...car,
    vx: car.vx + ax,
    vy: car.vy + ay,
    rotation: input.angle,
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Friction + Speed Clamp
// ─────────────────────────────────────────────────────────────────────────

/** Apply friction and clamp velocity. Pure — returns new CarState. */
export function applyFriction(car: CarState): CarState {
  let vx = car.vx * FRICTION
  let vy = car.vy * FRICTION

  // Clamp to max speed
  const speed = Math.sqrt(vx * vx + vy * vy)
  if (speed > MAX_SPEED) {
    vx = (vx / speed) * MAX_SPEED
    vy = (vy / speed) * MAX_SPEED
  }

  // Stop very slow movement
  if (Math.abs(vx) < 0.01) vx = 0
  if (Math.abs(vy) < 0.01) vy = 0

  return { ...car, vx, vy }
}

// ─────────────────────────────────────────────────────────────────────────
// Position Update
// ─────────────────────────────────────────────────────────────────────────

/** Advance position by velocity. Pure — returns new CarState. */
export function updatePosition(car: CarState): CarState {
  return {
    ...car,
    x: car.x + car.vx,
    y: car.y + car.vy,
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Wall Bounce
// ─────────────────────────────────────────────────────────────────────────

/** Bounce off arena walls. Pure — returns new CarState only if a wall was hit. */
export function handleWallCollisions(car: CarState): CarState {
  let x = car.x
  let y = car.y
  let vx = car.vx
  let vy = car.vy
  let hit = false

  if (x - CAR_RADIUS < 0) {
    x = CAR_RADIUS
    vx = -vx * WALL_BOUNCE
    hit = true
  }
  if (x + CAR_RADIUS > ARENA_WIDTH) {
    x = ARENA_WIDTH - CAR_RADIUS
    vx = -vx * WALL_BOUNCE
    hit = true
  }
  if (y - CAR_RADIUS < 0) {
    y = CAR_RADIUS
    vy = -vy * WALL_BOUNCE
    hit = true
  }
  if (y + CAR_RADIUS > ARENA_HEIGHT) {
    y = ARENA_HEIGHT - CAR_RADIUS
    vy = -vy * WALL_BOUNCE
    hit = true
  }

  return hit ? { ...car, x, y, vx, vy } : car
}

// ─────────────────────────────────────────────────────────────────────────
// Front-Hit Detection (internal)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Check if a car hit another car with its front using velocity-based detection.
 *
 * A car scores a hit if:
 * 1. It's moving fast enough (speed > MIN_HIT_SPEED)
 * 2. Its velocity is pointing toward the other car (within ±60°)
 * 3. It has positive relative velocity toward the other car (actively approaching)
 */
function isHitWithFront(car: CarState, otherCar: CarState): boolean {
  const speed = Math.sqrt(car.vx * car.vx + car.vy * car.vy)
  if (speed < MIN_HIT_SPEED) return false

  const dx = otherCar.x - car.x
  const dy = otherCar.y - car.y

  const velocityAngle = normalizeAngle(Math.atan2(car.vy, car.vx))
  const collisionAngle = normalizeAngle(Math.atan2(dy, dx))

  let angleDiff = Math.abs(velocityAngle - collisionAngle)
  if (angleDiff > Math.PI) angleDiff = 2 * Math.PI - angleDiff

  // Front arc is ±60° (π/3 radians)
  if (angleDiff >= Math.PI / 3) return false

  const distance = Math.sqrt(dx * dx + dy * dy)
  if (distance === 0) return false

  // Dot product of velocity with unit vector toward other car
  const approachSpeed = car.vx * (dx / distance) + car.vy * (dy / distance)
  return approachSpeed > 0
}

/** Normalize angle to [0, 2π). */
function normalizeAngle(angle: number): number {
  let n = angle % (2 * Math.PI)
  if (n < 0) n += 2 * Math.PI
  return n
}

// ─────────────────────────────────────────────────────────────────────────
// Car–Car Collision
// ─────────────────────────────────────────────────────────────────────────

/** Result of checking a car-car collision. */
export type CarCollisionResult = {
  /** Collision info if they collided, null otherwise. */
  collision: Collision | null
  /** Updated car1 state (may be unchanged if no collision). */
  car1: CarState
  /** Updated car2 state (may be unchanged if no collision). */
  car2: CarState
}

/**
 * Check and resolve collision between two cars.
 * Pure — returns new CarState objects and collision info.
 * Does not mutate inputs.
 */
export function checkCarCollision(
  peer1: string,
  car1: CarState,
  peer2: string,
  car2: CarState,
  now: number,
): CarCollisionResult {
  const dx = car2.x - car1.x
  const dy = car2.y - car1.y
  const distance = Math.sqrt(dx * dx + dy * dy)
  const minDistance = CAR_RADIUS * 2

  if (distance >= minDistance || distance === 0) {
    return { collision: null, car1, car2 }
  }

  // Normalize collision vector
  const nx = dx / distance
  const ny = dy / distance

  // Relative velocity along collision normal
  const dvn = (car1.vx - car2.vx) * nx + (car1.vy - car2.vy) * ny

  // Only resolve if cars are moving towards each other
  if (dvn <= 0) {
    return { collision: null, car1, car2 }
  }

  // Impulse (assuming equal mass)
  const impulse = dvn * CAR_BOUNCE

  const nextCar1: CarState = {
    ...car1,
    vx: car1.vx - impulse * nx,
    vy: car1.vy - impulse * ny,
  }
  const nextCar2: CarState = {
    ...car2,
    vx: car2.vx + impulse * nx,
    vy: car2.vy + impulse * ny,
  }

  // Separate cars to prevent overlap
  const overlap = minDistance - distance
  const sx = (overlap / 2 + 1) * nx
  const sy = (overlap / 2 + 1) * ny

  const separatedCar1: CarState = {
    ...nextCar1,
    x: nextCar1.x - sx,
    y: nextCar1.y - sy,
  }
  const separatedCar2: CarState = {
    ...nextCar2,
    x: nextCar2.x + sx,
    y: nextCar2.y + sy,
  }

  // Determine who scored — only cars that hit with their front
  const scorers: string[] = []
  if (isHitWithFront(separatedCar1, separatedCar2)) scorers.push(peer1)
  if (isHitWithFront(separatedCar2, separatedCar1)) scorers.push(peer2)

  const collision: Collision = {
    peer1,
    peer2,
    timestamp: now,
    scorers,
  }

  return { collision, car1: separatedCar1, car2: separatedCar2 }
}

// ─────────────────────────────────────────────────────────────────────────
// Spawn Position
// ─────────────────────────────────────────────────────────────────────────

/** Find a spawn position that doesn't overlap with existing cars. */
export function getSpawnPosition(existingCars: CarState[]): {
  x: number
  y: number
} {
  const margin = CAR_RADIUS * 3
  const maxAttempts = 50

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const x = margin + Math.random() * (ARENA_WIDTH - margin * 2)
    const y = margin + Math.random() * (ARENA_HEIGHT - margin * 2)

    let clear = true
    for (const car of existingCars) {
      const dx = car.x - x
      const dy = car.y - y
      if (Math.sqrt(dx * dx + dy * dy) < CAR_RADIUS * 3) {
        clear = false
        break
      }
    }

    if (clear) return { x, y }
  }

  // Fallback to center
  return { x: ARENA_WIDTH / 2, y: ARENA_HEIGHT / 2 }
}

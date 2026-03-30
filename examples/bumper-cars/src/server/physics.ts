// ═══════════════════════════════════════════════════════════════════════════
//
//   Bumper Cars — Physics
//
//   Pure functions operating on plain types. No framework imports.
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

/** Apply joystick/keyboard input to a car's velocity. Mutates in place. */
export function applyInput(car: CarState, input: InputState): void {
  if (input.force > 0) {
    const ax = Math.cos(input.angle) * input.force * 0.5
    const ay = Math.sin(input.angle) * input.force * 0.5

    car.vx += ax
    car.vy += ay

    // Update rotation to face movement direction
    car.rotation = input.angle
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Friction + Speed Clamp
// ─────────────────────────────────────────────────────────────────────────

/** Apply friction and clamp velocity. Mutates in place. */
export function applyFriction(car: CarState): void {
  car.vx *= FRICTION
  car.vy *= FRICTION

  // Clamp to max speed
  const speed = Math.sqrt(car.vx * car.vx + car.vy * car.vy)
  if (speed > MAX_SPEED) {
    car.vx = (car.vx / speed) * MAX_SPEED
    car.vy = (car.vy / speed) * MAX_SPEED
  }

  // Stop very slow movement
  if (Math.abs(car.vx) < 0.01) car.vx = 0
  if (Math.abs(car.vy) < 0.01) car.vy = 0
}

// ─────────────────────────────────────────────────────────────────────────
// Position Update
// ─────────────────────────────────────────────────────────────────────────

/** Advance position by velocity. Mutates in place. */
export function updatePosition(car: CarState): void {
  car.x += car.vx
  car.y += car.vy
}

// ─────────────────────────────────────────────────────────────────────────
// Wall Bounce
// ─────────────────────────────────────────────────────────────────────────

/** Bounce off arena walls. Mutates in place. */
export function handleWallCollisions(car: CarState): void {
  if (car.x - CAR_RADIUS < 0) {
    car.x = CAR_RADIUS
    car.vx = -car.vx * WALL_BOUNCE
  }
  if (car.x + CAR_RADIUS > ARENA_WIDTH) {
    car.x = ARENA_WIDTH - CAR_RADIUS
    car.vx = -car.vx * WALL_BOUNCE
  }
  if (car.y - CAR_RADIUS < 0) {
    car.y = CAR_RADIUS
    car.vy = -car.vy * WALL_BOUNCE
  }
  if (car.y + CAR_RADIUS > ARENA_HEIGHT) {
    car.y = ARENA_HEIGHT - CAR_RADIUS
    car.vy = -car.vy * WALL_BOUNCE
  }
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

/**
 * Check and resolve collision between two cars.
 * Mutates car velocities and positions to separate overlapping cars.
 * Returns collision info if they collided, or null.
 */
export function checkCarCollision(
  peer1: string,
  car1: CarState,
  peer2: string,
  car2: CarState,
): Collision | null {
  const dx = car2.x - car1.x
  const dy = car2.y - car1.y
  const distance = Math.sqrt(dx * dx + dy * dy)
  const minDistance = CAR_RADIUS * 2

  if (distance >= minDistance || distance === 0) return null

  // Normalize collision vector
  const nx = dx / distance
  const ny = dy / distance

  // Relative velocity along collision normal
  const dvn = (car1.vx - car2.vx) * nx + (car1.vy - car2.vy) * ny

  // Only resolve if cars are moving towards each other
  if (dvn <= 0) return null

  // Impulse (assuming equal mass)
  const impulse = dvn * CAR_BOUNCE

  car1.vx -= impulse * nx
  car1.vy -= impulse * ny
  car2.vx += impulse * nx
  car2.vy += impulse * ny

  // Separate cars to prevent overlap
  const overlap = minDistance - distance
  const sx = (overlap / 2 + 1) * nx
  const sy = (overlap / 2 + 1) * ny
  car1.x -= sx
  car1.y -= sy
  car2.x += sx
  car2.y += sy

  // Determine who scored — only cars that hit with their front
  const scorers: string[] = []
  if (isHitWithFront(car1, car2)) scorers.push(peer1)
  if (isHitWithFront(car2, car1)) scorers.push(peer2)

  return { peer1, peer2, timestamp: Date.now(), scorers }
}

// ─────────────────────────────────────────────────────────────────────────
// Spawn Position
// ─────────────────────────────────────────────────────────────────────────

/** Find a spawn position that doesn't overlap with existing cars. */
export function getSpawnPosition(
  existingCars: CarState[],
): { x: number; y: number } {
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
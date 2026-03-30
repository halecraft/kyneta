// ═══════════════════════════════════════════════════════════════════════════
//
//   Bumper Cars — Tick (Functional Core)
//
//   A single pure function that advances the game by one frame.
//   Takes the current state + inputs, returns the next state + events.
//
//   No Exchange, no docs, no side effects. Easily testable.
//
// ═══════════════════════════════════════════════════════════════════════════

import {
  COLLISION_COOLDOWN,
  HIT_EFFECT_DURATION,
} from "../constants.js"
import type { CarState, Collision, InputState } from "../types.js"
import {
  applyFriction,
  applyInput,
  checkCarCollision,
  handleWallCollisions,
  updatePosition,
} from "./physics.js"

// ─────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────

export type TickInput = {
  /** Current car positions keyed by peerId. */
  cars: Map<string, CarState>
  /** Current joystick/keyboard inputs keyed by peerId. */
  inputs: Map<string, InputState>
  /** Recent collision pairs → timestamp (for cooldown). */
  recentCollisions: Map<string, number>
  /** Current wall-clock time (ms). */
  now: number
}

export type TickOutput = {
  /** Updated car positions (same Map identity, mutated in place). */
  cars: Map<string, CarState>
  /** Collisions that scored this tick (empty if none). */
  scoredCollisions: Collision[]
  /** Updated collision cooldown map. */
  recentCollisions: Map<string, number>
}

// ─────────────────────────────────────────────────────────────────────────
// tick — advance the game by one frame
// ─────────────────────────────────────────────────────────────────────────

/**
 * Pure game tick. Applies inputs, runs physics, detects collisions,
 * and returns the new state plus any scored collisions.
 *
 * Cars are mutated in place for performance (60fps × N cars). The
 * returned `cars` map is the same reference as the input.
 */
export function tick(input: TickInput): TickOutput {
  const { cars, inputs, now } = input

  // Clone the cooldown map so we don't mutate the caller's
  const recentCollisions = new Map(input.recentCollisions)

  // 1. Apply inputs + physics to each car
  for (const [peerId, car] of cars) {
    const playerInput = inputs.get(peerId)
    if (playerInput) {
      applyInput(car, playerInput)
    }
    applyFriction(car)
    updatePosition(car)
    handleWallCollisions(car)
  }

  // 2. Check all car-car collisions (O(n²) — fine for ≤10 players)
  const scoredCollisions: Collision[] = []
  const peerIds = Array.from(cars.keys())

  for (let i = 0; i < peerIds.length; i++) {
    for (let j = i + 1; j < peerIds.length; j++) {
      const p1 = peerIds[i]
      const p2 = peerIds[j]
      const car1 = cars.get(p1)!
      const car2 = cars.get(p2)!

      const collision = checkCarCollision(p1, car1, p2, car2)
      if (!collision || collision.scorers.length === 0) continue

      // Cooldown check — skip if this pair collided recently
      const key = [p1, p2].sort().join("-")
      const lastTime = recentCollisions.get(key)
      if (lastTime !== undefined && now - lastTime < COLLISION_COOLDOWN) {
        continue
      }

      // Record collision time
      recentCollisions.set(key, now)

      // Set hit effect on victim cars (those that were hit but didn't score)
      const hitUntil = now + HIT_EFFECT_DURATION
      for (const peer of [collision.peer1, collision.peer2]) {
        if (!collision.scorers.includes(peer)) {
          const victimCar = cars.get(peer)
          if (victimCar) victimCar.hitUntil = hitUntil
        }
      }

      scoredCollisions.push(collision)
    }
  }

  // 3. Clean up expired cooldowns
  for (const [key, timestamp] of recentCollisions) {
    if (now - timestamp > COLLISION_COOLDOWN * 2) {
      recentCollisions.delete(key)
    }
  }

  return { cars, scoredCollisions, recentCollisions }
}
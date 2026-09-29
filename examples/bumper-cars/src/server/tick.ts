// ═══════════════════════════════════════════════════════════════════════════
//
//   Bumper Cars — Tick (Functional Core)
//
//   A single pure function that advances the game by one frame.
//   Takes the current state + inputs, returns the next state + events.
//
//   No Exchange, no docs, no side effects, no mutation. Easily testable.
//
// ═══════════════════════════════════════════════════════════════════════════

import {
  COLLISION_COOLDOWN,
  COOLDOWN_RETENTION_MS,
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
  /** Updated car positions (new Map, new CarState objects). */
  cars: Map<string, CarState>
  /** Collisions that scored this tick (empty if none). */
  scoredCollisions: Collision[]
  /** Updated collision cooldown map (new Map). */
  recentCollisions: Map<string, number>
}

// ─────────────────────────────────────────────────────────────────────────
// tick — advance the game by one frame
// ─────────────────────────────────────────────────────────────────────────

/**
 * Pure game tick. Applies inputs, runs physics, detects collisions,
 * and returns the new state plus any scored collisions.
 *
 * Returns new Maps and new CarState objects — nothing is mutated.
 */
export function tick(input: TickInput): TickOutput {
  const { cars, inputs, now } = input

  // Build a new cooldown map from the input
  const recentCollisions = new Map(input.recentCollisions)

  // 1. Apply inputs + physics to each car — pure folding
  const nextCars = new Map<string, CarState>()
  for (const [peerId, car] of cars) {
    const playerInput = inputs.get(peerId)
    let next = playerInput ? applyInput(car, playerInput) : car
    next = applyFriction(next)
    next = updatePosition(next)
    next = handleWallCollisions(next)
    nextCars.set(peerId, next)
  }

  // 2. Check all car-car collisions (O(n²) — fine for ≤10 players)
  const scoredCollisions: Collision[] = []
  const peerIds = Array.from(nextCars.keys())

  for (let i = 0; i < peerIds.length; i++) {
    for (let j = i + 1; j < peerIds.length; j++) {
      const p1 = peerIds[i]
      const p2 = peerIds[j]
      const car1 = nextCars.get(p1)
      const car2 = nextCars.get(p2)
      // Every id came from `nextCars`, and none is ever removed from it.
      if (car1 === undefined || car2 === undefined) continue

      const result = checkCarCollision(p1, car1, p2, car2, now)
      if (!result.collision) {
        continue
      }

      // Always apply collision resolution (bounce + separation).
      // Scoring is gated separately — a side-swipe still bounces.
      nextCars.set(p1, result.car1)
      nextCars.set(p2, result.car2)

      if (result.collision.scorers.length === 0) {
        continue
      }

      // Cooldown check — skip if this pair scored recently
      const key = [p1, p2].sort().join("-")
      const lastTime = recentCollisions.get(key)
      if (lastTime !== undefined && now - lastTime < COLLISION_COOLDOWN) {
        continue
      }

      // Record collision time
      recentCollisions.set(key, now)

      scoredCollisions.push(result.collision)
    }
  }

  // Apply hit effects after all collisions are resolved.
  // This must run after the collision loop so that hitUntil
  // is not overwritten by subsequent collision results.
  for (const collision of scoredCollisions) {
    const hitUntil = now + HIT_EFFECT_DURATION
    for (const peer of [collision.peer1, collision.peer2]) {
      if (!collision.scorers.includes(peer)) {
        const victimCar = nextCars.get(peer)
        if (victimCar) {
          nextCars.set(peer, { ...victimCar, hitUntil })
        }
      }
    }
  }

  // 3. Clean up expired cooldowns
  for (const [key, timestamp] of recentCollisions) {
    if (now - timestamp > COOLDOWN_RETENTION_MS) {
      recentCollisions.delete(key)
    }
  }

  return { cars: nextCars, scoredCollisions, recentCollisions }
}

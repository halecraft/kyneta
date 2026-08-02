// ═══════════════════════════════════════════════════════════════════════════
//
//   Bumper Cars — Test Helpers
//
//   Shared test fixtures for the server-side pure functions.
//
// ═══════════════════════════════════════════════════════════════════════════

import { ARENA_HEIGHT, ARENA_WIDTH } from "../constants.js"
import type { CarState, InputState } from "../types.js"

export function makeCar(overrides: Partial<CarState> = {}): CarState {
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

export function makeTickInput(
  overrides: {
    cars?: Map<string, CarState>
    inputs?: Map<string, InputState>
    recentCollisions?: Map<string, number>
    now?: number
  } = {},
): {
  cars: Map<string, CarState>
  inputs: Map<string, InputState>
  recentCollisions: Map<string, number>
  now: number
} {
  return {
    cars: new Map(),
    inputs: new Map(),
    recentCollisions: new Map(),
    now: 1000,
    ...overrides,
  }
}

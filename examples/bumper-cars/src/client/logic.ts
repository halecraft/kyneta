// ═══════════════════════════════════════════════════════════════════════════
//
//   Bumper Cars — Client Logic
//
//   Pure functions for client-side logic. No React, no Exchange imports.
//   Ported from vendor/loro-extended/examples/bumper-cars/src/client/logic.ts
//   with presence-specific functions removed (partitionPresences,
//   createClientPresence) since kyneta uses separate documents.
//
// ═══════════════════════════════════════════════════════════════════════════

import type { InputState, PlayerScore } from "../types.js"

// =============================================================================
// Constants
// =============================================================================

/** Default input state (no movement). */
export const ZERO_INPUT: InputState = { force: 0, angle: 0 }

// =============================================================================
// Active Players
// =============================================================================

/** Player info for the player list component. */
export type ActivePlayer = {
  peerId: string
  name: string
  color: string
}

/**
 * Extracts active player info from the game state's cars record.
 * Pure transformation for the PlayerList component.
 */
export function getActivePlayers(
  cars: Record<string, { name: string; color: string }>,
): ActivePlayer[] {
  return Object.entries(cars).map(([peerId, car]) => ({
    peerId,
    name: car.name,
    color: car.color,
  }))
}

// =============================================================================
// Score Sorting
// =============================================================================

/** Score entry with peer ID for display in scoreboard. */
export type SortedScore = {
  peerId: string
  name: string
  color: string
  bumps: number
}

/**
 * Sorts scores by bumps descending and limits to top N.
 * Pure transformation for the Scoreboard component.
 */
export function sortScores(
  scores: Record<string, PlayerScore>,
  limit: number,
): SortedScore[] {
  return Object.entries(scores)
    .map(([peerId, score]) => ({
      peerId,
      name: score.name,
      color: score.color,
      bumps: score.bumps,
    }))
    .sort((a, b) => b.bumps - a.bumps)
    .slice(0, limit)
}

// =============================================================================
// Input Handling
// =============================================================================

/**
 * Combines joystick and keyboard inputs.
 * Joystick takes priority if it has any force applied.
 */
export function combineInputs(
  joystickInput: InputState,
  keyboardInput: InputState,
): InputState {
  if (joystickInput.force > 0) {
    return joystickInput
  }
  return keyboardInput
}

/**
 * Determines whether an input update should be sent based on throttling rules.
 *
 * Rules:
 * - If input hasn't changed, don't send
 * - If this is a "stop" input (force = 0), send immediately (responsive joystick release)
 * - Otherwise, respect the throttle interval
 */
export function shouldSendInputUpdate(
  currentInput: InputState,
  lastInput: InputState,
  lastUpdateTime: number,
  now: number,
  throttleMs: number,
): boolean {
  // Check if input actually changed
  const inputChanged =
    lastInput.force !== currentInput.force ||
    lastInput.angle !== currentInput.angle

  if (!inputChanged) {
    return false
  }

  // Always send zero-force updates immediately (joystick released)
  if (currentInput.force === 0) {
    return true
  }

  // Otherwise throttle updates
  return now - lastUpdateTime >= throttleMs
}
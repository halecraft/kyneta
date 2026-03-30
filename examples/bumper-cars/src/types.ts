// ═══════════════════════════════════════════════════════════════════════════
//
//   Bumper Cars — Types
//
//   Plain TypeScript types. No framework or schema imports.
//   Shared by server and client.
//
// ═══════════════════════════════════════════════════════════════════════════

/** Joystick / keyboard input state from a client. */
export type InputState = {
  force: number // 0–1 normalized
  angle: number // radians
}

/** A single car in the arena. */
export type CarState = {
  x: number
  y: number
  vx: number
  vy: number
  rotation: number
  color: string
  name: string
  /** Timestamp (ms) when the hit flash effect ends. 0 = not hit. */
  hitUntil: number
}

/** A scored collision between two cars. */
export type Collision = {
  peer1: string
  peer2: string
  timestamp: number
  /** Which peer(s) scored — only the car that hit with its front. */
  scorers: string[]
}

/** A player's score entry in the scoreboard. */
export type PlayerScore = {
  name: string
  color: string
  bumps: number
}
// ═══════════════════════════════════════════════════════════════════════════
//
//   Bumper Cars — Constants
//
//   Pure values. No framework imports. Shared by server and client.
//
// ═══════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────
// Arena
// ─────────────────────────────────────────────────────────────────────────

export const ARENA_WIDTH = 800
export const ARENA_HEIGHT = 600
export const CAR_RADIUS = 25
export const CAR_WIDTH = 50
export const CAR_HEIGHT = 30

// ─────────────────────────────────────────────────────────────────────────
// Physics
// ─────────────────────────────────────────────────────────────────────────

export const MAX_SPEED = 8
export const ACCELERATION = 0.5
export const FRICTION = 0.98
export const WALL_BOUNCE = 0.7
export const CAR_BOUNCE = 0.8
export const ROTATION_SPEED = 0.1

// ─────────────────────────────────────────────────────────────────────────
// Game loop
// ─────────────────────────────────────────────────────────────────────────

export const TICK_RATE = 60
export const TICK_INTERVAL = 1000 / TICK_RATE

// ─────────────────────────────────────────────────────────────────────────
// Collision
// ─────────────────────────────────────────────────────────────────────────

/** Minimum speed to score a front-hit. */
export const MIN_HIT_SPEED = 0.5

/** Duration of the hit flash effect (ms). */
export const HIT_EFFECT_DURATION = 300

/** Cooldown between scoring the same collision pair (ms). */
export const COLLISION_COOLDOWN = 500

// ─────────────────────────────────────────────────────────────────────────
// Color palette — 10 distinct car colors
// ─────────────────────────────────────────────────────────────────────────

export const CAR_COLORS = [
  "#FF6B6B", // Red
  "#FF9F43", // Orange
  "#FFEAA7", // Yellow
  "#26DE81", // Green
  "#4ECDC4", // Teal
  "#54A0FF", // Blue
  "#A55EEA", // Purple
  "#FFB8D0", // Pink
  "#2D3436", // Charcoal
  "#FFFFFF", // White
] as const

export type CarColor = (typeof CAR_COLORS)[number]
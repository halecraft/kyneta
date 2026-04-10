// ═══════════════════════════════════════════════════════════════════════════
//
//   Bumper Cars — Schema
//
//   Two documents, two merge strategies, zero CRDT dependencies.
//
//   This is the centerpiece file: it demonstrates that different data
//   in the same application can use different sync strategies, and the
//   Exchange handles them transparently.
//
//   • GameStateDoc  — json.bind (authoritative merge, server-authoritative)
//   • PlayerInputDoc — json.bind(ephemeral) (LWW broadcast, one per player)
//
//   The server is the single writer for game state (cars, scores, tick).
//   Clients only read it. No CRDT is needed — plain JS with authoritative
//   merge is simpler and correct.
//
//   If the game were peer-to-peer (no authoritative server), you'd use
//   loro.bind() with Schema.counter() for convergent concurrent score
//   increments. See the README for details.
//
// ═══════════════════════════════════════════════════════════════════════════

import { Schema, json } from "@kyneta/schema"

// ─────────────────────────────────────────────────────────────────────────
// Game state — plain JS, authoritative merge, server-authoritative.
//
// The server is the single writer. Cars, scores, and tick are all
// server-owned state that clients render but never mutate directly.
// ─────────────────────────────────────────────────────────────────────────

export const GameStateSchema = Schema.struct({
  cars: Schema.record(
    Schema.struct({
      x: Schema.number(),
      y: Schema.number(),
      vx: Schema.number(),
      vy: Schema.number(),
      rotation: Schema.number(),
      color: Schema.string(),
      name: Schema.string(),
      hitUntil: Schema.number(),
    }),
  ),
  scores: Schema.record(
    Schema.struct({
      name: Schema.string(),
      color: Schema.string(),
      bumps: Schema.number(),
    }),
  ),
  tick: Schema.number(),
})

export const GameStateDoc = json.bind(GameStateSchema)

// ─────────────────────────────────────────────────────────────────────────
// Player input — ephemeral, one doc per player.
//
// Each client writes joystick/keyboard state at ~20fps. The server
// reads all input docs every tick. Only the latest value matters.
// ─────────────────────────────────────────────────────────────────────────

export const PlayerInputSchema = Schema.struct({
  name: Schema.string(),
  color: Schema.string(),
  force: Schema.number(),
  angle: Schema.number(),
})

export const PlayerInputDoc = json.bind(PlayerInputSchema, "ephemeral")
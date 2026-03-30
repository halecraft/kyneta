// ═══════════════════════════════════════════════════════════════════════════
//
//   Bumper Cars — Game Loop (Imperative Shell)
//
//   Wires the pure tick() function to the Exchange. Follows the
//   Gather → Plan → Execute pattern:
//
//     1. Gather: read all input docs by calling each ref directly
//     2. Plan:   call tick() — pure function, no side effects
//     3. Execute: write results via change(gameStateDoc, ...)
//
//   Player lifecycle is managed externally via addPlayer / removePlayer,
//   called from the onDocDiscovered / onDocDismissed callbacks in server.ts.
//
// ═══════════════════════════════════════════════════════════════════════════

import { change } from "@kyneta/schema"
import type { Ref } from "@kyneta/schema"
import { TICK_INTERVAL } from "../constants.js"
import type { CarState, InputState } from "../types.js"
import { getSpawnPosition } from "./physics.js"
import { tick, type TickOutput } from "./tick.js"

// ─────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────

type PlayerEntry = {
  inputDoc: Ref<any>
  car: CarState
}

// ─────────────────────────────────────────────────────────────────────────
// GameLoop
// ─────────────────────────────────────────────────────────────────────────

export class GameLoop {
  readonly #gameStateDoc: Ref<any>
  readonly #players = new Map<string, PlayerEntry>()
  readonly #scores = new Map<string, number>()

  #tickCount = 0
  #intervalId: ReturnType<typeof setInterval> | null = null
  #recentCollisions = new Map<string, number>()

  constructor(gameStateDoc: Ref<any>) {
    this.#gameStateDoc = gameStateDoc
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Lifecycle
  // ═══════════════════════════════════════════════════════════════════════

  start(): void {
    if (this.#intervalId) return
    console.log(`  🎮 Game loop started (${TICK_INTERVAL}ms interval)`)
    this.#intervalId = setInterval(() => this.#update(), TICK_INTERVAL)
  }

  stop(): void {
    if (this.#intervalId) {
      clearInterval(this.#intervalId)
      this.#intervalId = null
      console.log("  🎮 Game loop stopped")
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Player management — called from server.ts callbacks
  // ═══════════════════════════════════════════════════════════════════════

  addPlayer(peerId: string, inputDoc: Ref<any>): void {
    if (this.#players.has(peerId)) return

    const existingCars = Array.from(this.#players.values()).map(e => e.car)
    const spawn = getSpawnPosition(existingCars)

    // Read initial identity from the input doc
    const input = inputDoc() as { name: string; color: string; force: number; angle: number }

    const car: CarState = {
      x: spawn.x,
      y: spawn.y,
      vx: 0,
      vy: 0,
      rotation: Math.random() * Math.PI * 2,
      color: input.color || "#4ECDC4",
      name: input.name || `Player-${peerId.slice(-4)}`,
      hitUntil: 0,
    }

    this.#players.set(peerId, { inputDoc, car })
    this.#scores.set(peerId, 0)

    console.log(`  🚗 ${car.name} joined at (${spawn.x.toFixed(0)}, ${spawn.y.toFixed(0)})`)
  }

  removePlayer(peerId: string): void {
    const entry = this.#players.get(peerId)
    if (!entry) return

    console.log(`  🚗 ${entry.car.name} left`)
    this.#players.delete(peerId)
    // Keep scores so they persist in the scoreboard after disconnect
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Main update — Gather → Plan → Execute
  // ═══════════════════════════════════════════════════════════════════════

  #update(): void {
    this.#tickCount++
    const now = Date.now()

    // ── Gather ────────────────────────────────────────────────────────
    // Read all input docs and build the cars + inputs maps for tick()

    const cars = new Map<string, CarState>()
    const inputs = new Map<string, InputState>()

    for (const [peerId, entry] of this.#players) {
      // Read the input doc — same callable ref API as the client
      const raw = entry.inputDoc() as {
        name: string
        color: string
        force: number
        angle: number
      }

      // Update car metadata if player changed name/color
      if (raw.name && raw.name !== entry.car.name) entry.car.name = raw.name
      if (raw.color && raw.color !== entry.car.color) entry.car.color = raw.color

      cars.set(peerId, entry.car)
      inputs.set(peerId, { force: raw.force, angle: raw.angle })
    }

    // ── Plan ──────────────────────────────────────────────────────────
    // Pure function — no side effects

    const result: TickOutput = tick({
      cars,
      inputs,
      recentCollisions: this.#recentCollisions,
      now,
    })

    this.#recentCollisions = result.recentCollisions

    // ── Execute ──────────────────────────────────────────────────────
    // Update scores for any collisions that scored this tick

    for (const collision of result.scoredCollisions) {
      for (const scorer of collision.scorers) {
        const prev = this.#scores.get(scorer) ?? 0
        this.#scores.set(scorer, prev + 1)
      }
    }

    // Build the full game state as a plain object, then replace atomically.
    // Using d.set({...}) instead of per-key d.cars.set()/d.cars.delete()
    // avoids dead-ref errors: individual .delete() marks stable refs as
    // dead, which causes "Ref access on deleted map entry" when the
    // changefeed fires on the receiving side. A single ReplaceChange at
    // the root replaces the entire store cleanly.
    const carsObject: Record<string, object> = {}
    for (const [peerId, car] of cars) {
      carsObject[peerId] = {
        x: car.x,
        y: car.y,
        vx: car.vx,
        vy: car.vy,
        rotation: car.rotation,
        color: car.color,
        name: car.name,
        hitUntil: car.hitUntil,
      }
    }

    const scoresObject: Record<string, object> = {}
    for (const [peerId, bumps] of this.#scores) {
      const entry = this.#players.get(peerId)
      scoresObject[peerId] = {
        name: entry?.car.name ?? peerId,
        color: entry?.car.color ?? "#4ECDC4",
        bumps,
      }
    }

    change(this.#gameStateDoc, (d: any) => {
      d.set({
        cars: carsObject,
        scores: scoresObject,
        tick: this.#tickCount,
      })
    })
  }
}
// ═══════════════════════════════════════════════════════════════════════════
//
//   Bumper Cars — Game Loop (Imperative Shell)
//
//   Wires the pure tick() function to the Exchange. Follows the
//   Gather → Plan → Execute pattern:
//
//     1. Gather: read all input docs by calling each ref directly
//     2. Plan:   call tick() — pure function, no side effects
//     3. Execute: write results via batch(gameStateDoc, ...)
//
//   Owns its Exchange subscriptions (doc-created, doc-removed,
//   peer-departed) so that server.ts is fully formed at construction
//   time — no temporal coupling via let-binding.
//
// ═══════════════════════════════════════════════════════════════════════════

import type { Exchange } from "@kyneta/exchange"
import type { Plain, Ref } from "@kyneta/schema"
import { batch } from "@kyneta/schema"
import { TICK_INTERVAL } from "../constants.js"
import {
  type GameStateSchema,
  PlayerInputDoc,
  type PlayerInputSchema,
} from "../schema.js"
import type { CarState, InputState } from "../types.js"
import { getSpawnPosition } from "./physics.js"
import { type TickOutput, tick } from "./tick.js"

// ─────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────

type GameState = Plain<typeof GameStateSchema>
type GameStateRef = Ref<typeof GameStateSchema>
type PlayerInputRef = Ref<typeof PlayerInputSchema>

type PlayerEntry = {
  inputDoc: PlayerInputRef
  car: CarState
}

type DepartedScore = {
  name: string
  color: string
  bumps: number
}

// ─────────────────────────────────────────────────────────────────────────
// GameLoop
// ─────────────────────────────────────────────────────────────────────────

export class GameLoop {
  readonly #exchange: Exchange
  readonly #gameStateDoc: GameStateRef
  readonly #players = new Map<string, PlayerEntry>()
  readonly #scores = new Map<string, number>()
  readonly #departedScores = new Map<string, DepartedScore>()

  #tickCount = 0
  #intervalId: ReturnType<typeof setInterval> | null = null
  #recentCollisions = new Map<string, number>()

  constructor(exchange: Exchange, gameStateDoc: GameStateRef) {
    this.#exchange = exchange
    this.#gameStateDoc = gameStateDoc
    this.#subscribeDocs()
    this.#subscribePeers()
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
  // Exchange subscriptions — private, set up once in constructor
  // ═══════════════════════════════════════════════════════════════════════

  #subscribeDocs(): void {
    this.#exchange.documents.subscribe(changeset => {
      for (const change of changeset.changes) {
        const docId = change.docId
        if (!docId.startsWith("input:")) continue

        const peerId = docId.slice("input:".length)

        if (change.type === "doc-created") {
          queueMicrotask(() => {
            if (this.#exchange.has(docId)) {
              const inputDoc = this.#exchange.get(docId, PlayerInputDoc)
              this.addPlayer(peerId, inputDoc)
            }
          })
        }

        if (change.type === "doc-removed") {
          this.removePlayer(peerId)
        }
      }
    })
  }

  #subscribePeers(): void {
    this.#exchange.peers.subscribe(changeset => {
      for (const change of changeset.changes) {
        if (change.type !== "peer-departed") continue
        const peerId = change.peer.peerId
        this.removePlayer(peerId)
        const inputDocId = `input:${peerId}`
        if (this.#exchange.has(inputDocId)) {
          this.#exchange.destroy(inputDocId)
        }
      }
    })
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Player management — called from subscription callbacks
  // ═══════════════════════════════════════════════════════════════════════

  addPlayer(peerId: string, inputDoc: PlayerInputRef): void {
    if (this.#players.has(peerId)) return

    // Intentionally reads #players before adding the new player,
    // so spawn position avoids all existing cars.
    const spawn = getSpawnPosition(
      Array.from(this.#players.values()).map(e => e.car),
    )

    // Initialize with safe defaults. The first #update gather pass
    // will populate real name and color from the input doc.
    const car: CarState = {
      x: spawn.x,
      y: spawn.y,
      vx: 0,
      vy: 0,
      rotation: Math.random() * Math.PI * 2,
      color: "#4ECDC4",
      name: "",
      hitUntil: 0,
    }

    this.#players.set(peerId, { inputDoc, car })
    this.#scores.set(peerId, 0)

    console.log(
      `  🚗 Player joined at (${spawn.x.toFixed(0)}, ${spawn.y.toFixed(0)})`,
    )
  }

  removePlayer(peerId: string): void {
    const entry = this.#players.get(peerId)
    if (!entry) return

    console.log(`  🚗 ${entry.car.name || "Player"} left`)

    // Snapshot the departed player's score so the scoreboard
    // retains their name and color after they leave.
    const bumps = this.#scores.get(peerId) ?? 0
    this.#departedScores.set(peerId, {
      name: entry.car.name,
      color: entry.car.color,
      bumps,
    })

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
      const raw = entry.inputDoc()

      // Update car metadata if player changed name/color.
      // We mutate entry.car here because tick() receives this exact
      // object and spreads it into new CarState objects — the mutation
      // is harmless and simpler than rebuilding the car before tick().
      if (raw.name && raw.name !== entry.car.name) entry.car.name = raw.name
      if (raw.color && raw.color !== entry.car.color)
        entry.car.color = raw.color

      cars.set(peerId, entry.car)
      inputs.set(peerId, { force: raw.force, angle: raw.angle })
    }

    // ── Plan ──────────────────────────────────────────────────────────
    // Pure function — no side effects, no mutation

    const result: TickOutput = tick({
      cars,
      inputs,
      recentCollisions: this.#recentCollisions,
      now,
    })

    // Replace cars in #players with the new pure state
    for (const [peerId, car] of result.cars) {
      const entry = this.#players.get(peerId)
      if (entry) entry.car = car
    }

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
    const carsObject: GameState["cars"] = {}
    for (const [peerId, car] of result.cars) {
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

    const scoresObject: GameState["scores"] = {}
    for (const [peerId, bumps] of this.#scores) {
      const entry = this.#players.get(peerId)
      const departed = this.#departedScores.get(peerId)
      scoresObject[peerId] = {
        name: entry?.car.name ?? departed?.name ?? peerId,
        color: entry?.car.color ?? departed?.color ?? "#4ECDC4",
        bumps,
      }
    }

    batch(this.#gameStateDoc, d => {
      d.set({
        cars: carsObject,
        scores: scoresObject,
        tick: this.#tickCount,
      })
    })
  }
}

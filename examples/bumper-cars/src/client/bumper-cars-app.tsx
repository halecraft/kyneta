// ═══════════════════════════════════════════════════════════════════════════
//
//   Bumper Cars — Main App Component
//
//   Wires together the Exchange documents, input hooks, and UI components.
//
//   Two documents, two binding targets:
//     • game-state (json.bind, authoritative) — server-authoritative cars + scores
//     • input:${peerId} (ephemeral.bind, field-level LWW) — this player's joystick input
//
//   The client reads game state reactively via useValue() and writes
//   input via batch() through the useInputSender hook.
//
// ═══════════════════════════════════════════════════════════════════════════

import {
  batch,
  useDocument,
  useExchange,
  useSyncState,
  useValue,
} from "@kyneta/react"
import type { Ref } from "@kyneta/schema"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { CAR_COLORS, type CarColor } from "../constants.js"
import type { PlayerInputSchema } from "../schema.js"
import { GameStateDoc, PlayerInputDoc } from "../schema.js"
import type { CarState, PlayerScore } from "../types.js"
import { ArenaCanvas } from "./components/arena-canvas.js"
import { JoinScreen } from "./components/join-screen.js"
import { PlayerList } from "./components/player-list.js"
import { Scoreboard } from "./components/scoreboard.js"
import { useInputSender } from "./hooks/use-input-sender.js"
import { useJoystick } from "./hooks/use-joystick.js"
import { useKeyboardInput } from "./hooks/use-keyboard-input.js"
import { combineInputs, getActivePlayers, sortScores } from "./logic.js"

type BumperCarsAppProps = {
  initialName: string
  initialColor: string | null
}

export default function BumperCarsApp({
  initialName,
  initialColor,
}: BumperCarsAppProps) {
  const exchange = useExchange()
  const myPeerId = exchange.peerId

  // ── Player state ─────────────────────────────────────────────────────

  const [hasJoined, setHasJoined] = useState(false)
  const [playerName, setPlayerName] = useState(initialName)
  const [playerColor, setPlayerColor] = useState<CarColor>(
    (initialColor as CarColor) ||
      CAR_COLORS[Math.floor(Math.random() * CAR_COLORS.length)],
  )

  // ── Documents ────────────────────────────────────────────────────────

  const gameStateDoc = useDocument("game-state", GameStateDoc)
  // Ephemeral input doc is managed imperatively via exchange.get/destroy,
  // not useDocument, because its lifetime is controlled by user intent
  // (join/leave) rather than component mount. See Task 1.1 in plan.
  const inputDocRef = useRef<Ref<typeof PlayerInputSchema> | null>(null)

  // ── Reactive game state ──────────────────────────────────────────────

  const gameState = useValue(gameStateDoc) as {
    cars: Record<string, CarState>
    scores: Record<string, PlayerScore>
    tick: number
  }

  const cars = gameState?.cars ?? {}
  const scores = gameState?.scores ?? {}

  // ── Sync status ──────────────────────────────────────────────────────

  const peerStates = useSyncState(gameStateDoc)
  const isSynced = peerStates.some(s => s.state === "synced")

  // ── Input ────────────────────────────────────────────────────────────

  const { input: joystickInput, zoneRef } = useJoystick()
  const keyboardInput = useKeyboardInput()

  const currentInput = useMemo(
    () => combineInputs(joystickInput, keyboardInput),
    [joystickInput, keyboardInput],
  )

  // Throttled input sender — writes to the ephemeral input doc
  useInputSender({
    inputDocRef,
    hasJoined,
    playerName,
    playerColor,
    input: currentInput,
  })

  // ── Join / Leave ─────────────────────────────────────────────────────

  const handleJoin = useCallback(
    (name: string, color: CarColor) => {
      setPlayerName(name)
      setPlayerColor(color)

      // Save to localStorage
      localStorage.setItem("bumper-cars-name", name)
      localStorage.setItem("bumper-cars-color", color)

      // Create the ephemeral input doc via imperative Exchange API.
      // useDocument is for persistent docs; ephemeral lifecycle is
      // owned by user intent (join/leave), not component mount.
      const doc = exchange.get(`input:${myPeerId}`, PlayerInputDoc)
      inputDocRef.current = doc

      batch(doc, d => {
        d.name.set(name)
        d.color.set(color)
        d.force.set(0)
        d.angle.set(0)
      })

      setHasJoined(true)
    },
    [exchange, myPeerId],
  )

  const handleLeave = useCallback(() => {
    // Destroy the ephemeral input doc to signal departure.
    // The server reacts to doc-removed, not empty-string name.
    exchange.destroy(`input:${myPeerId}`)
    inputDocRef.current = null
    setHasJoined(false)
  }, [exchange, myPeerId])

  // Escape key to leave the game
  useEffect(() => {
    if (!hasJoined) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        handleLeave()
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [hasJoined, handleLeave])

  // ── Derived data for components ──────────────────────────────────────

  const sortedScores = useMemo(() => sortScores(scores, 5), [scores])

  const activePlayers = useMemo(() => getActivePlayers(cars), [cars])

  // ── Render ───────────────────────────────────────────────────────────

  return (
    <div className="arena-container">
      {/* Scoreboard */}
      <Scoreboard scores={sortedScores} />

      {/* Canvas wrapper */}
      <div className="canvas-wrapper">
        {/* Arena canvas */}
        <ArenaCanvas cars={cars} myPeerId={myPeerId} />

        {/* Player list */}
        <PlayerList players={activePlayers} myPeerId={myPeerId} />

        {/* Joystick zone (only when joined) */}
        {hasJoined && <div ref={zoneRef} className="joystick-zone" />}

        {/* Controls hint */}
        {hasJoined && (
          <div className="controls-hint">
            Drag to move • WASD/Arrows • ESC to leave
          </div>
        )}

        {/* Sync indicator */}
        {!isSynced && hasJoined && (
          <div className="sync-indicator">⏳ Connecting...</div>
        )}

        {/* Join screen overlay */}
        {!hasJoined && (
          <JoinScreen
            initialName={playerName}
            initialColor={playerColor}
            onJoin={handleJoin}
            canJoin={true}
          />
        )}
      </div>
    </div>
  )
}

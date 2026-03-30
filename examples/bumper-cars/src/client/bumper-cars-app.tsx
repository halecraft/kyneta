// ═══════════════════════════════════════════════════════════════════════════
//
//   Bumper Cars — Main App Component
//
//   Wires together the Exchange documents, input hooks, and UI components.
//
//   Two documents, two merge strategies:
//     • game-state (bindPlain, sequential) — server-authoritative cars + scores
//     • input:${peerId} (bindEphemeral, LWW) — this player's joystick input
//
//   The client reads game state reactively via useValue() and writes
//   input via change() through the useInputSender hook.
//
// ═══════════════════════════════════════════════════════════════════════════

import { useCallback, useEffect, useMemo, useState } from "react"
import {
  useDocument,
  useExchange,
  useValue,
  useSyncStatus,
  change,
} from "@kyneta/react"
import { CAR_COLORS, type CarColor } from "../constants.js"
import { GameStateDoc, PlayerInputDoc } from "../schema.js"
import type { CarState, PlayerScore } from "../types.js"
import { ArenaCanvas } from "./components/arena-canvas.js"
import { JoinScreen } from "./components/join-screen.js"
import { PlayerList } from "./components/player-list.js"
import { Scoreboard } from "./components/scoreboard.js"
import { useJoystick } from "./hooks/use-joystick.js"
import { useKeyboardInput } from "./hooks/use-keyboard-input.js"
import { useInputSender } from "./hooks/use-input-sender.js"
import { combineInputs, getActivePlayers, sortScores, ZERO_INPUT } from "./logic.js"

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
  const inputDoc = useDocument(`input:${myPeerId}`, PlayerInputDoc)

  // ── Reactive game state ──────────────────────────────────────────────

  const gameState = useValue(gameStateDoc) as {
    cars: Record<string, CarState>
    scores: Record<string, PlayerScore>
    tick: number
  }

  const cars = gameState?.cars ?? {}
  const scores = gameState?.scores ?? {}

  // ── Sync status ──────────────────────────────────────────────────────

  const readyStates = useSyncStatus(gameStateDoc)
  const isSynced = readyStates.some(s => s.status === "synced")

  // ── Input ────────────────────────────────────────────────────────────

  const { input: joystickInput, zoneRef } = useJoystick()
  const keyboardInput = useKeyboardInput()

  const currentInput = useMemo(
    () => combineInputs(joystickInput, keyboardInput),
    [joystickInput, keyboardInput],
  )

  // Throttled input sender — writes to the LWW input doc
  useInputSender({
    inputDoc,
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

      // Write initial input state so the server sees name + color
      change(inputDoc, (d: any) => {
        d.name.set(name)
        d.color.set(color)
        d.force.set(0)
        d.angle.set(0)
      })

      setHasJoined(true)
    },
    [inputDoc],
  )

  const handleLeave = useCallback(() => {
    // Write zero input so the server knows we stopped
    change(inputDoc, (d: any) => {
      d.name.set("")
      d.color.set(playerColor)
      d.force.set(0)
      d.angle.set(0)
    })
    setHasJoined(false)
  }, [inputDoc, playerColor])

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

  const activePlayers = useMemo(
    () => getActivePlayers(cars),
    [cars],
  )

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
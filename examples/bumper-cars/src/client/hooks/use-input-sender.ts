// ═══════════════════════════════════════════════════════════════════════════
//
//   Bumper Cars — Input Sender Hook
//
//   Throttled writer that sends joystick/keyboard input to the player's
//   input doc via change(). Uses the pure shouldSendInputUpdate() from
//   logic.ts to decide whether to fire.
//
//   - Throttles to ~20fps (50ms interval)
//   - Sends immediately on zero-force (joystick release) for responsiveness
//   - Only sends when input actually changes
//
//   Adapted from vendor/loro-extended/examples/bumper-cars/src/client/hooks/use-presence-sender.ts
//   replacing sync(doc).presence.setSelf(...) with change(inputDoc, ...).
//
// ═══════════════════════════════════════════════════════════════════════════

import { useEffect, useRef } from "react"
import { change } from "@kyneta/react"
import type { InputState } from "../../types.js"
import { shouldSendInputUpdate, ZERO_INPUT } from "../logic.js"

/** Throttle interval for input updates (ms) — ~20 updates per second. */
const INPUT_UPDATE_INTERVAL = 50

type UseInputSenderOptions = {
  /** The player's input document ref (from useDocument). */
  inputDoc: any
  /** Whether the player has joined the game. */
  hasJoined: boolean
  /** Player's display name. */
  playerName: string
  /** Player's car color. */
  playerColor: string
  /** Current combined input state (from joystick + keyboard). */
  input: InputState
}

/**
 * Hook that handles throttled input document updates.
 *
 * Writes the player's current input state to their LWW input doc
 * via change(). The Exchange broadcasts the snapshot to the server
 * automatically via the ephemeral sync protocol.
 */
export function useInputSender({
  inputDoc,
  hasJoined,
  playerName,
  playerColor,
  input,
}: UseInputSenderOptions): void {
  // Track last sent input to avoid unnecessary updates
  const lastSentInputRef = useRef<InputState>(ZERO_INPUT)
  const lastUpdateTimeRef = useRef(0)

  useEffect(() => {
    if (!hasJoined) return

    const now = Date.now()

    if (
      !shouldSendInputUpdate(
        input,
        lastSentInputRef.current,
        lastUpdateTimeRef.current,
        now,
        INPUT_UPDATE_INTERVAL,
      )
    ) {
      return
    }

    // Update tracking refs
    lastSentInputRef.current = { ...input }
    lastUpdateTimeRef.current = now

    // Write to the input doc — the Exchange broadcasts via LWW
    change(inputDoc, (d: any) => {
      d.name.set(playerName)
      d.color.set(playerColor)
      d.force.set(input.force)
      d.angle.set(input.angle)
    })
  }, [hasJoined, playerName, playerColor, input, inputDoc])
}
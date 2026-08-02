// peer — entry point for the unix-socket-sync example.
//
// Run with: bun run peer
//
// Creates an Exchange, registers the config doc, starts the unix
// socket peer, and runs the TUI. Multiple instances share state
// over a single socket path. Kill any instance and the rest heal.

import { Exchange } from "@kyneta/exchange"
import { randomPeerId } from "@kyneta/random"
import { subscribe } from "@kyneta/schema"
import { createUnixSocketPeer } from "@kyneta/unix-socket-transport"
import {
  type Direction,
  fields,
  stepBoolean,
  stepNumber,
  stepString,
} from "./fields.js"
import { ConfigDoc } from "./schema.js"
import { type PeerInfo, render, startInput } from "./tui.js"

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SOCKET_PATH = process.env.SOCKET_PATH ?? "/tmp/kyneta-sync.sock"
const peerId = `peer-${randomPeerId()}`

// ---------------------------------------------------------------------------
// Exchange + unix socket peer
// ---------------------------------------------------------------------------

// The leaderless peer IS a transport — hand it to the Exchange like any
// other. It probes the socket path and becomes the listener or a connector,
// healing in place if the listener dies. No manual transport wiring.
const peer = createUnixSocketPeer({ path: SOCKET_PATH })

const exchange = new Exchange({
  id: { peerId, name: peerId },
  transports: [peer],
})

const doc = exchange.get("config", ConfigDoc)

// The TUI reads and writes config *scalar* fields by dynamic string key. Each
// is a scalar ref — callable to read, `.set()` to write. Narrow the typed doc
// to this dynamic view here, rather than scattering `as any` (which also hid
// the statically-typed `doc.peers` accesses below).
type ScalarFieldRef = { (): unknown; set(value: unknown): void }
const scalarFields = doc as unknown as Record<string, ScalarFieldRef>

// Write our presence into the document — a single mutation auto-commits.
doc.peers.set(peerId, true)

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let selectedIndex = 0

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function rerender() {
  // Read current values from the document
  const values: Record<string, unknown> = {}
  for (const field of fields) {
    values[field.key] = scalarFields[field.key]()
  }

  // Read peer info from the document's peers record
  const peersRecord = doc.peers()
  const peerIds = Object.keys(peersRecord).filter(id => peersRecord[id])

  const info: PeerInfo = {
    peerIds,
    role: peer.role,
  }

  process.stdout.write(render(fields, values, selectedIndex, info))
}

// Subscribe to document changes for re-render
subscribe(doc, () => rerender())

// Subscribe to exchange.peers for cleanup
exchange.peers.subscribe(changeset => {
  for (const peerChange of changeset.changes) {
    if (peerChange.type === "peer-departed") {
      // Remove departed peer from the document's peers record (single write).
      doc.peers.delete(peerChange.peer.peerId)
    }
  }
  // Re-render after cleanup
  rerender()
})

// Initial render
rerender()

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

const stopInput = startInput(action => {
  switch (action) {
    case "quit":
      cleanup()
      break
    case "up":
      selectedIndex = Math.max(0, selectedIndex - 1)
      rerender()
      break
    case "down":
      selectedIndex = Math.min(fields.length - 1, selectedIndex + 1)
      rerender()
      break
    case "left":
    case "right":
      applyChange(action)
      rerender()
      break
  }
})

function applyChange(direction: Direction) {
  const field = fields[selectedIndex]
  const currentValue = (doc as any)[field.key]()

  let newValue: unknown
  switch (field.type) {
    case "boolean":
      newValue = stepBoolean(currentValue as boolean, direction)
      break
    case "string":
      newValue = stepString(currentValue as string, field.options, direction)
      break
    case "number":
      newValue = stepNumber(
        currentValue as number,
        field.step,
        field.min,
        field.max,
        direction,
      )
      break
  }

  // Single mutation by dynamic key — write directly.
  scalarFields[field.key].set(newValue)
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

async function cleanup() {
  stopInput()
  // Remove our presence from the document (single write).
  doc.peers.delete(peerId)
  // exchange.shutdown() stops the peer transport like any other.
  await exchange.shutdown()
  // Clear screen and show cursor
  process.stdout.write("\x1b[2J\x1b[H\x1b[?25h")
  process.exit(0)
}

// Handle SIGINT/SIGTERM
process.on("SIGINT", () => cleanup())
process.on("SIGTERM", () => cleanup())

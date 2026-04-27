// peer — entry point for the unix-socket-sync example.
//
// Run with: bun run peer
//
// Creates an Exchange, registers the config doc, starts the unix
// socket peer, and runs the TUI. Multiple instances share state
// over a single socket path. Kill any instance and the rest heal.

import { Exchange } from "@kyneta/exchange"
import { randomPeerId } from "@kyneta/random"
import { change, subscribe } from "@kyneta/schema"
import { createUnixSocketPeer } from "@kyneta/unix-socket-transport"
import { ConfigDoc } from "./schema.js"
import { fields, stepBoolean, stepString, stepNumber, type Direction } from "./fields.js"
import { render, startInput, type PeerInfo } from "./tui.js"

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SOCKET_PATH = process.env.SOCKET_PATH ?? "/tmp/kyneta-sync.sock"
const peerId = `peer-${randomPeerId()}`

// ---------------------------------------------------------------------------
// Exchange + document
// ---------------------------------------------------------------------------

const exchange = new Exchange({
  id: { peerId, name: peerId },
})

const doc = exchange.get("config", ConfigDoc)

// Write our presence into the document
change(doc, (d: any) => {
  d.peers.set(peerId, true)
})

// ---------------------------------------------------------------------------
// Unix socket peer
// ---------------------------------------------------------------------------

const peer = createUnixSocketPeer(exchange, { path: SOCKET_PATH })

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
    values[field.key] = (doc as any)[field.key]()
  }

  // Read peer info from the document's peers record
  const peersRecord = (doc as any).peers() as Record<string, boolean>
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
exchange.peers.subscribe((changeset) => {
  for (const peerChange of changeset.changes) {
    if (peerChange.type === "peer-departed") {
      // Remove departed peer from the document's peers record
      change(doc, (d: any) => {
        d.peers.delete(peerChange.peer.peerId)
      })
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

const stopInput = startInput((action) => {
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
      newValue = stepNumber(currentValue as number, field.step, field.min, field.max, direction)
      break
  }

  change(doc, (d: any) => {
    d[field.key].set(newValue)
  })
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

async function cleanup() {
  stopInput()
  // Remove our presence from the document
  change(doc, (d: any) => {
    d.peers.delete(peerId)
  })
  await peer.dispose()
  await exchange.shutdown()
  // Clear screen and show cursor
  process.stdout.write("\x1b[2J\x1b[H\x1b[?25h")
  process.exit(0)
}

// Handle SIGINT/SIGTERM
process.on("SIGINT", () => cleanup())
process.on("SIGTERM", () => cleanup())
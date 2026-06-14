// ═══════════════════════════════════════════════════════════════════════════
//
//   Bumper Cars — Client Entry Point
//
//   Creates the Exchange via ExchangeProvider and renders the app.
//   PeerId is persisted in localStorage so reconnecting players keep
//   their identity (and their car color / name).
//
//   Run with:  bun src/server.ts  (serves the built client)
//
// ═══════════════════════════════════════════════════════════════════════════

import { createRoot } from "react-dom/client"
import { ExchangeProvider } from "@kyneta/react"
import { Exchange, persistentPeerId } from "@kyneta/exchange"
import { createWebsocketClient } from "@kyneta/websocket-transport/browser"
import BumperCarsApp from "./client/bumper-cars-app.js"
import "./index.css"

// ─────────────────────────────────────────────────────────────────────────
// Persistent peer identity
// ─────────────────────────────────────────────────────────────────────────

const NAME_KEY = "bumper-cars-name"
const COLOR_KEY = "bumper-cars-color"

function getOrCreate(key: string, fallback: () => string): string {
  let value = localStorage.getItem(key)
  if (!value) {
    value = fallback()
    localStorage.setItem(key, value)
  }
  return value
}

const peerId = persistentPeerId("bumper-cars-peer-id")

const initialName = getOrCreate(NAME_KEY, () => `Player-${peerId.slice(-4)}`)
const initialColor = localStorage.getItem(COLOR_KEY)

// ─────────────────────────────────────────────────────────────────────────
// Mount
// ─────────────────────────────────────────────────────────────────────────

const rootEl = document.getElementById("root")
if (!rootEl) throw new Error("#root not found")

const exchange = new Exchange({
  id: { peerId, name: initialName, type: "user" },
  transports: [
    createWebsocketClient({ url: `ws://${location.host}/ws`, WebSocket }),
  ],
})

createRoot(rootEl).render(
  <ExchangeProvider exchange={exchange}>
    <BumperCarsApp initialName={initialName} initialColor={initialColor} />
  </ExchangeProvider>,
)
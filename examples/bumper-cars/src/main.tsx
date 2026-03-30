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
import { createWebsocketClient } from "@kyneta/websocket-network-adapter/client"
import BumperCarsApp from "./client/bumper-cars-app.js"
import "./index.css"

// ─────────────────────────────────────────────────────────────────────────
// Persistent peer identity
// ─────────────────────────────────────────────────────────────────────────

const PEER_ID_KEY = "bumper-cars-peer-id"
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

const peerId = getOrCreate(PEER_ID_KEY, () =>
  crypto.randomUUID().replace(/-/g, "").slice(0, 16),
)

const initialName = getOrCreate(NAME_KEY, () => `Player-${peerId.slice(-4)}`)
const initialColor = localStorage.getItem(COLOR_KEY)

// ─────────────────────────────────────────────────────────────────────────
// Mount
// ─────────────────────────────────────────────────────────────────────────

const config = {
  identity: { peerId, name: initialName, type: "user" as const },
  adapters: [createWebsocketClient({ url: `ws://${location.host}/ws` })],
}

createRoot(document.getElementById("root")!).render(
  <ExchangeProvider config={config}>
    <BumperCarsApp initialName={initialName} initialColor={initialColor} />
  </ExchangeProvider>,
)
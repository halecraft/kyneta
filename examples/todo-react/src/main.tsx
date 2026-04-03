// ═══════════════════════════════════════════════════════════════════════════
//
//   Todo React — Client Bootstrap
//
//   Connects to the server's Exchange via WebSocket, wraps the app
//   in ExchangeProvider, and mounts the React tree.
//
//   Import story:
//     @kyneta/react                        — all React-level APIs
//     @kyneta/websocket-transport    — the transport
//
// ═══════════════════════════════════════════════════════════════════════════

import { createRoot } from "react-dom/client"
import { ExchangeProvider } from "@kyneta/react"
import { createWebsocketClient } from "@kyneta/websocket-transport/client"
import { App } from "./app.js"
import "../style.css"

// ─────────────────────────────────────────────────────────────────────────
// Persistent peer identity
//
// The peerId identifies this browser tab as a participant in causal
// history. It must be stable across page reloads for correct CRDT
// operation (version vector continuity, no phantom peer entries).
// ─────────────────────────────────────────────────────────────────────────

const PEER_ID_KEY = "todo-react-peer-id"

function getOrCreatePeerId(): string {
  let peerId = localStorage.getItem(PEER_ID_KEY)
  if (!peerId) {
    peerId = crypto.randomUUID().replace(/-/g, "").slice(0, 16)
    localStorage.setItem(PEER_ID_KEY, peerId)
  }
  return peerId
}

// ─────────────────────────────────────────────────────────────────────────
// Mount — ExchangeProvider creates the Exchange from config
// ─────────────────────────────────────────────────────────────────────────

createRoot(document.getElementById("root")!).render(
  <ExchangeProvider
    config={{
      identity: { peerId: getOrCreatePeerId() },
      transports: [createWebsocketClient({ url: `ws://${location.host}/ws` })],
    }}
  >
    <App />
  </ExchangeProvider>,
)
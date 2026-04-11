// ═══════════════════════════════════════════════════════════════════════════
//
//   Encrafte — Client Bootstrap
//
//   Connects to the server's Exchange via WebSocket, wraps the app
//   in ExchangeProvider, and mounts the React tree.
//
// ═══════════════════════════════════════════════════════════════════════════

import { persistentPeerId } from "@kyneta/exchange"
import { ExchangeProvider } from "@kyneta/react"
import { createWebsocketClient } from "@kyneta/websocket-transport/client"
import { createRoot } from "react-dom/client"
import { App } from "./app.jsx"
import "./style.css"

// ─────────────────────────────────────────────────────────────────────────
// Mount — ExchangeProvider creates the Exchange from config
// ─────────────────────────────────────────────────────────────────────────

const root = document.getElementById("root")
if (!root) throw new Error("Missing #root element")

createRoot(root).render(
  <ExchangeProvider
    config={{
      identity: { peerId: persistentPeerId("encrafte-peer-id") },
      transports: [createWebsocketClient({ url: `ws://${location.host}/ws` })],
    }}
  >
    <App />
  </ExchangeProvider>,
)

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
import { persistentPeerId } from "@kyneta/exchange"
import { createWebsocketClient } from "@kyneta/websocket-transport/client"
import { App } from "./app.js"
import "../style.css"

// ─────────────────────────────────────────────────────────────────────────
// Mount — ExchangeProvider creates the Exchange from config
// ─────────────────────────────────────────────────────────────────────────

createRoot(document.getElementById("root")!).render(
  <ExchangeProvider
    config={{
      identity: { peerId: persistentPeerId("todo-react-peer-id") },
      transports: [createWebsocketClient({ url: `ws://${location.host}/ws` })],
    }}
  >
    <App />
  </ExchangeProvider>,
)
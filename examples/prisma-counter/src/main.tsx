// ═══════════════════════════════════════════════════════════════════════════
//
//   Prisma Counter — Client Bootstrap
//
//   Connects to the server's Exchange via WebSocket, wraps the app
//   in ExchangeProvider, and mounts the React tree.
//
//   Import story:
//     @kyneta/react                     — all React-level APIs
//     @kyneta/websocket-transport — the transport
//
// ═══════════════════════════════════════════════════════════════════════════

import { createRoot } from "react-dom/client"
import { ExchangeProvider } from "@kyneta/react"
import { Exchange, persistentPeerId } from "@kyneta/exchange"
import { createWebsocketClient } from "@kyneta/websocket-transport/browser"
import { App } from "./app.js"
import "../style.css"

// ─────────────────────────────────────────────────────────────────────────
// Mount — Exchange is created once and provided to the React tree
// ─────────────────────────────────────────────────────────────────────────

const exchange = new Exchange({
  id: persistentPeerId("counter-peer-id"),
  transports: [
    createWebsocketClient({ url: `ws://${location.host}/ws`, WebSocket }),
  ],
})

createRoot(document.getElementById("root")!).render(
  <ExchangeProvider exchange={exchange}>
    <App />
  </ExchangeProvider>,
)

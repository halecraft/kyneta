// ═══════════════════════════════════════════════════════════════════════════
//
//   Todo React — Client Bootstrap
//
//   Connects to the server's Exchange via WebSocket, wraps the app
//   in ExchangeProvider, and mounts the React tree.
//
//   Import story:
//     @kyneta/react                        — all React-level APIs
//     @kyneta/websocket-network-adapter    — the transport
//
// ═══════════════════════════════════════════════════════════════════════════

import { createRoot } from "react-dom/client"
import { ExchangeProvider } from "@kyneta/react"
import { WebsocketClientAdapter } from "@kyneta/websocket-network-adapter/client"
import { App } from "./app.js"
import "../style.css"

// ─────────────────────────────────────────────────────────────────────────
// 1. Network Adapter — WebSocket client adapter
// ─────────────────────────────────────────────────────────────────────────

const wsAdapter = new WebsocketClientAdapter({
  url: `ws://${location.host}/ws`,
})

// ─────────────────────────────────────────────────────────────────────────
// 2. Mount — ExchangeProvider creates the Exchange from config
// ─────────────────────────────────────────────────────────────────────────

createRoot(document.getElementById("root")!).render(
  <ExchangeProvider config={{ adapters: [wsAdapter] }}>
    <App />
  </ExchangeProvider>,
)
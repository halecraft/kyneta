// ═══════════════════════════════════════════════════════════════════════════
//
//   Todo — Client Bootstrap
//
//   Connects to the server's Exchange via WebSocket, gets the
//   collaborative todo document, and mounts the Cast view.
//
// ═══════════════════════════════════════════════════════════════════════════

import { mount } from "@kyneta/cast"
import { Exchange } from "@kyneta/exchange"
import { WebsocketClientAdapter } from "@kyneta/websocket-transport/client"
import { createApp } from "./app.js"
import { TodoDoc } from "./schema.js"

// ─────────────────────────────────────────────────────────────────────────
// 1. Transport — WebSocket client adapter
// ─────────────────────────────────────────────────────────────────────────

const wsAdapter = new WebsocketClientAdapter({
  url: `ws://${location.host}/ws`,
})

// ─────────────────────────────────────────────────────────────────────────
// 2. Exchange — client-side sync
// ─────────────────────────────────────────────────────────────────────────

const exchange = new Exchange({
  adapters: [wsAdapter],
})

// ─────────────────────────────────────────────────────────────────────────
// 3. Document — get (or create) the collaborative todo doc
// ─────────────────────────────────────────────────────────────────────────

const doc = exchange.get("todos", TodoDoc)

// ─────────────────────────────────────────────────────────────────────────
// 4. Mount — render the Cast view into the DOM
// ─────────────────────────────────────────────────────────────────────────

const app = createApp(doc)
mount(app, document.getElementById("root")!)
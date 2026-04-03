// ═══════════════════════════════════════════════════════════════════════════
//
//   Todo — Client Bootstrap
//
//   Connects to the server's Exchange via WebSocket, gets the
//   collaborative todo document, and mounts the Cast view.
//
// ═══════════════════════════════════════════════════════════════════════════

import { mount } from "@kyneta/cast"
import { Exchange, persistentPeerId } from "@kyneta/exchange"
import { createWebsocketClient } from "@kyneta/websocket-transport/client"
import { createApp } from "./app.js"
import { TodoDoc } from "./schema.js"

// ─────────────────────────────────────────────────────────────────────────
// 1. Exchange — client-side sync
// ─────────────────────────────────────────────────────────────────────────

const exchange = new Exchange({
  identity: { peerId: persistentPeerId("todo-peer-id") },
  transports: [createWebsocketClient({ url: `ws://${location.host}/ws` })],
})

// ─────────────────────────────────────────────────────────────────────────
// 2. Document — get (or create) the collaborative todo doc
// ─────────────────────────────────────────────────────────────────────────

const doc = exchange.get("todos", TodoDoc)

// ─────────────────────────────────────────────────────────────────────────
// 3. Mount — render the Cast view into the DOM
// ─────────────────────────────────────────────────────────────────────────

const app = createApp(doc)
mount(app, document.getElementById("root")!)

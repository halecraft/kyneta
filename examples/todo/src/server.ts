// ═══════════════════════════════════════════════════════════════════════════
//
//   Todo — Bun Server
//
//   Single entry point that:
//   1. Creates a server-side Exchange with WebSocket network adapter
//   2. Registers the collaborative todo document
//   3. Builds the client app (+ optional brotli pre-compression)
//   4. Serves static files from dist/ and upgrades /ws to WebSocket
//      — serves .br pre-compressed files when Accept-Encoding: br
//
//   Run with:  bun src/server.ts
//
// ═══════════════════════════════════════════════════════════════════════════

/// <reference types="bun-types" />

import { Exchange } from "@kyneta/exchange"
import { WebsocketServerTransport } from "@kyneta/websocket-transport/server"
import {
  createBunWebsocketHandlers,
  type BunWebsocketData,
} from "@kyneta/websocket-transport/bun"
import { TodoDoc } from "./schema.js"
import { serveDist } from "@kyneta/bun-server"
import { build } from "./build.js"

// ─────────────────────────────────────────────────────────────────────────
// 1. Exchange — server-side sync hub
// ─────────────────────────────────────────────────────────────────────────

const serverTransport = new WebsocketServerTransport()

const exchange = new Exchange({
  id: { peerId: "todo-server", name: "server" },
  transports: [() => serverTransport],
})

// Register the todo document. The server holds the authoritative copy.
// When clients connect, the Exchange automatically syncs via the
// three-message protocol (discover → interest → offer).
exchange.get("todos", TodoDoc)

// ─────────────────────────────────────────────────────────────────────────
// 2. Build — compile the client app + optional brotli pre-compression
// ─────────────────────────────────────────────────────────────────────────

await build()

// ─────────────────────────────────────────────────────────────────────────
// 3. Serve — HTTP for static files, WebSocket for sync
// ─────────────────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT ?? 5173)

Bun.serve<BunWebsocketData>({
  port: PORT,

  async fetch(req, server) {
    const url = new URL(req.url)

    // WebSocket upgrade at /ws
    if (url.pathname === "/ws") {
      if (server.upgrade(req, { data: { handlers: {} } })) return
      return new Response("WebSocket upgrade failed", { status: 400 })
    }

    return serveDist(req, "./dist")
  },

  websocket: createBunWebsocketHandlers(serverTransport),
})

console.log(`\n  ✅ Todo dev server`)
console.log(`     http://localhost:${PORT}/`)
console.log(`     WebSocket: ws://localhost:${PORT}/ws\n`)

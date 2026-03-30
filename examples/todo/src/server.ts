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
import { WebsocketServerAdapter } from "@kyneta/websocket-network-adapter/server"
import {
  createBunWebsocketHandlers,
  type BunWebsocketData,
} from "@kyneta/websocket-network-adapter/bun"
import { TodoDoc } from "./schema.js"
import { buildClient } from "./build.js"

// ─────────────────────────────────────────────────────────────────────────
// 1. Exchange — server-side sync hub
// ─────────────────────────────────────────────────────────────────────────

const serverAdapter = new WebsocketServerAdapter()

const exchange = new Exchange({
  identity: { name: "server" },
  adapters: [() => serverAdapter],
})

// Register the todo document. The server holds the authoritative copy.
// When clients connect, the Exchange automatically syncs via the
// three-message protocol (discover → interest → offer).
exchange.get("todos", TodoDoc)

// ─────────────────────────────────────────────────────────────────────────
// 2. Build — compile the client app + optional brotli pre-compression
// ─────────────────────────────────────────────────────────────────────────

await buildClient()

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

    // Static file serving from dist/
    // Serve pre-compressed .br when the client accepts brotli
    const pathname = url.pathname === "/" ? "/index.html" : url.pathname
    const acceptsBr = /\bbr\b/.test(req.headers.get("accept-encoding") ?? "")

    if (acceptsBr) {
      const brFile = Bun.file(`./dist${pathname}.br`)
      if (await brFile.exists()) {
        const original = Bun.file(`./dist${pathname}`)
        return new Response(brFile, {
          headers: {
            "Content-Encoding": "br",
            "Content-Type": original.type,
          },
        })
      }
    }

    const file = Bun.file(`./dist${pathname}`)
    return (await file.exists())
      ? new Response(file)
      : new Response("Not found", { status: 404 })
  },

  websocket: createBunWebsocketHandlers(serverAdapter),
})

console.log(`\n  ✅ Todo dev server`)
console.log(`     http://localhost:${PORT}/`)
console.log(`     WebSocket: ws://localhost:${PORT}/ws\n`)

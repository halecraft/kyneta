// ═══════════════════════════════════════════════════════════════════════════
//
//   Encrafte — Bun Server
//
//   Single-process dev server using Bun's native fullstack dev server:
//   1. HTML import bundling + HMR (React Fast Refresh, CSS hot reload)
//   2. API routes at /api/* (server-side AI, health checks)
//   3. WebSocket at /ws (Exchange sync via @kyneta/websocket-transport)
//
//   Bun handles HTML bundling, TypeScript/JSX transpilation, and HMR
//   natively — no Vite, no Node compatibility shims.
//
//   Run with:  bun src/server.ts
//
// ═══════════════════════════════════════════════════════════════════════════

/// <reference types="bun-types" />

import { Exchange } from "@kyneta/exchange"
import {
  type BunWebsocketData,
  createBunWebsocketHandlers,
} from "@kyneta/websocket-transport/bun"
import { WebsocketServerTransport } from "@kyneta/websocket-transport/server"
import homepage from "../index.html"
import { handleApiRequest } from "./api.js"
import { ThreadDoc } from "./schema.js"

// ─────────────────────────────────────────────────────────────────────────
// 1. Exchange — server-side sync hub
// ─────────────────────────────────────────────────────────────────────────

const serverTransport = new WebsocketServerTransport()

const exchange = new Exchange({
  identity: { peerId: "encrafte-server", name: "encrafte-server" },
  transports: [() => serverTransport],
})

// Register the main thread document. When clients connect, the Exchange
// automatically syncs via the discover → interest → offer protocol.
exchange.get("thread:main", ThreadDoc)

// ─────────────────────────────────────────────────────────────────────────
// 2. Serve — Bun fullstack dev server
// ─────────────────────────────────────────────────────────────────────────

const PORT = Number(Bun.env.PORT ?? 5173)

Bun.serve<BunWebsocketData>({
  port: PORT,

  // Bun scans index.html for <script> and <link> tags, bundles
  // TypeScript/JSX/CSS, and serves the result with HMR.
  routes: {
    "/": homepage,
  },

  // HMR (React Fast Refresh) + browser→terminal console bridging
  development: {
    hmr: true,
    console: true,
  },

  // Fallback for routes not matched above: /ws upgrade and /api/*
  async fetch(req, server) {
    const url = new URL(req.url)

    // WebSocket upgrade at /ws
    if (url.pathname === "/ws") {
      if (server.upgrade(req, { data: { handlers: {} } })) return
      return new Response("WebSocket upgrade failed", { status: 400 })
    }

    // API routes at /api/*
    if (url.pathname.startsWith("/api/")) {
      return handleApiRequest(req)
    }

    return new Response("Not found", { status: 404 })
  },

  websocket: createBunWebsocketHandlers(serverTransport),
})

console.log(`\n  ✅ Encrafte dev server`)
console.log(`     http://localhost:${PORT}/`)
console.log(`     WebSocket: ws://localhost:${PORT}/ws`)
console.log(`     Bun HMR active\n`)

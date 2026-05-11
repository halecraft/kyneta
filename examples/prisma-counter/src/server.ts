// ═══════════════════════════════════════════════════════════════════════════
//
//   Prisma Counter — Server
//
//   Single-process server that combines:
//   1. Vite dev server (middleware mode) — React HMR, module transforms
//   2. WebSocket server — collaborative sync via @kyneta/exchange
//   3. Prisma + Postgres — persistence via @kyneta/prisma-store
//
//   Both share one node:http server on one port. Vite handles all HTTP
//   (index.html, HMR, static assets). The ws library handles WebSocket
//   upgrades at /ws.
//
//   Run with:  pnpm run dev  (calls tsx, which runs Node)
//
//   Prerequisites: Postgres running, DATABASE_URL set, Prisma migration
//   applied. See README for Docker one-liner and quick-start steps.
//
// ═══════════════════════════════════════════════════════════════════════════

import http from "node:http"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { PrismaClient } from "@prisma/client"
import { Exchange } from "@kyneta/exchange"
import { createPrismaStore } from "@kyneta/prisma-store"
import {
  WebsocketServerTransport,
  wrapNodeWebsocket,
} from "@kyneta/websocket-transport/server"
import { createServer as createViteServer } from "vite"
import { WebSocketServer } from "ws"
import { CounterDoc } from "./schema.js"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

// ─────────────────────────────────────────────────────────────────────────
// 1. Prisma — persistence layer
// ─────────────────────────────────────────────────────────────────────────

const prisma = new PrismaClient()

// createPrismaStore is async for ergonomic parity with createPostgresStore.
// The underlying constructor is sync; we await to follow the documented API.
const store = await createPrismaStore({ client: prisma })

// ─────────────────────────────────────────────────────────────────────────
// 2. Exchange — server-side sync hub with Postgres persistence
// ─────────────────────────────────────────────────────────────────────────

const serverTransport = new WebsocketServerTransport()

const exchange = new Exchange({
  id: { peerId: "counter-server", name: "server" },
  transports: [() => serverTransport],

  /** Persist counter state to Postgres via Prisma */
  stores: [store],
})

// Register the counter document. When clients connect, the Exchange
// automatically syncs via the three-message protocol
// (discover → interest → offer). On first start, the counter is 0;
// on restart, it hydrates from Postgres.
exchange.get("counter", CounterDoc)

// ─────────────────────────────────────────────────────────────────────────
// 3. HTTP server — shared by Vite and WebSocket
// ─────────────────────────────────────────────────────────────────────────

const httpServer = http.createServer()

// ─────────────────────────────────────────────────────────────────────────
// 4. Vite — middleware mode, attached to the HTTP server
// ─────────────────────────────────────────────────────────────────────────

const vite = await createViteServer({
  root,
  server: {
    middlewareMode: true,
    hmr: {
      server: httpServer,
    },
  },
})

// Vite handles all HTTP requests: index.html, HMR websocket, module
// transforms, static assets. No custom request handling needed.
httpServer.on("request", (req, res) => {
  vite.middlewares(req, res)
})

// ─────────────────────────────────────────────────────────────────────────
// 5. WebSocket — collaborative sync on /ws
//
//    Use noServer mode and manually route upgrade requests: /ws goes to
//    our WebSocketServer, everything else goes to Vite (HMR). This avoids
//    Vite's upgrade handler intercepting our sync connections.
// ─────────────────────────────────────────────────────────────────────────

const wss = new WebSocketServer({ noServer: true })

wss.on("connection", ws => {
  const { start } = serverTransport.handleConnection({
    socket: wrapNodeWebsocket(ws),
  })
  start()
})

httpServer.on("upgrade", (req, socket, head) => {
  if (req.url === "/ws") {
    wss.handleUpgrade(req, socket, head, ws => {
      wss.emit("connection", ws, req)
    })
  }
  // Other upgrade requests (e.g. Vite HMR) are handled by Vite's
  // own upgrade listener attached via hmr.server.
})

// ─────────────────────────────────────────────────────────────────────────
// 6. Listen — createViteServer is awaited, so Vite is ready before
//    the server accepts connections.
// ─────────────────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT ?? 5173)

httpServer.listen(PORT, () => {
  console.log(`\n  ✅ Prisma Counter dev server`)
  console.log(`     http://localhost:${PORT}/`)
  console.log(`     WebSocket: ws://localhost:${PORT}/ws`)
  console.log(`     Vite HMR active`)
  console.log(`     Persistence: Postgres via Prisma\n`)
})

// ─────────────────────────────────────────────────────────────────────────
// 7. Graceful shutdown
// ─────────────────────────────────────────────────────────────────────────

async function shutdown() {
  console.log(`\n  Shutting down...`)
  await exchange.shutdown()
  await prisma.$disconnect()
  httpServer.close()
  process.exit(0)
}

process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)

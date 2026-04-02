// ═══════════════════════════════════════════════════════════════════════════
//
//   Bumper Cars — Bun Server
//
//   Single entry point that:
//   1. Builds the client app via Bun.build()
//   2. Creates a server-side Exchange with:
//      - route:           input docs only visible to owner
//      - authorize:       clients can only write their own input doc
//      - onDocDiscovered: materializes input:${peerId} docs on player connect
//      - onDocDismissed:  cleans up when players disconnect
//   3. Runs the game loop at 60fps
//   4. Serves static files from dist/ and upgrades /ws to WebSocket
//
//   Run with:  bun src/server.ts
//
// ═══════════════════════════════════════════════════════════════════════════

/// <reference types="bun-types" />

import { Exchange } from "@kyneta/exchange"
import { Interpret } from "@kyneta/schema"
import { WebsocketServerTransport } from "@kyneta/websocket-transport/server"
import {
  createBunWebsocketHandlers,
  type BunWebsocketData,
} from "@kyneta/websocket-transport/bun"
import { GameStateDoc, PlayerInputDoc } from "./schema.js"
import { GameLoop } from "./server/game-loop.js"
import { buildClient } from "./build.js"

// ─────────────────────────────────────────────────────────────────────────
// 1. Build — compile the client app
// ─────────────────────────────────────────────────────────────────────────

await buildClient()

// ─────────────────────────────────────────────────────────────────────────
// 2. Exchange — server-side sync hub with access control
// ─────────────────────────────────────────────────────────────────────────

const serverTransport = new WebsocketServerTransport()

// GameLoop is declared before the Exchange so the callbacks can close
// over it. It's assigned after exchange.get("game-state") returns.
// No client connects before Bun.serve() starts, so the binding is
// always set by the time any callback fires.
let gameLoop: GameLoop

const exchange = new Exchange({
  identity: { peerId: "bumper-cars-server", name: "bumper-cars-server", type: "service" },
  transports: [() => serverTransport],

  // ── route ────────────────────────────────────────────────────────
  // Outbound flow control: which peers see which documents?
  //
  // • game-state: visible to everyone (all clients render it)
  // • input:*:    only visible to the owning peer
  //               (the server reads them locally, not via sync)
  route(docId, peer) {
    if (docId.startsWith("input:")) {
      const owner = docId.slice("input:".length)
      return peer.peerId === owner
    }
    return true
  },

  // ── authorize ────────────────────────────────────────────────────
  // Inbound flow control: whose mutations are accepted?
  //
  // • game-state: reject all remote writes (server is the single writer)
  // • input:*:    accept only from the owning peer
  authorize(docId, peer) {
    if (docId === "game-state") {
      return false
    }
    if (docId.startsWith("input:")) {
      const owner = docId.slice("input:".length)
      return peer.peerId === owner
    }
    return false
  },

  // ── onDocDiscovered ──────────────────────────────────────────────
  // A client created input:${peerId} — materialize it server-side
  // and register the player with the game loop.
  //
  // onDocDiscovered returns an Interpret disposition; the Exchange then
  // calls exchange.get(docId, bound) internally to create the doc. After
  // that call completes (synchronously), we can look the doc up.
  // We schedule a microtask to register the player so the Exchange
  // finishes its dispatch loop first.
  onDocDiscovered(docId, _peer, _replicaType, _mergeStrategy) {
    if (!docId.startsWith("input:")) return undefined

    const peerId = docId.slice("input:".length)

    queueMicrotask(() => {
      if (exchange.has(docId)) {
        const inputDoc = exchange.get(docId, PlayerInputDoc)
        gameLoop.addPlayer(peerId, inputDoc)
      }
    })

    return Interpret(PlayerInputDoc)
  },

  // ── onDocDismissed ───────────────────────────────────────────────
  // A client disconnected — remove their car and dismiss the doc.
  onDocDismissed(docId, _peer) {
    if (!docId.startsWith("input:")) return

    const peerId = docId.slice("input:".length)
    gameLoop.removePlayer(peerId)
    exchange.dismiss(docId)
  },
})

// Register the game state document — the server holds the authoritative copy.
const gameStateDoc = exchange.get("game-state", GameStateDoc)

// Create and start the game loop.
gameLoop = new GameLoop(gameStateDoc)
gameLoop.start()

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

  websocket: createBunWebsocketHandlers(serverTransport),
})

console.log(`\n  ✅ Bumper Cars server`)
console.log(`     http://localhost:${PORT}/`)
console.log(`     WebSocket: ws://localhost:${PORT}/ws\n`)
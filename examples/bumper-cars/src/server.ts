// ═══════════════════════════════════════════════════════════════════════════
//
//   Bumper Cars — Bun Server
//
//   Single entry point that:
//   1. Builds the client app via Bun.build()
//   2. Creates a server-side Exchange with:
//      - canShare:        input docs only visible to owner
//      - canAccept:       clients can only write their own input doc
//      - schemas:         declares PlayerInputDoc for auto-resolve
//   3. Subscribes to reactive feeds:
//      - exchange.documents.subscribe(): registers players on doc creation
//      - exchange.peers.subscribe():     cleans up on peer departure
//   4. Runs the game loop at 60fps
//   5. Serves static files from dist/ and upgrades /ws to WebSocket
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
  identity: {
    peerId: "bumper-cars-server",
    name: "bumper-cars-server",
    type: "service",
  },
  transports: [() => serverTransport],
  schemas: [PlayerInputDoc],

  // ── canShare ─────────────────────────────────────────────────────
  // Outbound flow control: which peers see which documents?
  //
  // • game-state: visible to everyone (all clients render it)
  // • input:*:    only visible to the owning peer
  //               (the server reads them locally, not via sync)
  canShare(docId, peer) {
    if (docId.startsWith("input:")) {
      const owner = docId.slice("input:".length)
      return peer.peerId === owner
    }
    return true
  },

  // ── canAccept ────────────────────────────────────────────────────
  // Inbound flow control: whose mutations are accepted?
  //
  // • game-state: reject all remote writes (server is the single writer)
  // • input:*:    accept only from the owning peer
  canAccept(docId, peer) {
    if (docId === "game-state") {
      return false
    }
    if (docId.startsWith("input:")) {
      const owner = docId.slice("input:".length)
      return peer.peerId === owner
    }
    return false
  },
})

// React to document creation via the reactive documents feed.
// When a remote peer's input doc is created, register the player.
exchange.documents.subscribe(changeset => {
  for (const change of changeset.changes) {
    if (change.type !== "doc-created") continue
    const docId = change.docId
    if (!docId.startsWith("input:")) continue

    const peerId = docId.slice("input:".length)

    queueMicrotask(() => {
      if (exchange.has(docId)) {
        const inputDoc = exchange.get(docId, PlayerInputDoc)
        gameLoop.addPlayer(peerId, inputDoc)
      }
    })
  }
})

// React to peer departures — clean up players when peers disconnect.
// This replaces the old onDocDismissed proxy, which failed on ungraceful
// disconnect (no dismiss wire message when a browser tab closes).
exchange.peers.subscribe(changeset => {
  for (const change of changeset.changes) {
    if (change.type !== "peer-departed") continue
    const peerId = change.peer.peerId
    gameLoop.removePlayer(peerId)
    // Destroy the input doc if it exists
    const inputDocId = `input:${peerId}`
    if (exchange.has(inputDocId)) {
      exchange.destroy(inputDocId)
    }
  }
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
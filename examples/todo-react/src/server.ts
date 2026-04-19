// ═══════════════════════════════════════════════════════════════════════════
//
//   Todo React — Server
//
//   Single-process server that combines:
//   1. Vite dev server (middleware mode) — React HMR, module transforms
//   2. WebSocket server — collaborative sync via @kyneta/exchange
//
//   Both share one node:http server on one port. Vite handles all HTTP
//   (index.html, HMR, static assets). The ws library handles WebSocket
//   upgrades at /ws.
//
//   Run with:  pnpm run dev  (calls tsx, which runs Node — not Bun)
//
//   Why Node? Vite's dev server internals are coupled to Node's
//   http/net/stream modules. The Cast-based todo example uses Bun;
//   this example uses Node — proving runtime agnosticism.
//
// ═══════════════════════════════════════════════════════════════════════════

import http from "node:http"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Exchange } from "@kyneta/exchange"
import {
  WebsocketServerTransport,
  wrapNodeWebsocket,
} from "@kyneta/websocket-transport/server"
import { createLevelDBStore } from "@kyneta/leveldb-store/server"
import { createServer as createViteServer } from "vite"
import { WebSocketServer } from "ws"
import { TodoDoc } from "./schema.js"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

// ─────────────────────────────────────────────────────────────────────────
// 1. Exchange — server-side sync hub
// ─────────────────────────────────────────────────────────────────────────

const serverTransport = new WebsocketServerTransport()

const exchange = new Exchange({
  id: { peerId: "todo-react-server", name: "server" },
  transports: [() => serverTransport],

  /** Uncomment to add local storage persistence via LevelDB */
  // stores: [createLevelDBStore("./todo.db")],
})

// Register the todo document. The server holds the authoritative copy.
// When clients connect, the Exchange automatically syncs via the
// three-message protocol (discover → interest → offer).
exchange.get("todos", TodoDoc)

// ─────────────────────────────────────────────────────────────────────────
// 2. HTTP server — shared by Vite and WebSocket
// ─────────────────────────────────────────────────────────────────────────

const httpServer = http.createServer()

// ─────────────────────────────────────────────────────────────────────────
// 3. Vite — middleware mode, attached to the HTTP server
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
// 4. WebSocket — collaborative sync on /ws
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
// 5. Listen — createViteServer is awaited, so Vite is ready before
//    the server accepts connections. No viteReady queuing needed.
// ─────────────────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT ?? 5173)

httpServer.listen(PORT, () => {
  console.log(`\n  ✅ Todo React dev server`)
  console.log(`     http://localhost:${PORT}/`)
  console.log(`     WebSocket: ws://localhost:${PORT}/ws`)
  console.log(`     Vite HMR active\n`)
})

// ═══════════════════════════════════════════════════════════════════════════
//
//   Recipe Book — Dev Server
//
//   A Bun-primary HTTP server embedding Vite in middleware mode for:
//   1. SSR — same app.ts compiled to HTML (server) and DOM (client)
//   2. HMR — Vite handles client JS, assets, and hot module replacement
//   3. WebSocket — sync endpoint at /ws for multi-tab collaboration
//
//   Run with:  bun src/server.ts
//   Node alt:  npx tsx src/server.ts
//
// ═══════════════════════════════════════════════════════════════════════════

import { createServer as createHttpServer } from "node:http"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"
import { createServer as createViteServer } from "vite"
import { WebSocketServer, type WebSocket } from "ws"

import { RecipeBookSchema } from "./schema.js"
import { SEED } from "./seed.js"
import {
  createDoc,
  change,
  applyChanges,
  subscribe,
  version,
  delta,
} from "./facade.js"
import type { Changeset, TreeEvent } from "@kyneta/schema"
import { parseServerMessage, toPendingChanges } from "./protocol.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, "..")
const PORT = Number(process.env.PORT ?? 3000)

async function start() {
  // ─────────────────────────────────────────────────────────────────────
  // Server-side document — the authoritative state
  // ─────────────────────────────────────────────────────────────────────
  const doc = createDoc(RecipeBookSchema, { ...SEED })

  // ─────────────────────────────────────────────────────────────────────
  // Part 1: Vite dev server in middleware mode
  // ─────────────────────────────────────────────────────────────────────
  const vite = await createViteServer({
    root,
    server: { middlewareMode: true },
    appType: "custom",
  })

  // ─────────────────────────────────────────────────────────────────────
  // Part 2 & 3: HTTP server with SSR handler + Vite middleware fallthrough
  // ─────────────────────────────────────────────────────────────────────
  const server = createHttpServer(async (req, res) => {
    const url = req.url ?? "/"

    try {
      // SSR handler for GET /
      if (url === "/" && req.method === "GET") {
        // 1. Read and transform the HTML template through Vite's pipeline
        //    (resolves <script> tags, injects HMR client, etc.)
        const rawHtml = readFileSync(resolve(root, "index.html"), "utf-8")
        const template = await vite.transformIndexHtml(url, rawHtml)

        // 2. Load the app module through Vite's SSR pipeline.
        //    Vite detects ssr: true → Kyneta plugin compiles to HTML target →
        //    generateRenderFunction output + __escapeHtml injection.
        const appModule = await vite.ssrLoadModule("/src/app.ts")
        const { createApp } = appModule as {
          createApp: (doc: unknown) => () => string
        }

        // 3. Call createApp with the server-side document to get the
        //    compiled SSR render function, then call it to produce HTML.
        const renderFn = createApp(doc)
        const appHtml = typeof renderFn === "function" ? renderFn() : ""

        // 4. Inject SSR content and frontier meta tag into the template.
        //    The version integer is the frontier — the client reads it on
        //    boot and sends it in the initial sync message so the server
        //    knows what delta to push.
        const currentVersion = version(doc)
        const html = template
          .replace("<!--ssr-->", appHtml)
          .replace(
            "</head>",
            `  <meta name="kyneta-version" content="${currentVersion}">\n</head>`,
          )

        res.writeHead(200, { "Content-Type": "text/html" })
        res.end(html)
        return
      }

      // All other requests fall through to Vite middleware
      // (serves client JS, assets, HMR WebSocket, etc.)
      vite.middlewares(req, res)
    } catch (e) {
      // Let Vite fix the stack trace for SSR errors
      if (e instanceof Error) {
        vite.ssrFixStacktrace(e)
      }
      console.error("[ssr error]", e)
      res.writeHead(500, { "Content-Type": "text/plain" })
      res.end(e instanceof Error ? e.message : "Internal Server Error")
    }
  })

  // ─────────────────────────────────────────────────────────────────────
  // Part 4: WebSocket sync endpoint at /ws
  //
  // Protocol:
  //   Client → Server:  { type: "sync", version: N }
  //     Server responds: { type: "delta", ops: [...], version: M }
  //
  //   Client → Server:  { type: "delta", ops: [...], version: N }
  //     Server applies ops and broadcasts to OTHER clients.
  //
  //   Server → Client:  { type: "delta", ops: [...], version: M }
  //     Pushed when another client's mutation is applied.
  // ─────────────────────────────────────────────────────────────────────
  const wss = new WebSocketServer({ noServer: true })

  // Track connected clients with their last-known version
  interface ClientState {
    ws: WebSocket
    knownVersion: number
  }
  const clients = new Map<WebSocket, ClientState>()

  server.on("upgrade", (req, socket, head) => {
    const { pathname } = new URL(req.url ?? "/", `http://${req.headers.host}`)

    if (pathname === "/ws") {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req)
      })
    } else {
      // Let Vite handle its own HMR WebSocket upgrades
      // (Vite middleware mode handles this internally)
      socket.destroy()
    }
  })

  // Subscribe to the server doc's tree changefeed.
  // When any mutation is applied (from any client), push deltas to all
  // OTHER connected clients that haven't seen those changes yet.
  subscribe(doc, (_changeset: Changeset<TreeEvent>) => {
    const currentVer = version(doc)
    for (const [ws, state] of clients) {
      if (state.knownVersion < currentVer && ws.readyState === 1 /* OPEN */) {
        const ops = delta(doc, state.knownVersion)
        ws.send(JSON.stringify({
          type: "delta",
          ops,
          version: currentVer,
        }))
        state.knownVersion = currentVer
      }
    }
  })

  wss.on("connection", (ws) => {
    const state: ClientState = { ws, knownVersion: 0 }
    clients.set(ws, state)
    console.log(`[ws] client connected (${clients.size} total)`)

    ws.on("message", (data) => {
      const msg = parseServerMessage(String(data))
      if (!msg) return

      if (msg.type === "sync") {
        state.knownVersion = msg.version
        const ops = delta(doc, msg.version)
        const currentVer = version(doc)
        ws.send(JSON.stringify({ type: "delta", ops, version: currentVer }))
        state.knownVersion = currentVer
        console.log(`[ws] sync: client at v${msg.version}, server at v${currentVer}, sent ${ops.length} ops`)
      } else if (msg.type === "delta" && msg.ops.length > 0) {
        // Mark this client as up-to-date BEFORE applying so the
        // subscribe broadcast (above) skips this sender.
        const nextVersion = version(doc) + 1
        state.knownVersion = nextVersion
        applyChanges(doc, toPendingChanges(msg.ops), { origin: "sync" })
        console.log(`[ws] applied ${msg.ops.length} ops from client, now at v${version(doc)}`)
      }
    })

    ws.on("close", () => {
      clients.delete(ws)
      console.log(`[ws] client disconnected (${clients.size} total)`)
    })
  })

  // ─────────────────────────────────────────────────────────────────────
  // Start listening
  // ─────────────────────────────────────────────────────────────────────
  server.listen(PORT, () => {
    console.log(`\n  🍳 Recipe Book dev server`)
    console.log(`     http://localhost:${PORT}/`)
    console.log(`     WebSocket: ws://localhost:${PORT}/ws\n`)
  })
}

start().catch((err) => {
  console.error("Failed to start server:", err)
  process.exit(1)
})
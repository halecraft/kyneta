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
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"
import { createServer as createViteServer } from "vite"
import { WebSocketServer, type WebSocket } from "ws"

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, "..")
const PORT = Number(process.env.PORT ?? 3000)

async function start() {
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
        const rawHtml = await import("node:fs").then((fs) =>
          fs.readFileSync(resolve(root, "index.html"), "utf-8"),
        )
        const template = await vite.transformIndexHtml(url, rawHtml)

        // 2. Load the app module through Vite's SSR pipeline.
        //    Vite detects ssr: true → Kyneta plugin compiles to HTML target →
        //    generateRenderFunction output + __escapeHtml injection.
        const appModule = await vite.ssrLoadModule("/src/app.ts")
        const { createApp } = appModule as {
          createApp: (doc: unknown) => () => string
        }

        // 3. Call createApp to get the compiled SSR render function,
        //    then call it to produce the HTML string.
        //    For Phase 1, doc is null — no schema document yet.
        const renderFn = createApp(null)
        const appHtml = typeof renderFn === "function" ? renderFn() : ""

        // 4. Inject SSR content and frontier meta tag into the template.
        //    Replace <!--ssr--> placeholder with rendered content.
        const html = template
          .replace("<!--ssr-->", appHtml)
          .replace(
            "</head>",
            `  <meta name="kyneta-version" content="0">\n</head>`,
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
  // ─────────────────────────────────────────────────────────────────────
  const wss = new WebSocketServer({ noServer: true })

  // Track connected clients (Phase 2 will add version tracking per client)
  const clients = new Set<WebSocket>()

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

  wss.on("connection", (ws) => {
    clients.add(ws)
    console.log(
      `[ws] client connected (${clients.size} total)`,
    )

    // Phase 1 stub: acknowledge connection
    ws.send(JSON.stringify({ type: "connected" }))

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(String(data))
        console.log("[ws] received:", msg.type)
        // Phase 2 will handle { type: "sync" } and { type: "delta" } messages
      } catch {
        console.warn("[ws] invalid message")
      }
    })

    ws.on("close", () => {
      clients.delete(ws)
      console.log(
        `[ws] client disconnected (${clients.size} total)`,
      )
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
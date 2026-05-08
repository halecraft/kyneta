// node-ws-server — Node-compatible WebSocket test server using `ws`.
//
// Spins up an HTTP server on a random port, accepts WebSocket upgrades
// via `ws.WebSocketServer`, and feeds them into a
// `WebsocketServerTransport` via `wrapNodeWebsocket`.

import http from "node:http"
import {
  type WebsocketServerTransport,
  wrapNodeWebsocket,
} from "@kyneta/websocket-transport/server"
import { WebSocketServer } from "ws"

export interface TestServer {
  url: string
  shutdown: () => void
}

export function createNodeTestServer(
  serverTransport: WebsocketServerTransport,
): TestServer {
  const httpServer = http.createServer()
  const wss = new WebSocketServer({ noServer: true })

  wss.on("connection", ws => {
    const { start } = serverTransport.handleConnection({
      socket: wrapNodeWebsocket(ws),
    })
    start()
  })

  httpServer.on("upgrade", (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, ws => {
      wss.emit("connection", ws, req)
    })
  })

  // Listen on port 0 for a random available port
  httpServer.listen(0)
  const addr = httpServer.address()
  const port = typeof addr === "object" && addr ? addr.port : 0

  const url = `ws://localhost:${port}/ws`

  return {
    url,
    shutdown() {
      wss.close()
      httpServer.close()
    },
  }
}

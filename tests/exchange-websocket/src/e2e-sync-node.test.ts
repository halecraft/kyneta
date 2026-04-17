// e2e-sync-node — Node-compatible integration test proving full-stack sync
// over real WebSocket connections using the `ws` library.
//
// Mirrors a subset of the Bun-based e2e-sync.test.ts, but uses:
// - `ws.WebSocketServer` + `wrapNodeWebsocket` for the server
// - `ws.WebSocket` as the client's WebSocket constructor
//
// This proves the transport works end-to-end on Node.js — no Bun APIs needed.

import http from "node:http"
import { Exchange } from "@kyneta/exchange"
import { change, json, Schema } from "@kyneta/schema"
import {
  type WebSocketConstructor,
  WebsocketClientTransport,
} from "@kyneta/websocket-transport/browser"
import {
  WebsocketServerTransport,
  wrapNodeWebsocket,
} from "@kyneta/websocket-transport/server"
import { afterEach, describe, expect, it } from "vitest"
import { WebSocket, WebSocketServer } from "ws"

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

interface TestServer {
  url: string
  shutdown: () => void
}

/**
 * Spin up a Node.js WebSocket server on a random port using `ws`.
 */
function createNodeTestServer(
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

/**
 * Drain microtask queue and yield to event loop.
 */
async function drain(rounds = 40): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>(r => queueMicrotask(r))
    await new Promise<void>(r => setTimeout(r, 2))
  }
}

/**
 * Wait for a client transport to reach the "ready" state.
 */
async function waitForReady(
  client: WebsocketClientTransport,
  timeoutMs = 5000,
): Promise<void> {
  await client.waitForStatus("ready", { timeoutMs })
}

// ---------------------------------------------------------------------------
// Test lifecycle management
// ---------------------------------------------------------------------------

const activeExchanges: Exchange[] = []
const activeServers: TestServer[] = []

function createExchange(
  params: ConstructorParameters<typeof Exchange>[0] = {},
): Exchange {
  const ex = new Exchange(params)
  activeExchanges.push(ex)
  return ex
}

afterEach(async () => {
  for (const ex of activeExchanges) {
    try {
      await ex.shutdown()
    } catch {
      // ignore
    }
  }
  activeExchanges.length = 0

  for (const s of activeServers) {
    try {
      s.shutdown()
    } catch {
      // ignore
    }
  }
  activeServers.length = 0
})

// ---------------------------------------------------------------------------
// Bound schemas
// ---------------------------------------------------------------------------

const sequentialSchema = Schema.struct({
  title: Schema.string(),
  count: Schema.number(),
})
const SequentialDoc = json.bind(sequentialSchema)

// ---------------------------------------------------------------------------
// Helper: create connected server + client pair (Node path)
// ---------------------------------------------------------------------------

async function createConnectedPair(opts?: {
  serverPeerId?: string
  clientPeerId?: string
  fragmentThreshold?: number
}): Promise<{
  serverExchange: Exchange
  clientExchange: Exchange
  serverTransport: WebsocketServerTransport
  clientTransport: WebsocketClientTransport
  testServer: TestServer
}> {
  const serverPeerId = opts?.serverPeerId ?? "server"
  const clientPeerId = opts?.clientPeerId ?? "client"
  const fragmentThreshold = opts?.fragmentThreshold

  const serverTransport = new WebsocketServerTransport(
    fragmentThreshold !== undefined ? { fragmentThreshold } : undefined,
  )

  const testServer = createNodeTestServer(serverTransport)
  activeServers.push(testServer)

  const serverExchange = createExchange({
    identity: { peerId: serverPeerId },
    transports: [() => serverTransport],
  })

  const clientTransport = new WebsocketClientTransport({
    url: testServer.url,
    WebSocket: WebSocket as unknown as WebSocketConstructor,
    reconnect: { enabled: false },
    fragmentThreshold,
  })

  const clientExchange = createExchange({
    identity: { peerId: clientPeerId },
    transports: [() => clientTransport],
  })

  await waitForReady(clientTransport)
  await drain(20)

  return {
    serverExchange,
    clientExchange,
    serverTransport,
    clientTransport,
    testServer,
  }
}

// ---------------------------------------------------------------------------
// Sequential sync over Node.js WebSocket (ws library)
// ---------------------------------------------------------------------------

describe("Sequential sync over Node.js WebSocket (ws library)", () => {
  it("server creates doc, client syncs and gets the same state", async () => {
    const { serverExchange, clientExchange } = await createConnectedPair()

    const docServer = serverExchange.get("doc-1", SequentialDoc)
    change(docServer, (d: any) => {
      d.title.set("Hello from Node Server")
      d.count.set(42)
    })

    expect(docServer.title()).toBe("Hello from Node Server")
    expect(docServer.count()).toBe(42)

    const docClient = clientExchange.get("doc-1", SequentialDoc)

    await drain()

    expect(docClient.title()).toBe("Hello from Node Server")
    expect(docClient.count()).toBe(42)
  })

  it("client creates doc, server syncs and gets the same state", async () => {
    const { serverExchange, clientExchange } = await createConnectedPair()

    const docClient = clientExchange.get("doc-1", SequentialDoc)
    change(docClient, (d: any) => {
      d.title.set("Hello from Node Client")
      d.count.set(99)
    })

    await drain()

    const docServer = serverExchange.get("doc-1", SequentialDoc)
    await drain()

    expect(docServer.title()).toBe("Hello from Node Client")
    expect(docServer.count()).toBe(99)
  })

  it("bidirectional mutations propagate", async () => {
    const { serverExchange, clientExchange } = await createConnectedPair()

    const docServer = serverExchange.get("doc-1", SequentialDoc)
    const docClient = clientExchange.get("doc-1", SequentialDoc)

    change(docServer, (d: any) => {
      d.title.set("Initial")
      d.count.set(0)
    })

    await drain()

    expect(docClient.title()).toBe("Initial")
    expect(docClient.count()).toBe(0)

    change(docClient, (d: any) => {
      d.count.set(100)
    })

    await drain()

    expect(docServer.count()).toBe(100)
    expect(docClient.count()).toBe(100)
  })
})

// e2e-sync — integration tests proving full-stack sync over real Websocket connections.
//
// These tests spin up a Bun Websocket server with WebsocketServerTransport,
// connect a WebsocketClientTransport, and verify that Exchange instances
// sync documents correctly over the real transport stack:
//
//   Exchange →
//     Synchronizer →
//       Adapter →
//         WebsocketConnection →
//           CBOR codec →
//             Frame →
//               Fragment →
//                 Websocket →
//               Fragment →
//             Frame →
//           CBOR codec →
//         WebsocketConnection →
//       Adapter →
//     Synchronizer →
//   Exchange
//
// Covers all three merge strategies (sequential, causal, LWW),
// heterogeneous documents, and large payload fragmentation.

/// <reference types="bun-types" />

import { Exchange } from "@kyneta/exchange"
import { LoroSchema, loro } from "@kyneta/loro-schema"
import { change, json, Schema } from "@kyneta/schema"
import {
  type BunWebsocketData,
  createBunWebsocketHandlers,
} from "@kyneta/websocket-transport/bun"
import { WebsocketClientTransport } from "@kyneta/websocket-transport/client"
import { WebsocketServerTransport } from "@kyneta/websocket-transport/server"
import { afterEach, describe, expect, it } from "vitest"

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

/**
 * Spin up a Bun Websocket server on a random port.
 * Returns the server, its URL, and the server adapter.
 */
function createTestServer(serverTransport: WebsocketServerTransport): {
  server: ReturnType<typeof Bun.serve>
  url: string
  shutdown: () => void
} {
  const handlers = createBunWebsocketHandlers(serverTransport)

  const server = Bun.serve<BunWebsocketData>({
    port: 0, // random port
    fetch(req, server) {
      const upgraded = server.upgrade(req, { data: { handlers: {} } })
      if (!upgraded) {
        return new Response("Upgrade failed", { status: 400 })
      }
      return undefined as unknown as Response
    },
    websocket: handlers,
  })

  const url = `ws://localhost:${server.port}/ws`

  return {
    server,
    url,
    shutdown() {
      server.stop(true)
    },
  }
}

/**
 * Drain microtask queue and yield to event loop — necessary for async
 * message delivery through Websocket transport.
 *
 * Unlike BridgeTransport's queueMicrotask delivery, real Websocket transport
 * involves actual I/O, so we need more aggressive draining.
 */
async function drain(rounds = 40): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>(r => queueMicrotask(r))
    await new Promise<void>(r => setTimeout(r, 2))
  }
}

/**
 * Wait for a client adapter to reach the "ready" state.
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
const activeServers: { shutdown: () => void }[] = []

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
// Bound schemas (module scope)
// ---------------------------------------------------------------------------

const sequentialSchema = Schema.doc({
  title: Schema.string(),
  count: Schema.number(),
})
const SequentialDoc = json.bind(sequentialSchema)

const loroSchema = LoroSchema.doc({
  title: LoroSchema.text(),
  items: Schema.list(Schema.struct({ name: Schema.string() })),
})
const LoroDoc = loro.bind(loroSchema)

const presenceSchema = Schema.doc({
  cursor: Schema.struct({
    x: Schema.number(),
    y: Schema.number(),
  }),
  name: Schema.string(),
})
const PresenceDoc = json.bind(presenceSchema, "ephemeral")

// ---------------------------------------------------------------------------
// Helper: create connected server + client exchange pair
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
  testServer: ReturnType<typeof createTestServer>
}> {
  const serverPeerId = opts?.serverPeerId ?? "server"
  const clientPeerId = opts?.clientPeerId ?? "client"
  const fragmentThreshold = opts?.fragmentThreshold

  const serverTransport = new WebsocketServerTransport(
    fragmentThreshold !== undefined ? { fragmentThreshold } : undefined,
  )

  const testServer = createTestServer(serverTransport)
  activeServers.push(testServer)

  const serverExchange = createExchange({
    identity: { peerId: serverPeerId },
    transports: [() => serverTransport],
  })

  const clientTransport = new WebsocketClientTransport({
    url: testServer.url,
    reconnect: { enabled: false },
    fragmentThreshold,
  })

  const clientExchange = createExchange({
    identity: { peerId: clientPeerId },
    transports: [() => clientTransport],
  })

  // Wait for the client to be fully ready
  await waitForReady(clientTransport)

  // Give the establishment handshake time to complete
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
// Sequential (PlainSubstrate) — two-peer sync over Websocket
// ---------------------------------------------------------------------------

describe("Sequential sync over Websocket (PlainSubstrate)", () => {
  it("server creates doc, client syncs and gets the same state", async () => {
    const { serverExchange, clientExchange } = await createConnectedPair()

    // Server creates a doc and populates it via change()
    const docServer = serverExchange.get("doc-1", SequentialDoc)
    change(docServer, (d: any) => {
      d.title.set("Hello from Server")
      d.count.set(42)
    })

    expect(docServer.title()).toBe("Hello from Server")
    expect(docServer.count()).toBe(42)

    // Client creates the same doc (empty initially)
    const docClient = clientExchange.get("doc-1", SequentialDoc)

    // Wait for sync over real Websocket
    await drain()

    // Client should have server's state
    expect(docClient.title()).toBe("Hello from Server")
    expect(docClient.count()).toBe(42)
  })

  it("mutations propagate from server to client after initial sync", async () => {
    const { serverExchange, clientExchange } = await createConnectedPair()

    const docServer = serverExchange.get("doc-1", SequentialDoc)
    change(docServer, (d: any) => {
      d.title.set("V1")
      d.count.set(1)
    })
    const docClient = clientExchange.get("doc-1", SequentialDoc)

    // Initial sync
    await drain()
    expect(docClient.title()).toBe("V1")

    // Server mutates
    change(docServer, (d: any) => {
      d.title.set("V2")
      d.count.set(2)
    })
    await drain()

    // Client should see the mutation
    expect(docClient.title()).toBe("V2")
    expect(docClient.count()).toBe(2)
  })

  it("mutations propagate from client to server after initial sync", async () => {
    const { serverExchange, clientExchange } = await createConnectedPair()

    const docServer = serverExchange.get("doc-1", SequentialDoc)
    change(docServer, (d: any) => {
      d.title.set("V1")
      d.count.set(1)
    })
    const docClient = clientExchange.get("doc-1", SequentialDoc)

    // Initial sync — client gets server's state
    await drain()
    expect(docClient.title()).toBe("V1")

    // Client mutates
    change(docClient, (d: any) => {
      d.title.set("From Client")
      d.count.set(99)
    })
    await drain()

    // Server should see the client's mutation
    expect(docServer.title()).toBe("From Client")
    expect(docServer.count()).toBe(99)
  })
})

// ---------------------------------------------------------------------------
// Causal (LoroSubstrate) — two-peer CRDT sync over Websocket
// ---------------------------------------------------------------------------

describe("Causal sync over Websocket (LoroSubstrate)", () => {
  it("server creates doc with text, client syncs and gets the same state", async () => {
    const { serverExchange, clientExchange } = await createConnectedPair()

    // Server creates and populates a Loro doc
    const docServer = serverExchange.get("doc-1", LoroDoc)
    change(docServer, (d: any) => {
      d.title.insert(0, "Hello CRDT")
    })
    // Client creates the same doc
    const docClient = clientExchange.get("doc-1", LoroDoc)

    await drain()

    // Client should have server's text
    expect(docClient.title()).toBe("Hello CRDT")
  })

  it("concurrent edits from both peers converge", async () => {
    const { serverExchange, clientExchange } = await createConnectedPair()

    // Both create the doc
    const docServer = serverExchange.get("doc-1", LoroDoc)
    const docClient = clientExchange.get("doc-1", LoroDoc)

    // Initial sync
    await drain()

    // Both insert concurrently
    change(docServer, (d: any) => {
      d.title.insert(0, "Server")
    })
    change(docClient, (d: any) => {
      d.title.insert(0, "Client")
    })
    // Let sync happen
    await drain()

    // Both should converge to the same value (CRDT merge)
    const valueServer = docServer.title()
    const valueClient = docClient.title()
    expect(valueServer).toBe(valueClient)
    // Both "Server" and "Client" should appear in the merged text
    expect(valueServer).toContain("Server")
    expect(valueServer).toContain("Client")
  })
})

// ---------------------------------------------------------------------------
// LWW (Ephemeral/Presence) — broadcast sync over Websocket
// ---------------------------------------------------------------------------

describe("LWW sync over Websocket (Ephemeral/Presence)", () => {
  it("server sets presence, client receives via broadcast", async () => {
    const { serverExchange, clientExchange } = await createConnectedPair()

    // Server sets presence
    const presServer = serverExchange.get("presence", PresenceDoc)
    change(presServer, (d: any) => {
      d.cursor.x.set(100)
      d.cursor.y.set(200)
      d.name.set("Server")
    })

    // Client creates the same presence doc
    const presClient = clientExchange.get("presence", PresenceDoc)

    await drain()

    // Client should have server's presence
    expect(presClient.name()).toBe("Server")
    expect(presClient.cursor.x()).toBe(100)
    expect(presClient.cursor.y()).toBe(200)
  })

  it("updates propagate via LWW broadcast", async () => {
    const { serverExchange, clientExchange } = await createConnectedPair()

    const presServer = serverExchange.get("presence", PresenceDoc)
    const presClient = clientExchange.get("presence", PresenceDoc)

    // Set initial values
    change(presServer, (d: any) => {
      d.cursor.x.set(0)
      d.cursor.y.set(0)
      d.name.set("Server")
    })
    await drain()
    expect(presClient.name()).toBe("Server")

    // Server moves cursor
    change(presServer, (d: any) => {
      d.cursor.x.set(500)
      d.cursor.y.set(600)
    })
    await drain()

    // Client sees updated cursor
    expect(presClient.cursor.x()).toBe(500)
    expect(presClient.cursor.y()).toBe(600)
  })
})

// ---------------------------------------------------------------------------
// Heterogeneous — mixed substrates over one Websocket connection
// ---------------------------------------------------------------------------

describe("Heterogeneous documents over Websocket", () => {
  it("one connection hosts both sequential and causal docs, both sync", async () => {
    const { serverExchange, clientExchange } = await createConnectedPair()

    const plainSchema = Schema.doc({ config: Schema.string() })
    const ConfigDoc = json.bind(plainSchema)

    const collabSchema = LoroSchema.doc({ text: LoroSchema.text() })
    const CollabDoc = loro.bind(collabSchema)

    // Server: plain config doc
    const configServer = serverExchange.get("config", ConfigDoc)
    change(configServer, (d: any) => {
      d.config.set("dark-mode")
    })

    // Server: Loro collaborative doc
    const textServer = serverExchange.get("collab", CollabDoc)
    change(textServer, (d: any) => {
      d.text.insert(0, "collaborative text")
    })
    // Client: create both docs
    const configClient = clientExchange.get("config", ConfigDoc)
    const textClient = clientExchange.get("collab", CollabDoc)

    await drain()

    // Both docs should sync
    expect(configClient.config()).toBe("dark-mode")
    expect(textClient.text()).toBe("collaborative text")
  })
})

// ---------------------------------------------------------------------------
// Large payload fragmentation over Websocket
// ---------------------------------------------------------------------------

describe("Large payload fragmentation over Websocket", () => {
  it("syncs a document that exceeds the fragment threshold", async () => {
    // Use a very small fragment threshold to force fragmentation
    const { serverExchange, clientExchange } = await createConnectedPair({
      fragmentThreshold: 256, // Very small — will force fragmentation
    })

    // Create a Loro doc with enough data to exceed the threshold
    const largeSchema = LoroSchema.doc({
      content: LoroSchema.text(),
    })
    const LargeDoc = loro.bind(largeSchema)

    const docServer = serverExchange.get("large-doc", LargeDoc)

    // Insert enough text to create a payload larger than 256 bytes
    change(docServer, (d: any) => {
      d.content.insert(
        0,
        "This is a fairly long piece of text that should generate a Loro snapshot " +
          "payload exceeding our artificially low 256-byte fragment threshold. " +
          "The purpose is to verify that the fragmentation and reassembly protocol " +
          "works correctly end-to-end over a real Websocket connection. " +
          "We repeat this text a few times to be sure. " +
          "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA " +
          "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB " +
          "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
      )
    })
    // Client creates the same doc
    const docClient = clientExchange.get("large-doc", LargeDoc)

    await drain(60) // Extra drain rounds for fragmented delivery

    // Client should have the full text
    const clientText = docClient.content()
    expect(clientText).toContain("This is a fairly long piece of text")
    expect(clientText).toContain("CCCCCCCCCCCCCCC")
  })
})

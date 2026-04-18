// Line integration tests — reliable bidirectional messaging between peers.
//
// Uses BridgeTransport to connect Exchange instances and verifies:
// - Doc ID utilities (lineDocId, isLineDocId, parseLineDocId, routeLine)
// - Symmetric and asymmetric Line send/receive via async iterator
// - Ack and pruning
// - Policy lifecycle (named policy registration/disposal)
// - Multiple Lines per peer pair (different topics)
// - Duplicate detection (throw on same peer+topic)
// - Hub-and-spoke relay
// - protocol.listen() — server receives clients, multiple clients,
//   onLine callback management, dispose semantics, queued messages,
//   hub-and-spoke with listen

import { json, Replicate, Schema } from "@kyneta/schema"
import type { DocId } from "@kyneta/transport"
import {
  Bridge,
  BridgeTransport,
  createBridgeTransport,
} from "@kyneta/transport"
import { afterEach, describe, expect, it } from "vitest"
import { Exchange } from "../exchange.js"
import {
  createLineDocSchema,
  isLineDocId,
  Line,
  lineDocId,
  parseLineDocId,
  routeLine,
} from "../line.js"
import { InMemoryStore } from "../store/in-memory-store.js"

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

async function drain(rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>(r => queueMicrotask(r))
    await new Promise<void>(r => setTimeout(r, 0))
  }
}

const activeExchanges: Exchange[] = []

function createExchange(
  params: ConstructorParameters<typeof Exchange>[0] = {},
): Exchange {
  const merged = {
    ...params,
    identity: { peerId: "test", ...params?.identity },
  }
  const ex = new Exchange(merged)
  activeExchanges.push(ex)
  return ex
}

/** Fire-and-forget drain of a Line's async iterator into an array. */
function collect<T>(
  line: { [Symbol.asyncIterator](): AsyncIterableIterator<T> },
  into: T[],
): void {
  ;(async () => {
    for await (const msg of line) into.push(msg)
  })()
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
})

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const RequestSchema = Schema.struct({
  method: Schema.string(),
  id: Schema.number(),
})

const ResponseSchema = Schema.struct({
  result: Schema.string(),
  id: Schema.number(),
})

const SimpleSchema = Schema.struct({
  value: Schema.number(),
})

// ---------------------------------------------------------------------------
// Doc ID utilities
// ---------------------------------------------------------------------------

describe("doc ID utilities", () => {
  it("lineDocId builds correct format", () => {
    expect(lineDocId("signaling", "alice", "bob")).toBe(
      "line:signaling:alice→bob",
    )
  })

  it("lineDocId with default topic", () => {
    expect(lineDocId("default", "alice", "bob")).toBe("line:default:alice→bob")
  })

  it("isLineDocId correctly identifies Line doc IDs", () => {
    expect(isLineDocId("line:signaling:alice→bob" as any)).toBe(true)
    expect(isLineDocId("line:default:a→b" as any)).toBe(true)
    expect(isLineDocId("not-a-line-doc" as any)).toBe(false)
    expect(isLineDocId("line:no-arrow" as any)).toBe(false)
    expect(isLineDocId("game-state" as any)).toBe(false)
  })

  it("parseLineDocId extracts topic, from, and to", () => {
    const result = parseLineDocId("line:signaling:alice→bob" as any)
    expect(result).toEqual({ topic: "signaling", from: "alice", to: "bob" })
  })

  it("parseLineDocId returns null for non-Line doc IDs", () => {
    expect(parseLineDocId("game-state" as any)).toBeNull()
    expect(parseLineDocId("line:no-arrow" as any)).toBeNull()
  })

  it("routeLine returns true for endpoint peers", () => {
    const docId = "line:signaling:alice→bob" as any
    expect(routeLine(docId, { peerId: "alice" } as any)).toBe(true)
    expect(routeLine(docId, { peerId: "bob" } as any)).toBe(true)
  })

  it("routeLine returns false for non-endpoint peers", () => {
    const docId = "line:signaling:alice→bob" as any
    expect(routeLine(docId, { peerId: "charlie" } as any)).toBe(false)
  })

  it("routeLine returns undefined for non-Line doc IDs", () => {
    expect(routeLine("game-state" as any, { peerId: "alice" } as any)).toBe(
      undefined,
    )
  })
})

// ---------------------------------------------------------------------------
// createLineDocSchema
// ---------------------------------------------------------------------------

describe("createLineDocSchema", () => {
  it("produces a bindable doc schema", () => {
    const docSchema = createLineDocSchema(SimpleSchema)
    const bound = json.bind(docSchema)
    expect(bound.schemaHash).toBeDefined()
    expect(typeof bound.schemaHash).toBe("string")
  })
})

// ---------------------------------------------------------------------------
// Symmetric Line — send and receive via generator
// ---------------------------------------------------------------------------

describe("symmetric Line send and receive via generator", () => {
  it("Alice sends a message, Bob receives it via async iterator", async () => {
    const bridge = new Bridge()
    const exchangeA = createExchange({
      identity: { peerId: "alice" },
      transports: [createBridgeTransport({ transportType: "alice", bridge })],
    })
    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      transports: [createBridgeTransport({ transportType: "bob", bridge })],
    })

    await drain()

    const P = Line.protocol({ topic: "test", schema: SimpleSchema })
    const lineA = P.open(exchangeA, "bob")
    const lineB = P.open(exchangeB, "alice")

    lineA.send({ value: 42 })
    await drain()

    // Collect one message from Bob's iterator
    const iter = lineB[Symbol.asyncIterator]()
    const result = await Promise.race([
      iter.next(),
      new Promise<{ value: undefined; done: true }>(r =>
        setTimeout(() => r({ value: undefined, done: true }), 500),
      ),
    ])

    expect(result.done).toBe(false)
    expect(result.value).toEqual({ value: 42 })

    lineA.close()
    lineB.close()
  })

  it("messages arrive in order", async () => {
    const bridge = new Bridge()
    const exchangeA = createExchange({
      identity: { peerId: "alice" },
      transports: [createBridgeTransport({ transportType: "alice", bridge })],
    })
    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      transports: [createBridgeTransport({ transportType: "bob", bridge })],
    })

    await drain()

    const P = Line.protocol({ topic: "order", schema: SimpleSchema })
    const lineA = P.open(exchangeA, "bob")
    const lineB = P.open(exchangeB, "alice")

    // Send messages, drain, then pull from iterator
    lineA.send({ value: 1 })
    lineA.send({ value: 2 })
    lineA.send({ value: 3 })
    await drain()

    // Pull 3 messages from iterator
    const received: { value: number }[] = []
    collect(lineB, received)
    await drain()
    expect(received.map(m => m.value)).toEqual([1, 2, 3])

    // Send more to verify continued ordering
    lineA.send({ value: 4 })
    lineA.send({ value: 5 })
    await drain()
    expect(received.map(m => m.value)).toEqual([1, 2, 3, 4, 5])

    lineA.close()
    lineB.close()
  })

  it("iterator completes when Line is closed", async () => {
    const exchange = createExchange({
      identity: { peerId: "alice" },
    })

    const P = Line.protocol({ topic: "close-test", schema: SimpleSchema })
    const line = P.open(exchange, "bob")

    const iter = line[Symbol.asyncIterator]()
    const pendingNext = iter.next()

    line.close()

    const result = await pendingNext
    expect(result.done).toBe(true)
  })

  it("concurrent sends from both sides", async () => {
    const bridge = new Bridge()
    const exchangeA = createExchange({
      identity: { peerId: "alice" },
      transports: [createBridgeTransport({ transportType: "alice", bridge })],
    })
    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      transports: [createBridgeTransport({ transportType: "bob", bridge })],
    })

    await drain()

    const P = Line.protocol({ topic: "bidir", schema: SimpleSchema })
    const lineA = P.open(exchangeA, "bob")
    const lineB = P.open(exchangeB, "alice")

    const receivedByA: { value: number }[] = []
    const receivedByB: { value: number }[] = []

    collect(lineA, receivedByA)
    collect(lineB, receivedByB)

    // Both send simultaneously
    lineA.send({ value: 1 })
    lineB.send({ value: 2 })

    await drain()

    expect(receivedByA.map(m => m.value)).toContain(2)
    expect(receivedByB.map(m => m.value)).toContain(1)

    lineA.close()
    lineB.close()
  })
})

// ---------------------------------------------------------------------------
// Asymmetric Line via protocol.listen
// ---------------------------------------------------------------------------

describe("asymmetric Line", () => {
  it("different schemas per direction via listen", async () => {
    const bridge = new Bridge()
    const exchangeClient = createExchange({
      identity: { peerId: "client" },
      transports: [createBridgeTransport({ transportType: "client", bridge })],
    })
    const exchangeServer = createExchange({
      identity: { peerId: "server" },
      transports: [createBridgeTransport({ transportType: "server", bridge })],
    })

    await drain()

    const RPC = Line.protocol({
      topic: "rpc",
      client: RequestSchema,
      server: ResponseSchema,
    })

    // Server listens — capture the server-side line for bidirectional test
    let capturedServerLine: any = null
    const serverReceived: Array<{ method: string; id: number }> = []
    const listener = RPC.listen(exchangeServer)
    listener.onLine(line => {
      capturedServerLine = line
      collect(line, serverReceived)
    })

    // Client opens and sends
    const clientLine = RPC.open(exchangeClient, "server")
    const clientReceived: Array<{ result: string; id: number }> = []
    collect(clientLine, clientReceived)

    clientLine.send({ method: "getData", id: 1 })
    await drain()

    // Server received the request
    expect(serverReceived).toEqual([{ method: "getData", id: 1 }])

    // Server responds on the captured line
    expect(capturedServerLine).not.toBeNull()
    capturedServerLine.send({ result: "ok", id: 1 })
    await drain()

    // Client received the response
    expect(clientReceived).toEqual([{ result: "ok", id: 1 }])

    listener.dispose()
    clientLine.close()
    capturedServerLine.close()
  })
})

// ---------------------------------------------------------------------------
// Ack and pruning
// ---------------------------------------------------------------------------

describe("ack and pruning", () => {
  it("messages are delivered reliably after many send/receive cycles", async () => {
    const bridge = new Bridge()
    const exchangeA = createExchange({
      identity: { peerId: "alice" },
      transports: [createBridgeTransport({ transportType: "alice", bridge })],
    })
    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      transports: [createBridgeTransport({ transportType: "bob", bridge })],
    })

    await drain()

    const P = Line.protocol({ topic: "prune", schema: SimpleSchema })
    const lineA = P.open(exchangeA, "bob")
    const lineB = P.open(exchangeB, "alice")

    const received: { value: number }[] = []
    collect(lineB, received)

    // Send 10 messages in batches with drains between
    for (let i = 0; i < 5; i++) {
      lineA.send({ value: i })
    }
    await drain()

    // Verify first batch
    expect(received.length).toBeGreaterThanOrEqual(5)
    expect(received.slice(0, 5).map(m => m.value)).toEqual([0, 1, 2, 3, 4])

    // Send second batch
    for (let i = 5; i < 10; i++) {
      lineA.send({ value: i })
    }
    await drain()

    // All 10 should be received in order
    expect(received.map(m => m.value)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])

    lineA.close()
    lineB.close()
  })
})

// ---------------------------------------------------------------------------
// Duplicate detection
// ---------------------------------------------------------------------------

describe("duplicate detection", () => {
  it("throws when opening same peer+topic twice", () => {
    const exchange = createExchange({
      identity: { peerId: "alice" },
    })

    const P = Line.protocol({ topic: "dup", schema: SimpleSchema })
    const line = P.open(exchange, "bob")

    expect(() => P.open(exchange, "bob")).toThrow(/already open/)

    line.close()
  })

  it("different topics succeed", () => {
    const exchange = createExchange({
      identity: { peerId: "alice" },
    })

    const P1 = Line.protocol({ topic: "signaling", schema: SimpleSchema })
    const P2 = Line.protocol({ topic: "rpc", schema: SimpleSchema })
    const line1 = P1.open(exchange, "bob")
    const line2 = P2.open(exchange, "bob")

    expect(line1.topic).toBe("signaling")
    expect(line2.topic).toBe("rpc")

    line1.close()
    line2.close()
  })

  it("close then reopen succeeds", () => {
    const exchange = createExchange({
      identity: { peerId: "alice" },
    })

    const P = Line.protocol({ topic: "reuse", schema: SimpleSchema })
    const line1 = P.open(exchange, "bob")
    line1.close()

    // Should succeed — topic freed by close
    const line2 = P.open(exchange, "bob")

    expect(line2.peer).toBe("bob")
    line2.close()
  })
})

// ---------------------------------------------------------------------------
// Multiple Lines per peer pair
// ---------------------------------------------------------------------------

describe("multiple Lines per peer pair", () => {
  it("two Lines with different topics are independent", async () => {
    const bridge = new Bridge()
    const exchangeA = createExchange({
      identity: { peerId: "alice" },
      transports: [createBridgeTransport({ transportType: "alice", bridge })],
    })
    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      transports: [createBridgeTransport({ transportType: "bob", bridge })],
    })

    await drain()

    const SigProto = Line.protocol({
      topic: "signaling",
      schema: SimpleSchema,
    })
    const RpcProto = Line.protocol({ topic: "rpc", schema: SimpleSchema })

    const sigA = SigProto.open(exchangeA, "bob")
    const rpcA = RpcProto.open(exchangeA, "bob")

    const sigB = SigProto.open(exchangeB, "alice")
    const rpcB = RpcProto.open(exchangeB, "alice")

    const sigReceived: { value: number }[] = []
    const rpcReceived: { value: number }[] = []

    collect(sigB, sigReceived)
    collect(rpcB, rpcReceived)

    // Send on signaling topic only
    sigA.send({ value: 1 })

    await drain()

    expect(sigReceived.map(m => m.value)).toEqual([1])
    expect(rpcReceived).toEqual([]) // rpc should NOT see signaling messages

    // Now send on rpc
    rpcA.send({ value: 2 })
    await drain()

    expect(rpcReceived.map(m => m.value)).toEqual([2])
    expect(sigReceived.map(m => m.value)).toEqual([1]) // signaling should NOT see rpc messages

    sigA.close()
    rpcA.close()
    sigB.close()
    rpcB.close()
  })

  it("doc IDs are distinct", () => {
    const sigId = lineDocId("signaling", "alice", "bob")
    const rpcId = lineDocId("rpc", "alice", "bob")
    expect(sigId).not.toBe(rpcId)
    expect(sigId).toContain("signaling")
    expect(rpcId).toContain("rpc")
  })
})

// ---------------------------------------------------------------------------
// Closed Line guards
// ---------------------------------------------------------------------------

describe("closed Line guards", () => {
  it("send() on closed Line throws", () => {
    const exchange = createExchange({
      identity: { peerId: "alice" },
    })

    const P = Line.protocol({ topic: "guard", schema: SimpleSchema })
    const line = P.open(exchange, "bob")
    line.close()

    expect(() => line.send({ value: 1 })).toThrow(/closed/)
  })

  it("close() is idempotent", () => {
    const exchange = createExchange({
      identity: { peerId: "alice" },
    })

    const P = Line.protocol({ topic: "idem", schema: SimpleSchema })
    const line = P.open(exchange, "bob")
    line.close()

    // Second close should not throw
    expect(() => line.close()).not.toThrow()
    expect(line.closed).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Hub-and-spoke relay (symmetric, both sides call open)
// ---------------------------------------------------------------------------

describe("hub-and-spoke relay", () => {
  // Fixed by jj:oyouvrss — two independent fixes:
  // 1. Append-log replica + init ops: the relay's PlainReplica no longer
  //    calls step()/applyChange() on merge, so nested structures don't
  //    crash. Init ops enter the log and advance the version, breaking
  //    the sync deadlock.
  // 2. Line authorize abstain: the per-line policy now returns `undefined`
  //    (abstain) for unknown peers instead of `false` (hard veto), so
  //    relay-forwarded offers are accepted by the exchange-level authorize.
  it("messages flow Alice → Server → Bob via relay", async () => {
    const bridgeAS = new Bridge()
    const bridgeSB = new Bridge()

    // The server is a schema-free relay — it uses Replicate() for all
    // docs, same pattern as the existing authoritative relay integration test.
    const exchangeA = createExchange({
      identity: { peerId: "alice" },
      transports: [
        createBridgeTransport({ transportType: "alice", bridge: bridgeAS }),
      ],
    })

    const _exchangeServer = createExchange({
      identity: { peerId: "server", type: "service" },
      transports: [
        createBridgeTransport({ transportType: "server-a", bridge: bridgeAS }),
        createBridgeTransport({ transportType: "server-b", bridge: bridgeSB }),
      ],
      onUnresolvedDoc: () => Replicate(),
    })

    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      transports: [
        createBridgeTransport({ transportType: "bob", bridge: bridgeSB }),
      ],
    })

    await drain(40)

    const P = Line.protocol({ topic: "relay", schema: SimpleSchema })

    // Alice opens a Line to Bob (routed through server)
    const lineA = P.open(exchangeA, "bob")

    // Bob opens the corresponding Line
    const lineB = P.open(exchangeB, "alice")

    await drain(60)

    const receivedByB: { value: number }[] = []
    collect(lineB, receivedByB)

    lineA.send({ value: 42 })

    // Give plenty of drain rounds for multi-hop relay
    await drain(100)

    expect(receivedByB.map(m => m.value)).toContain(42)

    // Bob can reply back through server
    const receivedByA: { value: number }[] = []
    collect(lineA, receivedByA)

    lineB.send({ value: 99 })
    await drain(100)

    expect(receivedByA.map(m => m.value)).toContain(99)

    lineA.close()
    lineB.close()
  })
})

// ---------------------------------------------------------------------------
// protocol.listen — server role tests
// ---------------------------------------------------------------------------

describe("protocol.listen", () => {
  it("server responds to client request via protocol.listen", async () => {
    const bridge = new Bridge()
    const exchangeClient = createExchange({
      identity: { peerId: "client" },
      transports: [createBridgeTransport({ transportType: "client", bridge })],
    })
    const exchangeServer = createExchange({
      identity: { peerId: "server" },
      transports: [createBridgeTransport({ transportType: "server", bridge })],
    })

    await drain()

    const RPC = Line.protocol({
      topic: "rpc",
      client: RequestSchema,
      server: ResponseSchema,
    })

    // Server listens and responds to each request via async iterator
    let capturedServerLine: any = null
    const listener = RPC.listen(exchangeServer)
    listener.onLine(line => {
      capturedServerLine = line
      ;(async () => {
        for await (const msg of line) {
          line.send({
            result: `${(msg as any).method}:done`,
            id: (msg as any).id,
          })
        }
      })()
    })

    // Client opens, collects responses, then sends
    const clientLine = RPC.open(exchangeClient, "server")
    const clientReceived: Array<{ result: string; id: number }> = []
    collect(clientLine, clientReceived)

    clientLine.send({ method: "ping", id: 1 })
    await drain()

    // Client should have received the server's response
    expect(clientReceived).toEqual([{ result: "ping:done", id: 1 }])

    // Send another request to verify continued operation
    clientLine.send({ method: "status", id: 2 })
    await drain()

    expect(clientReceived).toEqual([
      { result: "ping:done", id: 1 },
      { result: "status:done", id: 2 },
    ])

    listener.dispose()
    clientLine.close()
    if (capturedServerLine) capturedServerLine.close()
  })

  it("multiple clients each get an independent Line", async () => {
    const bridge1 = new Bridge()
    const bridge2 = new Bridge()
    const exchangeServer = createExchange({
      identity: { peerId: "server" },
      transports: [
        createBridgeTransport({ transportType: "server1", bridge: bridge1 }),
        createBridgeTransport({ transportType: "server2", bridge: bridge2 }),
      ],
    })
    const exchangeClient1 = createExchange({
      identity: { peerId: "client1" },
      transports: [
        createBridgeTransport({ transportType: "client1", bridge: bridge1 }),
      ],
    })
    const exchangeClient2 = createExchange({
      identity: { peerId: "client2" },
      transports: [
        createBridgeTransport({ transportType: "client2", bridge: bridge2 }),
      ],
    })

    await drain()

    const RPC = Line.protocol({
      topic: "rpc-multi",
      client: RequestSchema,
      server: ResponseSchema,
    })

    // Server listens — collect lines and messages per client
    const serverLines: Array<{
      peer: string
      msgs: Array<{ method: string; id: number }>
    }> = []
    const listener = RPC.listen(exchangeServer)
    listener.onLine(line => {
      const entry = {
        peer: line.peer,
        msgs: [] as Array<{ method: string; id: number }>,
      }
      serverLines.push(entry)
      collect(line, entry.msgs)
    })

    // Both clients open Lines
    const clientLine1 = RPC.open(exchangeClient1, "server")
    const clientLine2 = RPC.open(exchangeClient2, "server")

    clientLine1.send({ method: "from-1", id: 1 })
    clientLine2.send({ method: "from-2", id: 2 })
    await drain()

    // Server should have two distinct Lines
    expect(serverLines.length).toBe(2)

    // Find entries by peer
    const entry1 = serverLines.find(e => e.peer === "client1")
    const entry2 = serverLines.find(e => e.peer === "client2")

    expect(entry1).toBeDefined()
    expect(entry2).toBeDefined()
    expect(entry1?.msgs).toEqual([{ method: "from-1", id: 1 }])
    expect(entry2?.msgs).toEqual([{ method: "from-2", id: 2 }])

    listener.dispose()
    clientLine1.close()
    clientLine2.close()
  })

  it("onLine callbacks — multiple, unsubscribe", async () => {
    const bridge1 = new Bridge()
    const bridge2 = new Bridge()
    const exchangeServer = createExchange({
      identity: { peerId: "server" },
      transports: [
        createBridgeTransport({ transportType: "server1", bridge: bridge1 }),
        createBridgeTransport({ transportType: "server2", bridge: bridge2 }),
      ],
    })
    const exchangeClientA = createExchange({
      identity: { peerId: "client-a" },
      transports: [
        createBridgeTransport({ transportType: "client-a", bridge: bridge1 }),
      ],
    })
    const exchangeClientB = createExchange({
      identity: { peerId: "client-b" },
      transports: [
        createBridgeTransport({ transportType: "client-b", bridge: bridge2 }),
      ],
    })

    await drain()

    const P = Line.protocol({ topic: "multi-cb-listen", schema: SimpleSchema })

    const cb1Peers: string[] = []
    const cb2Peers: string[] = []

    const listener = P.listen(exchangeServer)
    const unsub1 = listener.onLine(line => {
      cb1Peers.push(line.peer)
    })
    listener.onLine(line => {
      cb2Peers.push(line.peer)
    })

    // First client connects — both callbacks should fire
    const line1 = P.open(exchangeClientA, "server")
    await drain()

    expect(cb1Peers).toEqual(["client-a"])
    expect(cb2Peers).toEqual(["client-a"])

    // Unsubscribe the first callback
    unsub1()

    // Second client connects — only cb2 should fire
    const line2 = P.open(exchangeClientB, "server")
    await drain()

    expect(cb1Peers).toEqual(["client-a"]) // unchanged
    expect(cb2Peers).toEqual(["client-a", "client-b"])

    listener.dispose()
    line1.close()
    line2.close()
  })

  it("dispose() stops accepting new Lines but existing Lines remain open", async () => {
    const bridge1 = new Bridge()
    const bridge2 = new Bridge()
    const exchangeServer = createExchange({
      identity: { peerId: "server" },
      transports: [
        createBridgeTransport({ transportType: "server1", bridge: bridge1 }),
        createBridgeTransport({ transportType: "server2", bridge: bridge2 }),
      ],
    })
    const exchangeClient1 = createExchange({
      identity: { peerId: "client1" },
      transports: [
        createBridgeTransport({ transportType: "client1", bridge: bridge1 }),
      ],
    })
    const exchangeClient2 = createExchange({
      identity: { peerId: "client2" },
      transports: [
        createBridgeTransport({ transportType: "client2", bridge: bridge2 }),
      ],
    })

    await drain()

    const P = Line.protocol({ topic: "dispose-test", schema: SimpleSchema })

    // Server listens
    let capturedLine: any = null
    const onLinePeers: string[] = []
    const listener = P.listen(exchangeServer)
    listener.onLine(line => {
      onLinePeers.push(line.peer)
      capturedLine = line
    })

    // First client connects — onLine fires
    const clientLine1 = P.open(exchangeClient1, "server")
    await drain()

    expect(onLinePeers).toEqual(["client1"])
    expect(capturedLine).not.toBeNull()

    // Set up bidirectional messaging on the existing Line
    const serverReceived: { value: number }[] = []
    collect(capturedLine, serverReceived)

    const clientReceived: { value: number }[] = []
    collect(clientLine1, clientReceived)

    // Dispose the listener
    listener.dispose()

    // Second client connects — onLine should NOT fire
    const clientLine2 = P.open(exchangeClient2, "server")
    await drain()

    expect(onLinePeers).toEqual(["client1"]) // no new entry

    // But existing Line from client1 is still functional
    clientLine1.send({ value: 42 })
    await drain()

    expect(serverReceived).toEqual([{ value: 42 }])

    // Server can still send back on the existing Line
    capturedLine.send({ value: 99 })
    await drain()

    expect(clientReceived).toEqual([{ value: 99 }])

    clientLine1.close()
    clientLine2.close()
    capturedLine.close()
  })

  it("client's queued messages delivered immediately", async () => {
    const bridge = new Bridge()
    const exchangeClient = createExchange({
      identity: { peerId: "client" },
      transports: [createBridgeTransport({ transportType: "client", bridge })],
    })
    const exchangeServer = createExchange({
      identity: { peerId: "server" },
      transports: [createBridgeTransport({ transportType: "server", bridge })],
    })

    await drain()

    const P = Line.protocol({ topic: "queued", schema: SimpleSchema })

    // Server starts listening FIRST — but the client will send multiple
    // messages before the server's onDocCreated fires. When the Line is
    // constructed inside onLine, #processInbox() in the constructor picks
    // up all queued messages synchronously.
    let capturedLine: any = null
    const listener = P.listen(exchangeServer)
    listener.onLine(line => {
      capturedLine = line
    })

    // Client opens and sends multiple messages rapidly
    const clientLine = P.open(exchangeClient, "server")
    clientLine.send({ value: 1 })
    clientLine.send({ value: 2 })
    clientLine.send({ value: 3 })

    // Drain — the outbox doc syncs to the server exchange, onDocCreated
    // fires, and the Line constructor's #processInbox() runs.
    await drain()

    expect(capturedLine).not.toBeNull()

    // Use collect to verify all queued messages are available
    const received: { value: number }[] = []
    collect(capturedLine, received)
    await drain()

    expect(received).toEqual([{ value: 1 }, { value: 2 }, { value: 3 }])

    // Verify subsequent messages also arrive
    clientLine.send({ value: 4 })
    await drain()

    expect(received).toEqual([
      { value: 1 },
      { value: 2 },
      { value: 3 },
      { value: 4 },
    ])

    listener.dispose()
    clientLine.close()
    capturedLine.close()
  })

  it("hub-and-spoke relay with protocol.listen", async () => {
    const bridgeCR = new Bridge()
    const bridgeRS = new Bridge()

    const exchangeClient = createExchange({
      identity: { peerId: "client" },
      transports: [
        createBridgeTransport({ transportType: "client", bridge: bridgeCR }),
      ],
    })

    const _exchangeRelay = createExchange({
      identity: { peerId: "relay", type: "service" },
      transports: [
        createBridgeTransport({ transportType: "relay-c", bridge: bridgeCR }),
        createBridgeTransport({ transportType: "relay-s", bridge: bridgeRS }),
      ],
      onUnresolvedDoc: () => Replicate(),
    })

    const exchangeServer = createExchange({
      identity: { peerId: "server" },
      transports: [
        createBridgeTransport({ transportType: "server", bridge: bridgeRS }),
      ],
    })

    await drain(40)

    const RPC = Line.protocol({
      topic: "relay-rpc",
      client: RequestSchema,
      server: ResponseSchema,
    })

    // Server listens
    let capturedServerLine: any = null
    const serverReceived: Array<{ method: string; id: number }> = []
    const listener = RPC.listen(exchangeServer)
    listener.onLine(line => {
      capturedServerLine = line
      collect(line, serverReceived)
    })

    // Client opens a Line to server (routed through relay)
    const clientLine = RPC.open(exchangeClient, "server")
    const clientReceived: Array<{ result: string; id: number }> = []
    collect(clientLine, clientReceived)

    await drain(60)

    // Client sends a request
    clientLine.send({ method: "relay-ping", id: 1 })

    // Give plenty of drain rounds for multi-hop relay
    await drain(100)

    // Server's onLine should have fired
    expect(capturedServerLine).not.toBeNull()
    expect(serverReceived).toEqual([{ method: "relay-ping", id: 1 }])

    // Server responds
    capturedServerLine.send({ result: "relay-pong", id: 1 })
    await drain(100)

    // Client receives the response through relay
    expect(clientReceived).toEqual([{ result: "relay-pong", id: 1 }])

    listener.dispose()
    clientLine.close()
    capturedServerLine.close()
  })

  it("late listen: client connects before server starts listening", async () => {
    const bridge = new Bridge()
    const exchangeClient = createExchange({
      identity: { peerId: "client" },
      transports: [createBridgeTransport({ transportType: "client", bridge })],
    })
    const exchangeServer = createExchange({
      identity: { peerId: "server" },
      transports: [createBridgeTransport({ transportType: "server", bridge })],
    })

    await drain()

    const P = Line.protocol({ topic: "late-listen", schema: SimpleSchema })

    // Client opens and sends BEFORE server starts listening.
    // The client's outbox doc will arrive at the server exchange and be
    // deferred (no schema registered yet). When listen() calls
    // registerSchema(), the deferred doc is auto-promoted with
    // origin: "local" — the listener must still detect it.
    const clientLine = P.open(exchangeClient, "server")
    clientLine.send({ value: 42 })

    await drain()

    // NOW the server starts listening — after the client's doc has arrived
    let capturedLine: any = null
    const listener = P.listen(exchangeServer)
    listener.onLine(line => {
      capturedLine = line
    })

    // Give time for the deferred→promoted transition to fire onDocCreated
    await drain()

    expect(capturedLine).not.toBeNull()
    expect(capturedLine.peer).toBe("client")

    // Verify the queued message is available
    const iter = capturedLine[Symbol.asyncIterator]()
    const result = await Promise.race([
      iter.next(),
      new Promise<{ value: undefined; done: true }>(r =>
        setTimeout(() => r({ value: undefined, done: true }), 500),
      ),
    ])
    expect(result.done).toBe(false)
    expect(result.value).toEqual({ value: 42 })

    listener.dispose()
    clientLine.close()
    capturedLine.close()
  })

  it("listeners on different topics are independent", async () => {
    const bridge = new Bridge()
    const exchangeClient = createExchange({
      identity: { peerId: "client" },
      transports: [createBridgeTransport({ transportType: "client", bridge })],
    })
    const exchangeServer = createExchange({
      identity: { peerId: "server" },
      transports: [createBridgeTransport({ transportType: "server", bridge })],
    })

    await drain()

    // Use distinct schemas — two protocols that both listen() on the same
    // exchange must have different schemas. If they share a schema, the
    // capabilities registry (keyed by schemaHash) stores only the last
    // BoundSchema reference, and exchange.get() throws on reference
    // inequality when the other listener's onDocCreated fires.
    const ChatSchema = Schema.struct({ text: Schema.string() })
    const RpcSchema = Schema.struct({ method: Schema.string() })

    const ChatProto = Line.protocol({ topic: "chat", schema: ChatSchema })
    const RpcProto = Line.protocol({ topic: "rpc", schema: RpcSchema })

    const chatPeers: string[] = []
    const rpcPeers: string[] = []

    const chatListener = ChatProto.listen(exchangeServer)
    chatListener.onLine(line => chatPeers.push(line.peer))

    const rpcListener = RpcProto.listen(exchangeServer)
    rpcListener.onLine(line => rpcPeers.push(line.peer))

    // Client opens only a chat Line — rpc listener should NOT fire
    const chatLine = ChatProto.open(exchangeClient, "server")
    await drain()

    expect(chatPeers).toEqual(["client"])
    expect(rpcPeers).toEqual([])

    chatListener.dispose()
    rpcListener.dispose()
    chatLine.close()
  })

  it("listener ignores Line docs addressed to other peers", async () => {
    const bridgeAS = new Bridge()
    const bridgeBS = new Bridge()

    const exchangeA = createExchange({
      identity: { peerId: "alice" },
      transports: [
        createBridgeTransport({ transportType: "alice", bridge: bridgeAS }),
      ],
    })
    const _exchangeB = createExchange({
      identity: { peerId: "bob" },
      transports: [
        createBridgeTransport({ transportType: "bob", bridge: bridgeBS }),
      ],
    })
    const exchangeServer = createExchange({
      identity: { peerId: "server" },
      transports: [
        createBridgeTransport({ transportType: "server-a", bridge: bridgeAS }),
        createBridgeTransport({ transportType: "server-b", bridge: bridgeBS }),
      ],
    })

    await drain()

    const P = Line.protocol({ topic: "targeted", schema: SimpleSchema })

    // Server listens — should only see Lines addressed to "server"
    const serverPeers: string[] = []
    const listener = P.listen(exchangeServer)
    listener.onLine(line => serverPeers.push(line.peer))

    // Alice opens a Line to the server — should fire
    const lineToServer = P.open(exchangeA, "server")
    await drain()

    expect(serverPeers).toEqual(["alice"])

    // Alice opens a Line to Bob (not the server) — the server can see
    // the doc via sync, but the listener must NOT fire for it
    const lineToBob = P.open(exchangeA, "bob")
    await drain()

    expect(serverPeers).toEqual(["alice"]) // unchanged

    listener.dispose()
    lineToServer.close()
    lineToBob.close()
  })
})

// ---------------------------------------------------------------------------
// Durable Line tests
// ---------------------------------------------------------------------------

describe("durable Line: close() vs destroy()", () => {
  it("close() preserves documents — destroy() removes them", () => {
    const exchange = createExchange({
      identity: { peerId: "alice" },
    })

    const P = Line.protocol({ topic: "close-vs-destroy", schema: SimpleSchema })
    const outboxDocId = lineDocId("close-vs-destroy", "alice", "bob")
    const inboxDocId = lineDocId("close-vs-destroy", "bob", "alice")

    // close() — docs remain
    const line1 = P.open(exchange, "bob")
    line1.close()
    expect(exchange.has(outboxDocId)).toBe(true)
    expect(exchange.has(inboxDocId)).toBe(true)

    // destroy() — docs removed
    const line2 = P.open(exchange, "bob")
    line2.destroy()
    expect(exchange.has(outboxDocId)).toBe(false)
    expect(exchange.has(inboxDocId)).toBe(false)
  })

  it("destroy() after close() is safe", () => {
    const exchange = createExchange({
      identity: { peerId: "alice" },
    })

    const P = Line.protocol({
      topic: "destroy-after-close",
      schema: SimpleSchema,
    })
    const line = P.open(exchange, "bob")
    line.close()
    expect(() => line.destroy()).not.toThrow()
  })

  it("destroy() resets state — reopen starts fresh at seq 1", async () => {
    const bridge = new Bridge()
    const exchangeA = createExchange({
      identity: { peerId: "alice" },
      transports: [createBridgeTransport({ transportType: "alice", bridge })],
    })
    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      transports: [createBridgeTransport({ transportType: "bob", bridge })],
    })
    await drain()

    const P = Line.protocol({ topic: "destroy-reset", schema: SimpleSchema })

    // Session 1: send messages, let acks flow
    const lineA1 = P.open(exchangeA, "bob")
    const lineB1 = P.open(exchangeB, "alice")
    const received1: any[] = []
    collect(lineB1, received1)

    lineA1.send({ value: 10 })
    lineA1.send({ value: 20 })
    await drain()
    expect(received1.length).toBe(2)

    // Destroy both sides — documents deleted, state gone
    lineA1.destroy()
    lineB1.destroy()

    // Session 2: reopen — should be a fresh Line (seq starts at 1)
    const lineA2 = P.open(exchangeA, "bob")
    const lineB2 = P.open(exchangeB, "alice")
    const received2: any[] = []
    collect(lineB2, received2)

    lineA2.send({ value: 30 })
    await drain()

    // Message arrives — seq numbering restarted from 1 so
    // Bob's fresh lastProcessedSeq=0 accepts seq=1.
    expect(received2.length).toBe(1)
    expect(received2[0]).toEqual({ value: 30 })

    lineA2.close()
    lineB2.close()
  })
})

describe("durable Line: nextSeq persistence", () => {
  it("nextSeq survives prune — close+reopen after prune still resumes", async () => {
    const bridge = new Bridge()
    const exchangeA = createExchange({
      identity: { peerId: "alice" },
      transports: [createBridgeTransport({ transportType: "alice", bridge })],
    })
    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      transports: [createBridgeTransport({ transportType: "bob", bridge })],
    })
    await drain()

    const P = Line.protocol({ topic: "seq-prune", schema: SimpleSchema })
    const lineA1 = P.open(exchangeA, "bob")
    const lineB1 = P.open(exchangeB, "alice")

    // Send 3 messages from Alice, let Bob ack and prune
    const received1: any[] = []
    collect(lineB1, received1)

    lineA1.send({ value: 1 })
    lineA1.send({ value: 2 })
    lineA1.send({ value: 3 })
    await drain()

    expect(received1.length).toBe(3)

    // Close both sides — prune has already happened
    lineA1.close()
    lineB1.close()

    // Reopen — nextSeq must be 4 even though outbox messages were pruned
    const lineA2 = P.open(exchangeA, "bob")
    const lineB2 = P.open(exchangeB, "alice")
    const received2: any[] = []
    collect(lineB2, received2)

    lineA2.send({ value: 4 })
    await drain()

    // Bob should receive message 4 (not skipped due to duplicate seq)
    expect(received2.length).toBe(1)
    expect(received2[0]).toEqual({ value: 4 })

    lineA2.close()
    lineB2.close()
  })
})

describe("durable Line: peer lifecycle decoupling", () => {
  it("Line remains open and functional after remote peer departs", async () => {
    const bridge = new Bridge()
    const exchangeA = createExchange({
      identity: { peerId: "alice" },
      transports: [createBridgeTransport({ transportType: "alice", bridge })],
      departureTimeout: 0, // immediate departure
    })
    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      transports: [createBridgeTransport({ transportType: "bob", bridge })],
    })
    await drain()

    const P = Line.protocol({ topic: "no-depart", schema: SimpleSchema })
    const lineA = P.open(exchangeA, "bob")
    await drain()

    // Remove Bob's transport — triggers peer-departed on Alice (timeout=0)
    await exchangeB.shutdown()
    await drain()

    // Line should NOT be closed — decoupled from peer lifecycle
    expect(lineA.closed).toBe(false)
    // send() should still work — messages queue in outbox
    expect(() => lineA.send({ value: 42 })).not.toThrow()

    lineA.close()
  })
})

describe("durable Line: close then reopen resumes state", () => {
  it("close+reopen delivers new messages without replaying old ones", async () => {
    const bridge = new Bridge()
    const exchangeA = createExchange({
      identity: { peerId: "alice" },
      transports: [createBridgeTransport({ transportType: "alice", bridge })],
    })
    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      transports: [createBridgeTransport({ transportType: "bob", bridge })],
    })
    await drain()

    const P = Line.protocol({ topic: "resume", schema: SimpleSchema })

    // Session 1: send messages, let acks flow, close
    const lineA1 = P.open(exchangeA, "bob")
    const lineB1 = P.open(exchangeB, "alice")
    const received1: any[] = []
    collect(lineB1, received1)

    lineA1.send({ value: 1 })
    lineA1.send({ value: 2 })
    lineA1.send({ value: 3 })
    await drain()
    expect(received1.length).toBe(3)

    lineA1.close()
    lineB1.close()

    // Session 2: re-open and send another message
    const lineA2 = P.open(exchangeA, "bob")
    const lineB2 = P.open(exchangeB, "alice")
    const received2: any[] = []
    collect(lineB2, received2)
    await drain()

    // No replayed messages from session 1
    expect(received2.length).toBe(0)

    lineA2.send({ value: 99 })
    await drain()

    // New message arrives — seq continued from persisted nextSeq,
    // so Bob's persisted lastProcessedSeq doesn't skip it.
    expect(received2.length).toBe(1)
    expect(received2[0]).toEqual({ value: 99 })

    lineA2.close()
    lineB2.close()
  })
})

describe("durable Line: disconnect/reconnect", () => {
  it("messages sent during disconnect are delivered on reconnect", async () => {
    const bridge = new Bridge()
    const exchangeA = createExchange({
      identity: { peerId: "alice" },
      transports: [createBridgeTransport({ transportType: "alice", bridge })],
    })
    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      transports: [createBridgeTransport({ transportType: "bob", bridge })],
    })
    await drain()

    const P = Line.protocol({ topic: "disconnect", schema: SimpleSchema })
    const lineA = P.open(exchangeA, "bob")
    const lineB = P.open(exchangeB, "alice")
    const received: any[] = []
    collect(lineB, received)

    // Send 3 messages while connected
    lineA.send({ value: 1 })
    lineA.send({ value: 2 })
    lineA.send({ value: 3 })
    await drain()
    expect(received.length).toBe(3)

    // Disconnect Bob
    await exchangeB.removeTransport("bob")
    await drain()

    // Send 2 more messages while disconnected
    lineA.send({ value: 4 })
    lineA.send({ value: 5 })
    await drain()

    // Bob should not have received the new messages yet
    expect(received.length).toBe(3)

    // Reconnect Bob
    await exchangeB.addTransport(
      new BridgeTransport({ transportType: "bob", bridge }),
    )
    await drain()

    // Bob should now have all 5 messages in order
    expect(received.map(m => m.value)).toEqual([1, 2, 3, 4, 5])

    lineA.close()
    lineB.close()
  })

  it("bidirectional sends during disconnect — both sides receive all", async () => {
    const bridge = new Bridge()
    const exchangeA = createExchange({
      identity: { peerId: "alice" },
      transports: [createBridgeTransport({ transportType: "alice", bridge })],
    })
    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      transports: [createBridgeTransport({ transportType: "bob", bridge })],
    })
    await drain()

    const P = Line.protocol({ topic: "bidi-disconnect", schema: SimpleSchema })
    const lineA = P.open(exchangeA, "bob")
    const lineB = P.open(exchangeB, "alice")
    const receivedByA: any[] = []
    const receivedByB: any[] = []
    collect(lineA, receivedByA)
    collect(lineB, receivedByB)

    // Initial exchange
    lineA.send({ value: 1 })
    lineB.send({ value: 100 })
    await drain()

    // Disconnect
    await exchangeB.removeTransport("bob")
    await drain()

    // Both sides send during disconnect
    lineA.send({ value: 2 })
    lineA.send({ value: 3 })
    lineB.send({ value: 200 })
    lineB.send({ value: 300 })
    await drain()

    // Reconnect
    await exchangeB.addTransport(
      new BridgeTransport({ transportType: "bob", bridge }),
    )
    await drain()

    // Both sides should have received all messages
    expect(receivedByB.map(m => m.value)).toEqual([1, 2, 3])
    expect(receivedByA.map(m => m.value)).toEqual([100, 200, 300])

    lineA.close()
    lineB.close()
  })
})

describe("durable Line: survives peer departure", () => {
  it("queued messages are delivered when peer returns after departure", async () => {
    const bridge = new Bridge()
    const exchangeA = createExchange({
      identity: { peerId: "alice" },
      transports: [createBridgeTransport({ transportType: "alice", bridge })],
      departureTimeout: 0,
    })
    let exchangeB = createExchange({
      identity: { peerId: "bob" },
      transports: [createBridgeTransport({ transportType: "bob", bridge })],
    })
    await drain()

    const P = Line.protocol({ topic: "survive-depart", schema: SimpleSchema })
    const lineA = P.open(exchangeA, "bob")

    // Send initial messages while Bob is connected
    lineA.send({ value: 1 })
    lineA.send({ value: 2 })
    await drain()

    // Shut down Bob — triggers peer-departed (timeout=0)
    await exchangeB.shutdown()
    await drain()

    // Alice's Line should still be open
    expect(lineA.closed).toBe(false)

    // Alice queues more messages while Bob is gone
    lineA.send({ value: 3 })
    lineA.send({ value: 4 })
    await drain()

    // Bob returns — new Exchange instance, same peerId
    exchangeB = createExchange({
      identity: { peerId: "bob" },
      transports: [createBridgeTransport({ transportType: "bob", bridge })],
    })
    await drain()

    // Bob listens and receives all queued messages
    const listener = P.listen(exchangeB)
    const received: any[] = []
    let capturedLine: Line<any, any> | null = null
    listener.onLine((line: Line<any, any>) => {
      capturedLine = line
      collect(line, received)
    })
    await drain()

    // Bob should receive messages 1-4 (messages sent before and after departure)
    // Note: messages 1-2 may have been pruned if acks flowed before departure.
    // At minimum, messages 3-4 must arrive.
    expect(received.length).toBeGreaterThanOrEqual(2)
    expect(received.map(m => m.value)).toContain(3)
    expect(received.map(m => m.value)).toContain(4)

    lineA.close()
    if (capturedLine) (capturedLine as Line<any, any>).close()
    listener.dispose()
  })
})

describe("durable Line: bidirectional close/reopen", () => {
  it("bidirectional close/reopen cycle preserves seq on both sides", async () => {
    const bridge = new Bridge()
    const exchangeA = createExchange({
      identity: { peerId: "alice" },
      transports: [createBridgeTransport({ transportType: "alice", bridge })],
    })
    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      transports: [createBridgeTransport({ transportType: "bob", bridge })],
    })
    await drain()

    const P = Line.protocol({ topic: "bidi-reopen", schema: SimpleSchema })

    // Session 1: bidirectional exchange
    const lineA1 = P.open(exchangeA, "bob")
    const lineB1 = P.open(exchangeB, "alice")
    const recvA1: any[] = []
    const recvB1: any[] = []
    collect(lineA1, recvA1)
    collect(lineB1, recvB1)

    lineA1.send({ value: 1 })
    lineB1.send({ value: 100 })
    await drain()

    expect(recvA1.length).toBe(1)
    expect(recvB1.length).toBe(1)

    // Both sides close
    lineA1.close()
    lineB1.close()

    // Session 2: both sides reopen
    const lineA2 = P.open(exchangeA, "bob")
    const lineB2 = P.open(exchangeB, "alice")
    const recvA2: any[] = []
    const recvB2: any[] = []
    collect(lineA2, recvA2)
    collect(lineB2, recvB2)

    lineA2.send({ value: 2 })
    lineB2.send({ value: 200 })
    await drain()

    // Both sides should receive the session-2 messages (not dropped as duplicates)
    expect(recvA2.map(m => m.value)).toEqual([200])
    expect(recvB2.map(m => m.value)).toEqual([2])

    lineA2.close()
    lineB2.close()
  })
})

describe("durable Line: storage stays bounded", () => {
  async function countEntries(
    store: InMemoryStore,
    docId: DocId,
  ): Promise<number> {
    let n = 0
    for await (const _ of store.loadAll(docId)) n++
    return n
  }

  it("unidirectional: sender's store stays bounded even when receiver never sends", async () => {
    const storeA = new InMemoryStore()
    const storeB = new InMemoryStore()
    const bridge = new Bridge()

    const exchangeA = createExchange({
      identity: { peerId: "alice" },
      transports: [createBridgeTransport({ transportType: "alice", bridge })],
      stores: [storeA],
    })
    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      transports: [createBridgeTransport({ transportType: "bob", bridge })],
      stores: [storeB],
    })

    // Flush hydration before opening Lines
    await exchangeA.flush()
    await exchangeB.flush()
    await drain()

    const P = Line.protocol({ topic: "bounded", schema: SimpleSchema })
    const lineA = P.open(exchangeA, "bob")
    const lineB = P.open(exchangeB, "alice")

    // Flush line doc hydration
    await exchangeA.flush()
    await exchangeB.flush()
    await drain()

    const received: any[] = []
    collect(lineB, received)

    const MESSAGE_COUNT = 20

    // Unidirectional: only Alice sends, Bob only receives.
    // Bob's ack syncs back to Alice's inbox — prune must still
    // fire even though no messages flow from Bob to Alice.
    for (let i = 0; i < MESSAGE_COUNT; i++) {
      lineA.send({ value: i })
      await drain(60)
    }

    // Let final ack/prune/compact settle
    await drain(120)
    await exchangeA.flush()
    await exchangeB.flush()
    await drain(60)

    expect(received.length).toBe(MESSAGE_COUNT)

    // Storage: Alice's outbox should be compacted down to O(1) entries.
    // Without prune firing on ack-only inbox changes, this would be
    // ~MESSAGE_COUNT entries (unbounded growth).
    const outboxA = lineDocId("bounded", "alice", "bob") as DocId
    const entriesA = await countEntries(storeA, outboxA)

    // Compaction replaces all entries with 1. A small number (≤ 3)
    // accounts for a trailing delta that arrived after the last compact.
    expect(entriesA).toBeLessThanOrEqual(3)

    lineA.close()
    lineB.close()
  })
})

// ---------------------------------------------------------------------------
// Per-Exchange Line Registry
// ---------------------------------------------------------------------------

describe("per-Exchange Line registry", () => {
  it("two Exchange instances with the same peerId can each open a Line", () => {
    const P = Line.protocol({ topic: "registry", schema: SimpleSchema })

    const ex1 = createExchange({ identity: { peerId: "alice" } })
    const ex2 = createExchange({ identity: { peerId: "alice" } })

    const line1 = P.open(ex1, "bob")
    const line2 = P.open(ex2, "bob")

    expect(line1.peer).toBe("bob")
    expect(line2.peer).toBe("bob")

    line1.close()
    line2.close()
  })

  it("shutting down one Exchange does not affect the other's open Lines", async () => {
    const P = Line.protocol({ topic: "isolation", schema: SimpleSchema })

    const ex1 = createExchange({ identity: { peerId: "alice" } })
    const ex2 = createExchange({ identity: { peerId: "alice" } })

    const line1 = P.open(ex1, "bob")
    const line2 = P.open(ex2, "bob")

    await ex1.shutdown()
    // Remove from activeExchanges so afterEach doesn't double-shutdown
    const idx = activeExchanges.indexOf(ex1)
    if (idx !== -1) activeExchanges.splice(idx, 1)

    expect(line1.closed).toBe(true)
    expect(line2.closed).toBe(false)

    line2.close()
  })
})

// ---------------------------------------------------------------------------
// Line Policy Teardown
// ---------------------------------------------------------------------------

describe("Line policy teardown", () => {
  it("exchange.shutdown() closes all open Lines", async () => {
    const bridge = new Bridge()
    const P = Line.protocol({ topic: "teardown", schema: SimpleSchema })

    const exchangeA = createExchange({
      identity: { peerId: "alice" },
      transports: [createBridgeTransport({ transportType: "alice", bridge })],
    })

    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      transports: [createBridgeTransport({ transportType: "bob", bridge })],
    })

    const listener = P.listen(exchangeB)
    const serverLines: Line<any, any>[] = []
    listener.onLine(line => serverLines.push(line))

    const clientLine = P.open(exchangeA, "bob")
    clientLine.send({ value: 1 })

    await drain()

    expect(serverLines.length).toBe(1)

    // Shutdown both — should close all lines via policy teardown
    await exchangeA.shutdown()
    await exchangeB.shutdown()

    // Remove from activeExchanges
    activeExchanges.length = 0

    expect(clientLine.closed).toBe(true)
    expect(serverLines[0].closed).toBe(true)
  })

  it("exchange.reset() closes all open Lines", () => {
    const P = Line.protocol({ topic: "reset-teardown", schema: SimpleSchema })
    const exchange = createExchange({ identity: { peerId: "alice" } })

    const line = P.open(exchange, "bob")
    expect(line.closed).toBe(false)

    exchange.reset()

    expect(line.closed).toBe(true)
  })

  it("exchange.shutdown() disposes all active listeners", async () => {
    const bridge = new Bridge()
    const P = Line.protocol({
      topic: "listener-teardown",
      schema: SimpleSchema,
    })

    const exchangeA = createExchange({
      identity: { peerId: "alice" },
      transports: [createBridgeTransport({ transportType: "alice", bridge })],
    })

    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      transports: [createBridgeTransport({ transportType: "bob", bridge })],
    })

    const listener = P.listen(exchangeB)
    const serverLines: Line<any, any>[] = []
    listener.onLine(line => serverLines.push(line))

    // First client connects
    const client1 = P.open(exchangeA, "bob")
    await drain()
    expect(serverLines.length).toBe(1)

    // Shutdown exchangeB — disposes listener
    await exchangeB.shutdown()
    const idx = activeExchanges.indexOf(exchangeB)
    if (idx !== -1) activeExchanges.splice(idx, 1)

    // Create a new exchangeB and new client — listener should NOT fire
    const exchangeB2 = createExchange({
      identity: { peerId: "bob" },
      transports: [createBridgeTransport({ transportType: "bob2", bridge })],
    })

    // Register a NEW listener on the new exchange to prove the old one is dead
    const listener2 = P.listen(exchangeB2)
    const serverLines2: Line<any, any>[] = []
    listener2.onLine(line => serverLines2.push(line))

    // serverLines should still be 1 — old listener was disposed
    expect(serverLines.length).toBe(1)

    client1.close()
    listener2.dispose()
  })

  it("after shutdown + new Exchange, protocol.open() succeeds", async () => {
    const P = Line.protocol({ topic: "reopen", schema: SimpleSchema })

    const ex1 = createExchange({ identity: { peerId: "alice" } })
    const line1 = P.open(ex1, "bob")
    expect(line1.closed).toBe(false)

    await ex1.shutdown()
    const idx = activeExchanges.indexOf(ex1)
    if (idx !== -1) activeExchanges.splice(idx, 1)

    expect(line1.closed).toBe(true)

    const ex2 = createExchange({ identity: { peerId: "alice" } })
    const line2 = P.open(ex2, "bob")
    expect(line2.closed).toBe(false)
    expect(line2.peer).toBe("bob")

    line2.close()
  })

  it("manual close() followed by shutdown() is safe — no double-fire", async () => {
    const P = Line.protocol({ topic: "double-safe", schema: SimpleSchema })
    const exchange = createExchange({ identity: { peerId: "alice" } })

    const line = P.open(exchange, "bob")
    line.close()
    expect(line.closed).toBe(true)

    // Shutdown should not throw — dispose callback calls close() again,
    // which is idempotent
    await exchange.shutdown()
    const idx = activeExchanges.indexOf(exchange)
    if (idx !== -1) activeExchanges.splice(idx, 1)

    expect(line.closed).toBe(true)
  })
})

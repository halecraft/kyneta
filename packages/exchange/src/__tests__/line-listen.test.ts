// Line listen tests — protocol.listen() server-side behavior:
// request-response, multiple clients, callback management, dispose,
// queued messages, late listen, topic independence, targeted routing.

import { Bridge, createBridgeTransport } from "@kyneta/bridge-transport"
import { Schema } from "@kyneta/schema"
import { afterEach, describe, expect, it } from "vitest"
import { Exchange, type ExchangeParams } from "../exchange.js"
import { Line } from "../line.js"

// ── Helpers ──────────────────────────────────────────────────────────────────

async function drain(rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>(r => queueMicrotask(r))
    await new Promise<void>(r => setTimeout(r, 0))
  }
}

const activeExchanges: Exchange[] = []

function createExchange(params: Partial<ExchangeParams> = {}): Exchange {
  const ex = new Exchange({ principal: "test", ...params })
  activeExchanges.push(ex)
  return ex
}

function collect<T>(recv: AsyncIterable<T>, into: T[]): void {
  ;(async () => {
    for await (const msg of recv) into.push(msg)
  })()
}

afterEach(async () => {
  for (const ex of activeExchanges) {
    try {
      await ex.shutdown()
    } catch {
      /* ignore */
    }
  }
  activeExchanges.length = 0
})

const RequestSchema = Schema.struct({
  method: Schema.string(),
  id: Schema.number(),
})
const ResponseSchema = Schema.struct({
  result: Schema.string(),
  id: Schema.number(),
})
const SimpleSchema = Schema.struct({ value: Schema.number() })

// ── Tests ────────────────────────────────────────────────────────────────────

describe("protocol.listen", () => {
  it("server responds to client request via onReceive", async () => {
    const bridge = new Bridge()
    const exchangeClient = createExchange({
      principal: "client",
      transports: [createBridgeTransport({ transportId: "client", bridge })],
    })
    const exchangeServer = createExchange({
      principal: "server",
      transports: [createBridgeTransport({ transportId: "server", bridge })],
    })
    await drain()

    const RPC = Line.protocol({
      topic: "rpc",
      client: RequestSchema,
      server: ResponseSchema,
    })

    let capturedServerSender: any = null
    const listener = RPC.listen(exchangeServer)
    listener.onReceive((sender, receiver) => {
      capturedServerSender = sender
      ;(async () => {
        for await (const msg of receiver) {
          sender.send({
            result: `${(msg as any).method}:done`,
            id: (msg as any).id,
          })
        }
      })()
    })

    const clientSender = RPC.sender(exchangeClient, exchangeServer.peerId)
    const clientReceiver = RPC.claimReceiver(
      exchangeClient,
      exchangeServer.peerId,
    )
    const clientReceived: Array<{ result: string; id: number }> = []
    collect(clientReceiver, clientReceived)

    clientSender.send({ method: "ping", id: 1 })
    await drain()
    expect(clientReceived).toEqual([{ result: "ping:done", id: 1 }])

    clientSender.send({ method: "status", id: 2 })
    await drain()
    expect(clientReceived).toEqual([
      { result: "ping:done", id: 1 },
      { result: "status:done", id: 2 },
    ])

    listener.dispose()
    clientSender.close()
    clientReceiver.close()
    capturedServerSender?.close()
  })

  it("multiple clients each get an independent Line", async () => {
    const bridge1 = new Bridge()
    const bridge2 = new Bridge()
    const exchangeServer = createExchange({
      principal: "server",
      transports: [
        createBridgeTransport({ transportId: "server1", bridge: bridge1 }),
        createBridgeTransport({ transportId: "server2", bridge: bridge2 }),
      ],
    })
    const exchangeClient1 = createExchange({
      principal: "client1",
      transports: [
        createBridgeTransport({ transportId: "client1", bridge: bridge1 }),
      ],
    })
    const exchangeClient2 = createExchange({
      principal: "client2",
      transports: [
        createBridgeTransport({ transportId: "client2", bridge: bridge2 }),
      ],
    })
    await drain()

    const RPC = Line.protocol({
      topic: "rpc-multi",
      client: RequestSchema,
      server: ResponseSchema,
    })

    const serverEntries: Array<{
      peer: string
      msgs: Array<{ method: string; id: number }>
    }> = []
    const listener = RPC.listen(exchangeServer)
    listener.onReceive((_sender, receiver) => {
      const entry = {
        peer: receiver.peer,
        msgs: [] as Array<{ method: string; id: number }>,
      }
      serverEntries.push(entry)
      collect(receiver, entry.msgs)
    })

    const clientSender1 = RPC.sender(exchangeClient1, exchangeServer.peerId)
    const clientSender2 = RPC.sender(exchangeClient2, exchangeServer.peerId)

    clientSender1.send({ method: "from-1", id: 1 })
    clientSender2.send({ method: "from-2", id: 2 })
    await drain()

    expect(serverEntries.length).toBe(2)
    const entry1 = serverEntries.find(e => e.peer === exchangeClient1.peerId)
    const entry2 = serverEntries.find(e => e.peer === exchangeClient2.peerId)
    expect(entry1?.msgs).toEqual([{ method: "from-1", id: 1 }])
    expect(entry2?.msgs).toEqual([{ method: "from-2", id: 2 }])

    listener.dispose()
    clientSender1.close()
    clientSender2.close()
  })

  it("onReceive callbacks — multiple, unsubscribe", async () => {
    const bridge1 = new Bridge()
    const bridge2 = new Bridge()
    const exchangeServer = createExchange({
      principal: "server",
      transports: [
        createBridgeTransport({ transportId: "server1", bridge: bridge1 }),
        createBridgeTransport({ transportId: "server2", bridge: bridge2 }),
      ],
    })
    const exchangeClientA = createExchange({
      principal: "client-a",
      transports: [
        createBridgeTransport({ transportId: "client-a", bridge: bridge1 }),
      ],
    })
    const exchangeClientB = createExchange({
      principal: "client-b",
      transports: [
        createBridgeTransport({ transportId: "client-b", bridge: bridge2 }),
      ],
    })
    await drain()

    const P = Line.protocol({ topic: "multi-cb", schema: SimpleSchema })

    const cb1Peers: string[] = []
    const cb2Peers: string[] = []

    const listener = P.listen(exchangeServer)
    const unsub1 = listener.onReceive((_s, r) => cb1Peers.push(r.peer))
    listener.onReceive((_s, r) => cb2Peers.push(r.peer))

    const line1 = P.sender(exchangeClientA, exchangeServer.peerId)
    await drain()
    expect(cb1Peers).toEqual([exchangeClientA.peerId])
    expect(cb2Peers).toEqual([exchangeClientA.peerId])

    unsub1()

    const line2 = P.sender(exchangeClientB, exchangeServer.peerId)
    await drain()
    expect(cb1Peers).toEqual([exchangeClientA.peerId])
    expect(cb2Peers).toEqual([exchangeClientA.peerId, exchangeClientB.peerId])

    listener.dispose()
    line1.close()
    line2.close()
  })

  it("dispose() stops accepting new Lines but existing Lines remain open", async () => {
    const bridge1 = new Bridge()
    const bridge2 = new Bridge()
    const exchangeServer = createExchange({
      principal: "server",
      transports: [
        createBridgeTransport({ transportId: "server1", bridge: bridge1 }),
        createBridgeTransport({ transportId: "server2", bridge: bridge2 }),
      ],
    })
    const exchangeClient1 = createExchange({
      principal: "client1",
      transports: [
        createBridgeTransport({ transportId: "client1", bridge: bridge1 }),
      ],
    })
    const exchangeClient2 = createExchange({
      principal: "client2",
      transports: [
        createBridgeTransport({ transportId: "client2", bridge: bridge2 }),
      ],
    })
    await drain()

    const P = Line.protocol({ topic: "dispose-test", schema: SimpleSchema })

    let capturedSender: any = null
    let capturedReceiver: any = null
    const onLinePeers: string[] = []
    const listener = P.listen(exchangeServer)
    listener.onReceive((sender, receiver) => {
      onLinePeers.push(receiver.peer)
      capturedSender = sender
      capturedReceiver = receiver
    })

    const clientSender1 = P.sender(exchangeClient1, exchangeServer.peerId)
    const clientReceiver1 = P.claimReceiver(
      exchangeClient1,
      exchangeServer.peerId,
    )
    await drain()
    expect(onLinePeers).toEqual([exchangeClient1.peerId])

    const serverReceived: { value: number }[] = []
    collect(capturedReceiver, serverReceived)
    const clientReceived: { value: number }[] = []
    collect(clientReceiver1, clientReceived)

    listener.dispose()

    // Second client connects — onReceive should NOT fire
    const clientSender2 = P.sender(exchangeClient2, exchangeServer.peerId)
    await drain()
    expect(onLinePeers).toEqual([exchangeClient1.peerId])

    // Existing Line from client1 is still functional
    clientSender1.send({ value: 42 })
    await drain()
    expect(serverReceived).toEqual([{ value: 42 }])

    capturedSender.send({ value: 99 })
    await drain()
    expect(clientReceived).toEqual([{ value: 99 }])

    clientSender1.close()
    clientReceiver1.close()
    clientSender2.close()
    capturedSender.close()
    capturedReceiver.close()
  })

  it("client's queued messages delivered immediately on onReceive", async () => {
    const bridge = new Bridge()
    const exchangeClient = createExchange({
      principal: "client",
      transports: [createBridgeTransport({ transportId: "client", bridge })],
    })
    const exchangeServer = createExchange({
      principal: "server",
      transports: [createBridgeTransport({ transportId: "server", bridge })],
    })
    await drain()

    const P = Line.protocol({ topic: "queued", schema: SimpleSchema })

    let capturedReceiver: any = null
    const listener = P.listen(exchangeServer)
    listener.onReceive((_sender, receiver) => {
      capturedReceiver = receiver
    })

    const clientSender = P.sender(exchangeClient, exchangeServer.peerId)
    clientSender.send({ value: 1 })
    clientSender.send({ value: 2 })
    clientSender.send({ value: 3 })
    await drain()

    expect(capturedReceiver).not.toBeNull()

    const received: { value: number }[] = []
    collect(capturedReceiver, received)
    await drain()
    expect(received).toEqual([{ value: 1 }, { value: 2 }, { value: 3 }])

    clientSender.send({ value: 4 })
    await drain()
    expect(received).toEqual([
      { value: 1 },
      { value: 2 },
      { value: 3 },
      { value: 4 },
    ])

    listener.dispose()
    clientSender.close()
    capturedReceiver.close()
  })

  it("late listen: client connects before server starts listening", async () => {
    const bridge = new Bridge()
    const exchangeClient = createExchange({
      principal: "client",
      transports: [createBridgeTransport({ transportId: "client", bridge })],
    })
    const exchangeServer = createExchange({
      principal: "server",
      transports: [createBridgeTransport({ transportId: "server", bridge })],
    })
    await drain()

    const P = Line.protocol({ topic: "late-listen", schema: SimpleSchema })

    const clientSender = P.sender(exchangeClient, exchangeServer.peerId)
    clientSender.send({ value: 42 })
    await drain()

    let capturedReceiver: any = null
    const listener = P.listen(exchangeServer)
    listener.onReceive((_sender, receiver) => {
      capturedReceiver = receiver
    })
    await drain()

    expect(capturedReceiver).not.toBeNull()
    expect(capturedReceiver.peer).toBe(exchangeClient.peerId)

    const iter = capturedReceiver[Symbol.asyncIterator]()
    const result = await Promise.race([
      iter.next(),
      new Promise<{ value: undefined; done: true }>(r =>
        setTimeout(() => r({ value: undefined, done: true }), 500),
      ),
    ])
    expect(result.done).toBe(false)
    expect(result.value).toEqual({ value: 42 })

    listener.dispose()
    clientSender.close()
    capturedReceiver.close()
  })

  it("listeners on different topics are independent", async () => {
    const bridge = new Bridge()
    const exchangeClient = createExchange({
      principal: "client",
      transports: [createBridgeTransport({ transportId: "client", bridge })],
    })
    const exchangeServer = createExchange({
      principal: "server",
      transports: [createBridgeTransport({ transportId: "server", bridge })],
    })
    await drain()

    const ChatSchema = Schema.struct({ text: Schema.string() })
    const RpcSchema = Schema.struct({ method: Schema.string() })
    const ChatProto = Line.protocol({ topic: "chat", schema: ChatSchema })
    const RpcProto = Line.protocol({ topic: "rpc", schema: RpcSchema })

    const chatPeers: string[] = []
    const rpcPeers: string[] = []
    const chatListener = ChatProto.listen(exchangeServer)
    chatListener.onReceive((_s, r) => chatPeers.push(r.peer))
    const rpcListener = RpcProto.listen(exchangeServer)
    rpcListener.onReceive((_s, r) => rpcPeers.push(r.peer))

    const chatLine = ChatProto.sender(exchangeClient, exchangeServer.peerId)
    await drain()

    expect(chatPeers).toEqual([exchangeClient.peerId])
    expect(rpcPeers).toEqual([])

    chatListener.dispose()
    rpcListener.dispose()
    chatLine.close()
  })

  it("listener ignores Line docs addressed to other peers", async () => {
    const bridgeAS = new Bridge()
    const bridgeBS = new Bridge()
    const exchangeA = createExchange({
      principal: "alice",
      transports: [
        createBridgeTransport({ transportId: "alice", bridge: bridgeAS }),
      ],
    })
    createExchange({
      principal: "bob",
      transports: [
        createBridgeTransport({ transportId: "bob", bridge: bridgeBS }),
      ],
    })
    const exchangeServer = createExchange({
      principal: "server",
      transports: [
        createBridgeTransport({ transportId: "server-a", bridge: bridgeAS }),
        createBridgeTransport({ transportId: "server-b", bridge: bridgeBS }),
      ],
    })
    await drain()

    const P = Line.protocol({ topic: "targeted", schema: SimpleSchema })
    const serverPeers: string[] = []
    const listener = P.listen(exchangeServer)
    listener.onReceive((_s, r) => serverPeers.push(r.peer))

    const lineToServer = P.sender(exchangeA, exchangeServer.peerId)
    await drain()
    expect(serverPeers).toEqual([exchangeA.peerId])

    const lineToBob = P.sender(exchangeA, "bob")
    await drain()
    expect(serverPeers).toEqual([exchangeA.peerId]) // unchanged

    listener.dispose()
    lineToServer.close()
    lineToBob.close()
  })

  it("carries the same message shape in both directions", async () => {
    // The asymmetric form does not require the two schemas to differ. A
    // mirrored control channel or an echo declares the same shape in both
    // directions, and binding each direction separately produces two
    // interchangeable BoundSchemas that must both be able to open their
    // document.
    const bridge = new Bridge()
    const exchangeClient = createExchange({
      principal: "client",
      transports: [createBridgeTransport({ transportId: "client", bridge })],
    })
    const exchangeServer = createExchange({
      principal: "server",
      transports: [createBridgeTransport({ transportId: "server", bridge })],
    })
    await drain()

    // Distinct schema objects of identical shape — the same thing a caller
    // writes when the two directions are declared independently.
    const Echo = Line.protocol({
      topic: "echo",
      client: Schema.struct({ value: Schema.number() }),
      server: Schema.struct({ value: Schema.number() }),
    })

    const listener = Echo.listen(exchangeServer)
    listener.onReceive((sender, receiver) => {
      ;(async () => {
        for await (const msg of receiver) {
          sender.send({ value: (msg as { value: number }).value * 2 })
        }
      })()
    })

    const sender = Echo.sender(exchangeClient, exchangeServer.peerId)
    const receiver = Echo.claimReceiver(exchangeClient, exchangeServer.peerId)
    const received: Array<{ value: number }> = []
    collect(receiver, received)

    sender.send({ value: 21 })
    await drain()

    expect(received).toEqual([{ value: 42 }])

    listener.dispose()
    sender.close()
    receiver.close()
  })
})

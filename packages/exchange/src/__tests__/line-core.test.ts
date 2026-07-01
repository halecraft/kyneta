// Line core tests — capability model, send/receive, ack/pruning,
// duplicate detection, closed guards, per-Exchange registry, policy teardown.

import { Bridge, createBridgeTransport } from "@kyneta/bridge-transport"
import { Schema } from "@kyneta/schema"
import { afterEach, describe, expect, it } from "vitest"
import {
  Exchange,
  type ExchangeParams,
  type PeerIdentityInput,
} from "../exchange.js"
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
  const merged = { id: "test" as string | PeerIdentityInput, ...params }
  const ex = new Exchange(merged as ExchangeParams)
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

const SimpleSchema = Schema.struct({ value: Schema.number() })

// ── Capability model ─────────────────────────────────────────────────────────

describe("capability model", () => {
  it("sender() is idempotent and returns the same instance", () => {
    const exchange = createExchange({ id: "alice" })
    const Chat = Line.protocol({ topic: "chat", schema: SimpleSchema })
    const s1 = Chat.sender(exchange, "bob")
    const s2 = Chat.sender(exchange, "bob")
    expect(s1).toBe(s2)
  })

  it("sender close() decrements refCount — teardown only when all refs close", () => {
    const exchange = createExchange({ id: "alice" })
    const Chat = Line.protocol({ topic: "chat", schema: SimpleSchema })
    const s1 = Chat.sender(exchange, "bob")
    const s2 = Chat.sender(exchange, "bob")
    expect(s1.closed).toBe(false)
    s1.close()
    expect(s1.closed).toBe(false)
    s2.close()
    expect(s2.closed).toBe(true)
  })

  it("receiver enforces single-iterator constraint", () => {
    const exchange = createExchange({ id: "alice" })
    const Chat = Line.protocol({ topic: "chat", schema: SimpleSchema })
    const receiver = Chat.claimReceiver(exchange, "bob")
    expect(receiver[Symbol.asyncIterator]()).toBeDefined()
    expect(() => receiver[Symbol.asyncIterator]()).toThrow(
      "Line is already being iterated",
    )
  })

  it("send() works from any sender reference", async () => {
    const bridge = new Bridge()
    const exchangeA = createExchange({
      id: "alice",
      transports: [createBridgeTransport({ transportId: "alice", bridge })],
    })
    const exchangeB = createExchange({
      id: "bob",
      transports: [createBridgeTransport({ transportId: "bob", bridge })],
    })
    await drain()

    const Chat = Line.protocol({ topic: "chat", schema: SimpleSchema })
    const aliceSender1 = Chat.sender(exchangeA, "bob")
    const aliceSender2 = Chat.sender(exchangeA, "bob")

    const bobMessages: any[] = []
    const listener = Chat.listen(exchangeB)
    listener.onReceive((_sender, receiver) => collect(receiver, bobMessages))

    aliceSender1.send({ value: 1 })
    aliceSender2.send({ value: 2 })
    await drain()

    expect(bobMessages).toEqual([{ value: 1 }, { value: 2 }])
  })

  it("re-opening after full close yields a new instance", () => {
    const exchange = createExchange({ id: "alice" })
    const Chat = Line.protocol({ topic: "chat", schema: SimpleSchema })
    const s1 = Chat.sender(exchange, "bob")
    s1.close()
    const s2 = Chat.sender(exchange, "bob")
    expect(s1).not.toBe(s2)
    expect(s1.closed).toBe(true)
    expect(s2.closed).toBe(false)
  })

  it("manager.destroy() terminates the line for all reference holders", () => {
    const exchange = createExchange({ id: "alice" })
    const Chat = Line.protocol({ topic: "chat", schema: SimpleSchema })
    const s1 = Chat.sender(exchange, "bob")
    const s2 = Chat.sender(exchange, "bob")
    const manager = Chat.manager(exchange, "bob")

    manager.destroy()

    expect(s1.closed).toBe(true)
    expect(s2.closed).toBe(true)
    expect(() => s2.send({ value: 1 })).toThrow(/closed/)
  })
})

// ── Send and receive ─────────────────────────────────────────────────────────

describe("symmetric send and receive", () => {
  it("sender transmits, receiver consumes via async iterator", async () => {
    const bridge = new Bridge()
    const exchangeA = createExchange({
      id: "alice",
      transports: [createBridgeTransport({ transportId: "alice", bridge })],
    })
    const exchangeB = createExchange({
      id: "bob",
      transports: [createBridgeTransport({ transportId: "bob", bridge })],
    })
    await drain()

    const P = Line.protocol({ topic: "test", schema: SimpleSchema })
    const aliceSender = P.sender(exchangeA, "bob")
    const bobReceiver = P.claimReceiver(exchangeB, "alice")

    aliceSender.send({ value: 42 })
    await drain()

    const iter = bobReceiver[Symbol.asyncIterator]()
    const result = await Promise.race([
      iter.next(),
      new Promise<{ value: undefined; done: true }>(r =>
        setTimeout(() => r({ value: undefined, done: true }), 500),
      ),
    ])
    expect(result.done).toBe(false)
    expect(result.value).toEqual({ value: 42 })

    aliceSender.close()
    bobReceiver.close()
  })

  it("messages arrive in order", async () => {
    const bridge = new Bridge()
    const exchangeA = createExchange({
      id: "alice",
      transports: [createBridgeTransport({ transportId: "alice", bridge })],
    })
    const exchangeB = createExchange({
      id: "bob",
      transports: [createBridgeTransport({ transportId: "bob", bridge })],
    })
    await drain()

    const P = Line.protocol({ topic: "order", schema: SimpleSchema })
    const aliceSender = P.sender(exchangeA, "bob")
    const bobReceiver = P.claimReceiver(exchangeB, "alice")

    aliceSender.send({ value: 1 })
    aliceSender.send({ value: 2 })
    aliceSender.send({ value: 3 })
    await drain()

    const received: { value: number }[] = []
    collect(bobReceiver, received)
    await drain()
    expect(received.map(m => m.value)).toEqual([1, 2, 3])

    aliceSender.send({ value: 4 })
    await drain()
    expect(received.map(m => m.value)).toEqual([1, 2, 3, 4])

    aliceSender.close()
    bobReceiver.close()
  })

  it("receiver iterator completes when sender closes the line", async () => {
    const exchange = createExchange({ id: "alice" })
    const P = Line.protocol({ topic: "close-test", schema: SimpleSchema })
    const sender = P.sender(exchange, "bob")
    const receiver = P.claimReceiver(exchange, "bob")

    const iter = receiver[Symbol.asyncIterator]()
    const pending = iter.next()

    // Close both sides to fully tear down (refCount reaches 0)
    sender.close()
    receiver.close()

    const result = await pending
    expect(result.done).toBe(true)
  })

  it("concurrent sends from both sides", async () => {
    const bridge = new Bridge()
    const exchangeA = createExchange({
      id: "alice",
      transports: [createBridgeTransport({ transportId: "alice", bridge })],
    })
    const exchangeB = createExchange({
      id: "bob",
      transports: [createBridgeTransport({ transportId: "bob", bridge })],
    })
    await drain()

    const P = Line.protocol({ topic: "bidir", schema: SimpleSchema })
    const aliceSender = P.sender(exchangeA, "bob")
    const aliceReceiver = P.claimReceiver(exchangeA, "bob")
    const bobSender = P.sender(exchangeB, "alice")
    const bobReceiver = P.claimReceiver(exchangeB, "alice")

    const receivedByA: { value: number }[] = []
    const receivedByB: { value: number }[] = []
    collect(aliceReceiver, receivedByA)
    collect(bobReceiver, receivedByB)

    aliceSender.send({ value: 1 })
    bobSender.send({ value: 2 })
    await drain()

    expect(receivedByA.map(m => m.value)).toContain(2)
    expect(receivedByB.map(m => m.value)).toContain(1)

    aliceSender.close()
    aliceReceiver.close()
    bobSender.close()
    bobReceiver.close()
  })
})

// ── Ack and pruning ──────────────────────────────────────────────────────────

describe("ack and pruning", () => {
  it("messages are delivered reliably after many send/receive cycles", async () => {
    const bridge = new Bridge()
    const exchangeA = createExchange({
      id: "alice",
      transports: [createBridgeTransport({ transportId: "alice", bridge })],
    })
    const exchangeB = createExchange({
      id: "bob",
      transports: [createBridgeTransport({ transportId: "bob", bridge })],
    })
    await drain()

    const P = Line.protocol({ topic: "prune", schema: SimpleSchema })
    const aliceSender = P.sender(exchangeA, "bob")
    const bobReceiver = P.claimReceiver(exchangeB, "alice")

    const received: { value: number }[] = []
    collect(bobReceiver, received)

    for (let i = 0; i < 5; i++) aliceSender.send({ value: i })
    await drain()
    expect(received.slice(0, 5).map(m => m.value)).toEqual([0, 1, 2, 3, 4])

    for (let i = 5; i < 10; i++) aliceSender.send({ value: i })
    await drain()
    expect(received.map(m => m.value)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])

    aliceSender.close()
    bobReceiver.close()
  })
})

// ── Duplicate detection ──────────────────────────────────────────────────────

describe("duplicate detection", () => {
  it("different topics succeed", () => {
    const exchange = createExchange({ id: "alice" })
    const P1 = Line.protocol({ topic: "signaling", schema: SimpleSchema })
    const P2 = Line.protocol({ topic: "rpc", schema: SimpleSchema })
    const s1 = P1.sender(exchange, "bob")
    const s2 = P2.sender(exchange, "bob")
    expect(s1.topic).toBe("signaling")
    expect(s2.topic).toBe("rpc")
    s1.close()
    s2.close()
  })

  it("close then reopen succeeds", () => {
    const exchange = createExchange({ id: "alice" })
    const P = Line.protocol({ topic: "reuse", schema: SimpleSchema })
    const s1 = P.sender(exchange, "bob")
    s1.close()
    const s2 = P.sender(exchange, "bob")
    expect(s2.peer).toBe("bob")
    s2.close()
  })
})

// ── Multiple Lines per peer pair ─────────────────────────────────────────────

describe("multiple Lines per peer pair", () => {
  it("two Lines with different topics are independent", async () => {
    const bridge = new Bridge()
    const exchangeA = createExchange({
      id: "alice",
      transports: [createBridgeTransport({ transportId: "alice", bridge })],
    })
    const exchangeB = createExchange({
      id: "bob",
      transports: [createBridgeTransport({ transportId: "bob", bridge })],
    })
    await drain()

    const SigProto = Line.protocol({ topic: "signaling", schema: SimpleSchema })
    const RpcProto = Line.protocol({ topic: "rpc", schema: SimpleSchema })

    const sigSenderA = SigProto.sender(exchangeA, "bob")
    const rpcSenderA = RpcProto.sender(exchangeA, "bob")
    const sigReceiverB = SigProto.claimReceiver(exchangeB, "alice")
    const rpcReceiverB = RpcProto.claimReceiver(exchangeB, "alice")

    const sigReceived: { value: number }[] = []
    const rpcReceived: { value: number }[] = []
    collect(sigReceiverB, sigReceived)
    collect(rpcReceiverB, rpcReceived)

    sigSenderA.send({ value: 1 })
    await drain()
    expect(sigReceived.map(m => m.value)).toEqual([1])
    expect(rpcReceived).toEqual([])

    rpcSenderA.send({ value: 2 })
    await drain()
    expect(rpcReceived.map(m => m.value)).toEqual([2])
    expect(sigReceived.map(m => m.value)).toEqual([1])

    sigSenderA.close()
    rpcSenderA.close()
    sigReceiverB.close()
    rpcReceiverB.close()
  })
})

// ── Closed Line guards ───────────────────────────────────────────────────────

describe("closed Line guards", () => {
  it("send() on closed Line throws", () => {
    const exchange = createExchange({ id: "alice" })
    const P = Line.protocol({ topic: "guard", schema: SimpleSchema })
    const sender = P.sender(exchange, "bob")
    sender.close()
    expect(() => sender.send({ value: 1 })).toThrow(/closed/)
  })

  it("close() is idempotent", () => {
    const exchange = createExchange({ id: "alice" })
    const P = Line.protocol({ topic: "idem", schema: SimpleSchema })
    const sender = P.sender(exchange, "bob")
    sender.close()
    expect(() => sender.close()).not.toThrow()
    expect(sender.closed).toBe(true)
  })
})

// ── Per-Exchange Line registry ───────────────────────────────────────────────

describe("per-Exchange Line registry", () => {
  it("two Exchange instances with the same peerId can each open a Line", () => {
    const P = Line.protocol({ topic: "registry", schema: SimpleSchema })
    const ex1 = createExchange({ id: "alice" })
    const ex2 = createExchange({ id: "alice" })
    const s1 = P.sender(ex1, "bob")
    const s2 = P.sender(ex2, "bob")
    expect(s1.peer).toBe("bob")
    expect(s2.peer).toBe("bob")
    s1.close()
    s2.close()
  })

  it("shutting down one Exchange does not affect the other's open Lines", async () => {
    const P = Line.protocol({ topic: "isolation", schema: SimpleSchema })
    const ex1 = createExchange({ id: "alice" })
    const ex2 = createExchange({ id: "alice" })
    const s1 = P.sender(ex1, "bob")
    const s2 = P.sender(ex2, "bob")

    await ex1.shutdown()
    const idx = activeExchanges.indexOf(ex1)
    if (idx !== -1) activeExchanges.splice(idx, 1)

    expect(s1.closed).toBe(true)
    expect(s2.closed).toBe(false)
    s2.close()
  })
})

// ── Line policy teardown ─────────────────────────────────────────────────────

describe("Line policy teardown", () => {
  it("exchange.shutdown() closes all open Lines", async () => {
    const bridge = new Bridge()
    const P = Line.protocol({ topic: "teardown", schema: SimpleSchema })
    const exchangeA = createExchange({
      id: "alice",
      transports: [createBridgeTransport({ transportId: "alice", bridge })],
    })
    const exchangeB = createExchange({
      id: "bob",
      transports: [createBridgeTransport({ transportId: "bob", bridge })],
    })

    const listener = P.listen(exchangeB)
    const serverSenders: any[] = []
    listener.onReceive(sender => serverSenders.push(sender))

    const clientSender = P.sender(exchangeA, "bob")
    clientSender.send({ value: 1 })
    await drain()

    expect(serverSenders.length).toBe(1)

    await exchangeA.shutdown()
    await exchangeB.shutdown()
    activeExchanges.length = 0

    expect(clientSender.closed).toBe(true)
    expect(serverSenders[0].closed).toBe(true)
  })

  it("exchange.reset() closes all open Lines", () => {
    const P = Line.protocol({ topic: "reset-teardown", schema: SimpleSchema })
    const exchange = createExchange({ id: "alice" })
    const sender = P.sender(exchange, "bob")
    expect(sender.closed).toBe(false)
    exchange.reset()
    expect(sender.closed).toBe(true)
  })

  it("after shutdown + new Exchange, protocol.sender() succeeds", async () => {
    const P = Line.protocol({ topic: "reopen", schema: SimpleSchema })
    const ex1 = createExchange({ id: "alice" })
    const s1 = P.sender(ex1, "bob")
    expect(s1.closed).toBe(false)

    await ex1.shutdown()
    const idx = activeExchanges.indexOf(ex1)
    if (idx !== -1) activeExchanges.splice(idx, 1)

    expect(s1.closed).toBe(true)

    const ex2 = createExchange({ id: "alice" })
    const s2 = P.sender(ex2, "bob")
    expect(s2.closed).toBe(false)
    expect(s2.peer).toBe("bob")
    s2.close()
  })

  it("manual close() followed by shutdown() is safe — no double-fire", async () => {
    const P = Line.protocol({ topic: "double-safe", schema: SimpleSchema })
    const exchange = createExchange({ id: "alice" })
    const sender = P.sender(exchange, "bob")
    sender.close()
    expect(sender.closed).toBe(true)

    await exchange.shutdown()
    const idx = activeExchanges.indexOf(exchange)
    if (idx !== -1) activeExchanges.splice(idx, 1)

    expect(sender.closed).toBe(true)
  })
})

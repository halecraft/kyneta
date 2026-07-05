// Line durability tests — close vs destroy, seq persistence across close/reopen,
// peer lifecycle decoupling, disconnect/reconnect, peer departure, storage bounds.

import {
  Bridge,
  BridgeTransport,
  createBridgeTransport,
} from "@kyneta/bridge-transport"
import { Schema } from "@kyneta/schema"
import type { DocId } from "@kyneta/transport"
import { afterEach, describe, expect, it } from "vitest"
import {
  Exchange,
  type ExchangeParams,
  type PeerIdentityInput,
} from "../exchange.js"
import { Line, lineDocId } from "../line.js"
import { InMemoryStore } from "../store/in-memory-store.js"

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

// ── close() vs destroy() ─────────────────────────────────────────────────────

describe("durable Line: close() vs destroy()", () => {
  it("close() preserves documents — destroy() removes them", () => {
    const exchange = createExchange({ id: "alice" })
    const P = Line.protocol({
      topic: "close-vs-destroy",
      schema: SimpleSchema,
    })
    const outboxDocId = lineDocId("close-vs-destroy", "alice", "bob")
    const inboxDocId = lineDocId("close-vs-destroy", "bob", "alice")

    const s1 = P.sender(exchange, "bob")
    s1.close()
    expect(exchange.has(outboxDocId)).toBe(true)
    expect(exchange.has(inboxDocId)).toBe(true)

    const s2 = P.sender(exchange, "bob")
    const m2 = P.manager(exchange, "bob")
    s2.close() // release sender ref so manager can destroy
    m2.destroy()
    expect(exchange.has(outboxDocId)).toBe(false)
    expect(exchange.has(inboxDocId)).toBe(false)
  })

  it("destroy() after close() is safe", () => {
    const exchange = createExchange({ id: "alice" })
    const P = Line.protocol({
      topic: "destroy-after-close",
      schema: SimpleSchema,
    })
    const sender = P.sender(exchange, "bob")
    const manager = P.manager(exchange, "bob")
    sender.close()
    expect(() => manager.destroy()).not.toThrow()
  })

  it("destroy() resets state — reopen starts fresh at seq 1", async () => {
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

    const P = Line.protocol({ topic: "destroy-reset", schema: SimpleSchema })

    const aliceSender1 = P.sender(exchangeA, "bob")
    const aliceManager1 = P.manager(exchangeA, "bob")
    const bobReceiver1 = P.claimReceiver(exchangeB, "alice")
    const bobManager1 = P.manager(exchangeB, "alice")
    const received1: any[] = []
    collect(bobReceiver1, received1)

    aliceSender1.send({ value: 10 })
    aliceSender1.send({ value: 20 })
    await drain()
    expect(received1.length).toBe(2)

    aliceManager1.destroy()
    bobManager1.destroy()

    const aliceSender2 = P.sender(exchangeA, "bob")
    const bobReceiver2 = P.claimReceiver(exchangeB, "alice")
    const received2: any[] = []
    collect(bobReceiver2, received2)

    aliceSender2.send({ value: 30 })
    await drain()

    expect(received2.length).toBe(1)
    expect(received2[0]).toEqual({ value: 30 })

    aliceSender2.close()
    bobReceiver2.close()
  })
})

// ── Seq persistence across close/reopen ──────────────────────────────────────

describe("durable Line: seq persistence", () => {
  it("nextSeq survives prune — close+reopen after prune still resumes", async () => {
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

    const P = Line.protocol({ topic: "seq-prune", schema: SimpleSchema })
    const aliceSender1 = P.sender(exchangeA, "bob")
    const bobReceiver1 = P.claimReceiver(exchangeB, "alice")
    const received1: any[] = []
    collect(bobReceiver1, received1)

    aliceSender1.send({ value: 1 })
    aliceSender1.send({ value: 2 })
    aliceSender1.send({ value: 3 })
    await drain()
    expect(received1.length).toBe(3)

    aliceSender1.close()
    bobReceiver1.close()

    const aliceSender2 = P.sender(exchangeA, "bob")
    const bobReceiver2 = P.claimReceiver(exchangeB, "alice")
    const received2: any[] = []
    collect(bobReceiver2, received2)

    aliceSender2.send({ value: 4 })
    await drain()

    expect(received2.length).toBe(1)
    expect(received2[0]).toEqual({ value: 4 })

    aliceSender2.close()
    bobReceiver2.close()
  })

  it("close+reopen delivers new messages without replaying old ones", async () => {
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

    const P = Line.protocol({ topic: "resume", schema: SimpleSchema })

    const aliceSender1 = P.sender(exchangeA, "bob")
    const bobReceiver1 = P.claimReceiver(exchangeB, "alice")
    const received1: any[] = []
    collect(bobReceiver1, received1)

    aliceSender1.send({ value: 1 })
    aliceSender1.send({ value: 2 })
    aliceSender1.send({ value: 3 })
    await drain()
    expect(received1.length).toBe(3)

    aliceSender1.close()
    bobReceiver1.close()

    const aliceSender2 = P.sender(exchangeA, "bob")
    const bobReceiver2 = P.claimReceiver(exchangeB, "alice")
    const received2: any[] = []
    collect(bobReceiver2, received2)
    await drain()
    expect(received2.length).toBe(0) // no replay

    aliceSender2.send({ value: 99 })
    await drain()
    expect(received2.length).toBe(1)
    expect(received2[0]).toEqual({ value: 99 })

    aliceSender2.close()
    bobReceiver2.close()
  })

  it("bidirectional close/reopen cycle preserves seq on both sides", async () => {
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

    const P = Line.protocol({ topic: "bidi-reopen", schema: SimpleSchema })

    // Session 1
    const aliceSender1 = P.sender(exchangeA, "bob")
    const aliceReceiver1 = P.claimReceiver(exchangeA, "bob")
    const bobSender1 = P.sender(exchangeB, "alice")
    const bobReceiver1 = P.claimReceiver(exchangeB, "alice")
    const recvA1: any[] = []
    const recvB1: any[] = []
    collect(aliceReceiver1, recvA1)
    collect(bobReceiver1, recvB1)

    aliceSender1.send({ value: 1 })
    bobSender1.send({ value: 100 })
    await drain()
    expect(recvA1.length).toBe(1)
    expect(recvB1.length).toBe(1)

    aliceSender1.close()
    aliceReceiver1.close()
    bobSender1.close()
    bobReceiver1.close()

    // Session 2
    const aliceSender2 = P.sender(exchangeA, "bob")
    const aliceReceiver2 = P.claimReceiver(exchangeA, "bob")
    const bobSender2 = P.sender(exchangeB, "alice")
    const bobReceiver2 = P.claimReceiver(exchangeB, "alice")
    const recvA2: any[] = []
    const recvB2: any[] = []
    collect(aliceReceiver2, recvA2)
    collect(bobReceiver2, recvB2)

    aliceSender2.send({ value: 2 })
    bobSender2.send({ value: 200 })
    await drain()

    expect(recvA2.map(m => m.value)).toEqual([200])
    expect(recvB2.map(m => m.value)).toEqual([2])

    aliceSender2.close()
    aliceReceiver2.close()
    bobSender2.close()
    bobReceiver2.close()
  })
})

// ── Peer lifecycle decoupling ────────────────────────────────────────────────

describe("durable Line: peer lifecycle decoupling", () => {
  it("Line remains open and functional after remote peer departs", async () => {
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

    const P = Line.protocol({ topic: "no-depart", schema: SimpleSchema })
    const aliceSender = P.sender(exchangeA, "bob")
    await drain()

    await exchangeB.shutdown()
    await drain()

    expect(aliceSender.closed).toBe(false)
    expect(() => aliceSender.send({ value: 42 })).not.toThrow()

    aliceSender.close()
  })
})

// ── Disconnect / reconnect ───────────────────────────────────────────────────

describe("durable Line: disconnect/reconnect", () => {
  it("messages sent during disconnect are delivered on reconnect", async () => {
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

    const P = Line.protocol({ topic: "disconnect", schema: SimpleSchema })
    const aliceSender = P.sender(exchangeA, "bob")
    const bobReceiver = P.claimReceiver(exchangeB, "alice")
    const received: any[] = []
    collect(bobReceiver, received)

    aliceSender.send({ value: 1 })
    aliceSender.send({ value: 2 })
    aliceSender.send({ value: 3 })
    await drain()
    expect(received.length).toBe(3)

    await exchangeB.removeTransport("bob")
    await drain()

    aliceSender.send({ value: 4 })
    aliceSender.send({ value: 5 })
    await drain()
    expect(received.length).toBe(3) // not delivered yet

    await exchangeB.addTransport(
      new BridgeTransport({ transportId: "bob", bridge }),
    )
    await drain()

    expect(received.map(m => m.value)).toEqual([1, 2, 3, 4, 5])

    aliceSender.close()
    bobReceiver.close()
  })

  it("bidirectional sends during disconnect — both sides receive all", async () => {
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

    const P = Line.protocol({ topic: "bidi-disconnect", schema: SimpleSchema })
    const aliceSender = P.sender(exchangeA, "bob")
    const aliceReceiver = P.claimReceiver(exchangeA, "bob")
    const bobSender = P.sender(exchangeB, "alice")
    const bobReceiver = P.claimReceiver(exchangeB, "alice")
    const receivedByA: any[] = []
    const receivedByB: any[] = []
    collect(aliceReceiver, receivedByA)
    collect(bobReceiver, receivedByB)

    aliceSender.send({ value: 1 })
    bobSender.send({ value: 100 })
    await drain()

    await exchangeB.removeTransport("bob")
    await drain()

    aliceSender.send({ value: 2 })
    aliceSender.send({ value: 3 })
    bobSender.send({ value: 200 })
    bobSender.send({ value: 300 })
    await drain()

    await exchangeB.addTransport(
      new BridgeTransport({ transportId: "bob", bridge }),
    )
    await drain()

    expect(receivedByB.map(m => m.value)).toEqual([1, 2, 3])
    expect(receivedByA.map(m => m.value)).toEqual([100, 200, 300])

    aliceSender.close()
    aliceReceiver.close()
    bobSender.close()
    bobReceiver.close()
  })
})

// ── Survives peer departure ──────────────────────────────────────────────────

describe("durable Line: survives peer departure", () => {
  it("queued messages are delivered when peer returns after departure", async () => {
    const bridge = new Bridge()
    const exchangeA = createExchange({
      id: "alice",
      transports: [createBridgeTransport({ transportId: "alice", bridge })],
      departureTimeout: 0,
    })
    let exchangeB = createExchange({
      id: "bob",
      transports: [createBridgeTransport({ transportId: "bob", bridge })],
    })
    await drain()

    const P = Line.protocol({ topic: "survive-depart", schema: SimpleSchema })
    const aliceSender = P.sender(exchangeA, "bob")

    aliceSender.send({ value: 1 })
    aliceSender.send({ value: 2 })
    await drain()

    await exchangeB.shutdown()
    await drain()

    expect(aliceSender.closed).toBe(false)

    aliceSender.send({ value: 3 })
    aliceSender.send({ value: 4 })
    await drain()

    exchangeB = createExchange({
      id: "bob",
      transports: [createBridgeTransport({ transportId: "bob", bridge })],
    })
    await drain()

    let capturedReceiver: any = null
    const received: any[] = []
    const listener = P.listen(exchangeB)
    listener.onReceive((_sender, receiver) => {
      capturedReceiver = receiver
      collect(receiver, received)
    })
    await drain()

    expect(received.length).toBeGreaterThanOrEqual(2)
    expect(received.map(m => m.value)).toContain(3)
    expect(received.map(m => m.value)).toContain(4)

    aliceSender.close()
    capturedReceiver?.close()
    listener.dispose()
  })
})

// ── Storage stays bounded ────────────────────────────────────────────────────

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
      id: "alice",
      transports: [createBridgeTransport({ transportId: "alice", bridge })],
      stores: [storeA],
    })
    const exchangeB = createExchange({
      id: "bob",
      transports: [createBridgeTransport({ transportId: "bob", bridge })],
      stores: [storeB],
    })

    await exchangeA.flush()
    await exchangeB.flush()
    await drain()

    const P = Line.protocol({ topic: "bounded", schema: SimpleSchema })
    const aliceSender = P.sender(exchangeA, "bob")
    const bobReceiver = P.claimReceiver(exchangeB, "alice")

    await exchangeA.flush()
    await exchangeB.flush()
    await drain()

    const received: any[] = []
    collect(bobReceiver, received)

    const MESSAGE_COUNT = 20
    for (let i = 0; i < MESSAGE_COUNT; i++) {
      aliceSender.send({ value: i })
      await drain(60)
    }

    await drain(120)
    await exchangeA.flush()
    await exchangeB.flush()
    await drain(60)

    expect(received.length).toBe(MESSAGE_COUNT)

    const outboxA = lineDocId("bounded", "alice", "bob") as DocId
    const entriesA = await countEntries(storeA, outboxA)
    expect(entriesA).toBeLessThanOrEqual(3)

    aliceSender.close()
    bobReceiver.close()
  })
})

// ── Incarnation-aware cursors (writer restart with no persisted store) ───────
// Context: jj:nnltzzsp. Pre-fix, Line's bare `seq`/`ack` counters silently
// crossed incarnation boundaries: a peer that restarted with no persisted
// store would either have its fresh `seq: 1` dropped by the receiver's
// dedup guard, or have its own new messages pruned by a stale peer-side ack
// (silent data loss). The incarnation-paired `ackSeq`/`ackIncarnation` and
// the reset-on-mismatch logic in #processInbox / #pruneOutbox close both.

describe("durable Line: writer restart with no persisted store", () => {
  it("receiver-side fix: alice restarts → bob still delivers alice-2's fresh seq:1", async () => {
    // Exercises the originally-reported failure mode through Line's
    // send/receive surface (the higher-level Exchange-only version lives in
    // jj:wyqtwqlx). Pre-fix, bob's cached #lastProcessedSeq from the previous
    // incarnation would silently drop alice-2's fresh seq:1 as a duplicate.
    const bridge = new Bridge()

    const alice1 = createExchange({
      id: "alice",
      transports: [createBridgeTransport({ transportId: "alice-1", bridge })],
    })
    const bob = createExchange({
      id: "bob",
      transports: [createBridgeTransport({ transportId: "bob", bridge })],
    })
    await drain()

    const P = Line.protocol({ topic: "restart-recv", schema: SimpleSchema })
    const alice1Sender = P.sender(alice1, "bob")
    const bobReceiver = P.claimReceiver(bob, "alice")
    const received: any[] = []
    collect(bobReceiver, received)

    alice1Sender.send({ value: 11 })
    alice1Sender.send({ value: 12 })
    await drain()
    expect(received.map(m => m.value)).toEqual([11, 12])

    // Involuntary disconnect — no depart. Bob's cached #lastProcessedSeq
    // and the doc-sync state for alice survive the disconnect.
    await alice1.removeTransport("alice-1")
    alice1Sender.close()
    bobReceiver.close()
    await drain()

    // alice restarts: brand-new Exchange, same peerId, fresh substrate /
    // fresh incarnation. The outbox starts again at seq:1 — exactly the
    // value bob has already "consumed" in the previous incarnation.
    const alice2 = createExchange({
      id: "alice",
      transports: [createBridgeTransport({ transportId: "alice-2", bridge })],
    })
    await drain()

    const alice2Sender = P.sender(alice2, "bob")
    const bobReceiver2 = P.claimReceiver(bob, "alice")
    const received2: any[] = []
    collect(bobReceiver2, received2)

    alice2Sender.send({ value: 21 })
    await drain()

    expect(received2.map(m => m.value)).toEqual([21])

    alice2Sender.close()
    bobReceiver2.close()
  })

  it("sender-side fix: bob restarts → alice's post-restart messages are not pruned on bob's stale ack", async () => {
    // Symmetric to the receiver-side case but easy to miss: if the receiver
    // (not the sender) restarts, their stale ack survives untouched in their
    // own outbox. Pre-fix, the sender's #pruneOutbox would read that stale
    // ack and delete the sender's own brand-new, never-delivered messages
    // — silent data loss, distinct from the receiver-side drop.
    const bridge = new Bridge()

    const alice = createExchange({
      id: "alice",
      transports: [createBridgeTransport({ transportId: "alice", bridge })],
    })
    const bob1 = createExchange({
      id: "bob",
      transports: [createBridgeTransport({ transportId: "bob-1", bridge })],
    })
    await drain()

    const P = Line.protocol({ topic: "restart-send", schema: SimpleSchema })
    const aliceSender = P.sender(alice, "bob")
    const bob1Receiver = P.claimReceiver(bob1, "alice")
    const received1: any[] = []
    collect(bob1Receiver, received1)

    // alice sends, bob acks — bob's inbox (alice's outbox) now carries a
    // nonzero ack recorded against alice's current incarnation.
    aliceSender.send({ value: 1 })
    aliceSender.send({ value: 2 })
    await drain()
    expect(received1.map(m => m.value)).toEqual([1, 2])

    // Bob restarts (fresh Exchange, same peerId). His stale ack survives in
    // his old outbox doc — alice's #pruneOutbox reads it via her inbox.
    await bob1.removeTransport("bob-1")
    aliceSender.close()
    bob1Receiver.close()
    await drain()

    const bob2 = createExchange({
      id: "bob",
      transports: [createBridgeTransport({ transportId: "bob-2", bridge })],
    })
    await drain()

    // alice reopens her sender against the same outbox doc. The per-Exchange
    // Line registry means the cached Line object is the same one — this is
    // the long-lived-server scenario where alice never went down.
    const aliceSender2 = P.sender(alice, "bob")
    const bob2Receiver = P.claimReceiver(bob2, "alice")
    const received2: any[] = []
    collect(bob2Receiver, received2)

    aliceSender2.send({ value: 3 })
    aliceSender2.send({ value: 4 })
    await drain()

    expect(received2.map(m => m.value)).toEqual([3, 4])

    aliceSender2.close()
    bob2Receiver.close()
  })
})

// ── Regression guard: close/reopen (same incarnation) must NOT trip reset ────
// close()/reopen shares no incarnation change — same Exchange, same substrate,
// same Line object. The reset-on-mismatch logic above must not fire here; if it
// ever does, this guard will start replaying previously-acked messages.

describe("durable Line: regression — close/reopen does not trip incarnation reset", () => {
  it("close+reopen delivers new messages without replaying old ones (same incarnation)", async () => {
    // Focused re-statement of the seq-persistence test above, named for the
    // regression it guards. Spurious reset here would surface as replay.
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

    const P = Line.protocol({ topic: "reopen-noreplay", schema: SimpleSchema })
    const aliceSender1 = P.sender(exchangeA, "bob")
    const bobReceiver1 = P.claimReceiver(exchangeB, "alice")
    const received1: any[] = []
    collect(bobReceiver1, received1)

    aliceSender1.send({ value: 1 })
    aliceSender1.send({ value: 2 })
    await drain()
    expect(received1.length).toBe(2)

    aliceSender1.close()
    bobReceiver1.close()

    // Reopen — same Exchange objects, same incarnation throughout. The
    // receiver must NOT replay the two messages from session 1.
    const aliceSender2 = P.sender(exchangeA, "bob")
    const bobReceiver2 = P.claimReceiver(exchangeB, "alice")
    const received2: any[] = []
    collect(bobReceiver2, received2)
    await drain()
    expect(received2.length).toBe(0)

    aliceSender2.send({ value: 99 })
    await drain()
    expect(received2.map(m => m.value)).toEqual([99])

    aliceSender2.close()
    bobReceiver2.close()
  })
})

// Line durability tests — close vs destroy, seq persistence across close/reopen,
// peer lifecycle decoupling, disconnect/reconnect, peer departure, storage bounds.

import {
  Bridge,
  BridgeTransport,
  createBridgeTransport,
} from "@kyneta/bridge-transport"
import { batch, json, Schema } from "@kyneta/schema"
import type { DocId } from "@kyneta/transport"
import { describe, expect, it } from "vitest"
import { Line, type LineReceiver, lineDocId } from "../line.js"
import type { ObsEvent } from "../observe.js"
import {
  createInMemoryStoreData,
  InMemoryStore,
} from "../store/in-memory-store.js"
import { drain, exchangesPerTest } from "./exchanges.js"

// ── Helpers ──────────────────────────────────────────────────────────────────

const createExchange = exchangesPerTest()

function collect<T>(recv: AsyncIterable<T>, into: T[]): void {
  ;(async () => {
    for await (const msg of recv) into.push(msg)
  })()
}

const SimpleSchema = Schema.struct({ value: Schema.number() })

// ── close() vs destroy() ─────────────────────────────────────────────────────

describe("durable Line: close() vs destroy()", () => {
  it("close() preserves documents — destroy() removes them", () => {
    const exchange = createExchange({ principal: "alice" })
    const P = Line.protocol({
      topic: "close-vs-destroy",
      schema: SimpleSchema,
    })
    const outboxDocId = lineDocId("close-vs-destroy", exchange.peerId, "bob")
    const inboxDocId = lineDocId("close-vs-destroy", "bob", exchange.peerId)

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
    const exchange = createExchange({ principal: "alice" })
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
      principal: "alice",
      transports: [createBridgeTransport({ transportId: "alice", bridge })],
    })
    const exchangeB = createExchange({
      principal: "bob",
      transports: [createBridgeTransport({ transportId: "bob", bridge })],
    })
    await drain()

    const P = Line.protocol({ topic: "destroy-reset", schema: SimpleSchema })

    const aliceSender1 = P.sender(exchangeA, exchangeB.peerId)
    const aliceManager1 = P.manager(exchangeA, exchangeB.peerId)
    const bobReceiver1 = P.claimReceiver(exchangeB, exchangeA.peerId)
    const bobManager1 = P.manager(exchangeB, exchangeA.peerId)
    const received1: any[] = []
    collect(bobReceiver1, received1)

    aliceSender1.send({ value: 10 })
    aliceSender1.send({ value: 20 })
    await drain()
    expect(received1.length).toBe(2)

    aliceManager1.destroy()
    bobManager1.destroy()

    const aliceSender2 = P.sender(exchangeA, exchangeB.peerId)
    const bobReceiver2 = P.claimReceiver(exchangeB, exchangeA.peerId)
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
      principal: "alice",
      transports: [createBridgeTransport({ transportId: "alice", bridge })],
    })
    const exchangeB = createExchange({
      principal: "bob",
      transports: [createBridgeTransport({ transportId: "bob", bridge })],
    })
    await drain()

    const P = Line.protocol({ topic: "seq-prune", schema: SimpleSchema })
    const aliceSender1 = P.sender(exchangeA, exchangeB.peerId)
    const bobReceiver1 = P.claimReceiver(exchangeB, exchangeA.peerId)
    const received1: any[] = []
    collect(bobReceiver1, received1)

    aliceSender1.send({ value: 1 })
    aliceSender1.send({ value: 2 })
    aliceSender1.send({ value: 3 })
    await drain()
    expect(received1.length).toBe(3)

    aliceSender1.close()
    bobReceiver1.close()

    const aliceSender2 = P.sender(exchangeA, exchangeB.peerId)
    const bobReceiver2 = P.claimReceiver(exchangeB, exchangeA.peerId)
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
      principal: "alice",
      transports: [createBridgeTransport({ transportId: "alice", bridge })],
    })
    const exchangeB = createExchange({
      principal: "bob",
      transports: [createBridgeTransport({ transportId: "bob", bridge })],
    })
    await drain()

    const P = Line.protocol({ topic: "resume", schema: SimpleSchema })

    const aliceSender1 = P.sender(exchangeA, exchangeB.peerId)
    const bobReceiver1 = P.claimReceiver(exchangeB, exchangeA.peerId)
    const received1: any[] = []
    collect(bobReceiver1, received1)

    aliceSender1.send({ value: 1 })
    aliceSender1.send({ value: 2 })
    aliceSender1.send({ value: 3 })
    await drain()
    expect(received1.length).toBe(3)

    aliceSender1.close()
    bobReceiver1.close()

    const aliceSender2 = P.sender(exchangeA, exchangeB.peerId)
    const bobReceiver2 = P.claimReceiver(exchangeB, exchangeA.peerId)
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
      principal: "alice",
      transports: [createBridgeTransport({ transportId: "alice", bridge })],
    })
    const exchangeB = createExchange({
      principal: "bob",
      transports: [createBridgeTransport({ transportId: "bob", bridge })],
    })
    await drain()

    const P = Line.protocol({ topic: "bidi-reopen", schema: SimpleSchema })

    // Session 1
    const aliceSender1 = P.sender(exchangeA, exchangeB.peerId)
    const aliceReceiver1 = P.claimReceiver(exchangeA, exchangeB.peerId)
    const bobSender1 = P.sender(exchangeB, exchangeA.peerId)
    const bobReceiver1 = P.claimReceiver(exchangeB, exchangeA.peerId)
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
    const aliceSender2 = P.sender(exchangeA, exchangeB.peerId)
    const aliceReceiver2 = P.claimReceiver(exchangeA, exchangeB.peerId)
    const bobSender2 = P.sender(exchangeB, exchangeA.peerId)
    const bobReceiver2 = P.claimReceiver(exchangeB, exchangeA.peerId)
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
      principal: "alice",
      transports: [createBridgeTransport({ transportId: "alice", bridge })],
    })
    const exchangeB = createExchange({
      principal: "bob",
      transports: [createBridgeTransport({ transportId: "bob", bridge })],
    })
    await drain()

    const P = Line.protocol({ topic: "no-depart", schema: SimpleSchema })
    const aliceSender = P.sender(exchangeA, exchangeB.peerId)
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
      principal: "alice",
      transports: [createBridgeTransport({ transportId: "alice", bridge })],
    })
    const exchangeB = createExchange({
      principal: "bob",
      transports: [createBridgeTransport({ transportId: "bob", bridge })],
    })
    await drain()

    const P = Line.protocol({ topic: "disconnect", schema: SimpleSchema })
    const aliceSender = P.sender(exchangeA, exchangeB.peerId)
    const bobReceiver = P.claimReceiver(exchangeB, exchangeA.peerId)
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

  it("a reconnect draws no refuse: the remote's offer of our own outbox carries nothing to take", async () => {
    const bridge = new Bridge()
    const exchangeA = createExchange({
      principal: "alice",
      transports: [createBridgeTransport({ transportId: "alice", bridge })],
    })
    const exchangeB = createExchange({
      principal: "bob",
      transports: [createBridgeTransport({ transportId: "bob", bridge })],
    })
    const events: ObsEvent[] = []
    exchangeA.observe(e => events.push(e))
    exchangeB.observe(e => events.push(e))
    await drain()

    const P = Line.protocol({ topic: "reconnect-refuse", schema: SimpleSchema })
    const aliceSender = P.sender(exchangeA, exchangeB.peerId)
    const bobReceiver = P.claimReceiver(exchangeB, exchangeA.peerId)
    const bobSender = P.sender(exchangeB, exchangeA.peerId)
    const aliceReceiver = P.claimReceiver(exchangeA, exchangeB.peerId)
    const received: any[] = []
    collect(bobReceiver, received)
    collect(aliceReceiver, [])
    aliceSender.send({ value: 1 })
    bobSender.send({ value: 2 })
    await drain()

    await exchangeB.removeTransport("bob")
    await drain()
    await exchangeB.addTransport(
      new BridgeTransport({ transportId: "bob", bridge }),
    )
    aliceSender.send({ value: 3 })
    await drain()

    expect(received.map(m => m.value)).toEqual([1, 3])
    const refusals = events.filter(
      e =>
        (e.layer === "protocol" && e.msgType === "refuse") ||
        (e.layer === "diagnostic" && e.code === "offer-refused"),
    )
    expect(refusals).toEqual([])

    aliceSender.close()
    bobReceiver.close()
    bobSender.close()
    aliceReceiver.close()
  })

  it("bidirectional sends during disconnect — both sides receive all", async () => {
    const bridge = new Bridge()
    const exchangeA = createExchange({
      principal: "alice",
      transports: [createBridgeTransport({ transportId: "alice", bridge })],
    })
    const exchangeB = createExchange({
      principal: "bob",
      transports: [createBridgeTransport({ transportId: "bob", bridge })],
    })
    await drain()

    const P = Line.protocol({ topic: "bidi-disconnect", schema: SimpleSchema })
    const aliceSender = P.sender(exchangeA, exchangeB.peerId)
    const aliceReceiver = P.claimReceiver(exchangeA, exchangeB.peerId)
    const bobSender = P.sender(exchangeB, exchangeA.peerId)
    const bobReceiver = P.claimReceiver(exchangeB, exchangeA.peerId)
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
  it("queued messages are delivered when a departed seat returns", async () => {
    // Alice's grace period is zero, so bob departs the moment his channel
    // closes. The Line outlives the departure, and bob's seat returns with
    // the same Exchange.
    const bridge = new Bridge()
    const exchangeA = createExchange({
      principal: "alice",
      transports: [createBridgeTransport({ transportId: "alice", bridge })],
      departureTimeout: 0,
    })
    const exchangeB = createExchange({
      principal: "bob",
      transports: [createBridgeTransport({ transportId: "bob", bridge })],
    })
    await drain()

    const P = Line.protocol({ topic: "survive-depart", schema: SimpleSchema })
    const aliceSender = P.sender(exchangeA, exchangeB.peerId)

    aliceSender.send({ value: 1 })
    aliceSender.send({ value: 2 })
    await drain()

    await exchangeB.removeTransport("bob")
    await drain()
    expect(exchangeA.peers().has(exchangeB.peerId)).toBe(false)

    expect(aliceSender.closed).toBe(false)

    aliceSender.send({ value: 3 })
    aliceSender.send({ value: 4 })
    await drain()

    await exchangeB.addTransport(
      new BridgeTransport({ transportId: "bob", bridge }),
    )
    await drain()

    const received: { value: number }[] = []
    const receivers: LineReceiver<{ value: number }>[] = []
    const listener = P.listen(exchangeB)
    listener.onReceive((_sender, receiver) => {
      receivers.push(receiver)
      collect(receiver, received)
    })
    await drain()

    expect(received.map(m => m.value)).toEqual([1, 2, 3, 4])

    aliceSender.close()
    for (const receiver of receivers) receiver.close()
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
      principal: "alice",
      transports: [createBridgeTransport({ transportId: "alice", bridge })],
      store: storeA,
    })
    const exchangeB = createExchange({
      principal: "bob",
      transports: [createBridgeTransport({ transportId: "bob", bridge })],
      store: storeB,
    })

    await exchangeA.flush()
    await exchangeB.flush()
    await drain()

    const P = Line.protocol({ topic: "bounded", schema: SimpleSchema })
    const aliceSender = P.sender(exchangeA, exchangeB.peerId)
    const bobReceiver = P.claimReceiver(exchangeB, exchangeA.peerId)

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

    const outboxA = lineDocId(
      "bounded",
      exchangeA.peerId,
      exchangeB.peerId,
    ) as DocId
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
  it("receiver side: alice restarts → bob delivers alice-2's seq:1 on a fresh Line", async () => {
    // A restarted Exchange is a new seat, so its Line is a new pair of
    // documents, and bob's #lastProcessedSeq for alice-1's outbox cannot
    // drop alice-2's seq:1 as a duplicate. Before seats were issued, alice-2
    // reused alice-1's id and that drop was the reported failure
    // (jj:wyqtwqlx).
    const bridge = new Bridge()

    const alice1 = createExchange({
      principal: "alice",
      transports: [createBridgeTransport({ transportId: "alice-1", bridge })],
    })
    const bob = createExchange({
      principal: "bob",
      transports: [createBridgeTransport({ transportId: "bob", bridge })],
    })
    await drain()

    const P = Line.protocol({ topic: "restart-recv", schema: SimpleSchema })
    const alice1Sender = P.sender(alice1, bob.peerId)
    const bobReceiver = P.claimReceiver(bob, alice1.peerId)
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

    // alice restarts: brand-new Exchange, same principal, new seat. Her
    // outbox starts again at seq:1, the value bob already consumed from
    // alice-1.
    const alice2 = createExchange({
      principal: "alice",
      transports: [createBridgeTransport({ transportId: "alice-2", bridge })],
    })
    await drain()

    expect(alice2.peerId).not.toBe(alice1.peerId)
    const alice2Sender = P.sender(alice2, bob.peerId)
    const bobReceiver2 = P.claimReceiver(bob, alice2.peerId)
    const received2: any[] = []
    collect(bobReceiver2, received2)

    alice2Sender.send({ value: 21 })
    await drain()

    expect(received2.map(m => m.value)).toEqual([21])

    alice2Sender.close()
    bobReceiver2.close()
  })

  it("a reader that restarts without its state converges, even when a push reaches it before its catch-up", async () => {
    // The writer still counts the returning reader as synced, so the write
    // below is pushed as a delta from the writer's previous version. The
    // restarted reader holds nothing, so that delta does not continue what
    // it holds: applying it anyway appended it to an empty log, and the
    // catch-up then landed on top, duplicating entries for good.
    const ListDoc = json.bind(
      Schema.struct({ items: Schema.list(Schema.number()) }),
    )
    const bridge = new Bridge()
    const writer = createExchange({
      principal: "writer",
      transports: [createBridgeTransport({ transportId: "writer", bridge })],
    })
    const reader1 = createExchange({
      principal: "reader",
      transports: [createBridgeTransport({ transportId: "reader-1", bridge })],
    })
    const doc = writer.get("list", ListDoc)
    reader1.get("list", ListDoc)
    batch(doc, d => {
      d.items.push(1)
      d.items.push(2)
    })
    await drain()
    batch(doc, d => d.items.delete(0, 2))
    await drain()

    await reader1.removeTransport("reader-1")
    await drain()
    const reader2 = createExchange({
      principal: "reader",
      transports: [createBridgeTransport({ transportId: "reader-2", bridge })],
    })
    await drain()

    const restarted = reader2.get("list", ListDoc)
    batch(doc, d => d.items.push(3))
    await drain()

    expect(restarted.items()).toEqual(doc.items())
    expect(doc.items()).toEqual([3])
  })

  it("sender side: bob restarts → alice's messages to bob-2 are not pruned on bob-1's ack", async () => {
    // Symmetric to the receiver side: if the receiver restarts, its ack
    // survives in its old outbox. Before seats were issued, bob-2 reused
    // bob-1's id, and alice's #pruneOutbox read that stale ack and deleted
    // her new, never-delivered messages. Now bob-2 is a new seat, and alice
    // writes to it on a fresh Line.
    const bridge = new Bridge()

    const alice = createExchange({
      principal: "alice",
      transports: [createBridgeTransport({ transportId: "alice", bridge })],
    })
    const bob1 = createExchange({
      principal: "bob",
      transports: [createBridgeTransport({ transportId: "bob-1", bridge })],
    })
    await drain()

    const P = Line.protocol({ topic: "restart-send", schema: SimpleSchema })
    const aliceSender = P.sender(alice, bob1.peerId)
    const bob1Receiver = P.claimReceiver(bob1, alice.peerId)
    const received1: any[] = []
    collect(bob1Receiver, received1)

    // alice sends, bob acks — bob's inbox (alice's outbox) now carries a
    // nonzero ack recorded against alice's current incarnation.
    aliceSender.send({ value: 1 })
    aliceSender.send({ value: 2 })
    await drain()
    expect(received1.map(m => m.value)).toEqual([1, 2])

    // Bob restarts (fresh Exchange, same principal, new seat). His ack
    // survives in his old outbox doc.
    await bob1.removeTransport("bob-1")
    aliceSender.close()
    bob1Receiver.close()
    await drain()

    const bob2 = createExchange({
      principal: "bob",
      transports: [createBridgeTransport({ transportId: "bob-2", bridge })],
    })
    await drain()

    // alice, the long-lived side, opens a sender to bob's new seat.
    const aliceSender2 = P.sender(alice, bob2.peerId)
    const bob2Receiver = P.claimReceiver(bob2, alice.peerId)
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
      principal: "alice",
      transports: [createBridgeTransport({ transportId: "alice", bridge })],
    })
    const exchangeB = createExchange({
      principal: "bob",
      transports: [createBridgeTransport({ transportId: "bob", bridge })],
    })
    await drain()

    const P = Line.protocol({ topic: "reopen-noreplay", schema: SimpleSchema })
    const aliceSender1 = P.sender(exchangeA, exchangeB.peerId)
    const bobReceiver1 = P.claimReceiver(exchangeB, exchangeA.peerId)
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
    const aliceSender2 = P.sender(exchangeA, exchangeB.peerId)
    const bobReceiver2 = P.claimReceiver(exchangeB, exchangeA.peerId)
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

// ── A stored peer's restart ──────────────────────────────────────────────────

describe("durable Line: a stored peer restarts", () => {
  it("returns with the same seat, and the Line resumes with nothing lost or processed twice", async () => {
    const bridge = new Bridge()
    const storage = createInMemoryStoreData()
    const openServer = (transportId: string) =>
      createExchange({
        principal: "server",
        transports: [createBridgeTransport({ transportId, bridge })],
        store: new InMemoryStore(storage),
      })

    const server1 = openServer("server-1")
    const alice = createExchange({
      principal: "alice",
      transports: [createBridgeTransport({ transportId: "alice", bridge })],
    })
    await drain()

    const P = Line.protocol({ topic: "server-restart", schema: SimpleSchema })
    const aliceSender = P.sender(alice, server1.peerId)
    const received1: { value: number }[] = []
    const receiver1 = P.claimReceiver(server1, alice.peerId)
    collect(receiver1, received1)

    aliceSender.send({ value: 1 })
    aliceSender.send({ value: 2 })
    await drain()
    expect(received1.map(m => m.value)).toEqual([1, 2])

    receiver1.close()
    await server1.shutdown()
    await drain()

    // Sent while the server is down.
    aliceSender.send({ value: 3 })
    await drain()

    const server2 = openServer("server-2")
    expect(server2.peerId).toBe(server1.peerId)
    const received2: { value: number }[] = []
    const receiver2 = P.claimReceiver(server2, alice.peerId)
    collect(receiver2, received2)
    await drain()

    aliceSender.send({ value: 4 })
    await drain()

    expect(aliceSender.closed).toBe(false)
    expect(received2.map(m => m.value)).toEqual([3, 4])

    aliceSender.close()
    receiver2.close()
  })

  it("a message sent before the stored documents load is sent once they have", async () => {
    const bridge = new Bridge()
    const storage = createInMemoryStoreData()
    const server = createExchange({
      principal: "server",
      transports: [createBridgeTransport({ transportId: "server", bridge })],
      store: new InMemoryStore(storage),
    })
    const alice = createExchange({
      principal: "alice",
      transports: [createBridgeTransport({ transportId: "alice", bridge })],
    })
    await drain()

    const P = Line.protocol({ topic: "early-send", schema: SimpleSchema })
    const received: { value: number }[] = []
    const aliceReceiver = P.claimReceiver(alice, server.peerId)
    collect(aliceReceiver, received)

    // Opened and written on the same tick, while its outbox still loads.
    const serverSender = P.sender(server, alice.peerId)
    serverSender.send({ value: 1 })
    serverSender.send({ value: 2 })
    await drain()

    expect(received.map(m => m.value)).toEqual([1, 2])
    serverSender.close()
    aliceReceiver.close()
  })
})

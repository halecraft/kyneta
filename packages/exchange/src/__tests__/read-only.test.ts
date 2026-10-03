// read-only — a policy decides who may write a document, and a peer it
// excludes holds that document read-only.
//
// One `canWrite`, registered unchanged on every peer, keyed by principal. On
// a peer it excludes, every authored write throws `NotAWriterError` before
// anything is applied, so no operation exists that a receiver would have to
// drop. On every peer, an offer from a sender it excludes is not imported.

import { Bridge, createBridgeTransport } from "@kyneta/bridge-transport"
import { changefeed } from "@kyneta/changefeed"
import { loro } from "@kyneta/loro-schema"
import {
  type BoundSchema,
  batch,
  createDoc,
  type HasNativeAny,
  hasSubstrate,
  json,
  Schema,
  SUBSTRATE,
  type Substrate,
  unwrap,
  type Version,
} from "@kyneta/schema"
import { type PeerIdentityDetails, PROTOCOL_VERSION } from "@kyneta/transport"
import { yjs } from "@kyneta/yjs-schema"
import { describe, expect, it } from "vitest"
import type { Exchange } from "../exchange.js"
import { NotAWriterError, type Policy } from "../governance.js"
import { writeRefusal, writeRefusalFeed } from "../persistence.js"
import { createUndoStack } from "../undo/stack.js"
import { drain, exchangesPerTest } from "./exchanges.js"
import { ScriptedPeer } from "./scripted-peer.js"

const createExchange = exchangesPerTest()

const PlacesSchema = Schema.struct({ card: Schema.string() })

type PlacesBound = BoundSchema<typeof PlacesSchema>

const backends: readonly (readonly [string, PlacesBound])[] = [
  ["loro", loro.bind(PlacesSchema)],
  ["yjs", yjs.bind(PlacesSchema)],
  ["json", json.bind(PlacesSchema)],
]

type Card = { (): string; set(value: string): void }
type Places = HasNativeAny & { readonly card: Card }

/** The one policy every peer registers. */
const isHost = (p: PeerIdentityDetails) => p.principal === "host"
const onlyTheHostWritesPlaces: Policy = {
  canWrite: (docId, p) => (docId === "places" ? isHost(p) : undefined),
}

/**
 * Hub and spoke: the host links to each client over its own bridge, and the
 * clients do not link to each other.
 */
function hubAndSpoke() {
  const toBad = new Bridge()
  const toGood = new Bridge()
  const host = createExchange({
    principal: "host",
    type: "service",
    authority: "self",
    transports: [
      createBridgeTransport({ transportId: "host-bad", bridge: toBad }),
      createBridgeTransport({ transportId: "host-good", bridge: toGood }),
    ],
    ...onlyTheHostWritesPlaces,
  })
  const bad = createExchange({
    principal: "bad",
    transports: [createBridgeTransport({ transportId: "bad", bridge: toBad })],
    ...onlyTheHostWritesPlaces,
  })
  const good = createExchange({
    principal: "good",
    transports: [
      createBridgeTransport({ transportId: "good", bridge: toGood }),
    ],
    ...onlyTheHostWritesPlaces,
  })
  return { host, bad, good }
}

const places = (exchange: Exchange, bound: PlacesBound): Places =>
  exchange.get("places", bound) as unknown as Places

function substrateOf(doc: object): Substrate<Version> {
  if (!hasSubstrate(doc)) throw new Error("expected a root ref")
  return doc[SUBSTRATE]
}

for (const [name, bound] of backends) {
  describe(`read-only by policy (${name})`, () => {
    it("a client's writes and native handle throw NotAWriterError, and it still receives the host's writes", async () => {
      const { host, bad } = hubAndSpoke()
      const atHost = places(host, bound)
      const atClient = places(bad, bound)
      await drain()

      const refusal = writeRefusal(atClient)
      expect(refusal).toBeInstanceOf(NotAWriterError)
      if (!(refusal instanceof NotAWriterError)) return
      expect(refusal.docId).toBe("places")
      expect(refusal.peer.principal).toBe("bad")
      expect(writeRefusal(atClient.card)).toBe(refusal)

      expect(() => atClient.card.set("B")).toThrow(NotAWriterError)
      expect(() => batch(atClient, d => d.card.set("B"))).toThrow(
        NotAWriterError,
      )
      expect(() => unwrap(atClient)).toThrow(NotAWriterError)
      expect(atClient.card()).toBe("")

      // The host writes freely, and its writes arrive.
      expect(writeRefusal(atHost)).toBeUndefined()
      atHost.card.set("H1")
      expect(unwrap(atHost)).toBeDefined()
      await drain()
      expect(atClient.card()).toBe("H1")
    })

    it("the reproduction: the bad client's write throws, and all three agree after each host write", async () => {
      const { host, bad, good } = hubAndSpoke()
      const atHost = places(host, bound)
      const atBad = places(bad, bound)
      const atGood = places(good, bound)
      atHost.card.set("A")
      await drain()
      expect([atBad.card(), atGood.card()]).toEqual(["A", "A"])

      expect(() => atBad.card.set("B")).toThrow(NotAWriterError)
      await drain()
      expect([atHost.card(), atBad.card(), atGood.card()]).toEqual([
        "A",
        "A",
        "A",
      ])

      for (const value of ["H1", "H2"]) {
        atHost.card.set(value)
        await drain()
        expect([atHost.card(), atBad.card(), atGood.card()]).toEqual([
          value,
          value,
          value,
        ])
      }
    })

    it("an offer from a sender canWrite excludes is not imported, by the host or by another client", async () => {
      // A raw offer, from a peer that bypasses its own gate. Announced as a
      // client it is refused; the same offer announced as the host, the
      // control, is imported.
      const writer = createDoc(bound) as unknown as Places
      batch(writer, d => d.card.set("B"))
      const payload = substrateOf(writer).exportEntirety()
      const version = substrateOf(writer).version().serialize()

      const received = async (receiver: string, sender: string) => {
        const peer = new ScriptedPeer()
        const exchange = createExchange({
          principal: receiver,
          transports: [peer],
          ...onlyTheHostWritesPlaces,
        })
        const doc = places(exchange, bound)
        await Promise.resolve()
        peer.receive({
          type: "establish",
          identity: { peerId: sender, principal: sender, type: "user" },
          protocolVersion: PROTOCOL_VERSION,
        })
        peer.receive({ type: "interest", docId: "places" })
        peer.receive({ type: "offer", docId: "places", version, payload })
        await drain()
        return doc.card()
      }

      expect(await received("host", "bad")).toBe("")
      expect(await received("good", "bad")).toBe("")
      expect(await received("good", "host")).toBe("B")
    })
  })
}

describe("read-only by policy, over the policy's lifetime", () => {
  const bound = loro.bind(PlacesSchema)

  it("a policy registered after the document opened refuses its next write, and its disposal lifts the refusal", () => {
    const exchange = createExchange({ principal: "client" })
    const doc = places(exchange, bound)
    doc.card.set("before")
    const feed = changefeed(writeRefusalFeed(doc))
    let heard = 0
    feed.subscribe(() => heard++)

    const dispose = exchange.register(onlyTheHostWritesPlaces)
    expect(heard).toBe(1)
    expect(feed.current).toBeInstanceOf(NotAWriterError)
    expect(() => doc.card.set("refused")).toThrow(NotAWriterError)
    expect(doc.card()).toBe("before")

    dispose()
    expect(heard).toBe(2)
    expect(feed.current).toBeUndefined()
    doc.card.set("after")
    expect(doc.card()).toBe("after")
  })

  it("an offer from a sender is judged when it arrives, by the policies registered then", async () => {
    const writer = createDoc(bound) as unknown as Places
    batch(writer, d => d.card.set("B"))
    const peer = new ScriptedPeer()
    const exchange = createExchange({ principal: "host", transports: [peer] })
    const doc = places(exchange, bound)
    await Promise.resolve()
    peer.receive({
      type: "establish",
      identity: { peerId: "bad", principal: "bad", type: "user" },
      protocolVersion: PROTOCOL_VERSION,
    })
    peer.receive({ type: "interest", docId: "places" })
    const offer = () =>
      peer.receive({
        type: "offer",
        docId: "places",
        version: substrateOf(writer).version().serialize(),
        payload: substrateOf(writer).exportEntirety(),
      })

    const dispose = exchange.register(onlyTheHostWritesPlaces)
    offer()
    await drain()
    expect(doc.card()).toBe("")

    dispose()
    offer()
    await drain()
    expect(doc.card()).toBe("B")
  })

  it("the undo stack reverts the rest of a step, and names a read-only document's part stale", async () => {
    const Card = loro.bind(Schema.struct({ text: Schema.text() }))
    const exchange = createExchange({
      principal: "client",
      schemas: [Card, bound],
    })
    const card = exchange.get("card", Card)
    const doc = places(exchange, bound)
    const stack = await createUndoStack({
      exchange,
      docId: "undo",
      key: "main",
      scope: docId => docId !== "undo",
    })
    try {
      stack.gesture(() => {
        card.text.insert(0, "moved")
        doc.card.set("moved")
      })
      stack.gesture(() => {
        card.text.insert(0, "again ")
        doc.card.set("again")
      })
      await drain()
      exchange.register(onlyTheHostWritesPlaces)

      // Asked to undo a step whole, the stack refuses it, and drops it.
      const refused = await stack.undo({ whole: true })
      expect(refused.kind).toBe("refused")
      expect(card.text()).toBe("again moved")
      expect(doc.card()).toBe("again")

      const undone = await stack.undo()
      expect(undone.kind).toBe("undone")
      if (undone.kind !== "undone") return
      expect(undone.stale.map(part => part.docId)).toEqual(["places"])
      expect(card.text()).toBe("again ")
      expect(doc.card()).toBe("again")
    } finally {
      stack.dispose()
    }
  })
})

// refusal — a refused offer is answered with `refuse`, and a writer its
// authority refuses stops writing.
//
// The host accepts only its own operations (`canAccept`, with no `canWrite`,
// so nothing local stops a client's write). Clients name the host as their
// authority. A client whose write the host refuses is told, and holds the
// document read-only for as long as the host's refusal stands.

import { Bridge, createBridgeTransport } from "@kyneta/bridge-transport"
import { changefeed } from "@kyneta/changefeed"
import { loro } from "@kyneta/loro-schema"
import {
  type BoundSchema,
  batch,
  createDoc,
  hasSubstrate,
  json,
  Schema,
  SUBSTRATE,
  type Substrate,
  type Version,
  type WriteRefusal,
} from "@kyneta/schema"
import { type PeerIdentityDetails, PROTOCOL_VERSION } from "@kyneta/transport"
import { yjs } from "@kyneta/yjs-schema"
import { describe, expect, it, vi } from "vitest"
import type { Exchange, ExchangeParams } from "../exchange.js"
import type { ObsEvent } from "../observe.js"
import { writeRefusal, writeRefusalFeed } from "../persistence.js"
import { createInMemoryStore } from "../store/in-memory-store.js"
import { OfferRefusedError, sync } from "../sync.js"
import { drain, exchangesPerTest, sleep } from "./exchanges.js"
import { ScriptedPeer } from "./scripted-peer.js"

const createExchange = exchangesPerTest()

const PlacesSchema = Schema.struct({
  card: Schema.string(),
  other: Schema.string(),
})
type PlacesBound = BoundSchema<typeof PlacesSchema>
type Field = { (): string; set(value: string): void }
type Places = { readonly card: Field; readonly other: Field }

const backends: readonly (readonly [string, PlacesBound])[] = [
  ["loro", loro.bind(PlacesSchema)],
  ["yjs", yjs.bind(PlacesSchema)],
  ["json", json.bind(PlacesSchema)],
]

const isHost = (p: PeerIdentityDetails) => p.principal === "host"

const places = (exchange: Exchange, bound: PlacesBound): Places =>
  exchange.get("places", bound) as unknown as Places

/**
 * Hub and spoke: the host links to each client over its own bridge. The host
 * takes only its own operations; each client names the host its authority.
 */
function hubAndSpoke(client: Partial<ExchangeParams> = {}) {
  const toBad = new Bridge()
  const toGood = new Bridge()
  const host = createExchange({
    principal: "host",
    type: "service",
    authority: "self",
    canAccept: (_docId, p) => isHost(p),
    transports: [
      createBridgeTransport({ transportId: "host-bad", bridge: toBad }),
      createBridgeTransport({ transportId: "host-good", bridge: toGood }),
    ],
  })
  const bad = createExchange({
    principal: "bad",
    authority: isHost,
    transports: [createBridgeTransport({ transportId: "bad", bridge: toBad })],
    ...client,
  })
  const good = createExchange({
    principal: "good",
    authority: isHost,
    transports: [
      createBridgeTransport({ transportId: "good", bridge: toGood }),
    ],
  })
  return { host, bad, good, toBad }
}

/** What the host's later write to another field shows on a refused writer,
 *  by backend: a refused json writer misses the host's operation at the
 *  position its own refused one holds. */
const OTHER_AFTER_REFUSAL: Record<string, string> = {
  loro: "O1",
  yjs: "O1",
  json: "",
}

/** A hub and spoke where the host wrote "A" and every peer holds it. */
async function started(bound: PlacesBound, client?: Partial<ExchangeParams>) {
  const peers = hubAndSpoke(client)
  const atHost = places(peers.host, bound)
  const atBad = places(peers.bad, bound)
  const atGood = places(peers.good, bound)
  atHost.card.set("A")
  await drain()
  expect([atBad.card(), atGood.card()]).toEqual(["A", "A"])
  return { ...peers, atHost, atBad, atGood }
}

for (const [name, bound] of backends) {
  describe(`a writer its authority refuses (${name})`, () => {
    it("is told, and stops writing: its next write throws OfferRefusedError", async () => {
      const { atHost, atBad, atGood } = await started(bound)
      const feed = changefeed(writeRefusalFeed(atBad))
      let heard = 0
      feed.subscribe(() => heard++)

      atBad.card.set("B")
      await drain()
      expect(atHost.card()).toBe("A")
      expect(atGood.card()).toBe("A")

      const refusal = writeRefusal(atBad)
      expect(refusal).toBeInstanceOf(OfferRefusedError)
      if (!(refusal instanceof OfferRefusedError)) return
      expect(refusal.docId).toBe("places")
      expect(refusal.peer.principal).toBe("host")
      expect(writeRefusal(atBad)).toBe(refusal)
      expect(heard).toBeGreaterThan(0)
      expect(() => atBad.card.set("C")).toThrow(OfferRefusedError)
      expect(atBad.card()).toBe("B")
      // The good client is unaffected.
      expect(writeRefusal(atGood)).toBeUndefined()
    })
  })
}

for (const [name, bound] of backends) {
  describe(`what a refused writer holds (${name})`, () => {
    it("is forked from its authority until it rebuilds, and destroy then get rejoins", async () => {
      const { bad, atHost, atBad } = await started(bound)
      atBad.card.set("B")
      await drain()
      expect(writeRefusal(atBad)).toBeInstanceOf(OfferRefusedError)

      atHost.other.set("O1")
      await drain()
      expect(atBad.other()).toBe(OTHER_AFTER_REFUSAL[name])

      bad.destroy("places")
      await drain()
      const rebuilt = places(bad, bound)
      await drain()
      expect(writeRefusal(rebuilt)).toBeUndefined()
      expect([rebuilt.card(), rebuilt.other()]).toEqual([
        atHost.card(),
        atHost.other(),
      ])
      expect([atHost.card(), atHost.other()]).toEqual(["A", "O1"])
    })
  })
}

describe("the lock follows the authority's current refusal", () => {
  const bound = loro.bind(PlacesSchema)

  /** Every value the refusal feed of `doc` passes through, from now. */
  function history(doc: object): (WriteRefusal | undefined)[] {
    const feed = changefeed(writeRefusalFeed(doc))
    const seen: (WriteRefusal | undefined)[] = []
    feed.subscribe(() => seen.push(feed.current))
    return seen
  }

  it("holds while the host is away; a reconnect lifts it until the host refuses again", async () => {
    const { bad, toBad, atBad } = await started(bound)
    atBad.card.set("B")
    await drain()
    const refusal = writeRefusal(atBad)
    expect(refusal).toBeInstanceOf(OfferRefusedError)

    await bad.removeTransport("bad")
    await drain()
    expect(writeRefusal(atBad)).toBe(refusal)

    const seen = history(atBad)
    await bad.addTransport(
      createBridgeTransport({ transportId: "bad", bridge: toBad }),
    )
    await drain()
    expect(seen[0]).toBeUndefined()
    expect(seen.at(-1)).toBeInstanceOf(OfferRefusedError)
    expect(writeRefusal(atBad)).toBeInstanceOf(OfferRefusedError)
  })

  it("lifts once the host departs", async () => {
    const { atBad, bad } = await started(bound, { departureTimeout: 5 })
    atBad.card.set("B")
    await drain()
    expect(writeRefusal(atBad)).toBeInstanceOf(OfferRefusedError)

    await bad.removeTransport("bad")
    await sleep(20)
    await drain()
    expect(writeRefusal(atBad)).toBeUndefined()
  })

  it("lifts when a policy change makes the refusing peer no longer the authority", async () => {
    const { bad, atBad } = await started(bound, { authority: undefined })
    bad.register({ name: "authority", authority: isHost })
    atBad.card.set("B")
    await drain()
    expect(writeRefusal(atBad)).toBeInstanceOf(OfferRefusedError)

    const seen = history(atBad)
    bad.register({ name: "authority", authority: "self" })
    expect(seen).toEqual([undefined])
    atBad.card.set("C")
    expect(atBad.card()).toBe("C")
  })

  it("returns after an unload and a load: the reloaded document's offer is refused again", async () => {
    const { bad, atBad } = await started(bound, {
      store: createInMemoryStore(),
    })
    atBad.card.set("B")
    await drain()
    expect(writeRefusal(atBad)).toBeInstanceOf(OfferRefusedError)

    bad.unload("places")
    await bad.flush()
    await drain()
    expect(bad.runtime.lifecycleOf("places")?.phase).toBe("unloaded")

    const reloaded = places(bad, bound)
    await bad.whenHydrated("places")
    await drain()
    expect(reloaded.card()).toBe("B")
    expect(writeRefusal(reloaded)).toBeInstanceOf(OfferRefusedError)
  })
})

describe("a refusal from a peer that is not the authority", () => {
  const bound = loro.bind(PlacesSchema)

  it("is reported, leaves the sender writable, and the sender sends that peer no more content", async () => {
    // One bridge: every peer links to every other.
    const bridge = new Bridge()
    const host = createExchange({
      principal: "host",
      authority: "self",
      transports: [createBridgeTransport({ transportId: "host", bridge })],
    })
    const alice = createExchange({
      principal: "alice",
      authority: isHost,
      transports: [createBridgeTransport({ transportId: "alice", bridge })],
    })
    const bob = createExchange({
      principal: "bob",
      authority: isHost,
      canAccept: (_docId, p) => p.principal !== "alice",
      transports: [createBridgeTransport({ transportId: "bob", bridge })],
    })
    const events: ObsEvent[] = []
    alice.observe(e => events.push(e))
    const atAlice = places(alice, bound)
    places(host, bound)
    places(bob, bound)
    await drain()

    atAlice.card.set("A1")
    await drain()
    expect(events).toContainEqual(
      expect.objectContaining({
        layer: "diagnostic",
        code: "offer-refused",
        peer: bob.peerId,
        docId: "places",
      }),
    )
    expect(writeRefusal(atAlice)).toBeUndefined()

    events.length = 0
    atAlice.card.set("A2")
    await drain()
    const offersTo = (peer: string) =>
      events.filter(
        e =>
          e.layer === "protocol" &&
          e.kind === "message" &&
          e.dir === "out" &&
          e.msgType === "offer" &&
          e.peer === peer,
      )
    expect(offersTo(host.peerId).length).toBeGreaterThan(0)
    expect(offersTo(bob.peerId)).toEqual([])
  })

  it("a host its client refuses stays writable, under authority self", async () => {
    const bridge = new Bridge()
    const host = createExchange({
      principal: "host",
      authority: "self",
      transports: [createBridgeTransport({ transportId: "host", bridge })],
    })
    const client = createExchange({
      principal: "client",
      authority: isHost,
      canAccept: () => false,
      transports: [createBridgeTransport({ transportId: "client", bridge })],
    })
    const events: ObsEvent[] = []
    host.observe(e => events.push(e))
    const atHost = places(host, bound)
    places(client, bound)
    await drain()

    atHost.card.set("H1")
    await drain()
    expect(events).toContainEqual(
      expect.objectContaining({ code: "offer-refused", peer: client.peerId }),
    )
    expect(writeRefusal(atHost)).toBeUndefined()
    atHost.card.set("H2")
    expect(atHost.card()).toBe("H2")
  })
})

// ---------------------------------------------------------------------------
// The shell: what a vetoed offer gathers
// ---------------------------------------------------------------------------

describe("a vetoed offer, in the shell", () => {
  const bound = loro.bind(PlacesSchema)

  function substrateOf(doc: object): Substrate<Version> {
    if (!hasSubstrate(doc)) throw new Error("expected a root ref")
    return doc[SUBSTRATE]
  }

  /** An exchange holding "places", and a scripted peer "them" whose interest,
   *  stating `version`, it has answered. */
  async function scripted(params: Partial<ExchangeParams>, version?: string) {
    const peer = new ScriptedPeer()
    const exchange = createExchange({
      principal: "us",
      transports: [peer],
      ...params,
    })
    const doc = places(exchange, bound)
    await Promise.resolve()
    peer.receive({
      type: "establish",
      identity: { peerId: "them", principal: "them", type: "user" },
      protocolVersion: PROTOCOL_VERSION,
    })
    peer.receive({
      type: "interest",
      docId: "places",
      ...(version === undefined ? {} : { version }),
    })
    await drain()
    peer.sent.length = 0
    return { peer, exchange, doc }
  }

  const stateOfThem = (doc: object) =>
    sync(doc).peerStates.find(s => s.peer.peerId === "them")?.state

  it("never consults canReset, even for an offer that looks like a reset", async () => {
    const canReset = vi.fn(() => true)
    const control = await scripted({ canReset })
    const vetoed = await scripted({ canReset, canAccept: () => false })
    // Another document's whole state, from a sender already synced: a
    // compaction reset, by its facts.
    const theirs = createDoc(bound) as unknown as Places
    batch(theirs, d => d.card.set("theirs"))
    const offer = {
      type: "offer" as const,
      docId: "places",
      payload: substrateOf(theirs).exportEntirety(),
      version: substrateOf(theirs).version().serialize(),
    }

    control.peer.receive(offer)
    await drain()
    expect(canReset).toHaveBeenCalled()
    canReset.mockClear()

    vetoed.peer.receive(offer)
    await drain()
    expect(canReset).not.toHaveBeenCalled()
    expect(vetoed.doc.card()).toBe("")
    expect(vetoed.peer.sentOf("refuse")).toMatchObject([
      { docId: "places", version: offer.version },
    ])
  })

  it("marks a vetoed sender our version reaches synced, and leaves one with operations we lack pending", async () => {
    const reached = await scripted({ canAccept: () => false })
    const ours = substrateOf(reached.doc)
    reached.peer.receive({
      type: "offer",
      docId: "places",
      payload: ours.exportEntirety(),
      version: ours.version().serialize(),
    })
    await drain()
    expect(stateOfThem(reached.doc)).toBe("synced")
    expect(reached.peer.sentOf("refuse")).toEqual([])
    expect(reached.peer.sentOf("accept")).toEqual([])

    const theirs = createDoc(bound) as unknown as Places
    batch(theirs, d => d.card.set("theirs"))
    const version = substrateOf(theirs).version().serialize()
    const ahead = await scripted({ canAccept: () => false }, version)
    expect(stateOfThem(ahead.doc)).toBe("pending")
    ahead.peer.receive({
      type: "offer",
      docId: "places",
      payload: substrateOf(theirs).exportEntirety(),
      version,
    })
    await drain()
    expect(stateOfThem(ahead.doc)).toBe("pending")
    expect(ahead.doc.card()).toBe("")
    expect(ahead.peer.sentOf("refuse")).toHaveLength(1)
  })
})

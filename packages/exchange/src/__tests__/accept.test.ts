// accept — the shell sends an `accept` for an offer only once it holds the
// offered version.
//
// The program decides an accept is owed; the Synchronizer sends it on each
// path where the offer ends up held. These tests speak the protocol directly
// through a scripted peer, so they can offer what no real peer would: a
// version we cannot read, a delta that does not continue what we hold, and a
// delta whose sender held something we lack.

import { LoroVersion, loro } from "@kyneta/loro-schema"
import {
  batch,
  createDoc,
  hasSubstrate,
  json,
  Schema,
  SUBSTRATE,
  type Substrate,
  type SubstratePayload,
  type Version,
} from "@kyneta/schema"
import { type ChannelMsg, PROTOCOL_VERSION } from "@kyneta/transport"
import { YjsVersion, yjs } from "@kyneta/yjs-schema"
import { afterEach, describe, expect, it } from "vitest"
import { Exchange } from "../exchange.js"
import { ScriptedPeer } from "./scripted-peer.js"

const Doc = json.bind(Schema.struct({ n: Schema.number() }))

const exchanges: Exchange[] = []
afterEach(async () => {
  for (const exchange of exchanges) await exchange.shutdown()
  exchanges.length = 0
})

/** An exchange holding document `d`, connected to a scripted peer. */
async function connected<D>(
  open: (exchange: Exchange) => D,
): Promise<{ peer: ScriptedPeer; version: string; doc: D }> {
  const peer = new ScriptedPeer()
  const exchange = new Exchange({ principal: "us", transports: [peer] })
  exchanges.push(exchange)
  const doc = open(exchange)
  await Promise.resolve()
  peer.receive({
    type: "establish",
    identity: { peerId: "them", principal: "them", type: "user" },
    protocolVersion: PROTOCOL_VERSION,
  })
  const [present] = peer.sentOf("present")
  if (!present?.docs.some(d => d.docId === "d")) {
    throw new Error("the exchange did not present document d")
  }
  peer.receive({ type: "interest", docId: "d" })
  const [answer] = peer.sentOf("offer")
  if (!answer) throw new Error("the exchange did not answer the interest")
  peer.sent.length = 0
  return { peer, version: answer.version, doc }
}

const openPlain = (exchange: Exchange) => exchange.get("d", Doc)

function substrateOf(doc: object): Substrate<Version> {
  if (!hasSubstrate(doc)) throw new Error("expected a root ref")
  return doc[SUBSTRATE]
}

function exportSince(
  from: Substrate<Version>,
  since: Version,
): SubstratePayload {
  const payload = from.exportSince(since)
  if (payload === null) throw new Error("expected a delta")
  return payload
}

/** A plain delta, with nothing in it, that continues from `from`. */
function offer(version: string, from: number, lineage?: string): ChannelMsg {
  return {
    type: "offer",
    docId: "d",
    version,
    payload: {
      kind: "since",
      encoding: "json",
      data: JSON.stringify({ from, batches: [] }),
      ...(lineage === undefined ? {} : { lineage }),
    },
  }
}

describe("accept", () => {
  it("is sent for an offer of a version we already hold", async () => {
    const { peer, version } = await connected(openPlain)
    peer.receive(offer(version, 0))
    expect(peer.sentOf("accept")).toEqual([
      { type: "accept", docId: "d", version },
    ])
  })

  it("is not sent for an offer whose version we cannot read", async () => {
    const { peer } = await connected(openPlain)
    peer.receive(offer("not a version", 0))
    expect(peer.sentOf("accept")).toEqual([])
  })

  it("is not sent for a delta that does not continue what we hold", async () => {
    const { peer } = await connected(openPlain)
    peer.receive(offer("theirs:9", 5, "theirs"))
    expect(peer.sentOf("accept")).toEqual([])
    expect(peer.sentOf("interest")).toMatchObject([{ docId: "d" }])
  })

  it("is not sent for a delta whose sender held something we lack (yjs)", async () => {
    // Alice holds Carol's write and then writes one of her own, on a field
    // Carol's does not touch, so her delta merges cleanly into a replica
    // without Carol's. Nothing is left pending, and only the version shows
    // what is missing.
    const bound = yjs.bind(
      Schema.struct({ title: Schema.text(), n: Schema.number() }),
    )
    const { peer, doc } = await connected(exchange => exchange.get("d", bound))
    const carol = createDoc(bound)
    batch(carol, d => d.n.set(7))
    const alice = createDoc(bound)
    const aliceSubstrate = substrateOf(alice)
    aliceSubstrate.merge(substrateOf(carol).exportEntirety())
    const base = aliceSubstrate.version()
    batch(alice, d => d.title.insert(0, "hi"))

    const offered = aliceSubstrate.version().serialize()
    peer.receive({
      type: "offer",
      docId: "d",
      version: offered,
      payload: exportSince(aliceSubstrate, base),
    })
    expect(doc.title()).toBe("hi")
    expect(peer.sentOf("accept")).toEqual([])
    const [ask] = peer.sentOf("interest")
    if (ask?.version === undefined) throw new Error("expected an interest")

    // Alice answers with what we lack; now we hold her version.
    peer.receive({
      type: "offer",
      docId: "d",
      version: offered,
      payload: exportSince(aliceSubstrate, YjsVersion.parse(ask.version)),
    })
    expect(doc.n()).toBe(7)
    expect(peer.sentOf("accept")).toEqual([
      { type: "accept", docId: "d", version: offered },
    ])
  })

  it("is not sent for a delta whose dependencies we lack (loro)", async () => {
    // Alice's second write depends on her first, which we never received.
    // Loro holds it pending; our version stays short of hers.
    const bound = loro.bind(
      Schema.struct({ title: Schema.text(), n: Schema.number() }),
    )
    const { peer, doc } = await connected(exchange => exchange.get("d", bound))
    const alice = createDoc(bound)
    const aliceSubstrate = substrateOf(alice)
    batch(alice, d => d.title.insert(0, "a"))
    const afterFirst = aliceSubstrate.version()
    batch(alice, d => d.title.insert(1, "b"))

    const offered = aliceSubstrate.version().serialize()
    peer.receive({
      type: "offer",
      docId: "d",
      version: offered,
      payload: exportSince(aliceSubstrate, afterFirst),
    })
    expect(doc.title()).toBe("")
    expect(peer.sentOf("accept")).toEqual([])
    const [ask] = peer.sentOf("interest")
    if (ask?.version === undefined) throw new Error("expected an interest")

    peer.receive({
      type: "offer",
      docId: "d",
      version: offered,
      payload: exportSince(aliceSubstrate, LoroVersion.parse(ask.version)),
    })
    expect(doc.title()).toBe("ab")
    expect(peer.sentOf("accept")).toEqual([
      { type: "accept", docId: "d", version: offered },
    ])
  })
})

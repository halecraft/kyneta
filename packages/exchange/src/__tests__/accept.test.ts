// accept — the shell sends an `accept` for an offer only once it holds the
// offered version.
//
// The program decides an accept is owed; the Synchronizer sends it on each
// path where the offer ends up held. These tests speak the protocol directly
// through a scripted peer, so they can offer what no real peer would: a
// version we cannot read, and a delta that does not continue what we hold.

import { json, Schema } from "@kyneta/schema"
import {
  type ChannelMsg,
  type ConnectedChannel,
  type GeneratedChannel,
  PROTOCOL_VERSION,
  Transport,
} from "@kyneta/transport"
import { afterEach, describe, expect, it } from "vitest"
import { Exchange } from "../exchange.js"

/** A peer whose every message is written by the test. */
class ScriptedPeer extends Transport<void> {
  readonly sent: ChannelMsg[] = []
  #channel: ConnectedChannel | undefined

  constructor() {
    super({ transportType: "scripted", transportId: "scripted" })
  }

  protected generate(): GeneratedChannel {
    return {
      transportType: this.transportType,
      send: msg => {
        this.sent.push(msg)
      },
      stop: () => {},
    }
  }

  async onStart(): Promise<void> {
    const channel = this.addChannel(undefined)
    this.#channel = channel
    this.establishChannel(channel.channelId)
  }

  async onStop(): Promise<void> {}

  receive(msg: ChannelMsg): void {
    if (!this.#channel) throw new Error("the scripted peer has not started")
    this.#channel.onReceive(msg)
  }

  sentOf<T extends ChannelMsg["type"]>(
    type: T,
  ): Extract<ChannelMsg, { type: T }>[] {
    return this.sent.filter(
      (m): m is Extract<ChannelMsg, { type: T }> => m.type === type,
    )
  }
}

const Doc = json.bind(Schema.struct({ n: Schema.number() }))

const exchanges: Exchange[] = []
afterEach(async () => {
  for (const exchange of exchanges) await exchange.shutdown()
  exchanges.length = 0
})

/** An exchange holding document `d`, connected to a scripted peer. */
async function connected(): Promise<{ peer: ScriptedPeer; version: string }> {
  const peer = new ScriptedPeer()
  const exchange = new Exchange({ id: "us", transports: [peer] })
  exchanges.push(exchange)
  exchange.get("d", Doc)
  await Promise.resolve()
  peer.receive({
    type: "establish",
    identity: { peerId: "them", type: "user" },
    protocolVersion: PROTOCOL_VERSION,
  })
  const [present] = peer.sentOf("present")
  const doc = present?.docs.find(d => d.docId === "d")
  if (!doc) throw new Error("the exchange did not present document d")
  peer.receive({ type: "interest", docId: "d" })
  const [answer] = peer.sentOf("offer")
  if (!answer) throw new Error("the exchange did not answer the interest")
  peer.sent.length = 0
  return { peer, version: answer.version }
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
    const { peer, version } = await connected()
    peer.receive(offer(version, 0))
    expect(peer.sentOf("accept")).toEqual([
      { type: "accept", docId: "d", version },
    ])
  })

  it("is not sent for an offer whose version we cannot read", async () => {
    const { peer } = await connected()
    peer.receive(offer("not a version", 0))
    expect(peer.sentOf("accept")).toEqual([])
  })

  it("is not sent for a delta that does not continue what we hold", async () => {
    const { peer } = await connected()
    peer.receive(offer("theirs:9", 5, "theirs"))
    expect(peer.sentOf("accept")).toEqual([])
    expect(peer.sentOf("interest")).toMatchObject([{ docId: "d" }])
  })
})

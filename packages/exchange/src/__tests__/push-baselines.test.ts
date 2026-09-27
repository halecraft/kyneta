// push-baselines — each push starts from what its peer will hold.
//
// The program keeps, per peer, the version of ours it will hold once what we
// sent arrives (`ourVersionTheyWillHold`). The shell exports once per distinct
// baseline, and compaction, which trims to what peers have acknowledged, never
// passes a baseline, since a baseline moves on send and an acknowledgement
// only follows one.

import { Bridge, createBridgeTransport } from "@kyneta/bridge-transport"
import {
  batch,
  hasSubstrate,
  json,
  Schema,
  SUBSTRATE,
  type Substrate,
  type Version,
} from "@kyneta/schema"
import { describe, expect, it, vi } from "vitest"
import type { Exchange } from "../exchange.js"
import { exchangesPerTest, sleep } from "./exchanges.js"

const TestDoc = json.bind(Schema.struct({ title: Schema.string() }))

const createExchange = exchangesPerTest()

function exchangeOn(bridge: Bridge, id: string): Exchange {
  const exchange = createExchange({
    principal: id,
    transports: [createBridgeTransport({ bridge, transportId: id })],
  })
  return exchange
}

function substrateOf(doc: object): Substrate<Version> {
  if (!hasSubstrate(doc)) throw new Error("expected a root ref")
  return doc[SUBSTRATE]
}

describe("push baselines", () => {
  it("export once for a fan-out whose peers share a baseline", async () => {
    const bridge = new Bridge()
    const writer = exchangeOn(bridge, "writer")
    const readers = ["r1", "r2", "r3"].map(id => exchangeOn(bridge, id))
    const doc = writer.get("doc-1", TestDoc)
    const read = readers.map(reader => reader.get("doc-1", TestDoc))
    batch(doc, d => d.title.set("V1"))
    await sleep(50)
    expect(read.map(r => r.title())).toEqual(["V1", "V1", "V1"])

    const exports = vi.spyOn(substrateOf(doc), "exportSince")
    batch(doc, d => d.title.set("V2"))
    await sleep(50)

    expect(exports).toHaveBeenCalledTimes(1)
    expect(read.map(r => r.title())).toEqual(["V2", "V2", "V2"])
  })

  it("stay servable after compacting to what a peer acknowledged, with pushes in flight", async () => {
    const bridge = new Bridge()
    const writer = exchangeOn(bridge, "writer")
    const reader = exchangeOn(bridge, "reader")
    const doc = writer.get("doc-1", TestDoc)
    const read = reader.get("doc-1", TestDoc)
    batch(doc, d => d.title.set("V1"))
    await sleep(50)
    batch(doc, d => d.title.set("V2"))
    await sleep(50)
    const acknowledged = substrateOf(doc).version()

    // V3 is sent but not yet acknowledged when the writer compacts to what
    // the reader has acknowledged, V2. The reader's baseline is V3.
    batch(doc, d => d.title.set("V3"))
    await writer.compact("doc-1")
    expect(substrateOf(doc).baseVersion().compare(acknowledged)).toBe("equal")
    const wholes = vi.spyOn(substrateOf(doc), "exportEntirety")
    batch(doc, d => d.title.set("V4"))
    await sleep(50)

    expect(wholes).not.toHaveBeenCalled()
    expect(read.title()).toBe("V4")
  })
})

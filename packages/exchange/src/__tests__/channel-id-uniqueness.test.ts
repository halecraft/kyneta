// Peer discovery in a multi-transport mesh.
//
// A single `Synchronizer` can own several transports. Each transport
// maintains its own `ChannelDirectory`, so channelIds issued by
// independent directories would collide — and the session model's
// `Map<ChannelId, ChannelEntry>` would silently overwrite entries,
// dropping peer state. The synchronizer mints ids itself
// (`TransportContext.mintChannelId`) precisely to prevent that.
//
// The topology below is the smallest one where the failure manifests:
// `B` bridges `A` (on bridgeAB) and `C` (on bridgeBC). If channelIds
// collide, `B` discovers only the later-joining peer (`C`) and never
// registers `A` — because `A`'s echo-establish lands on the
// already-completed entry for `C`'s channel.
//
// A 2-peer setup cannot exercise the bug because B has only one
// channel — there is nothing for it to collide with.

import { Bridge, createBridgeTransport } from "@kyneta/bridge-transport"
import { json, Schema } from "@kyneta/schema"
import { describe, expect, it } from "vitest"
import { drain, exchangesPerTest } from "./exchanges.js"

const createExchange = exchangesPerTest()

const Doc = json.bind(Schema.struct({ v: Schema.number() }))

describe("multi-transport peer discovery", () => {
  it("three-peer mesh A ↔ B ↔ C: every peer discovers its neighbors", async () => {
    const bAB = new Bridge()
    const bBC = new Bridge()
    const A = createExchange({
      principal: "alice",
      transports: [createBridgeTransport({ transportId: "a", bridge: bAB })],
      schemas: [Doc],
    })
    const B = createExchange({
      principal: "bob",
      transports: [
        createBridgeTransport({ transportId: "b-ab", bridge: bAB }),
        createBridgeTransport({ transportId: "b-bc", bridge: bBC }),
      ],
      schemas: [Doc],
    })
    const C = createExchange({
      principal: "carol",
      transports: [createBridgeTransport({ transportId: "c", bridge: bBC })],
      schemas: [Doc],
    })

    await drain()

    expect([...A.peers().keys()]).toEqual([B.peerId])
    expect([...B.peers().keys()].sort()).toEqual([A.peerId, C.peerId].sort())
    expect([...C.peers().keys()]).toEqual([B.peerId])
  })
})

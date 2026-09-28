// wrapped-runtime — a standalone Runtime wrapped in an Exchange later
// (`new Exchange(runtime, params)`) gives the documents it already holds the
// same network capabilities as documents created through `exchange.get()`:
// `sync()`, and the peer half of their settle conjunction. Both arrive
// through one hook, `onDocInterpreted`, backfilled like `onDocReady`.

import { Bridge, createBridgeTransport } from "@kyneta/bridge-transport"
import {
  batch,
  json,
  plainReplicaFactory,
  Schema,
  SYNC_AUTHORITATIVE,
} from "@kyneta/schema"
import { describe, expect, it } from "vitest"
import { docStatus } from "../doc-status.js"
import { Exchange } from "../exchange.js"
import { Runtime } from "../runtime.js"
import { settled } from "../settle.js"
import { sync } from "../sync.js"
import { drain, exchangesPerTest } from "./exchanges.js"

const TitleSchema = Schema.struct({ title: Schema.string() })
const TitleDoc = json.bind(TitleSchema)

const createExchange = exchangesPerTest()

describe("a document created before its Runtime is wrapped", () => {
  it("syncs, and settles on what the network says", async () => {
    const bridge = new Bridge()
    const host = createExchange({
      principal: "host",
      transports: [createBridgeTransport({ bridge, transportId: "host" })],
    })
    batch(host.get("doc", TitleDoc), d => d.title.set("hosted"))

    const runtime = new Runtime()
    const doc = runtime.get("doc", TitleDoc)
    const exchange = new Exchange(runtime, {
      principal: "client",
      transports: [createBridgeTransport({ bridge, transportId: "client" })],
      authority: p => p.principal === "host",
    })

    expect(() => sync(doc)).not.toThrow()
    expect(sync(doc).peerId).toBe(exchange.peerId)
    expect(settled(doc)).toBe(false)
    expect(docStatus(doc)).toBe("pending")

    await drain()
    expect(settled(doc)).toBe(true)
    expect(docStatus(doc)).toBe("populated")
    expect(doc.title()).toBe("hosted")
    await exchange.shutdown()
  })
})

describe("onDocInterpreted", () => {
  it("fires once per interpreted document: by backfill, at creation before it is ready, and for a promotion", () => {
    const runtime = new Runtime({ tickInterval: 0 })
    const before = runtime.get("before", TitleDoc)
    runtime.replicate(
      "promoted",
      plainReplicaFactory,
      SYNC_AUTHORITATIVE,
      TitleDoc.schemaHash,
    )

    const events: string[] = []
    runtime.setHooks({
      onDocInterpreted: (docId, ref) => {
        events.push(`interpreted:${docId}`)
        if (docId === "before") expect(ref).toBe(before)
      },
      onDocReady: info => events.push(`ready:${info.docId}`),
    })
    expect(events).toEqual([
      "interpreted:before",
      "ready:before",
      "ready:promoted",
    ])

    events.length = 0
    const after = runtime.get("after", TitleDoc)
    expect(events).toEqual(["interpreted:after", "ready:after"])

    events.length = 0
    const promoted = runtime.get("promoted", TitleDoc)
    expect(events[0]).toBe("interpreted:promoted")
    expect(events.filter(e => e.startsWith("interpreted:"))).toEqual([
      "interpreted:promoted",
    ])
    expect(promoted).not.toBe(after)
    void runtime.shutdown()
  })
})

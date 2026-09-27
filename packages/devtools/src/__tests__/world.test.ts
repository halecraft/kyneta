// world — integration over a two-peer bridge, plus pure retention.

import { Bridge, createBridgeTransport } from "@kyneta/bridge-transport"
import type { ObsEvent } from "@kyneta/exchange"
import { Exchange } from "@kyneta/exchange"
import { loro } from "@kyneta/loro-schema"
import { batch, Schema } from "@kyneta/schema"
import { afterEach, describe, expect, it } from "vitest"
import { attach, createWorldModel } from "../world.js"

const TodoDoc = loro.bind(
  Schema.struct({
    title: Schema.text(),
    items: Schema.list(
      Schema.struct({ text: Schema.string(), done: Schema.boolean() }),
    ),
  }),
)

async function drain(rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>(r => queueMicrotask(r))
    await new Promise<void>(r => setTimeout(r, 0))
  }
}

const active: Exchange[] = []
function peer(id: string, bridge: Bridge): Exchange {
  const ex = new Exchange({
    principal: id,
    transports: [createBridgeTransport({ transportId: id, bridge })],
    schemas: [TodoDoc],
  })
  active.push(ex)
  return ex
}
afterEach(async () => {
  for (const ex of active) {
    try {
      await ex.shutdown()
    } catch {
      /* ignore */
    }
  }
  active.length = 0
})

describe("world model — two peers (merged stream)", () => {
  it("converges peers/documents/syncStates; one entry per peer (dual-identity)", async () => {
    const bridge = new Bridge()
    const alice = peer("alice", bridge)
    const bob = peer("bob", bridge)

    const model = createWorldModel()
    const offA = attach(alice, model)
    const offB = attach(bob, model)

    const aDoc = alice.get("d", TodoDoc)
    bob.get("d", TodoDoc)
    await drain()
    batch(aDoc, (d: { title: { insert: (i: number, s: string) => void } }) =>
      d.title.insert(0, "Hi"),
    )
    await drain()

    // peers: exactly alice + bob, regardless of which stream mentioned whom
    expect(model.peers.has(alice.peerId)).toBe(true)
    expect(model.peers.has(bob.peerId)).toBe(true)
    expect(model.peers.size).toBe(2)
    // documents: "d" is known
    expect(model.documents.has("d")).toBe(true)
    // syncStates: reached `synced` for doc "d"
    const synced = [...model.syncStates.current.values()].filter(
      s => s.docId === "d" && s.state === "synced",
    )
    expect(synced.length).toBeGreaterThanOrEqual(1)

    offA()
    offB()
    model.dispose()
  })
})

describe("world model — retention", () => {
  it("the events collection respects the FIFO cap", () => {
    const model = createWorldModel({ eventCap: 3 })
    for (let i = 0; i < 5; i++) {
      model.ingest({
        v: 1,
        seq: i,
        t: 0,
        peerId: "a",
        layer: "engine",
        kind: "transition",
        program: "sync",
        summary: "x",
      } as ObsEvent)
    }
    expect(model.events.size).toBe(3)
    expect(model.events.has("a:0")).toBe(false) // oldest evicted
    expect(model.events.has("a:1")).toBe(false)
    expect(model.events.has("a:4")).toBe(true) // newest retained
    model.dispose()
  })

  it("the diagnostics collection respects its FIFO cap", () => {
    const model = createWorldModel({ diagnosticCap: 3 })
    for (let i = 0; i < 5; i++) {
      model.ingest({
        v: 1,
        seq: i,
        t: 0,
        peerId: "a",
        layer: "diagnostic",
        kind: "diagnostic",
        severity: "error",
        message: `m${i}`,
      } as ObsEvent)
    }
    expect(model.diagnostics.size).toBe(3)
    expect(model.diagnostics.has("a:0")).toBe(false) // oldest evicted
    expect(model.diagnostics.has("a:1")).toBe(false)
    expect(model.diagnostics.has("a:4")).toBe(true) // newest retained
    model.dispose()
  })
})

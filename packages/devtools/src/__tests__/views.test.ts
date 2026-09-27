// views — Phase 3: cross-peer `docId` groupings + selectors over a two-peer bridge.

import { Bridge, createBridgeTransport } from "@kyneta/bridge-transport"
import { Exchange } from "@kyneta/exchange"
import { loro } from "@kyneta/loro-schema"
import { batch, Schema } from "@kyneta/schema"
import { afterEach, describe, expect, it } from "vitest"
import { docActivity, docView, syncFor, timeline } from "../select.js"
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

describe("views — cross-peer docId grouping", () => {
  it("byDoc gathers a doc's activity from both peers; docView + timeline compose it", async () => {
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

    // byDoc group "d" contains activity emitted by BOTH peers (a shared docId
    // is a correct cross-peer key under any topology).
    const view = docView(model, "d")
    expect(view.docId).toBe("d")
    const peers = new Set(view.activity.map(e => e.peerId))
    expect(peers.has(alice.peerId)).toBe(true)
    expect(peers.has(bob.peerId)).toBe(true)

    // docView also exposes the doc's sync entries.
    expect(view.sync.some(s => s.state === "synced")).toBe(true)

    // docActivity is per-peer ordered (by seq, ascending within a peer).
    const acts = docActivity(model, "d")
    const aliceSeqs = acts
      .filter(e => e.peerId === alice.peerId)
      .map(e => e.seq)
    expect([...aliceSeqs].sort((x, y) => x - y)).toEqual(aliceSeqs)

    // timeline is non-empty and stable per-peer ordered.
    expect(timeline(model).length).toBeGreaterThan(0)

    offA()
    offB()
    model.dispose()
  })

  it("syncFor reads membership from syncByDoc; repeated selector calls are stable", async () => {
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

    // syncByDoc groups the per-peer sync entries under docId "d" (incrementally,
    // via Source.fromReactiveMap over the LWW syncStates map).
    const sync = syncFor(model, "d")
    expect(sync.length).toBeGreaterThanOrEqual(1)
    expect(sync.some(s => s.docId === "d" && s.state === "synced")).toBe(true)

    // Selectors read the index `.current` (never SecondaryIndex.get), so
    // repeated calls return equal results without allocating subscriptions.
    expect(syncFor(model, "d")).toEqual(syncFor(model, "d"))
    expect(docActivity(model, "d")).toEqual(docActivity(model, "d"))

    offA()
    offB()
    model.dispose()
  })
})

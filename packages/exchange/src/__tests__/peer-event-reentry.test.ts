// Subscribers on exchange.peers may mutate docs from inside their
// callbacks. Two failure modes:
//   - Input-phase re-entry — `change(doc, ...)` inside `peer-departed`
//     must propagate to remaining peers (B-direct).
//   - Output-phase re-entry — `exchange.destroy(...)` inside a peer
//     subscriber must fan out a doc-removed event to document-feed
//     subscribers in the same dispatch (tick-induced).
//
// Both used to drop the second-pass work; the outer coordinator's
// drain-to-quiescence is what makes them converge.

import { Bridge, createBridgeTransport } from "@kyneta/bridge-transport"
import { change, json, Schema } from "@kyneta/schema"
import { afterEach, describe, expect, it } from "vitest"
import {
  Exchange,
  type ExchangeParams,
  type PeerIdentityInput,
} from "../exchange.js"

async function drain(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>(r => queueMicrotask(r))
    await new Promise<void>(r => setTimeout(r, 0))
  }
}

const activeExchanges: Exchange[] = []

function createExchange(params: Partial<ExchangeParams> = {}): Exchange {
  const merged = { id: "test" as string | PeerIdentityInput, ...params }
  const ex = new Exchange(merged as ExchangeParams)
  activeExchanges.push(ex)
  return ex
}

afterEach(async () => {
  for (const ex of activeExchanges) {
    try {
      await ex.shutdown()
    } catch {
      // ignore
    }
  }
  activeExchanges.length = 0
})

// A "presence" doc whose `version` field is bumped to signal an update.
const PresenceSchema = Schema.struct({
  version: Schema.number(),
})
const PresenceDoc = json.bind(PresenceSchema)

/**
 * Set up a 3-peer mesh: A ↔ B ↔ C, with B bridging both ends.
 */
function makeMesh() {
  const bridgeAB = new Bridge()
  const bridgeBC = new Bridge()

  const exchangeA = createExchange({
    id: "alice",
    transports: [createBridgeTransport({ transportId: "a", bridge: bridgeAB })],
    departureTimeout: 0,
  })
  const exchangeB = createExchange({
    id: "bob",
    transports: [
      createBridgeTransport({ transportId: "b-ab", bridge: bridgeAB }),
      createBridgeTransport({ transportId: "b-bc", bridge: bridgeBC }),
    ],
    departureTimeout: 0,
  })
  const exchangeC = createExchange({
    id: "carol",
    transports: [createBridgeTransport({ transportId: "c", bridge: bridgeBC })],
    departureTimeout: 0,
  })

  return { exchangeA, exchangeB, exchangeC }
}

describe("peer-event reentry", () => {
  it("baseline: mutation outside any subscriber propagates", async () => {
    const { exchangeA, exchangeB, exchangeC } = makeMesh()

    const docA = exchangeA.get("room", PresenceDoc)
    const docB = exchangeB.get("room", PresenceDoc)
    const docC = exchangeC.get("room", PresenceDoc)

    change(docA, (d: any) => {
      d.version.set(1)
    })
    await drain()
    expect(docB.version()).toBe(1)
    expect(docC.version()).toBe(1)

    // Mutation outside any subscriber — baseline behaviour.
    change(docB, (d: any) => {
      d.version.set(2)
    })
    await drain()

    expect(docA.version()).toBe(2)
    expect(docC.version()).toBe(2)
  })

  it("B-direct: mutation inside peer-departed subscriber propagates to remaining peers (regression)", async () => {
    const { exchangeA, exchangeB, exchangeC } = makeMesh()

    const docA = exchangeA.get("room", PresenceDoc)
    const docB = exchangeB.get("room", PresenceDoc)
    const docC = exchangeC.get("room", PresenceDoc)

    change(docA, (d: any) => {
      d.version.set(1)
    })
    await drain()
    expect(docB.version()).toBe(1)
    expect(docC.version()).toBe(1)

    // B subscribes to its peer feed; on peer-departed, B mutates the
    // shared doc inside the callback. The fix must ensure this
    // mutation propagates to C.
    exchangeB.peers.subscribe(cs => {
      for (const ch of cs.changes) {
        if (ch.type === "peer-departed" && ch.peer.peerId === "alice") {
          change(docB, (d: any) => {
            d.version.set(99)
          })
        }
      }
    })

    // Alice shuts down — triggers peer-departed on B (departureTimeout=0
    // makes the departure immediate via the depart message handshake).
    await exchangeA.shutdown()
    await drain()
    const idx = activeExchanges.indexOf(exchangeA)
    if (idx >= 0) activeExchanges.splice(idx, 1)

    // B saw the departure and bumped version to 99. The change must have
    // propagated to C.
    expect(docB.version()).toBe(99)
    expect(docC.version()).toBe(99)
  })

  it("tick-induced: destroy() inside a peer subscriber fans out doc-removed in the same dispatch", async () => {
    // Defends the outer-coordinator-as-createDispatcher choice: a plain
    // method-style outer that fires `tick` exactly once would deliver
    // peer-events but skip the doc-events tick triggered by the
    // re-entrant destroy() call. The drain-to-quiescence loop is what
    // makes the second tick fire.
    const { exchangeA, exchangeB, exchangeC } = makeMesh()

    exchangeA.get("room", PresenceDoc)
    exchangeB.get("room", PresenceDoc)
    exchangeC.get("room", PresenceDoc)

    await drain()

    const docEvents: { type: string; docId: string }[] = []
    exchangeB.documents.subscribe(cs => {
      for (const ch of cs.changes)
        docEvents.push({ type: ch.type, docId: ch.docId })
    })

    // Inside the peer-departed callback, destroy a doc. The doc-removed
    // event must reach the documents subscriber within the same dispatch
    // that produced peer-departed.
    let destroyCalledFromInsideEmit = false
    exchangeB.peers.subscribe(cs => {
      for (const ch of cs.changes) {
        if (ch.type === "peer-departed" && ch.peer.peerId === "alice") {
          destroyCalledFromInsideEmit = true
          exchangeB.destroy("room")
        }
      }
    })

    await exchangeA.shutdown()
    await drain()
    const idx = activeExchanges.indexOf(exchangeA)
    if (idx >= 0) activeExchanges.splice(idx, 1)

    expect(destroyCalledFromInsideEmit).toBe(true)
    const removed = docEvents.filter(
      e => e.type === "doc-removed" && e.docId === "room",
    )
    expect(removed.length).toBe(1)
    expect(exchangeB.documents.has("room")).toBe(false)
  })

  it("B-microtask: same as B-direct but using queueMicrotask deferral still works", async () => {
    const { exchangeA, exchangeB, exchangeC } = makeMesh()

    const docA = exchangeA.get("room", PresenceDoc)
    const docB = exchangeB.get("room", PresenceDoc)
    const docC = exchangeC.get("room", PresenceDoc)

    change(docA, (d: any) => {
      d.version.set(1)
    })
    await drain()

    exchangeB.peers.subscribe(cs => {
      for (const ch of cs.changes) {
        if (ch.type === "peer-departed" && ch.peer.peerId === "alice") {
          // Deferred — the existing workaround pattern.
          queueMicrotask(() => {
            change(docB, (d: any) => {
              d.version.set(99)
            })
          })
        }
      }
    })

    await exchangeA.shutdown()
    await drain()
    const idx = activeExchanges.indexOf(exchangeA)
    if (idx >= 0) activeExchanges.splice(idx, 1)

    expect(docB.version()).toBe(99)
    expect(docC.version()).toBe(99)
  })
})

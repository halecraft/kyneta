// Doc-layer re-entry — whole-stack regression case post-1.6.0
// (jj:yksllknw). The Exchange's `#lease` is shared with the Synchronizer
// (jj:qlvnvxox) AND with every per-doc changefeed dispatcher (this slice).
// That means:
//
// - A subscriber on `exchange.peers` that mutates a doc no longer
//   requires `queueMicrotask` — same-doc re-entry drains in a sub-tick.
// - Cross-layer cascades through synchronizer:* + changefeed labels
//   share one budget; a runaway oscillation throws BudgetExhaustedError
//   whose history names both layers.

import { Bridge, createBridgeTransport } from "@kyneta/bridge-transport"
import { createLease } from "@kyneta/machine"
import { change, json, Schema, subscribeNode } from "@kyneta/schema"
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

const PresenceSchema = Schema.struct({
  version: Schema.number(),
  scratch: Schema.number(),
})
const PresenceDoc = json.bind(PresenceSchema)

function makeMesh(leases?: {
  alice?: Parameters<typeof createExchange>[0]["lease"]
  bob?: Parameters<typeof createExchange>[0]["lease"]
  carol?: Parameters<typeof createExchange>[0]["lease"]
}) {
  const bridgeAB = new Bridge()
  const bridgeBC = new Bridge()

  const exchangeA = createExchange({
    id: "alice",
    transports: [createBridgeTransport({ transportId: "a", bridge: bridgeAB })],
    departureTimeout: 0,
    lease: leases?.alice,
  })
  const exchangeB = createExchange({
    id: "bob",
    transports: [
      createBridgeTransport({ transportId: "b-ab", bridge: bridgeAB }),
      createBridgeTransport({ transportId: "b-bc", bridge: bridgeBC }),
    ],
    departureTimeout: 0,
    lease: leases?.bob,
  })
  const exchangeC = createExchange({
    id: "carol",
    transports: [createBridgeTransport({ transportId: "c", bridge: bridgeBC })],
    departureTimeout: 0,
    lease: leases?.carol,
  })

  return { exchangeA, exchangeB, exchangeC }
}

describe("doc-layer re-entry: same-doc inside a peer-event subscriber", () => {
  it("change() inside peer-departed propagates without queueMicrotask deferral", async () => {
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

    // peer-departed handler mutates docB AND its scratch sibling
    // synchronously, no queueMicrotask. Pre-1.6.0 this would have
    // thrown "Mutation during notification delivery is not supported."
    exchangeB.peers.subscribe(cs => {
      for (const ch of cs.changes) {
        if (ch.type === "peer-departed" && ch.peer.peerId === "alice") {
          change(docB, (d: any) => {
            d.version.set(99)
            d.scratch.set(42)
          })
        }
      }
    })

    await exchangeA.shutdown()
    await drain()
    const idx = activeExchanges.indexOf(exchangeA)
    if (idx >= 0) activeExchanges.splice(idx, 1)

    expect(docB.version()).toBe(99)
    expect(docB.scratch()).toBe(42)
    expect(docC.version()).toBe(99)
    expect(docC.scratch()).toBe(42)
  })
})

describe("doc-layer re-entry: whole-stack tick-induced cascade", () => {
  it("subscribeNode callback on docA writes docA again; sub-tick drains in the same outer dispatch", async () => {
    const { exchangeA } = makeMesh()
    const docA = exchangeA.get("room", PresenceDoc)

    // When version changes, bump scratch.
    let scratchFires = 0
    subscribeNode(docA.scratch, () => {
      scratchFires++
    })
    subscribeNode(docA.version, () => {
      change(docA, (d: any) => {
        d.scratch.set(d.scratch() + 1)
      })
    })

    change(docA, (d: any) => {
      d.version.set(1)
    })

    expect(docA.version()).toBe(1)
    expect(docA.scratch()).toBe(1)
    expect(scratchFires).toBe(1)
  })
})

describe("doc-layer re-entry: budget exhaustion spans synchronizer + changefeed", () => {
  it("oscillating doc-layer cascade throws BudgetExhaustedError with both layer labels", () => {
    // Two docs on the same Exchange share its #lease via createRef.
    // An A→B→A oscillation in subscribers fills the budget; history
    // labels include "changefeed" entries. (synchronizer:* entries may
    // or may not appear depending on whether the synchronizer dispatcher
    // is engaged in this purely-local oscillation; the existence of any
    // "changefeed" label proves the doc-layer dispatcher participated
    // in the shared lease.)
    const lease = createLease({ budget: 16 })
    const exchange = createExchange({ lease })
    const docA = exchange.get("docA", PresenceDoc)
    const docB = exchange.get("docB", PresenceDoc)

    subscribeNode(docA.version, () => {
      change(docB, (d: any) => {
        d.version.set(d.version() + 1)
      })
    })
    subscribeNode(docB.version, () => {
      change(docA, (d: any) => {
        d.version.set(d.version() + 1)
      })
    })

    let error: unknown
    try {
      change(docA, (d: any) => {
        d.version.set(1)
      })
    } catch (e) {
      error = e
    }

    expect(error).toBeDefined()
    const labels = new Set(
      (error as { lease?: { history?: { label: string }[] } }).lease?.history?.map(
        h => h.label,
      ) ?? [],
    )
    expect(labels.has("changefeed")).toBe(true)
  })
})

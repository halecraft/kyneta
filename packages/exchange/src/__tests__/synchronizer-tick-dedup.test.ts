// The synchronizer's outer coordinator coalesces pending ticks: a burst
// of routes queues at most one tick at a time, since the tick-quiescent
// handlers are idempotent. The coalescing is implemented by a flag that
// must be cleared *before* tick processing dispatches — otherwise a
// subscriber-induced re-entry inside emit-* effects can't queue a fresh
// tick, and the second cascade silently fails to fan out.
//
// `peer-event-reentry.test.ts:148` ("tick-induced: destroy() inside a
// peer subscriber fans out doc-removed in the same dispatch") is the
// cross-program canary for the same invariant; this test pins the
// single-doc subscriber path.

import { change, json, Schema, subscribe } from "@kyneta/schema"
import { afterEach, describe, expect, it } from "vitest"
import {
  Exchange,
  type ExchangeParams,
  type PeerIdentityInput,
} from "../exchange.js"

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

const DocSchema = Schema.struct({ n: Schema.number() })
const Doc = json.bind(DocSchema)

describe("synchronizer outer tick coalescing", () => {
  it("a mid-drain subscriber re-entry still queues a fresh tick", () => {
    // A subscriber that synchronously writes again mid-drain triggers a
    // second flush + emit cycle. If the dedup flag were cleared after
    // the tick-quiescent dispatches rather than before, the second
    // cycle's subscribers would never fire.
    const exchange = createExchange()
    const doc = exchange.get("d", Doc)

    let chainedFired = false
    subscribe(doc.n, () => {
      if (doc.n() < 2) {
        change(doc, (d: any) => {
          d.n.set(2)
        })
      } else {
        chainedFired = true
      }
    })

    change(doc, (d: any) => {
      d.n.set(1)
    })

    expect(chainedFired).toBe(true)
    expect(doc.n()).toBe(2)
  })
})

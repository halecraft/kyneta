// The Exchange threads a Lease through to the Synchronizer; absent
// caller-supplied state, it owns a private lease. Subscriber-driven
// cascade budgets are exercised at the dispatcher unit-test level —
// here we only verify the Exchange-level threading and reset semantics.

import { createLease } from "@kyneta/machine"
import { change, json, Schema } from "@kyneta/schema"
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

const CounterSchema = Schema.struct({ n: Schema.number() })
const CounterDoc = json.bind(CounterSchema)

describe("synchronizer lease", () => {
  it("Exchange uses a private Lease by default; normal operations don't trip the budget", async () => {
    const exchange = createExchange()
    const doc = exchange.get("doc", CounterDoc)

    // Many sequential changes should not trip the default budget of 100k.
    for (let i = 0; i < 100; i++) {
      change(doc, (d: any) => {
        d.n.set(i)
      })
    }
    expect(doc.n()).toBe(99)
  })

  it("Custom lease passed via ExchangeParams.lease is honored", () => {
    const lease = createLease({ budget: 50_000 })
    const exchange = createExchange({ lease })
    const doc = exchange.get("doc", CounterDoc)

    change(doc, (d: any) => {
      d.n.set(7)
    })
    expect(doc.n()).toBe(7)
    // Lease iterations reset to 0 after the owning drain exits.
    expect(lease.iterations).toBe(0)
    expect(lease.depth).toBe(0)
  })

  it("lease iterations reset to 0 after a drain exits", () => {
    // The owning dispatcher (depth 0 → 1 on entry) is responsible for
    // resetting `iterations` on its 1 → 0 exit. If this regresses, the
    // budget keeps accumulating across unrelated dispatches and trips
    // BudgetExhaustedError on long-lived Exchanges.
    const lease = createLease()
    const exchange = createExchange({ lease })
    const doc = exchange.get("doc", CounterDoc)

    change(doc, (d: any) => {
      d.n.set(42)
    })
    expect(lease.iterations).toBe(0)
    expect(lease.depth).toBe(0)
  })
})

// The exchange's auto-subscribe filter discriminates "echo from sync"
// from "local write" via the structural `Changeset.replay` flag, not by
// matching the `origin` label string. These tests pin both halves of
// that discrimination — origin-as-label cannot suppress a broadcast,
// and replay (regardless of origin string) does. Context: jj:qpultxsw.

import { Bridge, createBridgeTransport } from "@kyneta/bridge-transport"
import { change, exportEntirety, json, merge, Schema } from "@kyneta/schema"
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
      /* ignore */
    }
  }
  activeExchanges.length = 0
})

const TestSchema = Schema.struct({
  value: Schema.number(),
})
const TestDoc = json.bind(TestSchema)

function makePair() {
  const bridge = new Bridge()
  const exchangeA = createExchange({
    id: "alice",
    transports: [createBridgeTransport({ transportId: "a", bridge })],
    departureTimeout: 0,
  })
  const exchangeB = createExchange({
    id: "bob",
    transports: [createBridgeTransport({ transportId: "b", bridge })],
    departureTimeout: 0,
  })
  return { exchangeA, exchangeB }
}

describe("exchange origin-echo: structural replay discriminator", () => {
  it("change() with origin 'sync' still broadcasts to peers", async () => {
    const { exchangeA, exchangeB } = makePair()
    const docA = exchangeA.get("doc", TestDoc)
    const docB = exchangeB.get("doc", TestDoc)
    await drain()

    // A user's `change()` is local-in-intent regardless of its origin
    // label; "sync" must not accidentally suppress the broadcast.
    change(docA, (d: any) => d.value.set(42), { origin: "sync" })
    await drain()

    expect(docB.value()).toBe(42)
  })

  it("merge with a non-'sync' origin does not echo back to peers", async () => {
    const { exchangeA, exchangeB } = makePair()
    const docA = exchangeA.get("doc", TestDoc)
    const docB = exchangeB.get("doc", TestDoc)
    await drain()

    // Build a payload from an unrelated source doc and inject it into
    // docA directly (bypassing the wire). The substrate marks the
    // resulting Changeset as a replay; the exchange must skip echoing
    // it back over the wire — regardless of the origin label.
    const sourceEx = createExchange({ id: "source" })
    const sourceDoc = sourceEx.get("source", TestDoc)
    change(sourceDoc, (d: any) => d.value.set(99))
    await drain()
    const payload = exportEntirety(sourceDoc)

    merge(docA, payload, { origin: "from-external-pubsub" })
    await drain()

    expect(docA.value()).toBe(99)
    // No echo: B never saw A's externally-injected state because the
    // replay flag short-circuited A's auto-subscribe filter.
    expect(docB.value()).toBe(0)
  })
})

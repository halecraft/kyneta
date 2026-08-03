// doc-status — the three-state that makes the dangerous state unrepresentable.
//
// The rule is tested twice over: once as a pure truth table (no Exchange, no
// store, no transport), and once at each deployment layer, because the point
// of the design is that the same call works everywhere and reports `"pending"`
// exactly when it genuinely does not know.

import { CHANGEFEED } from "@kyneta/changefeed"
import { json, Schema } from "@kyneta/schema"
import { batch, createDoc } from "@kyneta/schema/basic"
import { describe, expect, it } from "vitest"
import { deriveDocStatus, docStatus, docStatusFeed } from "../doc-status.js"
import { Exchange, type ExchangeParams } from "../exchange.js"
import type { InMemoryStoreData } from "../store/in-memory-store.js"
import { createInMemoryStore, InMemoryStore } from "../store/in-memory-store.js"
import { makeMetaRecord } from "../testing/store-conformance.js"

const TestSchema = Schema.struct({
  title: Schema.string(),
  count: Schema.number(),
})
const TestDoc = json.bind(TestSchema)

function createExchange(options: Partial<ExchangeParams> = {}): Exchange {
  return new Exchange({ id: "test", ...options } as ExchangeParams)
}

async function seedStoredDoc(data: string): Promise<InMemoryStoreData> {
  const sharedData: InMemoryStoreData = {
    records: new Map(),
    metadata: new Map(),
  }
  const backend = new InMemoryStore(sharedData)
  await backend.append("doc-1", makeMetaRecord())
  await backend.append("doc-1", {
    kind: "entry",
    payload: { kind: "entirety" as const, encoding: "json" as const, data },
    version: "1",
  })
  return sharedData
}

// ===========================================================================
// Pure — the whole rule as a truth table
// ===========================================================================

describe("deriveDocStatus", () => {
  it("reports populated whenever there is data, settled or not", () => {
    // Data that has already arrived is not made less real by another source
    // still being in flight. This is the disjunctive half.
    expect(deriveDocStatus({ populated: true, settled: true })).toBe(
      "populated",
    )
    expect(deriveDocStatus({ populated: true, settled: false })).toBe(
      "populated",
    )
  })

  it("reports empty only once everything has reported", () => {
    // The conjunctive half: "empty" is a claim about absence, so it needs
    // every source to have been consulted.
    expect(deriveDocStatus({ populated: false, settled: true })).toBe("empty")
  })

  it("reports pending when a source has not reported", () => {
    // The state that used to be indistinguishable from "empty" — and writing
    // defaults here is the data-loss bug the whole design exists to prevent.
    expect(deriveDocStatus({ populated: false, settled: false })).toBe(
      "pending",
    )
  })
})

// ===========================================================================
// One call, every layer
// ===========================================================================

describe("docStatus — at each layer", () => {
  it("a standalone document is never pending", () => {
    // No store, no network: nothing to await, so the answer is immediate.
    const doc = createDoc(TestSchema)
    expect(docStatus(doc)).toBe("empty")

    batch(doc, d => d.title.set("hello"))
    expect(docStatus(doc)).toBe("populated")
  })

  it("a transportless, storeless Exchange is never pending either", () => {
    const exchange = createExchange()
    const doc = exchange.get("doc-1", TestDoc)

    expect(docStatus(doc)).toBe("empty")

    exchange.reset()
  })

  it("a document with a store is pending until it has loaded", async () => {
    const sharedData = await seedStoredDoc('{"title":"stored","count":42}')
    const exchange = createExchange({
      stores: [createInMemoryStore({ sharedData })],
    })

    const doc = exchange.get("doc-1", TestDoc)

    // The whole point: the store holds data, so this document is NOT empty —
    // but nothing knows that yet, and saying "empty" here would invite an
    // initializer to overwrite it.
    expect(docStatus(doc)).toBe("pending")

    await exchange.flush()

    expect(docStatus(doc)).toBe("populated")
    expect(doc.title()).toBe("stored")

    await exchange.shutdown()
  })

  it("an empty store yields empty, not pending, once it has loaded", async () => {
    const exchange = createExchange({ stores: [createInMemoryStore()] })
    const doc = exchange.get("doc-1", TestDoc)

    expect(docStatus(doc)).toBe("pending")
    await exchange.flush()
    expect(docStatus(doc)).toBe("empty")

    await exchange.shutdown()
  })

  it("never throws, whatever the layer", () => {
    // Totality matters: `sync(doc)` throws for a document with no Exchange
    // behind it, which forces callers to know which layer they are on.
    // `docStatus` deliberately does not.
    expect(() => docStatus(createDoc(TestSchema))).not.toThrow()
    expect(() => docStatus({})).not.toThrow()
    expect(docStatus({})).toBe("empty")
  })
})

// ===========================================================================
// The observable form
// ===========================================================================

describe("docStatusFeed", () => {
  it("reads the same value as docStatus", () => {
    const doc = createDoc(TestSchema)
    expect(docStatusFeed(doc)()).toBe("empty")

    batch(doc, d => d.title.set("hello"))
    expect(docStatusFeed(doc)()).toBe("populated")
  })

  it("fires when data arrives", async () => {
    const doc = createDoc(TestSchema)
    const seen: string[] = []
    const feed = docStatusFeed(doc)
    feed[CHANGEFEED].subscribe(() => seen.push(feed()))

    batch(doc, d => d.title.set("hello"))

    expect(seen).toContain("populated")
  })
})

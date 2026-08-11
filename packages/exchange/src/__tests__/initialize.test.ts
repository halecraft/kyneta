// initialize — seed a document exactly once, and only when it is really empty.
//
// The guards are tested as a pure truth table, because their failure mode is
// silent: a wrong branch does not throw, it writes defaults over data that
// already existed. The integration tests then pin the scenario that motivated
// the whole design — a store holding data that has not finished loading.

import { json, Schema } from "@kyneta/schema"
import { describe, expect, it } from "vitest"
import { docStatus } from "../doc-status.js"
import { Exchange, type ExchangeParams } from "../exchange.js"
import type { Authority } from "../governance.js"
import { initialize, planInitialization } from "../initialize.js"
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
// Pure — every guard, no Exchange
// ===========================================================================

describe("planInitialization", () => {
  const base = {
    waitOutcome: "peer" as const,
    authority: "any" as Authority,
    writerModel: "concurrent" as const,
  }

  it("skips a document that already has data", () => {
    expect(planInitialization({ ...base, status: "populated" })).toEqual({
      action: "skip",
    })
  })

  it("seeds a document that is genuinely empty", () => {
    expect(planInitialization({ ...base, status: "empty" })).toEqual({
      action: "seed",
    })
  })

  // The two rows that carry the whole timeout rule.
  it("seeds when pending only because we chose to stop waiting", () => {
    // `docStatus` still reads "pending" — truthfully, we never heard. Acting
    // anyway is an explicit decision, recorded as `waitOutcome: "offline"`.
    expect(
      planInitialization({
        ...base,
        status: "pending",
        waitOutcome: "offline",
      }),
    ).toEqual({ action: "seed" })
  })

  it("does NOT seed while still pending for any other reason", () => {
    // The original data-loss bug: seeding whenever the status is unknown.
    expect(
      planInitialization({ ...base, status: "pending", waitOutcome: "peer" }),
    ).toEqual({ action: "skip" })
    expect(
      planInitialization({ ...base, status: "pending", waitOutcome: "local" }),
    ).toEqual({ action: "skip" })
  })

  it("refuses a serialized-writer document from a non-authority", () => {
    const result = planInitialization({
      ...base,
      status: "empty",
      writerModel: "serialized",
      authority: "any",
    })
    expect(result.action).toBe("reject")
    // The message has to name the fix, or it just moves the confusion.
    if (result.action === "reject") {
      expect(result.reason).toContain('authority: "self"')
    }
  })

  it("allows the authority to seed a serialized-writer document", () => {
    expect(
      planInitialization({
        ...base,
        status: "empty",
        writerModel: "serialized",
        authority: "self",
      }),
    ).toEqual({ action: "seed" })
  })

  it("skips a populated serialized document rather than rejecting", () => {
    // Nothing to seed means nothing to refuse — no reason to raise an error
    // at a caller who was going to be a no-op anyway.
    expect(
      planInitialization({
        ...base,
        status: "populated",
        writerModel: "serialized",
        authority: "any",
      }),
    ).toEqual({ action: "skip" })
  })
})

// ===========================================================================
// Integration
// ===========================================================================

describe("initialize", () => {
  it("seeds an empty document and reports 'created'", async () => {
    const exchange = createExchange({ authority: "self" })
    const doc = exchange.get("doc-1", TestDoc)

    const outcome = await initialize(doc, (d: never) =>
      (d as { title: { set(v: string): void } }).title.set("Untitled"),
    )

    expect(outcome).toBe("created")
    expect(doc.title()).toBe("Untitled")

    await exchange.shutdown()
  })

  it("does NOT overwrite a store that still has data loading", async () => {
    // The regression that motivates the entire design. Before this layer
    // existed, `populated` read false while hydration was in flight, so a
    // naive `if (!populated) seed()` destroyed the stored document.
    const sharedData = await seedStoredDoc('{"title":"stored","count":42}')
    const exchange = createExchange({
      stores: [createInMemoryStore({ sharedData })],
      authority: "self",
    })

    const doc = exchange.get("doc-1", TestDoc)
    expect(docStatus(doc)).toBe("pending")

    const outcome = await initialize(doc, (d: never) =>
      (d as { title: { set(v: string): void } }).title.set("CLOBBERED"),
    )

    expect(outcome).toBe("loaded")
    expect(doc.title()).toBe("stored")

    await exchange.shutdown()
  })

  it("collapses concurrent calls into a single write", async () => {
    const exchange = createExchange({ authority: "self" })
    const doc = exchange.get("doc-1", TestDoc)

    let writes = 0
    const seed = (d: never) => {
      writes++
      ;(d as { count: { set(v: number): void } }).count.set(1)
    }

    const [a, b, c] = await Promise.all([
      initialize(doc, seed),
      initialize(doc, seed),
      initialize(doc, seed),
    ])

    expect(writes).toBe(1)
    expect([a, b, c]).toEqual(["created", "created", "created"])

    await exchange.shutdown()
  })

  it("refuses to seed a serialized document from a non-authority", async () => {
    // `json.bind` is SYNC_AUTHORITATIVE — serialized writer. A client seeding
    // one is a topology mistake, and the schema binding lets us say so rather
    // than lose a race.
    const exchange = createExchange()
    const doc = exchange.get("doc-1", TestDoc)

    await expect(initialize(doc, () => {})).rejects.toThrow(/serialized-writer/)

    await exchange.shutdown()
  })

  it("resolves without hanging on a transportless daemon", async () => {
    const exchange = createExchange({ authority: "self" })
    const doc = exchange.get("doc-1", TestDoc)

    await expect(initialize(doc, () => {})).resolves.toBe("created")

    await exchange.shutdown()
  })
})

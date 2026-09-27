// initialize — seed a document exactly once, and only when it is really empty.
//
// The guards are tested as a pure truth table, because their failure mode is
// silent: a wrong branch does not throw, it writes defaults over data that
// already existed. The integration tests then pin the scenario that motivated
// the whole design — a store holding data that has not finished loading.

import { Bridge, createBridgeTransport } from "@kyneta/bridge-transport"
import { loro } from "@kyneta/loro-schema"
import { json, Schema } from "@kyneta/schema"
import { describe, expect, it } from "vitest"
import { docStatus } from "../doc-status.js"
import { Exchange, type ExchangeParams } from "../exchange.js"
import type { Authority } from "../governance.js"
import { initialize, planInitialization } from "../initialize.js"
import { createInMemoryStore } from "../store/in-memory-store.js"
import { seedStoredDoc } from "./stored-doc.js"

const TestSchema = Schema.struct({
  title: Schema.string(),
  count: Schema.number(),
})
const TestDoc = json.bind(TestSchema)

// A CRDT document, for the cases where concurrent seeds must be *allowed* to
// merge. `json.bind` is serialized-writer, so `planInitialization` refuses a
// non-authority seed outright and the wait never comes into it.
const MergeableDoc = loro.bind(Schema.struct({ title: Schema.text() }))

function createExchange(options: Partial<ExchangeParams> = {}): Exchange {
  return new Exchange({ id: "test", ...options } as ExchangeParams)
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

    const outcome = await initialize(doc, d => d.title.set("Untitled"))

    expect(outcome).toBe("created")
    expect(doc.title()).toBe("Untitled")

    await exchange.shutdown()
  })

  it("does NOT overwrite a store that still has data loading", async () => {
    // The regression that motivates the entire design. Before this layer
    // existed, `populated` read false while hydration was in flight, so a
    // naive `if (!populated) seed()` destroyed the stored document.
    const sharedData = await seedStoredDoc({ title: "stored", count: 42 })
    const exchange = createExchange({
      store: createInMemoryStore({ sharedData }),
      authority: "self",
    })

    const doc = exchange.get("doc-1", TestDoc)
    expect(docStatus(doc)).toBe("pending")

    const outcome = await initialize(doc, d => d.title.set("CLOBBERED"))

    expect(outcome).toBe("loaded")
    expect(doc.title()).toBe("stored")

    await exchange.shutdown()
  })

  it("collapses concurrent calls into a single write", async () => {
    const exchange = createExchange({ authority: "self" })
    const doc = exchange.get("doc-1", TestDoc)

    let writes = 0
    // Named rather than inline so all three calls share one identity, which is
    // what the collapse is keyed on. `typeof doc` is needed because a standalone
    // callback has no call site to infer the draft from.
    const seed = (d: typeof doc) => {
      writes++
      d.count.set(1)
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

  it("infers the draft type from the document", async () => {
    // A type-level regression test, not a behavioural one. `initialize` binds
    // its type parameter to `doc` so the draft infers; if someone widens `doc`
    // back to `object`, the draft silently becomes `unknown` and NOTHING in
    // this package fails — the damage lands on callers. This assertion is the
    // only thing standing between that regression and a release.
    const exchange = createExchange({ authority: "self" })
    const doc = exchange.get("doc-1", TestDoc)

    await initialize(doc, d => {
      // Reached only if `d` is the document type. Were it `unknown`, these
      // property accesses would not compile.
      d.title.set("typed")
      d.count.set(7)
    })

    expect(doc.title()).toBe("typed")
    expect(doc.count()).toBe(7)

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

  it("an authoritative server with a transport seeds without waiting for a client", async () => {
    // The transport is the whole point. A server that serves clients has one
    // configured, and until this was fixed that alone was enough to make
    // `initialize` wait — forever, for a client that had nothing to say.
    // Every `authority: "self"` test above is transportless, which is exactly
    // why the bug survived a release.
    const bridge = new Bridge()
    const exchange = createExchange({
      id: "server",
      transports: [createBridgeTransport({ transportId: "server", bridge })],
      authority: "self",
    })
    const doc = exchange.get("doc-1", TestDoc)

    const outcome = await Promise.race([
      initialize(doc, d => d.set({ title: "Untitled", count: 0 })),
      new Promise(r => setTimeout(() => r("hung"), 200)),
    ])

    expect(outcome).toBe("created")
    expect(doc.title()).toBe("Untitled")

    await exchange.shutdown()
  })

  it("does not decide on a non-authority peer's reply", async () => {
    // Two empty clients, both naming an absent server as the authority. The
    // failure this prevents is quiet: `initialize` returning "loaded" — "the
    // document already had data" — on the word of a peer just as empty as we
    // are. A mergeable document, because the serialized-writer guard would
    // otherwise refuse the seed before the wait is ever reached.
    const bridge = new Bridge()
    const isServer = (p: { peerId: string }) => p.peerId === "server"
    const clientA = createExchange({
      id: "client-a",
      transports: [createBridgeTransport({ transportId: "client-a", bridge })],
      authority: isServer,
    })
    const clientB = createExchange({
      id: "client-b",
      transports: [createBridgeTransport({ transportId: "client-b", bridge })],
      authority: isServer,
    })

    const docA = clientA.get("doc-1", MergeableDoc)
    clientB.get("doc-1", MergeableDoc)
    for (let i = 0; i < 30; i++) await new Promise(r => setTimeout(r, 0))

    // client-b has reconciled; the authority has not spoken.
    expect(docStatus(docA)).toBe("pending")
    expect(
      await Promise.race([
        initialize(docA, d => d.title.insert(0, "Untitled")),
        new Promise(r => setTimeout(() => r("waiting"), 100)),
      ]),
    ).toBe("waiting")

    await clientA.shutdown()
    await clientB.shutdown()
  })

  it("seeds under the offline escape once the authority is given up on", async () => {
    // The offline-first path. `offlineAfter` says "act on local evidence" —
    // a decision made visibly at the call site, which is why `docStatus`
    // keeps reporting "pending" rather than pretending to have learned the
    // document is empty.
    const bridge = new Bridge()
    const client = createExchange({
      id: "client-a",
      transports: [createBridgeTransport({ transportId: "client-a", bridge })],
      authority: (p: { peerId: string }) => p.peerId === "server",
    })
    const doc = client.get("doc-1", MergeableDoc)

    await expect(
      initialize(doc, d => d.title.insert(0, "Untitled"), { offlineAfter: 20 }),
    ).resolves.toBe("created")
    expect(doc.title()).toBe("Untitled")

    await client.shutdown()
  })
})

// settle — the conjunction over a document's truth sources.
//
// The rule under test: a document is settled when every attached term is true,
// and a document with no terms at all is settled immediately. That second case
// is the one that makes a plain in-memory document and a transportless daemon
// behave the same way, so it is asserted directly rather than inferred.

import { CHANGEFEED } from "@kyneta/changefeed"
import { json, Schema } from "@kyneta/schema"
import { describe, expect, it } from "vitest"
import { Exchange, type ExchangeParams } from "../exchange.js"
import {
  hydrated,
  hydratedFeed,
  makeSettleTerm,
  registerSettleTerm,
  settled,
  settledFeed,
} from "../settle.js"
import type { InMemoryStoreData } from "../store/in-memory-store.js"
import { createInMemoryStore, InMemoryStore } from "../store/in-memory-store.js"
import type { Store } from "../store/store.js"
import { sync, whenSettled } from "../sync.js"
import { makeMetaRecord } from "../testing/store-conformance.js"

const TestDoc = json.bind(
  Schema.struct({ title: Schema.string(), count: Schema.number() }),
)

function createExchange(options: Partial<ExchangeParams> = {}): Exchange {
  return new Exchange({ id: "test", ...options } as ExchangeParams)
}

/** A term whose value the test drives by hand. */
function controllableTerm() {
  let value = false
  const listeners = new Set<() => void>()
  const term = makeSettleTerm(
    () => value,
    onChange => {
      listeners.add(onChange)
      return () => listeners.delete(onChange)
    },
  )
  return {
    term,
    flip() {
      value = true
      for (const l of listeners) l()
    },
  }
}

/** Append a meta record + a JSON entirety entry for `doc-1`. */
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
// The conjunction
// ===========================================================================

describe("settle — the conjunction", () => {
  it("is true with no terms attached (the empty conjunction)", () => {
    // Nothing to wait for, so the honest answer is "settled". This is what
    // makes a standalone document and a transportless daemon agree.
    expect(settled({})).toBe(true)
  })

  it("is true only when every attached term is true", () => {
    const ref = {}
    const a = controllableTerm()
    const b = controllableTerm()
    registerSettleTerm(ref, a.term)
    registerSettleTerm(ref, b.term)

    expect(settled(ref)).toBe(false)
    a.flip()
    expect(settled(ref)).toBe(false)
    b.flip()
    expect(settled(ref)).toBe(true)
  })

  it("notifies subscribers when any single term moves", () => {
    const ref = {}
    const a = controllableTerm()
    const b = controllableTerm()
    registerSettleTerm(ref, a.term)
    registerSettleTerm(ref, b.term)

    let fired = 0
    // A term carries the protocol under `[CHANGEFEED]`; it does not promise a
    // top-level `.subscribe` (that is `Changefeed`, the richer type).
    settledFeed(ref)[CHANGEFEED].subscribe(() => {
      fired++
    })

    a.flip()
    expect(fired).toBe(1)
    b.flip()
    expect(fired).toBe(2)
  })

  it("returns an actual boolean, not a callable", () => {
    // The whole point of the short name is that it is safe in an `if`. The
    // carrier (`settledFeed`) is a function and therefore always truthy, which
    // is the trap this naming exists to avoid.
    expect(typeof settled({})).toBe("boolean")
    expect(typeof settledFeed({})).toBe("function")
  })
})

// ===========================================================================
// The storage term
// ===========================================================================

describe("settle — the storage term", () => {
  it("is true immediately when no stores are configured", () => {
    const exchange = createExchange()
    const doc = exchange.get("doc-1", TestDoc)

    expect(hydrated(doc)).toBe(true)
    expect(settled(doc)).toBe(true)

    exchange.reset()
  })

  it("is false until hydration completes, then true", async () => {
    const sharedData = await seedStoredDoc('{"title":"stored","count":42}')
    const exchange = createExchange({
      stores: [createInMemoryStore({ sharedData })],
    })

    const doc = exchange.get("doc-1", TestDoc)
    expect(hydrated(doc)).toBe(false)
    expect(settled(doc)).toBe(false)

    await exchange.flush()

    expect(hydrated(doc)).toBe(true)
    expect(settled(doc)).toBe(true)

    await exchange.shutdown()
  })

  it("returns an actual boolean, not a callable", () => {
    const exchange = createExchange()
    const doc = exchange.get("doc-1", TestDoc)

    expect(typeof hydrated(doc)).toBe("boolean")
    expect(typeof hydratedFeed(doc)).toBe("function")

    exchange.reset()
  })

  it("stays false when the store read fails", async () => {
    // A failed load is not an empty document. Reporting it as loaded would
    // invite an initializer to write defaults over data we could not read —
    // the exact failure this layer exists to prevent. So the term stays false
    // and the document stays un-settled.
    const failing: Store = {
      async append() {},
      // biome-ignore lint/correctness/useYield: the point is that it throws
      async *loadAll() {
        throw new Error("disk on fire")
      },
      async replace() {},
      async delete() {},
      async currentMeta() {
        // Hydration reads metadata first; throwing here is the simplest
        // faithful "the store read failed" — the same shape as a dropped
        // connection or a corrupt file.
        throw new Error("disk on fire")
      },
      // biome-ignore lint/correctness/useYield: an empty store lists nothing
      async *listDocIds() {},
      async close() {},
    }
    const exchange = createExchange({ stores: [failing] })

    const doc = exchange.get("doc-1", TestDoc)
    await exchange.flush().catch(() => {})

    expect(hydrated(doc)).toBe(false)
    expect(settled(doc)).toBe(false)

    exchange.reset()
  })

  it("survives suspend/resume without regressing", async () => {
    // The sync latch deliberately survives suspend; the storage term must
    // match. If it regressed to "loading", a resumed document would look
    // un-settled and a naive initializer could seed over it.
    const sharedData = await seedStoredDoc('{"title":"stored","count":1}')
    const exchange = createExchange({
      stores: [createInMemoryStore({ sharedData })],
    })

    const doc = exchange.get("doc-1", TestDoc)
    await exchange.flush()
    expect(hydrated(doc)).toBe(true)

    exchange.suspend("doc-1")
    expect(hydrated(doc)).toBe(true)

    exchange.resume("doc-1")
    expect(hydrated(doc)).toBe(true)

    await exchange.shutdown()
  })
})

// ===========================================================================
// `ready` on a transportless exchange
// ===========================================================================

describe("ready — transportless", () => {
  it("is true with no transports; readyFor stays strict", () => {
    // No transport means no peer can ever answer, so `ready` reports true
    // rather than waiting forever. `readyFor` asks a narrower question — did
    // *this* peer answer? — and the honest answer there is still no.
    const exchange = createExchange()
    const doc = exchange.get("doc-1", TestDoc)

    expect(sync(doc).ready).toBe(true)
    expect(sync(doc).readyFor(() => true)).toBe(false)

    exchange.reset()
  })
})

// ===========================================================================
// whenSettled — the layered wait
// ===========================================================================

describe("whenSettled", () => {
  it("resolves via 'local' when there is nothing upstream", async () => {
    const exchange = createExchange()
    const doc = exchange.get("doc-1", TestDoc)

    await expect(whenSettled(doc)).resolves.toEqual({ via: "local" })

    exchange.reset()
  })

  it("waits for hydration before reporting settled", async () => {
    const sharedData = await seedStoredDoc('{"title":"stored","count":7}')
    const exchange = createExchange({
      stores: [createInMemoryStore({ sharedData })],
    })

    const doc = exchange.get("doc-1", TestDoc)

    let done = false
    const wait = whenSettled(doc).then(r => {
      done = true
      return r
    })

    // Still loading, so the wait must not have resolved yet.
    expect(done).toBe(false)

    await expect(wait).resolves.toEqual({ via: "local" })
    expect(doc.title()).toBe("stored")

    await exchange.shutdown()
  })

  it("rejects with the store error when the load fails", async () => {
    // A failed read is a fault to surface, not a state to proceed from. The
    // alternative — resolving as though the document were empty — is how
    // defaults get written over data we could not read.
    const failing: Store = {
      async append() {},
      // biome-ignore lint/correctness/useYield: the point is that it throws
      async *loadAll() {
        throw new Error("disk on fire")
      },
      async replace() {},
      async delete() {},
      async currentMeta(): Promise<never> {
        throw new Error("disk on fire")
      },
      // biome-ignore lint/correctness/useYield: an empty store lists nothing
      async *listDocIds() {},
      async close() {},
    }
    const exchange = createExchange({ stores: [failing] })
    const doc = exchange.get("doc-1", TestDoc)

    await expect(whenSettled(doc)).rejects.toThrow("disk on fire")

    exchange.reset()
  })

  it("does not let offlineAfter rescue a stuck hydration", async () => {
    // The timeout is for peers, never for storage. A missing peer may truly
    // never arrive, so giving up is the only option; a slow disk is a local
    // fault, and giving up on it would mean proceeding as though the document
    // were empty. This test is what stops the two waits being "simplified"
    // into one timeout later.
    const stuck: Store = {
      async append() {},
      // biome-ignore lint/correctness/useYield: never reached
      async *loadAll() {},
      async replace() {},
      async delete() {},
      currentMeta() {
        return new Promise(() => {}) // never settles
      },
      // biome-ignore lint/correctness/useYield: an empty store lists nothing
      async *listDocIds() {},
      async close() {},
    }
    const exchange = createExchange({ stores: [stuck] })
    const doc = exchange.get("doc-1", TestDoc)

    const raced = await Promise.race([
      whenSettled(doc, { offlineAfter: 20 }).then(() => "settled"),
      new Promise(resolve => setTimeout(() => resolve("still waiting"), 60)),
    ])

    expect(raced).toBe("still waiting")
    expect(settled(doc)).toBe(false)

    exchange.reset()
  })
})

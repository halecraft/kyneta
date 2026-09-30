// exchange-open — `open` gives a document this exchange holds, and never
// creates one.

import { Bridge, createBridgeTransport } from "@kyneta/bridge-transport"
import { loro } from "@kyneta/loro-schema"
import { Defer, Schema } from "@kyneta/schema"
import { describe, expect, it } from "vitest"
import type { Exchange } from "../exchange.js"
import { whenPersisted } from "../persistence.js"
import { whenHydrated } from "../settle.js"
import {
  createInMemoryStore,
  createInMemoryStoreData,
  type InMemoryStoreData,
} from "../store/in-memory-store.js"
import type { DocChange } from "../types.js"
import { drain, exchangesPerTest } from "./exchanges.js"
import { gated, wrapStore } from "./wrap-store.js"

const Doc = loro.bind(Schema.struct({ title: Schema.text() }))

const createExchange = exchangesPerTest()

const over = (data: InMemoryStoreData) =>
  createExchange({ store: createInMemoryStore({ sharedData: data }) })

/** `data` holding "doc" with `title`, written by an exchange now shut down. */
async function storedDoc(title: string): Promise<InMemoryStoreData> {
  const data = createInMemoryStoreData()
  const writer = over(data)
  const doc: any = writer.get("doc", Doc)
  await whenHydrated(doc)
  doc.title.insert(0, title)
  await whenPersisted(doc)
  await writer.shutdown()
  createExchange.forget(writer)
  return data
}

function changesOf(exchange: Exchange): DocChange[] {
  const changes: DocChange[] = []
  exchange.documents.subscribe(changeset => {
    changes.push(...changeset.changes)
  })
  return changes
}

describe("exchange.open", () => {
  it("gives an open document", async () => {
    const exchange = createExchange()
    const doc = exchange.get("doc", Doc)
    expect(await exchange.open("doc", Doc)).toBe(doc)
  })

  it("gives a stored document that is not open, as stored", async () => {
    const data = await storedDoc("kept")
    const doc: any = await over(data).open("doc", Doc)
    expect(doc?.title()).toBe("kept")
  })

  it("creates, writes and announces nothing for a document it does not hold", async () => {
    const data = createInMemoryStoreData()
    const exchange = over(data)
    const changes = changesOf(exchange)
    expect(await exchange.open("doc", Doc)).toBeUndefined()
    await exchange.flush()
    expect(exchange.has("doc")).toBe(false)
    expect(changes).toEqual([])
    expect(
      await createInMemoryStore({ sharedData: data }).currentMeta("doc"),
    ).toBeNull()
  })

  it("holds nothing without a store but what is open", async () => {
    const exchange = createExchange()
    expect(await exchange.open("doc", Doc)).toBeUndefined()
    expect(exchange.has("doc")).toBe(false)
  })

  it("does not hold a document destroyed here, while its delete is in flight", async () => {
    const data = await storedDoc("gone")
    const gate = gated(createInMemoryStore({ sharedData: data }), "delete")
    const exchange = createExchange({ store: gate.store })
    await whenHydrated(exchange.get("doc", Doc))
    gate.hold()
    exchange.destroy("doc")
    const opened = exchange.open("doc", Doc)
    await drain()
    gate.release()
    expect(await opened).toBeUndefined()
    expect(exchange.has("doc")).toBe(false)
  })

  it("does not hold a document destroyed while it loads", async () => {
    const data = await storedDoc("gone")
    const exchange = over(data)
    const opened = exchange.open("doc", Doc)
    exchange.destroy("doc")
    expect(await opened).toBeUndefined()
    await exchange.flush()
    expect(exchange.has("doc")).toBe(false)
  })

  it("does not hold a document another exchange over the same store destroyed", async () => {
    const data = await storedDoc("gone")
    const other = over(data)
    await whenHydrated(other.get("doc", Doc))
    other.destroy("doc")
    await other.flush()
    expect(await over(data).open("doc", Doc)).toBeUndefined()
  })

  it("two opens of a document it does not hold both resolve undefined", async () => {
    const exchange = over(createInMemoryStoreData())
    const first = exchange.open("doc", Doc)
    // The second starts once the first's entry is loading.
    await Promise.resolve()
    await Promise.resolve()
    const second = exchange.open("doc", Doc)
    const [a, b] = await Promise.all([first, second])
    expect(a).toBeUndefined()
    expect(b).toBeUndefined()
    expect(exchange.has("doc")).toBe(false)
  })

  it("keeps a document a get asked for while it loaded", async () => {
    const exchange = over(createInMemoryStoreData())
    const opened = exchange.open("doc", Doc)
    const doc = exchange.get("doc", Doc)
    expect(await opened).toBe(doc)
    expect(exchange.has("doc")).toBe(true)
  })

  it("rejects when the store cannot be read", async () => {
    const inner = createInMemoryStore()
    const exchange = createExchange({
      store: wrapStore(inner, {
        currentMeta: () => Promise.reject(new Error("read failed")),
      }),
    })
    await expect(exchange.open("doc", Doc)).rejects.toThrow("read failed")
  })

  describe("a deferred document", () => {
    /** `client` over `data`, with the peer having presented "doc", which
     *  the client defers. */
    async function deferredBy(data: InMemoryStoreData) {
      const bridge = new Bridge()
      const peer = createExchange({
        principal: "peer",
        transports: [createBridgeTransport({ transportId: "peer", bridge })],
      })
      const doc: any = peer.get("doc", Doc)
      doc.title.insert(0, "remote")
      const client = createExchange({
        principal: "client",
        store: createInMemoryStore({ sharedData: data }),
        resolve: () => Defer(),
        transports: [createBridgeTransport({ transportId: "client", bridge })],
      })
      await drain()
      expect(client.deferred.has("doc")).toBe(true)
      return client
    }

    it("opens when the store holds it", async () => {
      const client = await deferredBy(await storedDoc("kept"))
      const doc: any = await client.open("doc", Doc)
      expect(doc?.title()).toContain("kept")
    })

    it("stays deferred when the store does not", async () => {
      const client = await deferredBy(createInMemoryStoreData())
      expect(await client.open("doc", Doc)).toBeUndefined()
      expect(client.deferred.has("doc")).toBe(true)
      expect(client.documents.get("doc")?.mode).toBe("deferred")
    })
  })
})

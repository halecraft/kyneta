// store-order — a document's store calls around a destroy run in the order
// they were made: the delete after a write already sent, a load after the
// delete, and a shutdown after both.

import { loro } from "@kyneta/loro-schema"
import { Schema } from "@kyneta/schema"
import { describe, expect, it } from "vitest"
import type { Exchange } from "../exchange.js"
import { whenPersisted } from "../persistence.js"
import { whenHydrated } from "../settle.js"
import {
  createInMemoryStore,
  createInMemoryStoreData,
  type InMemoryStoreData,
} from "../store/in-memory-store.js"
import { drain, exchangesPerTest } from "./exchanges.js"
import { gated, type Holdable } from "./wrap-store.js"

const Doc = loro.bind(Schema.struct({ title: Schema.text() }))

const createExchange = exchangesPerTest()

/** An in-memory store over `data` whose `method` calls can be held. */
const holding = (data: InMemoryStoreData, method: Holdable) =>
  gated(createInMemoryStore({ sharedData: data }), method)

async function stored(data: InMemoryStoreData, docId: string) {
  return createInMemoryStore({ sharedData: data }).currentMeta(docId)
}

async function written(exchange: Exchange, text: string): Promise<void> {
  const doc: any = exchange.get("doc", Doc)
  await whenHydrated(doc)
  doc.title.insert(0, text)
  await whenPersisted(doc)
}

describe("a document's store calls around a destroy", () => {
  it("a write already sent lands before the delete, so nothing is stored", async () => {
    const data = createInMemoryStoreData()
    const { store, hold, release } = holding(data, "compact")
    const exchange = createExchange({ store })
    hold()
    const doc: any = exchange.get("doc", Doc)
    await whenHydrated(doc)
    doc.title.insert(0, "gone")
    await drain()
    exchange.destroy("doc")
    release()
    await exchange.flush()
    expect(await stored(data, "doc")).toBeNull()
  })

  it("a get after a destroy is a fresh document, while the delete is in flight", async () => {
    const data = createInMemoryStoreData()
    const { store, hold, release } = holding(data, "delete")
    const exchange = createExchange({ store })
    await written(exchange, "old")
    hold()
    exchange.destroy("doc")
    const again: any = exchange.get("doc", Doc)
    await drain()
    release()
    await whenHydrated(again)
    expect(again.title()).toBe("")
  })

  it("shutdown waits for the delete", async () => {
    const data = createInMemoryStoreData()
    const { store, hold, release } = holding(data, "delete")
    const exchange = createExchange({ store })
    await written(exchange, "old")
    hold()
    exchange.destroy("doc")
    let done = false
    const shutdown = exchange.shutdown().then(() => {
      done = true
    })
    createExchange.forget(exchange)
    await drain()
    expect(done).toBe(false)
    release()
    await shutdown
    expect(await stored(data, "doc")).toBeNull()
  })
})

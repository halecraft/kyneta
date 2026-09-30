// compact — Exchange.compact() and Runtime.compact() for every document.
//
// Compaction trims a document's history in memory as far as its replica can
// and every peer allows, and replaces what the store holds with the whole
// document. A live Yjs or Loro document trims nothing in memory, since it
// cannot swap the native document its callers hold, and used to throw for
// it; its storage is compacted all the same. The trim point is the least
// common version, met with our own, so it is always one the replica can
// place, even during a first contact.

import { Bridge, createBridgeTransport } from "@kyneta/bridge-transport"
import { loro } from "@kyneta/loro-schema"
import { type BoundSchema, batch, json, Schema } from "@kyneta/schema"
import { yjs } from "@kyneta/yjs-schema"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Exchange } from "../exchange.js"
import { writeRefusal } from "../persistence.js"
import { Runtime } from "../runtime.js"
import { whenHydrated } from "../settle.js"
import {
  createInMemoryStoreData,
  InMemoryStore,
  type InMemoryStoreData,
  recordsOf,
} from "../store/in-memory-store.js"
import { WriterRefusedError } from "../store/seats.js"
import { drain, exchangesPerTest } from "./exchanges.js"
import { gated } from "./wrap-store.js"

const LogSchema = Schema.struct({ log: Schema.text() })
type LogDoc = {
  readonly log: { (): string; insert(index: number, text: string): void }
}

const BACKENDS: readonly (readonly [string, BoundSchema<typeof LogSchema>])[] =
  [
    ["yjs", yjs.bind(LogSchema)],
    ["loro", loro.bind(LogSchema)],
    ["plain", json.bind(LogSchema)],
  ]

const createExchange = exchangesPerTest()

function append(doc: LogDoc, text: string): void {
  batch(doc as never, (d: any) => d.log.insert(d.log().length, text))
}

/** The record kinds a storage holds for `docId`. */
function kinds(storage: InMemoryStoreData, docId = "doc"): string[] {
  return recordsOf(storage, docId).map(record => record.kind)
}

describe.each(BACKENDS)("compaction (%s)", (_name, bound) => {
  function open(
    principal: string,
    bridge: Bridge,
    storage?: InMemoryStoreData,
  ): Exchange {
    return createExchange({
      principal,
      transports: [createBridgeTransport({ bridge, transportId: principal })],
      ...(storage ? { store: new InMemoryStore(storage) } : {}),
    })
  }

  it("stores the whole document once, reloads it, and syncs on incrementally", async () => {
    const bridge = new Bridge()
    const storage = createInMemoryStoreData()
    const writer = open("writer", bridge, storage)
    const peer = open("peer", bridge)
    const doc = writer.get("doc", bound) as unknown as LogDoc
    const seen = peer.get("doc", bound) as unknown as LogDoc
    await whenHydrated(doc as never)
    append(doc, "one")
    await drain()
    append(doc, "two")
    await writer.flush()
    await drain()
    expect(seen.log()).toBe("onetwo")
    expect(kinds(storage).length).toBeGreaterThan(2)

    await writer.compact("doc")
    expect(kinds(storage)).toEqual(["meta", "entry"])

    // A further write reaches the peer as a delta, not the whole document.
    const replica = writer.synchronizer.getDoc("doc")?.replica
    if (replica === undefined) throw new Error("expected the document")
    const entirety = vi.spyOn(replica, "exportEntirety")
    append(doc, "three")
    await writer.flush()
    await drain()
    expect(seen.log()).toBe("onetwothree")
    expect(entirety).not.toHaveBeenCalled()

    await writer.shutdown()
    const reloaded = open("reloaded", new Bridge(), storage)
    const again = reloaded.get("doc", bound) as unknown as LogDoc
    await whenHydrated(again as never)
    expect(again.log()).toBe("onetwothree")
  })

  it("never trims past our own version during a first contact, and compacts there", async () => {
    // A peer with writes of its own connects. Its first interest records its
    // whole version as what it holds of ours, ahead of or concurrent with
    // ours until its accept arrives.
    const bridge = new Bridge()
    const storage = createInMemoryStoreData()
    const host = open("host", bridge, storage)
    const doc = host.get("doc", bound) as unknown as LogDoc
    await whenHydrated(doc as never)
    append(doc, "host")
    await host.flush()

    const peer = createExchange({ principal: "peer" })
    append(peer.get("doc", bound) as unknown as LogDoc, "peer")
    const connecting = peer.addTransport(
      createBridgeTransport({ bridge, transportId: "peer" }),
    )

    // The window is a few microtasks wide, so sample after every one, and
    // start compactions without awaiting them, which would move the timing.
    const orders = new Set<string>()
    const compactions: Promise<unknown>[] = []
    for (let i = 0; i < 400; i++) {
      await new Promise<void>(resolve => queueMicrotask(resolve))
      const lcv = host.leastCommonVersion("doc")
      const ours = host.synchronizer.getDoc("doc")?.replica.version()
      if (lcv !== null && ours !== undefined) {
        orders.add(lcv.compare(ours))
        compactions.push(
          host.compact("doc").then(
            () => undefined,
            e => e,
          ),
        )
      }
      if (i % 50 === 49) await new Promise(resolve => setTimeout(resolve, 0))
    }
    await connecting
    const failures = (await Promise.all(compactions)).filter(
      outcome => outcome !== undefined,
    )
    expect(orders.size).toBeGreaterThan(0)
    expect(orders.has("ahead")).toBe(false)
    expect(orders.has("concurrent")).toBe(false)
    expect(failures).toEqual([])
  })
})

describe("compaction and the writer rule", () => {
  const Plain = json.bind(LogSchema)

  it("a refused reader compacts without claiming, and loses nothing of the writer's", async () => {
    const storage = createInMemoryStoreData()
    const writerRuntime = new Runtime({ store: new InMemoryStore(storage) })
    const readerRuntime = new Runtime({ store: new InMemoryStore(storage) })
    const written = writerRuntime.get("doc", Plain) as unknown as LogDoc
    await whenHydrated(written as never)
    append(written, "one")
    await writerRuntime.flush()

    const read = readerRuntime.get("doc", Plain) as unknown as LogDoc
    await whenHydrated(read as never)
    expect(writeRefusal(read as never)).toBeInstanceOf(WriterRefusedError)
    append(written, "two")
    await writerRuntime.flush()

    await readerRuntime.compact("doc")
    const store = new InMemoryStore(storage)
    expect(await store.writerOf("doc")).toBe(writerRuntime.peerId)
    await store.close()

    append(written, "three")
    await writerRuntime.flush()
    expect(writeRefusal(written as never)).toBeUndefined()

    await readerRuntime.shutdown()
    await writerRuntime.shutdown()
    const third = new Runtime({ store: new InMemoryStore(storage) })
    const loaded = third.get("doc", Plain) as unknown as LogDoc
    await whenHydrated(loaded as never)
    expect(loaded.log()).toBe("onetwothree")
    await third.shutdown()
  })
})

describe("compaction with an own write unconfirmed", () => {
  it.each(
    BACKENDS,
  )("sends nothing while the write is held, across the compaction, and then the write (%s)", async (_name, bound) => {
    const bridge = new Bridge()
    const storage = createInMemoryStoreData()
    const gate = gated(new InMemoryStore(storage), "append")
    const writer = createExchange({
      principal: "writer",
      transports: [createBridgeTransport({ bridge, transportId: "writer" })],
      store: gate.store,
    })
    const peer = createExchange({
      principal: "peer",
      transports: [createBridgeTransport({ bridge, transportId: "peer" })],
    })
    const doc = writer.get("doc", bound) as unknown as LogDoc
    const seen = peer.get("doc", bound) as unknown as LogDoc
    await whenHydrated(doc as never)
    append(doc, "one")
    await writer.flush()
    await drain()
    expect(seen.log()).toBe("one")

    gate.hold()
    append(doc, "two")
    await drain()
    const compaction = writer.compact("doc")
    await drain()
    expect(seen.log()).toBe("one")

    gate.release()
    await compaction
    await writer.flush()
    await drain()
    expect(seen.log()).toBe("onetwo")
    expect(kinds(storage)).toEqual(["meta", "entry"])
  })
})

describe("a standalone Runtime compacts", () => {
  const Plain = json.bind(LogSchema)
  const runtimes: Runtime[] = []
  afterEach(async () => {
    for (const runtime of runtimes.splice(0)) await runtime.shutdown()
  })

  it("trims fully and stores the whole document once", async () => {
    const storage = createInMemoryStoreData()
    const runtime = new Runtime({ store: new InMemoryStore(storage) })
    runtimes.push(runtime)
    const doc = runtime.get("doc", Plain) as unknown as LogDoc
    await whenHydrated(doc as never)
    append(doc, "one")
    await runtime.flush()
    append(doc, "two")
    await runtime.flush()

    await runtime.compact("doc")
    expect(kinds(storage)).toEqual(["meta", "entry"])
    const replica = (runtime.getEntry("doc") as { readyInfo: { replica: any } })
      .readyInfo.replica
    expect(replica.baseVersion().serialize()).toBe(
      replica.version().serialize(),
    )
  })

  it("without a store, trims memory and returns", async () => {
    const runtime = new Runtime()
    runtimes.push(runtime)
    const doc = runtime.get("doc", Plain) as unknown as LogDoc
    append(doc, "one")
    append(doc, "two")
    await runtime.compact("doc")
    const replica = (runtime.getEntry("doc") as { readyInfo: { replica: any } })
      .readyInfo.replica
    expect(replica.baseVersion().serialize()).toBe(
      replica.version().serialize(),
    )
    expect(doc.log()).toBe("onetwo")
  })
})

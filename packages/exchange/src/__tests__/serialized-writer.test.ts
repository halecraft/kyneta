// serialized-writer — of the seats sharing one storage, at most one authors
// each serialized document.
//
// A serialized (plain) document's identity is its lineage, which every writer
// extends at the same positions, whatever its peer id. Two Runtimes over one
// storage that both wrote one plain document used to store two different
// operations at one position, and a later load kept only one of them. The
// storage now records the seat that writes each serialized document, refuses
// every other seat's authored writes, and a seat that lost the race rebuilds
// from storage before anything of its write leaves the process.

import { Bridge, createBridgeTransport } from "@kyneta/bridge-transport"
import {
  batch,
  DocumentLoadingError,
  json,
  plainReplicaFactory,
  Schema,
  SYNC_AUTHORITATIVE,
} from "@kyneta/schema"
import { yjs } from "@kyneta/yjs-schema"
import { describe, expect, it } from "vitest"
import type { Exchange } from "../exchange.js"
import { Line } from "../line.js"
import { writeRefusal, writeRefusalFeed } from "../persistence.js"
import { whenHydrated } from "../settle.js"
import {
  abandonSeat,
  createInMemoryStoreData,
  InMemoryStore,
  type InMemoryStoreData,
} from "../store/in-memory-store.js"
import { WriterRefusedError } from "../store/seats.js"
import type { Store } from "../store/store.js"
import { collectAll } from "../testing/store-conformance.js"
import { drain, exchangesPerTest } from "./exchanges.js"
import { wrapStore } from "./wrap-store.js"

const FieldsSchema = Schema.struct({ a: Schema.string(), b: Schema.string() })

/** The seat a refusal names, if it is another seat's claim. */
const writerOf = (refusal: unknown) =>
  refusal instanceof WriterRefusedError ? refusal.writer : undefined
const Fields = json.bind(FieldsSchema)
type Field = { (): string; set(value: string): void }
type FieldsDoc = { readonly a: Field; readonly b: Field }

const createExchange = exchangesPerTest()

/** An Exchange over `storage`, connected to `bridge` when given. */
function open(
  storage: InMemoryStoreData,
  options: {
    readonly bridge?: Bridge
    readonly store?: Store
    readonly errors?: unknown[]
  } = {},
): Exchange {
  return createExchange({
    principal: "user",
    store: options.store ?? new InMemoryStore(storage),
    transports: options.bridge
      ? [
          createBridgeTransport({
            bridge: options.bridge,
            transportId: `user-${Math.random()}`,
          }),
        ]
      : [],
    onStoreError: (_docId, _operation, error) => options.errors?.push(error),
  })
}

async function loaded(exchange: Exchange): Promise<FieldsDoc> {
  const doc = exchange.get("doc", Fields) as FieldsDoc
  await whenHydrated(doc)
  return doc
}

/** A peer of the storage's seats, over the bridge, with no store. */
function host(bridge: Bridge): Exchange {
  return createExchange({
    principal: "host",
    transports: [createBridgeTransport({ bridge, transportId: "host" })],
  })
}

describe("serialized documents: one writer seat per storage", () => {
  it("the reproduction: the second seat's write is refused, rebuilt away, and never stored", async () => {
    const storage = createInMemoryStoreData()
    const first = open(storage)
    const errors: unknown[] = []
    const second = open(storage, { errors })
    const one = await loaded(first)
    const two = await loaded(second)
    expect(writeRefusal(two)).toBeUndefined()

    one.a.set("first")
    await first.flush()
    // Loaded before the claim, so the write is allowed here and refused by
    // the store.
    two.b.set("second")
    await second.flush()

    expect(two.a()).toBe("first")
    expect(two.b()).toBe("")
    const refusal = writeRefusal(two)
    expect(refusal).toBeInstanceOf(WriterRefusedError)
    expect(writerOf(refusal)).toBe(first.peerId)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(WriterRefusedError)
    // The rebuild's own write succeeded; the refusal stays.
    expect(writeRefusal(two)).toBe(refusal)
    expect(() => two.b.set("again")).toThrow("one writer per storage")

    await second.shutdown()
    await first.shutdown()
    const reader = await loaded(open(storage))
    expect(reader.a()).toBe("first")
    expect(reader.b()).toBe("")
  })

  it("a seat loading a document another seat writes is refused before it writes", async () => {
    const storage = createInMemoryStoreData()
    const writer = open(storage)
    const written = await loaded(writer)
    written.a.set("mine")
    await writer.flush()

    const reader = open(storage)
    const doc = reader.get("doc", Fields) as FieldsDoc
    const feed = writeRefusalFeed(doc)
    // While it loads, a serialized document refuses every authored write.
    expect(feed()).toBeInstanceOf(DocumentLoadingError)
    await whenHydrated(doc)
    expect(feed()).toBeInstanceOf(WriterRefusedError)
    expect(writerOf(feed())).toBe(writer.peerId)
    expect(() => doc.b.set("theirs")).toThrow(
      "a serialized document has one writer per storage",
    )
    expect(() => batch(doc, d => d.b.set("theirs"))).toThrow(writer.peerId)
    expect(doc.a()).toBe("mine")
  })

  it("nothing of a refused write reaches a peer, and owed offers go out after the rebuild", async () => {
    // Only the loser is connected, so the peer learns the winner's write
    // only through the offer the loser owed it when its write was refused.
    const bridge = new Bridge()
    const peer = host(bridge)
    const seen = peer.get("doc", Fields) as FieldsDoc
    const storage = createInMemoryStoreData()
    const first = open(storage)
    const second = open(storage, { bridge })
    const one = await loaded(first)
    const two = await loaded(second)
    await drain()

    one.a.set("first")
    // The loser writes before the winner's write is stored; its offer to the
    // peer is owed until its store write is confirmed.
    two.b.set("second")
    await first.flush()
    await second.flush()
    await drain()

    expect(writeRefusal(two)).toBeInstanceOf(WriterRefusedError)
    expect(seen.a()).toBe("first")
    expect(seen.b()).toBe("")
    expect(two.a()).toBe("first")
    expect(two.b()).toBe("")
  })

  it("readers persist what the network sends without claiming", async () => {
    const bridge = new Bridge()
    const author = host(bridge)
    const authored = author.get("doc", Fields) as FieldsDoc
    authored.a.set("hosted")
    const storage = createInMemoryStoreData()
    const readers = [open(storage, { bridge }), open(storage, { bridge })]
    for (const reader of readers) await loaded(reader)
    await drain()
    authored.b.set("more")
    await drain()
    for (const reader of readers) await reader.flush()

    const store = new InMemoryStore(storage)
    expect(await store.writerOf("doc")).toBeNull()
    await store.close()
    for (const reader of readers) await reader.shutdown()
    const fourth = await loaded(open(storage))
    expect(fourth.a()).toBe("hosted")
    expect(fourth.b()).toBe("more")
    expect(writeRefusal(fourth)).toBeUndefined()
  })

  it("writership moves with the seat: the next holder of a dead writer's seat may author", async () => {
    const storage = createInMemoryStoreData()
    const inner = new InMemoryStore(storage)
    const writer = open(storage, { store: inner })
    const written = await loaded(writer)
    written.a.set("before")
    await writer.flush()

    // The writer dies: nothing more is flushed, and its seat is released.
    createExchange.forget(writer)
    writer.reset()
    abandonSeat(inner)

    const next = open(storage)
    expect(next.peerId).toBe(writer.peerId)
    const doc = await loaded(next)
    expect(writeRefusal(doc)).toBeUndefined()
    doc.b.set("after")
    await next.flush()
    expect(doc.a()).toBe("before")
    expect(doc.b()).toBe("after")
  })

  it("a merge that arrives while the loser rebuilds is asked for again", async () => {
    const bridge = new Bridge()
    const storage = createInMemoryStoreData()
    const first = open(storage, { bridge })
    // Hold the loser's reads, once it has been refused.
    let refused = false
    let release = () => {}
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    const inner = new InMemoryStore(storage)
    const second = open(storage, {
      bridge,
      store: wrapStore(inner, {
        append: async (docId, record, options) => {
          try {
            await inner.append(docId, record, options)
          } catch (error) {
            refused = true
            throw error
          }
        },
        // Read at once, answer once released: what arrives meanwhile is
        // not in what the rebuild read.
        loadAll: docId => {
          if (!refused) return inner.loadAll(docId)
          const read = collectAll(inner.loadAll(docId))
          return (async function* () {
            const records = await read
            await held
            yield* records
          })()
        },
      }),
    })
    const one = await loaded(first)
    const two = await loaded(second)
    await drain()

    one.a.set("first")
    two.b.set("second")
    await drain()
    expect(refused).toBe(true)

    // The winner writes again while the loser's rebuild waits on its read.
    one.b.set("later")
    await first.flush()
    await drain()

    release()
    await second.flush()
    await drain()
    expect(two.a()).toBe("first")
    expect(two.b()).toBe("later")
  })

  it("a document destroyed while it rebuilds is left alone", async () => {
    const storage = createInMemoryStoreData()
    const first = open(storage)
    let refused = false
    let release = () => {}
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    const inner = new InMemoryStore(storage)
    const errors: unknown[] = []
    const second = open(storage, {
      errors,
      store: wrapStore(inner, {
        append: async (docId, record, options) => {
          try {
            await inner.append(docId, record, options)
          } catch (error) {
            refused = true
            throw error
          }
        },
        // Read at once, answer once released: what arrives meanwhile is
        // not in what the rebuild read.
        loadAll: docId => {
          if (!refused) return inner.loadAll(docId)
          const read = collectAll(inner.loadAll(docId))
          return (async function* () {
            const records = await read
            await held
            yield* records
          })()
        },
      }),
    })
    const one = await loaded(first)
    const two = await loaded(second)
    one.a.set("first")
    await first.flush()
    two.b.set("second")
    await drain()
    expect(refused).toBe(true)

    second.destroy("doc")
    release()
    await second.flush()
    expect(second.has("doc")).toBe(false)
    // The only errors are the refused write and the refused delete: nothing
    // was reset, re-hydrated or written.
    expect(errors).toHaveLength(2)
    expect(await inner.writerOf("doc")).toBe(first.peerId)
  })

  it("a relayed document promoted by get() is refused like a loaded one", async () => {
    const storage = createInMemoryStoreData()
    const writer = open(storage)
    const written = await loaded(writer)
    written.a.set("written")
    await writer.flush()

    const relay = open(storage)
    relay.replicate(
      "doc",
      plainReplicaFactory,
      SYNC_AUTHORITATIVE,
      Fields.schemaHash,
    )
    await drain()
    const promoted = relay.get("doc", Fields) as FieldsDoc
    await whenHydrated(promoted)
    expect(promoted.a()).toBe("written")
    expect(writeRefusal(promoted)).toBeInstanceOf(WriterRefusedError)
    expect(() => promoted.b.set("relay")).toThrow("one writer per storage")
  })

  it("a reader's destroy() evicts the document here and leaves the writer's copy", async () => {
    const storage = createInMemoryStoreData()
    const writer = open(storage)
    const written = await loaded(writer)
    written.a.set("kept")
    await writer.flush()

    const errors: unknown[] = []
    const reader = open(storage, { errors })
    await loaded(reader)
    reader.destroy("doc")
    await reader.flush()
    await drain()
    expect(reader.has("doc")).toBe(false)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(WriterRefusedError)

    await reader.shutdown()
    await writer.shutdown()
    const third = await loaded(open(storage))
    expect(third.a()).toBe("kept")
  })

  it("CRDT documents are unaffected: both seats' writes are kept, and no writer is recorded", async () => {
    const Text = yjs.bind(
      Schema.struct({ a: Schema.string(), b: Schema.string() }),
    )
    const storage = createInMemoryStoreData()
    const first = open(storage)
    const second = open(storage)
    const one = first.get("doc", Text) as FieldsDoc
    const two = second.get("doc", Text) as FieldsDoc
    await whenHydrated(one)
    await whenHydrated(two)
    one.a.set("first")
    two.b.set("second")
    await first.flush()
    await second.flush()
    expect(writeRefusal(two)).toBeUndefined()

    await first.shutdown()
    await second.shutdown()
    const store = new InMemoryStore(storage)
    expect(await store.writerOf("doc")).toBeNull()
    await store.close()
    const third = open(storage).get("doc", Text) as FieldsDoc
    await whenHydrated(third)
    expect(third.a()).toBe("first")
    expect(third.b()).toBe("second")
  })

  it("Lines from two seats of one storage never contend", async () => {
    const bridge = new Bridge()
    const server = createExchange({
      principal: "server",
      transports: [createBridgeTransport({ bridge, transportId: "server" })],
    })
    const storage = createInMemoryStoreData()
    const tabs = [open(storage, { bridge }), open(storage, { bridge })]
    await drain()

    const P = Line.protocol({
      topic: "tabs",
      schema: Schema.struct({ from: Schema.string() }),
    })
    const received: string[] = []
    P.listen(server).onReceive((_reply, receiver) => {
      void (async () => {
        for await (const msg of receiver) received.push(msg.from)
      })()
    })
    const senders = tabs.map(tab => P.sender(tab, server.peerId))
    senders[0]?.send({ from: "tab-0" })
    senders[1]?.send({ from: "tab-1" })
    await drain()
    for (const tab of tabs) await tab.flush()
    await drain()

    expect(received.sort()).toEqual(["tab-0", "tab-1"])
    for (const sender of senders) sender.close()
  })
})

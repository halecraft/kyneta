// release — a closed document is released. Once the app lets go of its refs,
// its root ref and native document are collected, on every backend, with or
// without a store; and a ref the app still holds reads its last value, refuses
// writes, and keeps nothing else alive.

import { Bridge, createBridgeTransport } from "@kyneta/bridge-transport"
import { CHANGEFEED } from "@kyneta/changefeed"
import { loro, loroReplicaFactory } from "@kyneta/loro-schema"
import {
  batch,
  DocumentClosedError,
  ephemeral,
  json,
  type ReplicaLike,
  Schema,
  SYNC_COLLABORATIVE,
  unwrap,
} from "@kyneta/schema"
import { collectGarbage } from "@kyneta/schema/testing"
import { yjs } from "@kyneta/yjs-schema"
import type { LoroDoc } from "loro-crdt"
import { describe, expect, it } from "vitest"
import { Exchange } from "../exchange.js"
import { persistedFeed, whenPersisted, writeRefusal } from "../persistence.js"
import { hydratedFeed, whenHydrated } from "../settle.js"
import { createInMemoryStore } from "../store/in-memory-store.js"
import { whenSettled } from "../sync.js"
import { drain, exchangesPerTest, sleep } from "./exchanges.js"
import { gated } from "./wrap-store.js"

const createExchange = exchangesPerTest()

const FieldsSchema = Schema.struct({
  title: Schema.string(),
  n: Schema.number(),
})

const LoroFields = loro.bind(FieldsSchema)
const YjsFields = yjs.bind(FieldsSchema)
const JsonFields = json.bind(FieldsSchema)
const EphemeralFields = ephemeral.bind(FieldsSchema)

/** A backend, and how to open its document of `FieldsSchema`. */
type Backend = {
  readonly name: string
  readonly open: (exchange: Exchange, docId: string) => any
}

const backends: readonly Backend[] = [
  { name: "loro", open: (ex, docId) => ex.get(docId, LoroFields) },
  { name: "yjs", open: (ex, docId) => ex.get(docId, YjsFields) },
  { name: "json", open: (ex, docId) => ex.get(docId, JsonFields) },
  { name: "ephemeral", open: (ex, docId) => ex.get(docId, EphemeralFields) },
]

/** What a test may hold of a document without keeping it alive. */
type Weak = { readonly ref: WeakRef<object>; readonly native: WeakRef<object> }

/** Open `docId`, write to it, wait for the store, and hold it only weakly. */
async function written(
  exchange: Exchange,
  docId: string,
  backend: Backend,
): Promise<Weak> {
  const doc = backend.open(exchange, docId)
  await whenHydrated(doc)
  batch(doc, (d: any) => {
    d.title.set("written")
    d.n.set(1)
  })
  await whenPersisted(doc)
  return { ref: new WeakRef(doc), native: new WeakRef(unwrap(doc) as object) }
}

const stores = [
  ["an in-memory store", () => ({ store: createInMemoryStore() })],
  ["no store", () => ({})],
] as const

describe("collection after the document closes", () => {
  for (const backend of backends) {
    for (const [storeName, params] of stores) {
      describe(`${backend.name}, ${storeName}`, () => {
        it("destroy: the root ref and the native document are collected", async () => {
          const exchange = createExchange(params())
          const held = await written(exchange, "doc", backend)
          exchange.destroy("doc")
          await exchange.flush()
          await collectGarbage()
          expect(held.ref.deref()).toBeUndefined()
          expect(held.native.deref()).toBeUndefined()
        })

        it("reset: the root ref and the native document are collected", async () => {
          const exchange = createExchange(params())
          const held = await written(exchange, "doc", backend)
          exchange.reset()
          await collectGarbage()
          expect(held.ref.deref()).toBeUndefined()
          expect(held.native.deref()).toBeUndefined()
        })

        it("shutdown: the root ref and the native document are collected", async () => {
          const exchange = createExchange(params())
          const held = await written(exchange, "doc", backend)
          await exchange.shutdown()
          await collectGarbage()
          expect(held.ref.deref()).toBeUndefined()
          expect(held.native.deref()).toBeUndefined()
        })
      })
    }
  }
})

describe("a ref held after shutdown", () => {
  for (const backend of backends) {
    // A plain or ephemeral document's native value is σ, which a held ref
    // keeps to read; a CRDT's is its native document, which it does not.
    const nativeIsSigma =
      backend.name === "json" || backend.name === "ephemeral"
    it(`${backend.name}: reads its last value, refuses writes, and keeps neither the native document, the Runtime nor the Exchange`, async () => {
      const open = async () => {
        const exchange = new Exchange({
          principal: "test",
          store: createInMemoryStore(),
        })
        const doc = backend.open(exchange, "doc")
        await whenHydrated(doc)
        batch(doc, (d: any) => d.title.set("last"))
        const native = new WeakRef(unwrap(doc) as object)
        await exchange.shutdown()
        return {
          doc,
          native,
          runtime: new WeakRef(exchange.runtime),
          exchange: new WeakRef(exchange),
        }
      }
      const { doc, native, runtime, exchange } = await open()
      await collectGarbage()
      if (!nativeIsSigma) expect(native.deref()).toBeUndefined()
      expect(runtime.deref()).toBeUndefined()
      expect(exchange.deref()).toBeUndefined()

      expect(doc.title()).toBe("last")
      expect(() => doc.title.set("lost")).toThrow(DocumentClosedError)
      expect(writeRefusal(doc)).toBeInstanceOf(DocumentClosedError)
      expect(writeRefusal(doc.title)).toBeInstanceOf(DocumentClosedError)
    })
  }
})

describe("replicate mode", () => {
  it("a destroyed replicate-mode document releases its replica", async () => {
    const exchange = createExchange({ store: createInMemoryStore() })
    const replicaOf = (): WeakRef<ReplicaLike> => {
      exchange.replicate(
        "doc",
        loroReplicaFactory,
        SYNC_COLLABORATIVE,
        LoroFields.schemaHash,
      )
      const instance = exchange.runtime.instanceOf("doc")
      if (instance?.tier !== "replicate") throw new Error("expected a replica")
      return new WeakRef(instance.readyInfo.replica)
    }
    const replica = replicaOf()
    await exchange.flush()
    exchange.destroy("doc")
    expect(() => replica.deref()?.version()).toThrow(DocumentClosedError)
    await exchange.flush()
    await collectGarbage()
    expect(replica.deref()).toBeUndefined()
  })
})

describe("terms across the close", () => {
  it("whenPersisted rejects for a destroy that dropped unconfirmed writes", async () => {
    const appends = gated(createInMemoryStore(), "append")
    const exchange = createExchange({ store: appends.store })
    const doc: any = exchange.get("doc", JsonFields)
    await whenHydrated(doc)
    appends.hold()
    doc.title.set("unconfirmed")
    await drain(2)
    const persisted = whenPersisted(doc)
    exchange.destroy("doc")
    await expect(persisted).rejects.toBeInstanceOf(DocumentClosedError)
    await expect(whenPersisted(doc)).rejects.toBeInstanceOf(DocumentClosedError)
    appends.release()
  })

  it("a persistedFeed and a hydratedFeed taken before the close notify once, then read the closed values", async () => {
    const appends = gated(createInMemoryStore(), "append")
    const exchange = createExchange({ store: appends.store })
    const doc: any = exchange.get("doc", JsonFields)
    await whenHydrated(doc)
    appends.hold()
    doc.title.set("unconfirmed")
    await drain(2)
    const persisted = persistedFeed(doc)
    const hydrated = hydratedFeed(doc)
    let heard = 0
    persisted[CHANGEFEED].subscribe(() => heard++)
    hydrated[CHANGEFEED].subscribe(() => heard++)
    expect(persisted()).toBe(false)
    expect(hydrated()).toBe(true)
    exchange.destroy("doc")
    expect(heard).toBe(2)
    expect(persisted()).toBe(false)
    expect(hydrated()).toBe(true)
    appends.release()
  })

  it("whenSettled after destroy resolves with the via it had, when the peers had answered", async () => {
    const bridge = new Bridge()
    const alice = createExchange({
      principal: "alice",
      transports: [createBridgeTransport({ transportId: "alice", bridge })],
    })
    const bob = createExchange({
      principal: "bob",
      transports: [createBridgeTransport({ transportId: "bob", bridge })],
    })
    batch(bob.get("doc", LoroFields), d => d.title.set("bob's"))
    const doc = alice.get("doc", LoroFields)
    await expect(whenSettled(doc)).resolves.toEqual({ via: "peer" })
    alice.destroy("doc")
    await expect(whenSettled(doc)).resolves.toEqual({ via: "peer" })
  })

  it("a whenSettled begun before destroy rejects with DocumentClosedError, when no peer had answered", async () => {
    const bridge = new Bridge()
    const alice = createExchange({
      principal: "alice",
      transports: [createBridgeTransport({ transportId: "alice", bridge })],
    })
    const doc: any = alice.get("doc", LoroFields)
    const settledWait = whenSettled(doc)
    await sleep(20)
    alice.destroy("doc")
    const error = await settledWait.then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(DocumentClosedError)
    expect((error as DocumentClosedError).reason).toBe("destroyed")
  })
})

describe("promotion", () => {
  it("a promoted document's LoroDoc is freed once when it is destroyed", async () => {
    const exchange = createExchange()
    exchange.replicate(
      "doc",
      loroReplicaFactory,
      SYNC_COLLABORATIVE,
      LoroFields.schemaHash,
    )
    const doc = exchange.get("doc", LoroFields)
    const native = unwrap(doc) as LoroDoc
    let frees = 0
    const free = native.free.bind(native)
    native.free = () => {
      frees++
      free()
    }
    doc.title.set("promoted")
    exchange.destroy("doc")
    expect(frees).toBe(1)
    expect(() => doc.title.set("again")).toThrow(DocumentClosedError)
  })
})

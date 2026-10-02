// unload — a stored document leaves memory and stays in the store.
//
// At `unload` its writes are refused; once the store holds all of it, its ref
// closes and it leaves the sync graph; once it has left, its replica is
// disposed. A door before the release cancels the unload, and one after
// loads it again.

import { Bridge, createBridgeTransport } from "@kyneta/bridge-transport"
import { CHANGEFEED } from "@kyneta/changefeed"
import { loro } from "@kyneta/loro-schema"
import {
  type BoundSchema,
  batch,
  DocumentClosedError,
  ephemeral,
  json,
  Schema,
  subscribe,
  unwrap,
} from "@kyneta/schema"
import { collectGarbage } from "@kyneta/schema/testing"
import { type ChannelMsg, PROTOCOL_VERSION } from "@kyneta/transport"
import { describe, expect, it } from "vitest"
import { Exchange } from "../exchange.js"
import {
  persisted,
  persistedFeed,
  writeRefusal,
  writeRefusalFeed,
} from "../persistence.js"
import { Runtime } from "../runtime.js"
import { hydratedFeed, whenHydrated } from "../settle.js"
import {
  createInMemoryStore,
  createInMemoryStoreData,
} from "../store/in-memory-store.js"
import type { Store } from "../store/store.js"
import { FIRST_RETRY_MS } from "../store/store-program.js"
import { sync, whenSettled } from "../sync.js"
import { drain, exchangesPerTest, sleep } from "./exchanges.js"
import { ScriptedPeer } from "./scripted-peer.js"
import { gated, wrapStore } from "./wrap-store.js"

const createExchange = exchangesPerTest()

const FieldsSchema = Schema.struct({
  title: Schema.string(),
  n: Schema.number(),
})

const backends: readonly (readonly [string, BoundSchema])[] = [
  ["loro", loro.bind(FieldsSchema)],
  ["json", json.bind(FieldsSchema)],
]

const Fields = loro.bind(FieldsSchema)

/** A document's ref, as the tests use it. */
type Doc = any

/** `exchange.get` over a schema whose type is not known here. */
const getDoc = (exchange: Exchange, docId: string, bound: BoundSchema): Doc =>
  (exchange as any).get(docId, bound)

/** Open `docId`, write `title`, and wait until the store holds it. */
async function written(
  exchange: Exchange,
  docId: string,
  bound: BoundSchema,
  title = "written",
): Promise<Doc> {
  const doc: Doc = getDoc(exchange, docId, bound)
  await whenHydrated(doc)
  batch(doc, (d: Doc) => {
    d.title.set(title)
    d.n.set(1)
  })
  await exchange.flush()
  return doc
}

/** What a fresh Runtime over `storage` loads of `docId`. */
async function storedTitle(
  storage: ReturnType<typeof createInMemoryStoreData>,
  docId: string,
  bound: BoundSchema = Fields,
): Promise<string | undefined> {
  const runtime = new Runtime({
    store: createInMemoryStore({ sharedData: storage }),
  })
  try {
    const doc: Doc = (runtime as any).get(docId, bound)
    await whenHydrated(doc)
    return doc.title()
  } finally {
    await runtime.shutdown()
  }
}

const phaseOf = (exchange: Exchange, docId: string) =>
  exchange.runtime.lifecycleOf(docId)?.phase

/** A scripted peer that has established with `exchange`'s transport. */
async function establish(peer: ScriptedPeer): Promise<void> {
  await Promise.resolve()
  peer.receive({
    type: "establish",
    identity: { peerId: "them", principal: "them", type: "user" },
    protocolVersion: PROTOCOL_VERSION,
  })
  await drain(2)
}

function presented(peer: ScriptedPeer, docId: string): boolean {
  return peer
    .sentOf("present")
    .some((m: Extract<ChannelMsg, { type: "present" }>) =>
      m.docs.some(d => d.docId === docId),
    )
}

describe("a suspended instance registers without being announced", () => {
  it("promoting a suspended replica sends no present, and resume announces it", async () => {
    const peer = new ScriptedPeer()
    const exchange = createExchange({ transports: [peer] })
    exchange.replicate(
      "doc",
      Fields.factory({
        peerId: exchange.peerId,
        binding: Fields.identityBinding,
      }).replica,
      Fields.syncMode,
      Fields.schemaHash,
    )
    exchange.suspend("doc")
    await establish(peer)
    peer.sent.length = 0

    exchange.get("doc", Fields)
    await drain(2)
    expect(presented(peer, "doc")).toBe(false)
    expect(exchange.documents.get("doc")).toEqual({
      mode: "interpret",
      suspended: true,
    })

    exchange.resume("doc")
    await drain(2)
    expect(presented(peer, "doc")).toBe(true)
    expect(exchange.documents.get("doc")).toEqual({
      mode: "interpret",
      suspended: false,
    })
  })
})

describe("unload", () => {
  for (const [name, bound] of backends) {
    describe(name, () => {
      it("releases the document, and open loads it again with the last write", async () => {
        const storage = createInMemoryStoreData()
        const exchange = createExchange({
          store: createInMemoryStore({ sharedData: storage }),
        })
        const held = await (async () => {
          const doc = await written(exchange, "doc", bound)
          return {
            ref: new WeakRef<object>(doc),
            native: new WeakRef(unwrap(doc) as object),
          }
        })()
        exchange.unload("doc")
        await exchange.flush()
        expect(phaseOf(exchange, "doc")).toBe("unloaded")
        await collectGarbage()
        expect(held.ref.deref()).toBeUndefined()
        expect(held.native.deref()).toBeUndefined()

        const doc: Doc = await (exchange as any).open("doc", bound)
        expect(doc.title()).toBe("written")
        expect(exchange.documents.get("doc")).toEqual({
          mode: "interpret",
          suspended: false,
        })
      })

      it("stays in memory while the store owes a write, and releases once it is stored", async () => {
        const storage = createInMemoryStoreData()
        const gate = gated(
          createInMemoryStore({ sharedData: storage }),
          "append",
        )
        const exchange = createExchange({ store: gate.store })
        const doc = await written(exchange, "doc", bound)
        gate.hold()
        doc.title.set("last")
        exchange.unload("doc")
        await drain()
        expect(phaseOf(exchange, "doc")).toBe("unloading")
        expect(exchange.runtime.instanceOf("doc")).toBeDefined()

        gate.release()
        await exchange.flush()
        expect(phaseOf(exchange, "doc")).toBe("unloaded")
        expect(await storedTitle(storage, "doc", bound)).toBe("last")
      })

      it("is released only once a failed write's retry succeeds", async () => {
        const storage = createInMemoryStoreData()
        const inner = createInMemoryStore({ sharedData: storage })
        // The unload's write and the one it owes fail; the retry succeeds.
        let failures = 0
        const exchange = createExchange({
          store: wrapStore(inner, {
            append: async (docId, record, options) => {
              if (failures > 0) {
                failures--
                throw new Error("disk full")
              }
              return inner.append(docId, record, options)
            },
          }),
          onStoreError: () => {},
        })
        const doc = await written(exchange, "doc", bound)
        failures = 2
        doc.title.set("last")
        exchange.unload("doc")
        // A failing store does not hold flush up; the document stays.
        await exchange.flush()
        expect(failures).toBe(0)
        expect(phaseOf(exchange, "doc")).toBe("unloading")

        // Two failures in a row: the retry waits twice the first delay.
        await sleep(2 * FIRST_RETRY_MS + 100)
        await exchange.flush()
        expect(phaseOf(exchange, "doc")).toBe("unloaded")
        expect(await storedTitle(storage, "doc", bound)).toBe("last")
      })

      it("refuses writes on the old ref from unload on, and after it has left", async () => {
        const gate = gated(createInMemoryStore(), "append")
        const exchange = createExchange({ store: gate.store })
        const doc = await written(exchange, "doc", bound)
        gate.hold()
        doc.title.set("last")
        exchange.unload("doc")
        const refused = (): unknown => {
          try {
            doc.n.set(9)
          } catch (error) {
            return error
          }
          return undefined
        }
        expect(refused()).toBeInstanceOf(DocumentClosedError)
        expect(writeRefusal(doc)).toMatchObject({ reason: "unloaded" })

        gate.release()
        await exchange.flush()
        expect(phaseOf(exchange, "doc")).toBe("unloaded")
        expect(refused()).toBeInstanceOf(DocumentClosedError)
        expect(writeRefusal(doc)).toBeInstanceOf(DocumentClosedError)
        expect(doc.title()).toBe("last")
      })
    })
  }

  it("a refusal subscriber hears the unload, and hears it lift at a cancel", async () => {
    const gate = gated(createInMemoryStore(), "append")
    const exchange = createExchange({ store: gate.store })
    const doc = await written(exchange, "doc", Fields)
    const heard: unknown[] = []
    const feed = writeRefusalFeed(doc)
    feed[CHANGEFEED].subscribe(() => heard.push(feed()))
    gate.hold()
    doc.title.set("last")
    exchange.unload("doc")
    expect(heard).toEqual([expect.any(DocumentClosedError)])

    expect(exchange.get("doc", Fields)).toBe(doc)
    expect(heard).toEqual([expect.any(DocumentClosedError), undefined])
    doc.n.set(2)
    gate.release()
    await exchange.flush()
    expect(phaseOf(exchange, "doc")).toBe("ready")
  })

  it("get before the release returns the same ref, writable and stored", async () => {
    const storage = createInMemoryStoreData()
    const gate = gated(createInMemoryStore({ sharedData: storage }), "append")
    const exchange = createExchange({ store: gate.store })
    const doc = await written(exchange, "doc", Fields)
    gate.hold()
    doc.title.set("before")
    exchange.unload("doc")
    expect(exchange.get("doc", Fields)).toBe(doc)
    doc.title.set("after")
    gate.release()
    await exchange.flush()
    expect(phaseOf(exchange, "doc")).toBe("ready")
    expect(await storedTitle(storage, "doc")).toBe("after")
  })

  it("documentIds excludes an unloaded document, and has includes it", async () => {
    const exchange = createExchange({ store: createInMemoryStore() })
    await written(exchange, "doc", Fields)
    exchange.unload("doc")
    await exchange.flush()
    expect(exchange.documentIds().has("doc")).toBe(false)
    expect(exchange.runtime.documentIds().has("doc")).toBe(false)
    expect(exchange.has("doc")).toBe(true)
    expect(exchange.documents.get("doc")).toEqual({
      mode: "unloaded",
      suspended: false,
    })
  })

  it("records doc-unloaded", async () => {
    const exchange = createExchange({ store: createInMemoryStore() })
    await written(exchange, "doc", Fields)
    const events: string[] = []
    exchange.documents.subscribe(changeset => {
      for (const change of changeset.changes) events.push(change.type)
    })
    exchange.unload("doc")
    await exchange.flush()
    expect(events).toEqual(["doc-unloaded"])
  })

  it("a door the release reaches through a persisted listener keeps the document, and the store keeps tracking it", async () => {
    const storage = createInMemoryStoreData()
    const inner = createInMemoryStore({ sharedData: storage })
    let failures = 0
    const exchange = createExchange({
      store: wrapStore(inner, {
        append: async (docId, record, options) => {
          if (failures > 0) {
            failures--
            throw new Error("disk full")
          }
          return inner.append(docId, record, options)
        },
      }),
      onStoreError: () => {},
    })
    const doc = await written(exchange, "doc", Fields)
    // A write that failed, with its retry scheduled: the unload's own write
    // is then the one that confirms it, and the release comes in the same
    // transition as the confirmation.
    failures = 1
    doc.title.set("unloading")
    await drain(2)
    expect(persisted(doc)).toBe(false)

    let kept = false
    persistedFeed(doc)[CHANGEFEED].subscribe(() => {
      if (!kept && persisted(doc)) {
        kept = true
        exchange.get("doc", Fields)
      }
    })
    exchange.unload("doc")
    await exchange.flush()
    expect(kept).toBe(true)
    expect(phaseOf(exchange, "doc")).toBe("ready")

    doc.title.set("kept")
    await exchange.flush()
    expect(await storedTitle(storage, "doc")).toBe("kept")
  })

  it("a peer's change merged just before unload is in the store", async () => {
    const storage = createInMemoryStoreData()
    const bridge = new Bridge()
    const alice = createExchange({
      principal: "alice",
      store: createInMemoryStore({ sharedData: storage }),
      transports: [createBridgeTransport({ transportId: "alice", bridge })],
    })
    const bob = createExchange({
      principal: "bob",
      transports: [createBridgeTransport({ transportId: "bob", bridge })],
    })
    const doc: Doc = alice.get("doc", Fields)
    const theirs: Doc = bob.get("doc", Fields)
    await whenSettled(doc)
    await whenSettled(theirs)
    await alice.flush()
    // Unload inside the import that merges bob's write, before the
    // Synchronizer's quiet point reports it to the store.
    subscribe(doc, () => {
      if (doc.title() === "bob's" && phaseOf(alice, "doc") === "ready") {
        alice.unload("doc")
      }
    })
    theirs.title.set("bob's")
    await drain()
    await alice.flush()
    expect(phaseOf(alice, "doc")).toBe("unloaded")
    expect(await storedTitle(storage, "doc")).toBe("bob's")
  })

  it("an unload begun on a standalone Runtime, wrapped while storing and then cancelled, is registered", async () => {
    const gate = gated(createInMemoryStore(), "append")
    const runtime = new Runtime({ store: gate.store })
    const doc: Doc = runtime.get("doc", Fields)
    await whenHydrated(doc)
    doc.title.set("first")
    await runtime.flush()
    gate.hold()
    doc.title.set("unloading")
    runtime.unload("doc")
    const exchange = new Exchange(runtime, { principal: "wrapper" })
    try {
      expect(exchange.documents.has("doc")).toBe(false)
      expect(exchange.get("doc", Fields)).toBe(doc)
      await drain(2)
      expect(exchange.documents.get("doc")).toEqual({
        mode: "interpret",
        suspended: false,
      })
    } finally {
      gate.release()
      await exchange.shutdown()
    }
  })

  it("open of a document another seat deleted while unloaded removes it everywhere", async () => {
    const storage = createInMemoryStoreData()
    const exchange = createExchange({
      store: createInMemoryStore({ sharedData: storage }),
    })
    await written(exchange, "doc", Fields)
    exchange.unload("doc")
    await exchange.flush()

    const other = createExchange({
      store: createInMemoryStore({ sharedData: storage }),
    })
    other.destroy("doc")
    await other.flush()

    expect(await exchange.open("doc", Fields)).toBeUndefined()
    await drain(2)
    expect(exchange.has("doc")).toBe(false)
    expect(exchange.documents.has("doc")).toBe(false)
  })

  it("throws for a document it cannot let go of", async () => {
    const without = createExchange()
    without.get("doc", Fields)
    expect(() => without.unload("doc")).toThrow(/not stored/)
    expect(() => without.unload("absent")).toThrow(/does not exist/)

    const exchange = createExchange({ store: createInMemoryStore() })
    exchange.get("live", ephemeral.bind(FieldsSchema))
    expect(() => exchange.unload("live")).toThrow(/not stored/)
    exchange.get("loading", Fields)
    expect(() => exchange.unload("loading")).toThrow(/still loading/)

    const unreadable: Store = wrapStore(createInMemoryStore(), {
      currentMeta: async () => {
        throw new Error("disk unreadable")
      },
    })
    const failing = createExchange({ store: unreadable })
    const doc: Doc = failing.get("doc", Fields)
    await whenHydrated(doc).catch(() => {})
    expect(() => failing.unload("doc")).toThrow(/disk unreadable/)
  })

  it("does nothing for a document already unloading or unloaded", async () => {
    const gate = gated(createInMemoryStore(), "append")
    const exchange = createExchange({ store: gate.store })
    const doc = await written(exchange, "doc", Fields)
    gate.hold()
    doc.title.set("last")
    exchange.unload("doc")
    exchange.unload("doc")
    gate.release()
    await exchange.flush()
    exchange.unload("doc")
    expect(phaseOf(exchange, "doc")).toBe("unloaded")
  })

  it("destroy after unload deletes the stored document", async () => {
    const storage = createInMemoryStoreData()
    const exchange = createExchange({
      store: createInMemoryStore({ sharedData: storage }),
    })
    await written(exchange, "doc", Fields)
    exchange.unload("doc")
    await exchange.flush()
    exchange.destroy("doc")
    await exchange.flush()
    expect(exchange.has("doc")).toBe(false)
    expect(exchange.documents.has("doc")).toBe(false)
    expect(await exchange.open("doc", Fields)).toBeUndefined()
  })

  it("destroy while unloading deletes it, and leaves nothing registered", async () => {
    const storage = createInMemoryStoreData()
    const gate = gated(createInMemoryStore({ sharedData: storage }), "append")
    const exchange = createExchange({ store: gate.store })
    const doc = await written(exchange, "doc", Fields)
    gate.hold()
    doc.title.set("last")
    exchange.unload("doc")
    exchange.destroy("doc")
    gate.release()
    await exchange.flush()
    expect(exchange.has("doc")).toBe(false)
    expect(exchange.documents.has("doc")).toBe(false)
    expect(exchange.synchronizer.hasDoc("doc")).toBe(false)
    expect(await exchange.open("doc", Fields)).toBeUndefined()
  })

  it("registerSchema after unload leaves it unloaded", async () => {
    const exchange = createExchange({ store: createInMemoryStore() })
    await written(exchange, "doc", Fields)
    exchange.unload("doc")
    await exchange.flush()
    exchange.registerSchema(Fields)
    expect(phaseOf(exchange, "doc")).toBe("unloaded")
  })

  it("a replica unloaded and replicated again is a replica", async () => {
    const storage = createInMemoryStoreData()
    await (async () => {
      const writer = createExchange({
        store: createInMemoryStore({ sharedData: storage }),
      })
      await written(writer, "doc", Fields)
      await writer.shutdown()
    })()
    const exchange = createExchange({
      store: createInMemoryStore({ sharedData: storage }),
    })
    const factory = Fields.factory({
      peerId: exchange.peerId,
      binding: Fields.identityBinding,
    }).replica
    exchange.replicate("doc", factory, Fields.syncMode, Fields.schemaHash)
    await exchange.whenHydrated("doc")
    const version = exchange.runtime
      .instanceOf("doc")
      ?.readyInfo.replica.version()
      .serialize()
    exchange.unload("doc")
    await exchange.flush()
    expect(phaseOf(exchange, "doc")).toBe("unloaded")

    exchange.replicate("doc", factory, Fields.syncMode, Fields.schemaHash)
    await exchange.whenHydrated("doc")
    const instance = exchange.runtime.instanceOf("doc")
    expect(instance?.tier).toBe("replicate")
    expect(instance?.readyInfo.replica.version().serialize()).toBe(version)
    expect(exchange.documents.get("doc")).toEqual({
      mode: "replicate",
      suspended: false,
    })
  })

  it("a suspended document stays suspended across an unload, unannounced and never reloaded by a peer", async () => {
    const peer = new ScriptedPeer()
    const exchange = createExchange({
      store: createInMemoryStore(),
      transports: [peer],
      authority: "self",
    })
    await written(exchange, "doc", Fields)
    exchange.suspend("doc")
    await establish(peer)
    exchange.unload("doc")
    await exchange.flush()
    expect(exchange.documents.get("doc")).toEqual({
      mode: "unloaded",
      suspended: true,
    })

    peer.receive({
      type: "present",
      docs: [
        {
          docId: "doc",
          replicaType: Fields.replicaType,
          syncMode: Fields.syncMode,
          schemaHash: Fields.schemaHash,
        },
      ],
    })
    peer.receive({ type: "interest", docId: "doc" })
    await drain(2)
    expect(phaseOf(exchange, "doc")).toBe("unloaded")

    const doc: Doc = await exchange.open("doc", Fields)
    expect(doc.title()).toBe("written")
    await drain(2)
    expect(exchange.documents.get("doc")).toEqual({
      mode: "interpret",
      suspended: true,
    })
    expect(presented(peer, "doc")).toBe(false)
  })

  it("a standalone Runtime unloads and loads again", async () => {
    const runtime = new Runtime({ store: createInMemoryStore() })
    try {
      const doc: Doc = runtime.get("doc", Fields)
      await whenHydrated(doc)
      doc.title.set("alone")
      runtime.unload("doc")
      await runtime.flush()
      expect(runtime.lifecycleOf("doc")?.phase).toBe("unloaded")
      expect(runtime.instanceOf("doc")).toBeUndefined()
      const again: Doc = runtime.get("doc", Fields)
      expect(again).not.toBe(doc)
      await whenHydrated(again)
      expect(again.title()).toBe("alone")
    } finally {
      await runtime.shutdown()
    }
  })

  it("a door at the release, with the leave still to run, loads a new instance; the owed offer still reaches the peer", async () => {
    const bridge = new Bridge()
    const alice = createExchange({
      principal: "alice",
      store: createInMemoryStore(),
      transports: [createBridgeTransport({ transportId: "alice", bridge })],
    })
    const bob = createExchange({
      principal: "bob",
      transports: [createBridgeTransport({ transportId: "bob", bridge })],
    })
    const doc: Doc = alice.get("doc", Fields)
    const theirs: Doc = bob.get("doc", Fields)
    await whenSettled(doc)
    await whenSettled(theirs)

    // Unload from inside the import of bob's write, after answering it, so
    // the unload starts while the Synchronizer is busy and an offer is owed.
    subscribe(doc, () => {
      if (doc.title() !== "bob's" || phaseOf(alice, "doc") !== "ready") return
      doc.n.set(42)
      alice.unload("doc")
    })
    // The release closes the old ref; a door reached from its close finds
    // the document leaving, and loads a new instance.
    let replacement: Doc
    hydratedFeed(doc)[CHANGEFEED].subscribe(() => {
      const entry = alice.runtime.lifecycleOf("doc")
      if (entry?.phase === "unloading" && entry.stage === "leaving") {
        replacement = alice.get("doc", Fields)
      }
    })
    theirs.title.set("bob's")
    await drain()
    await alice.flush()
    await drain()

    expect(replacement).toBeDefined()
    expect(replacement).not.toBe(doc)
    await whenHydrated(replacement)
    expect(replacement.n()).toBe(42)
    expect(() => doc.n.set(1)).toThrow(DocumentClosedError)
    expect(alice.documents.get("doc")).toEqual({
      mode: "interpret",
      suspended: false,
    })
    expect(theirs.n()).toBe(42)
  })

  it("a ref held across an unload keeps the sync state it had; the next load starts unsettled", async () => {
    const bridge = new Bridge()
    const alice = createExchange({
      principal: "alice",
      store: createInMemoryStore(),
      transports: [createBridgeTransport({ transportId: "alice", bridge })],
    })
    const bob = createExchange({
      principal: "bob",
      transports: [createBridgeTransport({ transportId: "bob", bridge })],
    })
    bob.get("doc", Fields).title.set("bob's")
    const doc: Doc = alice.get("doc", Fields)
    await whenSettled(doc)
    await alice.flush()
    const before = sync(doc)
    expect(before.ready).toBe(true)
    const peers = before.peerStates.map(state => state.peer.peerId)
    expect(peers).toEqual([bob.peerId])

    alice.unload("doc")
    await alice.flush()
    expect(phaseOf(alice, "doc")).toBe("unloaded")
    expect(sync(doc).ready).toBe(true)
    expect(sync(doc).peerStates.map(state => state.peer.peerId)).toEqual(peers)

    const again: Doc = alice.get("doc", Fields)
    expect(sync(again).ready).toBe(false)
    await whenSettled(again)
    expect(sync(again).ready).toBe(true)
    expect(again.title()).toBe("bob's")
  })
})

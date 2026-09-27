// deletes — a delete reaches every peer, however it was made and whoever holds
// what.
//
// A Yjs delete does not advance the Yjs state vector on its own, so these are
// the cases where a version that orders inserts only would let a peer believe
// it holds everything while missing a delete. Loro clocks deletes natively,
// and runs the concurrent case too, to pin that only Yjs needs help.

import { Bridge, createBridgeTransport } from "@kyneta/bridge-transport"
import { loro } from "@kyneta/loro-schema"
import { batch, Schema, unwrap } from "@kyneta/schema"
import { yjs } from "@kyneta/yjs-schema"
import { afterEach, describe, expect, it } from "vitest"
import * as Y from "yjs"
import { Exchange } from "../exchange.js"
import { whenHydrated } from "../settle.js"
import {
  createInMemoryStore,
  type InMemoryStoreData,
} from "../store/in-memory-store.js"

const TextDoc = Schema.struct({ title: Schema.text() })

const exchanges: Exchange[] = []
afterEach(async () => {
  for (const exchange of exchanges) await exchange.shutdown()
  exchanges.length = 0
})

async function drain(ms = 50): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

function exchangeOn(
  id: string,
  links: ReadonlyArray<{ bridge: Bridge; transportId: string }>,
  store?: InMemoryStoreData,
): Exchange {
  const exchange = new Exchange({
    id,
    transports: links.map(link => createBridgeTransport(link)),
    ...(store ? { stores: [createInMemoryStore({ sharedData: store })] } : {}),
  })
  exchanges.push(exchange)
  return exchange
}

/** A text document on one backend, as `exchange` holds it. */
interface TextBackend<D extends object> {
  readonly name: string
  open(exchange: Exchange): D
  title(doc: D): string
  insert(doc: D, at: number, text: string): void
  remove(doc: D, at: number, length: number): void
}

function concurrentDeleteAndInsert<D extends object>(
  backend: TextBackend<D>,
): void {
  it(`converge (${backend.name})`, async () => {
    // Bob's delete leaves his version where it was on Yjs, while Alice's
    // insert moves hers. An offer judged by that version alone reads Bob as
    // behind, and Alice skips the delete it carries.
    const bridge = new Bridge()
    const alice = exchangeOn("alice", [{ bridge, transportId: "alice" }])
    const bob = exchangeOn("bob", [{ bridge, transportId: "bob" }])
    const a = backend.open(alice)
    const b = backend.open(bob)
    await drain()
    backend.insert(a, 0, "abc")
    await drain()
    expect(backend.title(b)).toBe("abc")

    backend.remove(b, 1, 1)
    backend.insert(a, 3, "X")
    await drain(150)

    expect(backend.title(a)).toBe("acX")
    expect(backend.title(b)).toBe("acX")
  })
}

// The collaborative backends. Plain is single-writer, so two peers writing
// at once is outside its model.
describe("concurrent delete and insert", () => {
  const yjsDoc = yjs.bind(TextDoc)
  const loroDoc = loro.bind(TextDoc)
  concurrentDeleteAndInsert({
    name: "yjs",
    open: exchange => exchange.get("doc", yjsDoc),
    title: doc => doc.title(),
    insert: (doc, at, text) => batch(doc, d => d.title.insert(at, text)),
    remove: (doc, at, length) => batch(doc, d => d.title.delete(at, length)),
  })
  concurrentDeleteAndInsert({
    name: "loro",
    open: exchange => exchange.get("doc", loroDoc),
    title: doc => doc.title(),
    insert: (doc, at, text) => batch(doc, d => d.title.insert(at, text)),
    remove: (doc, at, length) => batch(doc, d => d.title.delete(at, length)),
  })
})

describe("a Yjs delete-only change", () => {
  const bound = yjs.bind(TextDoc)

  it("is relayed to a peer beyond the next one, and persisted", async () => {
    const left = new Bridge()
    const right = new Bridge()
    const store: InMemoryStoreData = { records: new Map(), metadata: new Map() }
    const alice = exchangeOn(
      "alice",
      [{ bridge: left, transportId: "alice" }],
      store,
    )
    const bob = exchangeOn("bob", [
      { bridge: left, transportId: "bob-left" },
      { bridge: right, transportId: "bob-right" },
    ])
    const carol = exchangeOn("carol", [{ bridge: right, transportId: "carol" }])
    const a = alice.get("doc", bound)
    bob.get("doc", bound)
    const c = carol.get("doc", bound)
    await drain()
    batch(a, d => d.title.insert(0, "abc"))
    await drain(100)
    expect(c.title()).toBe("abc")

    batch(a, d => d.title.delete(1, 1))
    await drain(100)
    await alice.flush()

    expect(c.title()).toBe("ac")
    await alice.shutdown()
    const restarted = exchangeOn("alice", [], store)
    const reloaded = restarted.get("doc", bound)
    await whenHydrated(reloaded)
    expect(reloaded.title()).toBe("ac")
  })

  it("made while apart reaches the peer on reconnect", async () => {
    const bridge = new Bridge()
    const alice = exchangeOn("alice", [{ bridge, transportId: "alice" }])
    const bob = exchangeOn("bob", [{ bridge, transportId: "bob" }])
    const a = alice.get("doc", bound)
    const b = bob.get("doc", bound)
    await drain()
    batch(a, d => d.title.insert(0, "abc"))
    await drain()

    await alice.removeTransport("alice")
    batch(a, d => d.title.delete(1, 1))
    await drain(10)
    expect(b.title()).toBe("abc")

    await alice.addTransport(
      createBridgeTransport({ bridge, transportId: "alice" }),
    )
    await drain(150)
    expect(b.title()).toBe("ac")
  })

  it("from a plain Yjs client on a parallel provider reaches a peer only on the exchange", async () => {
    // A plain Yjs document forwards updates to and from Alice's `Y.Doc`, as a
    // provider would. Its delete reaches Alice as a remote transaction that
    // advances no clock.
    const bridge = new Bridge()
    const alice = exchangeOn("alice", [{ bridge, transportId: "alice" }])
    const bob = exchangeOn("bob", [{ bridge, transportId: "bob" }])
    const a = alice.get("doc", bound)
    const b = bob.get("doc", bound)
    await drain()
    batch(a, d => d.title.insert(0, "abc"))
    await drain()

    const aliceDoc = unwrap(a)
    const plain = new Y.Doc()
    Y.applyUpdate(plain, Y.encodeStateAsUpdate(aliceDoc))
    aliceDoc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin !== "provider") Y.applyUpdate(plain, update, "provider")
    })
    plain.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin !== "provider") Y.applyUpdate(aliceDoc, update, "provider")
    })
    const titleKey = [...aliceDoc.getMap("root").entries()].find(
      ([, value]) => value === unwrap(a.title),
    )?.[0]
    if (titleKey === undefined) throw new Error("title not found in the root")
    const plainTitle = plain.getMap("root").get(titleKey)
    if (!(plainTitle instanceof Y.Text)) throw new Error("title is not text")

    await bob.removeTransport("bob")
    plainTitle.delete(1, 1)
    expect(a.title()).toBe("ac")

    await bob.addTransport(
      createBridgeTransport({ bridge, transportId: "bob" }),
    )
    await drain(150)
    expect(b.title()).toBe("ac")
  })
})

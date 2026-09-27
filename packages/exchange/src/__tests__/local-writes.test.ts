// local-writes — a local write leaves the process however it was made.
//
// Editor bindings (y-prosemirror, y-codemirror, loro-prosemirror) write on the
// native document reached through `unwrap`, not through `batch`. Such a write
// is local, so it must reach peers and the store like any other. What leaves
// the process follows the substrate's local-update signal, which fires for
// every local write, including ones the schema's changefeed never sees.

import { Bridge, createBridgeTransport } from "@kyneta/bridge-transport"
import { loro } from "@kyneta/loro-schema"
import { batch, json, Schema, subscribe, unwrap } from "@kyneta/schema"
import { yjs } from "@kyneta/yjs-schema"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Exchange } from "../exchange.js"
import { Runtime } from "../runtime.js"
import { whenHydrated } from "../settle.js"
import {
  createInMemoryStore,
  createInMemoryStoreData,
  type InMemoryStoreData,
} from "../store/in-memory-store.js"

const DocSchema = Schema.struct({
  title: Schema.text(),
  count: Schema.number(),
})

const exchanges: Exchange[] = []
afterEach(async () => {
  for (const exchange of exchanges) await exchange.shutdown()
  exchanges.length = 0
})

async function drain(ms = 50): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

function freshStore(): InMemoryStoreData {
  return createInMemoryStoreData()
}

/** What a test needs to write on, and read from, one backend's documents. */
interface Backend<D extends object> {
  readonly name: string
  open(exchange: Exchange): D
  title(doc: D): string
  /** Write `text` into `title` on the native document, and commit it. */
  writeTitle(doc: D, text: string): void
  /** Write to a native container the schema does not declare, and commit. */
  writeSide(doc: D): void
  /** What that container holds. */
  readSide(doc: D): unknown
}

const yjsDoc = yjs.bind(DocSchema)
const loroDoc = loro.bind(DocSchema)

function localWrites<D extends object>(backend: Backend<D>): void {
  describe(`a local write on the native document (${backend.name})`, () => {
    /** Alice, who keeps a store, connected to Bob. */
    async function pair(store: InMemoryStoreData) {
      const bridge = new Bridge()
      const alice = new Exchange({
        principal: "alice",
        transports: [createBridgeTransport({ transportId: "alice", bridge })],
        store: createInMemoryStore({ sharedData: store }),
      })
      const bob = new Exchange({
        principal: "bob",
        transports: [createBridgeTransport({ transportId: "bob", bridge })],
      })
      exchanges.push(alice, bob)
      const aliceDoc = backend.open(alice)
      const bobDoc = backend.open(bob)
      await drain()
      return { alice, aliceDoc, bobDoc }
    }

    /** Alice's document, as a restarted Alice loads it from her store. */
    async function reload(store: InMemoryStoreData): Promise<D> {
      const restarted = new Exchange({
        principal: "alice",
        store: createInMemoryStore({ sharedData: store }),
      })
      exchanges.push(restarted)
      const doc = backend.open(restarted)
      await whenHydrated(doc)
      return doc
    }

    it("reaches the peer and the store", async () => {
      // The ADR's evidence: this used to leave the write visible locally and
      // nowhere else.
      const store = freshStore()
      const { alice, aliceDoc, bobDoc } = await pair(store)

      backend.writeTitle(aliceDoc, "native")
      await drain()
      await alice.flush()

      expect(backend.title(bobDoc)).toBe("native")
      await alice.shutdown()
      expect(backend.title(await reload(store))).toBe("native")
    })

    it("reaches the peer and the store outside the schema", async () => {
      // No changeset reports this write; the signal is the only thing that
      // sees it.
      const store = freshStore()
      const { alice, aliceDoc, bobDoc } = await pair(store)

      backend.writeSide(aliceDoc)
      await drain()
      await alice.flush()

      expect(backend.readSide(bobDoc)).toEqual(backend.readSide(aliceDoc))
      await alice.shutdown()
      expect(backend.readSide(await reload(store))).toEqual(
        backend.readSide(aliceDoc),
      )
    })
  })
}

localWrites({
  name: "yjs",
  open: exchange => exchange.get("doc", yjsDoc),
  title: doc => doc.title(),
  writeTitle: (doc, text) => unwrap(doc.title).insert(0, text),
  writeSide: doc => unwrap(doc).getArray("side").push([1]),
  readSide: doc => unwrap(doc).getArray("side").toArray(),
})

localWrites({
  name: "loro",
  open: exchange => exchange.get("doc", loroDoc),
  title: doc => doc.title(),
  writeTitle: (doc, text) => {
    unwrap(doc.title).insert(0, text)
    unwrap(doc).commit()
  },
  writeSide: doc => {
    unwrap(doc).getMap("side").set("k", 1)
    unwrap(doc).commit()
  },
  readSide: doc => unwrap(doc).getMap("side").toJSON(),
})

// ===========================================================================
// Written while a merge is applied
// ===========================================================================

/**
 * Bob writes a large body, and Alice writes something small while she takes
 * it in. Each case arranges Alice's write in its own way.
 */
interface DuringMerge<D extends object> {
  readonly name: string
  open(exchange: Exchange): D
  writeBody(doc: D, text: string): void
  /** Arrange Alice's write; it must happen while she merges Bob's. */
  arrange(alice: D): void
  /** Whether Bob holds Alice's write. */
  holdsReply(bob: D): boolean
}

/** Letters no compressor can shrink much: a payload's size is its length. */
function noise(length: number): string {
  let seed = 7
  let text = ""
  for (let i = 0; i < length; i++) {
    seed = (seed * 1103515245 + 12345) % 2 ** 31
    text += String.fromCharCode(97 + (seed % 26))
  }
  return text
}

/**
 * A reply made in a changeset subscriber: on the first merge, `reply` sets
 * `count` to 7 through `batch`.
 */
function kynetaReply<D extends object & { count(): number }>(
  name: string,
  open: (exchange: Exchange) => D,
  writeBody: (doc: D, text: string) => void,
  reply: (doc: D) => void,
): DuringMerge<D> {
  return {
    name: `a subscriber batches in reaction (${name})`,
    open,
    writeBody,
    arrange: alice => {
      let replied = false
      subscribe(alice, changeset => {
        if (!changeset.replay || replied) return
        replied = true
        reply(alice)
      })
    },
    holdsReply: bob => bob.count() === 7,
  }
}

const BODY = 4000

function writtenDuringMerge<D extends object>(c: DuringMerge<D>): void {
  it(`${c.name}: reaches the peer, which is not sent its own write back`, async () => {
    const bridge = new Bridge()
    const alice = new Exchange({
      principal: "alice",
      transports: [createBridgeTransport({ transportId: "alice", bridge })],
    })
    const bob = new Exchange({
      principal: "bob",
      transports: [createBridgeTransport({ transportId: "bob", bridge })],
    })
    exchanges.push(alice, bob)
    const aliceDoc = c.open(alice)
    const bobDoc = c.open(bob)
    await drain()
    c.arrange(aliceDoc)

    let toBob = 0
    const route = bridge.routeBytes.bind(bridge)
    bridge.routeBytes = (from, to, bytes) => {
      if (to === "bob") toBob += bytes.byteLength
      route(from, to, bytes)
    }
    c.writeBody(bobDoc, noise(BODY))
    await drain()

    expect(c.holdsReply(bobDoc)).toBe(true)
    // Alice's reply and her acknowledgement, not the body Bob just sent her.
    expect(toBob).toBeGreaterThan(0)
    expect(toBob).toBeLessThan(BODY / 4)
  })
}

const TextDoc = Schema.struct({
  title: Schema.text(),
  body: Schema.text(),
  count: Schema.number(),
})
const yjsText = yjs.bind(TextDoc)
const loroText = loro.bind(TextDoc)
const plainDoc = json.bind(
  Schema.struct({ body: Schema.string(), count: Schema.number() }),
)

describe("a local write made while a merge is applied", () => {
  writtenDuringMerge({
    name: "a Loro import commits a pending native op (loro)",
    open: ex => ex.get("doc", loroText),
    writeBody: (doc, text) => batch(doc, d => d.body.insert(0, text)),
    // Loro commits pending native ops implicitly when it imports, so this
    // write is committed from inside the merge of Bob's.
    arrange: alice => unwrap(alice.title).insert(0, "pending"),
    holdsReply: bob => bob.title() === "pending",
  })

  writtenDuringMerge({
    name: "a native observer writes in reaction (yjs)",
    open: ex => ex.get("doc", yjsText),
    writeBody: (doc, text) => batch(doc, d => d.body.insert(0, text)),
    arrange: alice => {
      let replied = false
      unwrap(alice)
        .getMap("root")
        .observeDeep((_events, transaction) => {
          if (transaction.local || replied) return
          replied = true
          unwrap(alice.title).insert(0, "reply")
        })
    },
    holdsReply: bob => bob.title() === "reply",
  })

  writtenDuringMerge(
    kynetaReply(
      "plain",
      ex => ex.get("doc", plainDoc),
      (doc, text) => batch(doc, d => d.body.set(text)),
      doc => batch(doc, d => d.count.set(7)),
    ),
  )
  writtenDuringMerge(
    kynetaReply(
      "loro",
      ex => ex.get("doc", loroText),
      (doc, text) => batch(doc, d => d.body.insert(0, text)),
      doc => batch(doc, d => d.count.set(7)),
    ),
  )
  writtenDuringMerge(
    kynetaReply(
      "yjs",
      ex => ex.get("doc", yjsText),
      (doc, text) => batch(doc, d => d.body.insert(0, text)),
      doc => batch(doc, d => d.count.set(7)),
    ),
  )
})

// ===========================================================================
// A destroyed document
// ===========================================================================

describe("a destroyed document", () => {
  it("does not persist or push its successor when written", async () => {
    // A ref outlives `destroy`. If its subscriptions did too, a write on it
    // would mark the id dirty, and the new document created under that id
    // would be persisted and pushed on its behalf.
    const runtime = new Runtime({
      store: createInMemoryStore(),
    })
    const old = runtime.get("doc", yjsDoc)
    await whenHydrated(old)
    runtime.destroy("doc")
    const successor = runtime.get("doc", yjsDoc)
    await whenHydrated(successor)
    await runtime.flush()

    const persisted = vi.spyOn(runtime, "onStateAdvanced")
    batch(old, d => d.count.set(1))
    unwrap(old.title).insert(0, "native")
    await runtime.flush()

    expect(persisted).not.toHaveBeenCalled()
    await runtime.shutdown()
  })
})

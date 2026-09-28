// identity-stability.test.ts — a peer keeps its data and its identity across
// a restart with a store, and a document speaks as its Runtime's seat.
//
// A CRDT addresses each operation by (peer, counter), and the counter restarts
// at zero on a fresh document. So a peer that claims its stable identity on an
// empty document and then writes — before loading its own stored history —
// produces operations at addresses that history already occupies. Merge
// deduplicates by address, and one of the two is discarded silently.
//
// A store issues its Runtime a seat that survives a restart over the same
// storage. That is sound only because every document hydrates before it
// writes under the seat, which these tests pin.

import { loro } from "@kyneta/loro-schema"
import {
  type BoundSchema,
  batch,
  createDocAs,
  Schema,
  unwrap,
} from "@kyneta/schema"
import { yjs, yjsClientId } from "@kyneta/yjs-schema"
import { describe, expect, it } from "vitest"
import { Runtime } from "../runtime.js"
import {
  createInMemoryStore,
  createInMemoryStoreData,
  type InMemoryStoreData,
} from "../store/in-memory-store.js"

const ListSchema = Schema.struct({ items: Schema.list(Schema.string()) })

/** Yjs exposes identity as `clientID`, Loro as `peerIdStr`. */
function identityOf(ref: unknown): string {
  const doc = unwrap(ref as never) as { clientID?: number; peerIdStr?: string }
  return String(doc.clientID ?? doc.peerIdStr)
}

/**
 * One session: open a store over `storage`, open the document, do something
 * with it, shut down.
 */
async function session<T>(
  storage: InMemoryStoreData,
  bound: BoundSchema<typeof ListSchema, never>,
  use: (doc: any, runtime: Runtime) => Promise<T> | T,
): Promise<T> {
  const runtime = new Runtime({
    store: createInMemoryStore({ sharedData: storage }),
  })
  const doc = runtime.get("doc-1", bound)
  const result = await use(doc, runtime)
  await runtime.flush()
  await runtime.shutdown()
  return result
}

describe("stored data survives a write issued before hydration", () => {
  // The load-bearing test, and the symptom a user would report. `get()` returns
  // synchronously, so an application that writes on the same tick it opens a
  // document is inside the window where its stored state has not arrived yet.
  // The second session holds the first one's seat, so its early write is
  // under an identity whose history has not loaded.
  it.each([
    ["yjs", yjs.bind(ListSchema)],
    ["loro", loro.bind(ListSchema)],
  ])("%s", async (_name, bound) => {
    const storage = createInMemoryStoreData()

    const first = await session(storage, bound as never, (doc, runtime) => {
      batch(doc, (d: any) => {
        d.items.push("stored-1")
        d.items.push("stored-2")
      })
      return runtime.peerId
    })

    // Second session writes immediately — no await, no settle check.
    const after = await session(
      storage,
      bound as never,
      async (doc, runtime) => {
        expect(runtime.peerId).toBe(first)
        batch(doc, (d: any) => {
          d.items.push("early-write")
        })
        await runtime.flush()
        return doc.items()
      },
    )

    expect(after).toContain("stored-1")
    expect(after).toContain("stored-2")
    expect(after).toContain("early-write")
  })
})

describe("a restart with a store keeps the peer's identity and its data", () => {
  it.each([
    ["yjs", yjs.bind(ListSchema)],
    ["loro", loro.bind(ListSchema)],
  ])("%s", async (_name, bound) => {
    const storage = createInMemoryStoreData()

    const first = await session(
      storage,
      bound as never,
      async (doc, runtime) => {
        batch(doc, (d: any) => {
          d.items.push("one")
        })
        await runtime.flush()
        return { peerId: runtime.peerId, identity: identityOf(doc) }
      },
    )

    const second = await session(
      storage,
      bound as never,
      async (doc, runtime) => {
        await runtime.flush()
        batch(doc, (d: any) => {
          d.items.push("two")
        })
        await runtime.flush()
        return {
          peerId: runtime.peerId,
          identity: identityOf(doc),
          items: doc.items(),
        }
      },
    )

    expect(second.peerId).toBe(first.peerId)
    expect(second.identity).toBe(first.identity)
    expect(second.items).toEqual(["one", "two"])
  })
})

describe("a document with no store", () => {
  it("speaks as its Runtime's seat immediately, and keeps it", async () => {
    // Nothing to import, so there is nothing to defer for. This pins that the
    // deferral is conditional on hydration rather than applied everywhere.
    const bound = yjs.bind(ListSchema)
    const runtime = new Runtime()
    const doc = runtime.get("doc-1", bound)
    const seat = String(yjsClientId(runtime.peerId))
    expect(identityOf(doc)).toBe(seat)
    await runtime.flush()
    expect(identityOf(doc)).toBe(seat)
    await runtime.shutdown()
  })
})

describe("create() still claims identity", () => {
  // The property the whole design rests on: `create()` is unchanged, so every
  // caller that imports nothing at construction stays correct without knowing
  // any of this happened. This is what fails if someone later collapses the
  // two construction paths back into one.
  //
  // It is also only expressible because `createDocAs` requires a peer to name.
  //
  // Each case binds its schema inside the test rather than receiving it as a
  // parameter: passing a bound schema through one makes TypeScript re-infer
  // `DocRef`'s generics at the call site and trip its instantiation-depth
  // limit on schemas this deep.
  it("yjs", () => {
    const bound = yjs.bind(ListSchema)
    expect(identityOf(createDocAs("alice", bound))).toBe(
      identityOf(createDocAs("alice", bound)),
    )
    expect(identityOf(createDocAs("bob", bound))).not.toBe(
      identityOf(createDocAs("alice", bound)),
    )
  })

  it("loro", () => {
    const bound = loro.bind(ListSchema)
    expect(identityOf(createDocAs("alice", bound))).toBe(
      identityOf(createDocAs("alice", bound)),
    )
    expect(identityOf(createDocAs("bob", bound))).not.toBe(
      identityOf(createDocAs("alice", bound)),
    )
  })
})

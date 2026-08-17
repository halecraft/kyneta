// identity-stability.test.ts — a peer keeps its identity, and its data, across
// a restart.
//
// A CRDT addresses each operation by (peer, counter), and the counter restarts
// at zero on a fresh document. So a peer that claims its stable identity on an
// empty document and then writes — before loading its own stored history —
// produces operations at addresses that history already occupies. Merge
// deduplicates by address, and one of the two is discarded silently.
//
// These tests pin both halves of that: the data must survive, and so must the
// identity.

import { loro } from "@kyneta/loro-schema"
import {
  type BoundSchema,
  batch,
  createDocAs,
  Schema,
  unwrap,
} from "@kyneta/schema"
import { yjs } from "@kyneta/yjs-schema"
import { describe, expect, it } from "vitest"
import { Runtime } from "../runtime.js"
import { createInMemoryStore } from "../store/in-memory-store.js"
import type { Store } from "../store/store.js"

const ListSchema = Schema.struct({ items: Schema.list(Schema.string()) })

/** Yjs exposes identity as `clientID`, Loro as `peerIdStr`. */
function identityOf(ref: unknown): string {
  const doc = unwrap(ref as never) as { clientID?: number; peerIdStr?: string }
  return String(doc.clientID ?? doc.peerIdStr)
}

/** One session: open the document, do something with it, shut down. */
async function session<T>(
  store: Store,
  bound: BoundSchema<typeof ListSchema, never>,
  use: (doc: any, runtime: Runtime) => Promise<T> | T,
): Promise<T> {
  const runtime = new Runtime({ peerId: "alice", stores: [store] })
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
  it.each([
    ["yjs", yjs.bind(ListSchema)],
    ["loro", loro.bind(ListSchema)],
  ])("%s", async (_name, bound) => {
    const store = createInMemoryStore()

    await session(store, bound as never, doc => {
      batch(doc, (d: any) => {
        d.items.push("stored-1")
        d.items.push("stored-2")
      })
    })

    // Second session writes immediately — no await, no settle check.
    const after = await session(store, bound as never, async (doc, runtime) => {
      batch(doc, (d: any) => {
        d.items.push("early-write")
      })
      await runtime.flush()
      return doc.items()
    })

    expect(after).toContain("stored-1")
    expect(after).toContain("stored-2")
    expect(after).toContain("early-write")
  })
})

describe("peer identity survives a restart", () => {
  it.each([
    ["yjs", yjs.bind(ListSchema)],
    ["loro", loro.bind(ListSchema)],
  ])("%s", async (_name, bound) => {
    const store = createInMemoryStore()

    // Read the identity *after* flushing, in both sessions. A store-backed
    // document wears a throwaway identity until its stored state has arrived —
    // that is the whole mechanism here — so sampling before then reads the
    // transient one and compares two pieces of noise.
    const first = await session(store, bound as never, async (doc, runtime) => {
      batch(doc, (d: any) => {
        d.items.push("one")
      })
      await runtime.flush()
      return identityOf(doc)
    })

    // Second session waits for its stored state before looking.
    const second = await session(
      store,
      bound as never,
      async (doc, runtime) => {
        await runtime.flush()
        return { id: identityOf(doc), items: doc.items() }
      },
    )

    expect(second.id).toBe(first)
    // Asserted alongside identity on purpose: a "fix" that stabilised the id by
    // discarding stored state would otherwise pass, and that is worse than the
    // defect it replaced.
    expect(second.items).toEqual(["one"])
  })
})

describe("a document with no store", () => {
  it("has its identity immediately, and keeps it", () => {
    // Nothing to import, so there is nothing to defer for. This pins that the
    // deferral is conditional on hydration rather than applied everywhere.
    const bound = yjs.bind(ListSchema)
    const a = new Runtime({ peerId: "alice" })
    const b = new Runtime({ peerId: "alice" })
    expect(identityOf(a.get("doc-1", bound))).toBe(
      identityOf(b.get("doc-1", bound)),
    )
    a.shutdown()
    b.shutdown()
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

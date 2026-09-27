// identity-stability.test.ts — a peer keeps its data across a restart, and a
// document speaks as its Runtime's seat.
//
// A CRDT addresses each operation by (peer, counter), and the counter restarts
// at zero on a fresh document. So a peer that claims its stable identity on an
// empty document and then writes — before loading its own stored history —
// produces operations at addresses that history already occupies. Merge
// deduplicates by address, and one of the two is discarded silently.
//
// These tests pin that the data survives. The identity does not: every Runtime
// issues itself a fresh seat. PLAN-2026-09-27-durable-seats lets a store keep
// one across restarts, and restores the identity assertion.

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
  const runtime = new Runtime({ store })
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

describe("stored data survives a restart", () => {
  it.each([
    ["yjs", yjs.bind(ListSchema)],
    ["loro", loro.bind(ListSchema)],
  ])("%s", async (_name, bound) => {
    const store = createInMemoryStore()

    await session(store, bound as never, async (doc, runtime) => {
      batch(doc, (d: any) => {
        d.items.push("one")
      })
      await runtime.flush()
    })

    // The second session is a new seat, and waits for its stored state.
    const second = await session(
      store,
      bound as never,
      async (doc, runtime) => {
        await runtime.flush()
        batch(doc, (d: any) => {
          d.items.push("two")
        })
        await runtime.flush()
        return doc.items()
      },
    )

    expect(second).toEqual(["one", "two"])
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

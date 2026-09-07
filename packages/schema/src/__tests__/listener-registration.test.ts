// listener-registration — when a node's own-path listener enters and leaves
// the shared registry.
//
// A ref carrier is not unique per path. Every call to the catamorphism's
// per-id child closure mints a fresh one (see "Per-ref-instance carrier
// multiplication" in `packages/schema/TECHNICAL.md`), and each one wires its
// own changefeed. Registering at carrier-construction time therefore left one
// permanent entry per carrier ever created, with nothing able to remove it:
// JavaScript has no destructor, and the changefeed layer holds no reference to
// the carrier it could weaken. Registration now follows the *subscribers* —
// established on the first, released on the last — so a carrier nobody
// subscribes to never appears in the registry at all.
//
// Most assertions here read the registry directly, which is deliberate and
// matches `with-caching-handler-chain.test.ts` one interpreter over. Delivery
// calls exactly the callbacks that are subscribed either way, so counting
// callbacks passes whether or not dead entries accumulate. The registry's size
// is the only place the difference shows.

import { describe, expect, it } from "vitest"
import {
  batch,
  createDoc,
  Schema,
  subscribe,
  subscribeNode,
} from "../basic/index.js"
import { __getListenerCountAtPath } from "../interpreters/with-changefeed.js"
import { TRANSACT } from "../interpreters/writable.js"
import { RawPath } from "../path.js"

const Doc = Schema.struct({
  top: Schema.number(),
  outer: Schema.struct({ x: Schema.number() }),
  tree: Schema.tree(Schema.struct({ label: Schema.string() })),
})

const topKey = RawPath.empty.field("top").key
const treeKey = RawPath.empty.field("tree").key
const nodeKey = (id: string) => RawPath.empty.field("tree").node(id).key

/** The context the changefeed layer wired itself onto. */
const contextOf = (doc: unknown) => (doc as any)[TRANSACT] as object

// ===========================================================================
// Registration follows subscriptions
// ===========================================================================

describe("the shared registry tracks live subscriptions", () => {
  it("navigating without subscribing registers nothing", () => {
    const doc: any = createDoc(Doc)
    const ctx = contextOf(doc)

    for (let i = 0; i < 100; i++) void doc.top

    expect(__getListenerCountAtPath(ctx, topKey)).toBe(0)
  })

  it("churning tree-node carriers does not accumulate registrations", () => {
    // The workload `TECHNICAL.md` calls common, and the one that accumulated
    // fastest: `d.tree.node(id)` mints a carrier, which registered and was
    // then dropped. Thirty access-and-write cycles used to leave sixty
    // permanent entries at one path key — two per cycle, one for the read
    // carrier and one for the carrier the batch itself navigates to.
    const doc: any = createDoc(Doc)
    const ctx = contextOf(doc)
    let id = ""
    batch(doc, (d: any) => {
      id = d.tree.create(null, { label: "x" })
    })

    for (let i = 0; i < 30; i++) {
      void doc.tree.node(id)
      batch(doc, (d: any) => d.tree.node(id).label.set(`v${i}`))
    }

    expect(__getListenerCountAtPath(ctx, nodeKey(id))).toBe(0)
  })

  it("subscribing registers, and unsubscribing releases", () => {
    const doc: any = createDoc(Doc)
    const ctx = contextOf(doc)

    const unsubscribe = subscribeNode(doc.top, () => {})
    expect(__getListenerCountAtPath(ctx, topKey)).toBe(1)

    unsubscribe()
    expect(__getListenerCountAtPath(ctx, topKey)).toBe(0)
  })

  it("stops delivering after the last subscriber leaves", () => {
    const doc: any = createDoc(Doc)
    let calls = 0
    const unsubscribe = subscribeNode(doc.top, () => {
      calls++
    })
    unsubscribe()

    batch(doc, (d: any) => d.top.set(1))

    expect(calls).toBe(0)
  })
})

// ===========================================================================
// Emptying and refilling
// ===========================================================================

describe("a node that empties and refills", () => {
  it("re-registers rather than going deaf", () => {
    // The regression a `registered` boolean introduces: having released the
    // registration, the node must establish a fresh one instead of assuming
    // its old one is still in the map.
    const doc: any = createDoc(Doc)
    const ctx = contextOf(doc)

    subscribeNode(doc.top, () => {})()

    let calls = 0
    subscribeNode(doc.top, () => {
      calls++
    })
    batch(doc, (d: any) => d.top.set(1))

    expect(calls).toBe(1)
    expect(__getListenerCountAtPath(ctx, topKey)).toBe(1)
  })

  it("survives a teardown being called twice", () => {
    // A doubled teardown must not release the registration that the *next*
    // subscriber established, which is why teardown guards on set membership
    // rather than on set size.
    const doc: any = createDoc(Doc)
    const ctx = contextOf(doc)

    const unsubscribe = subscribeNode(doc.top, () => {})
    unsubscribe()

    let calls = 0
    subscribeNode(doc.top, () => {
      calls++
    })
    unsubscribe()

    batch(doc, (d: any) => d.top.set(1))

    expect(calls).toBe(1)
    expect(__getListenerCountAtPath(ctx, topKey)).toBe(1)
  })

  it("keeps delivering while any subscriber remains", () => {
    const doc: any = createDoc(Doc)
    const ctx = contextOf(doc)
    let first = 0
    let second = 0

    const unsubscribeFirst = subscribeNode(doc.top, () => {
      first++
    })
    subscribeNode(doc.top, () => {
      second++
    })
    unsubscribeFirst()

    batch(doc, (d: any) => d.top.set(1))

    expect(first).toBe(0)
    expect(second).toBe(1)
    expect(__getListenerCountAtPath(ctx, topKey)).toBe(1)
  })
})

// ===========================================================================
// Several carriers at one path
// ===========================================================================

describe("two carriers at the same path", () => {
  it("both deliver, and releasing one does not silence the other", () => {
    // Two carriers now contend over one shared registry key, where before each
    // held its own entry. `doc.tree.node(id)` is the reliable way to mint
    // distinct carriers at one path — struct fields and list items are
    // memoized by `withCaching`, so `doc.top` hands back the same carrier.
    const doc: any = createDoc(Doc)
    let id = ""
    batch(doc, (d: any) => {
      id = d.tree.create(null, { label: "x" })
    })

    // Subscribe at the node's `label` leaf, reached through two independent
    // node carriers. `subscribeNode` is the own-path channel, and a write to
    // `label` is a *descendant* of the node itself — so the node ref is the
    // wrong place to observe it from, while the leaf is exactly right.
    const first = doc.tree.node(id).label
    const second = doc.tree.node(id).label
    expect(first).not.toBe(second)

    let firstCalls = 0
    let secondCalls = 0
    const unsubscribeFirst = subscribeNode(first, () => {
      firstCalls++
    })
    subscribeNode(second, () => {
      secondCalls++
    })

    batch(doc, (d: any) => d.tree.node(id).label.set("a"))
    expect(firstCalls).toBe(1)
    expect(secondCalls).toBe(1)

    unsubscribeFirst()
    batch(doc, (d: any) => d.tree.node(id).label.set("b"))

    expect(firstCalls).toBe(1)
    expect(secondCalls).toBe(2)
  })
})

// ===========================================================================
// The tree's delete scan is not a subscription
// ===========================================================================

describe("the tree's delete scan", () => {
  it("holds its registration whether or not anyone is subscribed", () => {
    // The tree watches every changeset for delete instructions so a vanishing
    // node can be told it is gone. That is a side effect on the changeset, not
    // a subscription, so it registers eagerly and is never released.
    const doc: any = createDoc(Doc)
    const ctx = contextOf(doc)

    // Nothing is registered before the tree is navigated to, because no tree
    // carrier exists yet — refs are built on demand by the catamorphism.
    expect(__getListenerCountAtPath(ctx, treeKey)).toBe(0)

    void doc.tree
    expect(__getListenerCountAtPath(ctx, treeKey)).toBe(1)
  })

  it("still delivers a terminal to a subscriber on the deleted node", () => {
    const doc: any = createDoc(Doc)
    let id = ""
    batch(doc, (d: any) => {
      id = d.tree.create(null, { label: "x" })
    })

    const terminals: unknown[] = []
    subscribe(doc.tree.node(id), (changeset: any) => {
      terminals.push(changeset)
    })

    batch(doc, (d: any) => d.tree.delete(id))

    expect(terminals.length).toBeGreaterThan(0)
    const last: any = terminals[terminals.length - 1]
    expect(last.changes[0].change.type).toBe("tree")
    expect(last.changes[0].change.instructions[0].action).toBe("delete")
  })

  it("fires when nobody is subscribed to the tree node", () => {
    // The scan used to ride along inside the tree's own fan-out shim, which
    // existed for as long as the carrier did. With the shim gone, the scan
    // needs its own registration or it disappears the moment the tree has no
    // subscribers — and this is how that regression would show.
    const doc: any = createDoc(Doc)
    let id = ""
    batch(doc, (d: any) => {
      id = d.tree.create(null, { label: "x" })
    })

    const deletes: unknown[] = []
    subscribe(doc, (changeset: any) => {
      for (const op of changeset.changes) {
        if (op.change.type !== "tree") continue
        for (const inst of op.change.instructions) {
          if (inst.action === "delete") deletes.push(inst)
        }
      }
    })

    batch(doc, (d: any) => d.tree.delete(id))

    expect(deletes).toHaveLength(1)
  })
})

// ===========================================================================
// Changing the subscriber set while a changeset is being delivered
// ===========================================================================

describe("subscribing from inside a callback", () => {
  // The reason delivery snapshots each subscriber set before calling into it.
  //
  // A `Set` being iterated live visits entries added during the iteration, so
  // a subscriber registered from inside a callback would receive the changeset
  // that was already in flight — one planned, and committed to the substrate,
  // before it existed. Someone subscribing at a *different* path in the same
  // callback gets nothing, because `planDelivery` ran to completion before any
  // callback fired. Snapshotting makes the same-path case agree.

  it("does not deliver the in-flight changeset to the new own-path subscriber", () => {
    const doc: any = createDoc(Doc)
    let lateCalls = 0
    let subscribed = false

    subscribeNode(doc.top, () => {
      if (subscribed) return
      subscribed = true
      subscribeNode(doc.top, () => {
        lateCalls++
      })
    })

    batch(doc, (d: any) => d.top.set(1))

    expect(lateCalls).toBe(0)

    // And it is a real subscription — the next batch reaches it.
    batch(doc, (d: any) => d.top.set(2))
    expect(lateCalls).toBe(1)
  })

  it("does not deliver the in-flight changeset to the new deep subscriber", () => {
    const doc: any = createDoc(Doc)
    let lateCalls = 0
    let subscribed = false

    subscribe(doc.outer, () => {
      if (subscribed) return
      subscribed = true
      subscribe(doc.outer, () => {
        lateCalls++
      })
    })

    batch(doc, (d: any) => d.outer.x.set(1))

    expect(lateCalls).toBe(0)
  })
})

describe("unsubscribing a peer from inside a callback", () => {
  // The other half of iterating live: removing an entry the loop has not
  // reached yet skips it silently. Snapshotting means the batch already in
  // flight still reaches everyone who was subscribed when it was planned, and
  // the unsubscribe takes effect from the next one.

  it("still delivers the in-flight changeset to that peer", () => {
    const doc: any = createDoc(Doc)
    let secondCalls = 0
    let unsubscribeSecond: (() => void) | undefined

    subscribeNode(doc.top, () => {
      unsubscribeSecond?.()
    })
    unsubscribeSecond = subscribeNode(doc.top, () => {
      secondCalls++
    })

    batch(doc, (d: any) => d.top.set(1))
    expect(secondCalls).toBe(1)

    batch(doc, (d: any) => d.top.set(2))
    expect(secondCalls).toBe(1)
  })
})

// ===========================================================================
// Delivery itself is unchanged
// ===========================================================================

describe("delivery across a multi-path batch", () => {
  it("reaches both channels with the same contents as before", () => {
    // The cheapest guard that this stayed a lifecycle change. `descendant-
    // delivery.test.ts` owns the delivery contract in full; this pins that
    // both channels still work at all once registration moved.
    const doc: any = createDoc(Doc)
    const deep: any[] = []
    const own: any[] = []
    subscribe(doc, (changeset: any) => deep.push(changeset))
    subscribeNode(doc.outer.x, (changeset: any) => own.push(changeset))

    batch(doc, (d: any) => {
      d.top.set(1)
      d.outer.x.set(2)
    })

    expect(deep).toHaveLength(1)
    expect(deep[0].changes.map((op: any) => op.path.format())).toEqual([
      "top",
      "outer.x",
    ])
    expect(own).toHaveLength(1)
    expect(own[0].changes).toHaveLength(1)
  })
})

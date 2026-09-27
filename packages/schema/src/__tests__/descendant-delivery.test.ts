// descendant-delivery — the contract of `subscribeDescendants`.
//
// "Tell me about changes at this node or anywhere beneath it." Simple to state,
// and the details are what consumers actually depend on: how many changesets
// arrive per batch, what path each change carries, and whether a subscription
// keeps working after the document changes shape.
//
// That last one is the reason this file exists. Descendant delivery used to be
// a graph of subscriptions between ref objects, rebuilt by hand whenever the
// document's shape changed. A `.nullable()` field swaps its carrier when the
// variant shifts, and nothing rebuilt the graph for that case — so subscribing
// before an optional field was populated meant never hearing about writes
// inside it, permanently. Delivery is now derived from paths at flush time, so
// there is no graph to go stale.
//
// The batching and relative-path cases are pinned here because they are easy to
// "tidy" into something subtly different. What they pin changed in 4.0: a batch
// now reaches each subscriber as one changeset covering its whole subtree, in
// dispatch order, rather than one changeset per changed path.

import type { Changeset } from "@kyneta/changefeed"
import { describe, expect, it } from "vitest"
import type { Op } from "../basic/index.js"
import {
  batch,
  createDoc,
  Schema,
  subscribe,
  subscribeNode,
} from "../basic/index.js"
import { remove } from "../index.js"

const Inner = Schema.struct({ from: Schema.number(), to: Schema.number() })

const Doc = Schema.struct({
  optional: Inner.nullable(),
  outer: Schema.struct({ x: Schema.number(), y: Schema.number() }),
  top: Schema.number(),
  items: Schema.list(Schema.struct({ title: Schema.string() })),
  entries: Schema.record(Schema.number()),
})

/** Collect the relative path of every change a subscriber receives. */
function record(ref: unknown): {
  paths: string[]
  changesets: Changeset<Op>[]
} {
  const paths: string[] = []
  const changesets: Changeset<Op>[] = []
  subscribe(ref, changeset => {
    changesets.push(changeset)
    for (const change of changeset.changes) paths.push(change.path.format())
  })
  return { paths, changesets }
}

// A `.nullable()` field types as `ScalarRef<T | null>` and exposes no members of
// its own, so reaching a leaf inside one is a compile error even though the
// runtime proxy resolves the variant by value and allows it.
const inner = (ref: unknown) => ref as any

// ===========================================================================
// Reshaping the document must not orphan a subscriber
// ===========================================================================

describe("a subscription survives the document changing shape", () => {
  it("a sum populated AFTER subscribing still reports interior writes", () => {
    const doc: any = createDoc(Doc)
    // Subscribing first is the case that used to break, and it is not exotic:
    // the Exchange wires its document subscription at creation time, before
    // anything has been written, so every synced document is in this state.
    const seen = record(doc)

    batch(doc, (writable: any) => writable.optional.set({ from: 1, to: 7 }))
    batch(doc, (writable: any) => inner(writable.optional).to.set(2))

    expect(doc.optional()).toEqual({ from: 1, to: 2 })
    expect(seen.paths).toEqual(["optional", "optional.to"])
  })

  it("keeps reporting across a null round-trip", () => {
    const doc: any = createDoc(Doc)
    const seen = record(doc)

    batch(doc, (writable: any) => writable.optional.set({ from: 1, to: 7 }))
    batch(doc, (writable: any) => inner(writable.optional).to.set(2))
    batch(doc, (writable: any) => writable.optional.set(null))
    batch(doc, (writable: any) => writable.optional.set({ from: 5, to: 5 }))
    batch(doc, (writable: any) => inner(writable.optional).to.set(6))

    expect(doc.optional()).toEqual({ from: 5, to: 6 })
    expect(seen.paths.filter(path => path === "optional.to")).toHaveLength(2)
  })

  it("an insert before a subscribed list item does not detach it", () => {
    const doc: any = createDoc(Doc)
    batch(doc, (writable: any) => writable.items.push({ title: "first" }))

    // Subscribe to the item, then push a new item in front of it. Its index
    // moves; its identity does not.
    const item = doc.items.at(0)
    const seen = record(item)

    batch(doc, (writable: any) =>
      writable.items.insert(0, { title: "inserted" }),
    )
    batch(doc, (writable: any) => writable.items.at(1).title.set("renamed"))

    expect(doc.items.at(1).title()).toBe("renamed")
    expect(seen.paths).toContain("title")
  })

  it("a record entry removed and re-added still reports", () => {
    const doc: any = createDoc(Doc)
    const seen = record(doc)

    batch(doc, (writable: any) => writable.entries.set("a", 1))
    batch(doc, (writable: any) => remove(writable.entries.at("a")))
    batch(doc, (writable: any) => writable.entries.set("a", 2))

    expect(doc.entries()).toEqual({ a: 2 })
    expect(seen.changesets.length).toBeGreaterThanOrEqual(3)
  })
})

// ===========================================================================
// Delivery shape — what consumers depend on
// ===========================================================================

describe("delivery shape", () => {
  it("delivers one changeset PER SUBSCRIBER, not one per changed path", () => {
    // Three writes in one batch reach this subscriber as one changeset of
    // three ops, in the order they were dispatched.
    //
    // This file used to pin the opposite, on the grounds that merging "would
    // break `@kyneta/reactive` and `@kyneta/index`, which consume this shape."
    // Neither does. `@kyneta/index` subscribes only through `subscribeNode`
    // (see the "subscribeNode, NOT subscribe" note in its `source.ts`), which
    // is the own-path channel and is unaffected. `@kyneta/reactive` passes
    // `onInvalidate` to the deep channel and discards the changeset entirely,
    // so fewer, larger changesets are strictly less work for it.
    const doc: any = createDoc(Doc)
    const seen = record(doc)

    batch(doc, (writable: any) => {
      writable.outer.x.set(1)
      writable.outer.y.set(2)
      writable.top.set(3)
    })

    expect(seen.changesets).toHaveLength(1)
    expect(seen.changesets[0]?.changes).toHaveLength(3)
    // Not sorted — dispatch order is the contract.
    expect(seen.paths).toEqual(["outer.x", "outer.y", "top"])
  })

  it("paths are relative to the subscription point", () => {
    const doc: any = createDoc(Doc)
    const atRoot = record(doc)
    const atOuter = record(doc.outer)
    const atLeaf = record(doc.outer.x)

    batch(doc, (writable: any) => writable.outer.x.set(9))

    expect(atRoot.paths).toEqual(["outer.x"])
    expect(atOuter.paths).toEqual(["x"])
    // The subscribed node itself. A leaf is a tree of size one, so its own
    // change is its whole subtree, carried at the empty relative path — which
    // `format()` renders as "root".
    expect(atLeaf.paths).toEqual(["root"])
    expect(atLeaf.changesets[0]?.changes[0]?.path.length).toBe(0)
  })

  it("relative paths work through a list index", () => {
    const doc: any = createDoc(Doc)
    batch(doc, (writable: any) => writable.items.push({ title: "a" }))

    const atRoot = record(doc)
    const atItem = record(doc.items.at(0))

    batch(doc, (writable: any) => writable.items.at(0).title.set("b"))

    expect(atItem.paths).toEqual(["title"])
    expect(atRoot.paths).toHaveLength(1)
    expect(atRoot.paths[0]).toContain("title")
  })
})

// ===========================================================================
// One batch, one changeset per subscriber
// ===========================================================================

describe("a batch is one unit of delivery", () => {
  // The example `packages/schema/TECHNICAL.md` has used to describe this
  // contract since the descendant-delivery rewrite. Promoted to an executable
  // pin so the claim is anchored to something that runs.
  it("delivers the documented shape: one changeset to every level", () => {
    const doc: any = createDoc(Doc)
    batch(doc, (d: any) => d.items.push({ title: "a" }))

    const atRoot = record(doc)
    const atItems = record(doc.items)
    const atItem = record(doc.items.at(0))
    const atTitle = record(doc.items.at(0).title)

    batch(doc, (d: any) => {
      d.items.at(0).title.set("b")
      d.top.set(7)
    })

    // The root sees both writes together; the deeper subscribers see only
    // what lies in their own subtree.
    expect(atRoot.changesets).toHaveLength(1)
    expect(atRoot.changesets[0]?.changes).toHaveLength(2)
    expect(atItems.changesets).toHaveLength(1)
    expect(atItem.changesets).toHaveLength(1)
    expect(atTitle.changesets).toHaveLength(1)
    expect(atTitle.paths).toEqual(["root"])
  })

  it("keeps ops in dispatch order, not grouped by path", () => {
    const doc: any = createDoc(Doc)
    const seen = record(doc)

    batch(doc, (d: any) => {
      d.outer.x.set(1)
      d.top.set(2)
      d.outer.y.set(3)
    })

    expect(seen.paths).toEqual(["outer.x", "top", "outer.y"])
  })

  it("keeps an ancestor write between the two descendant writes it separates", () => {
    // Grouping by path would float `outer` past both `outer.x` writes, and
    // replaying that order reaches a different state than the writes produced.
    const doc: any = createDoc(Doc)
    const seen = record(doc)

    batch(doc, (d: any) => {
      d.outer.x.set(1)
      d.outer.set({ x: 9, y: 9 })
      d.outer.x.set(2)
    })

    expect(seen.paths).toEqual(["outer.x", "outer", "outer.x"])
  })

  it("fires deep subscribers deepest-first", () => {
    const doc: any = createDoc(Doc)
    const order: string[] = []
    subscribe(doc, () => order.push("root"))
    subscribe(doc.outer, () => order.push("outer"))

    batch(doc, (d: any) => {
      d.top.set(1)
      d.outer.x.set(2)
    })

    expect(order).toEqual(["outer", "root"])
  })

  it("fires every own-path callback before any deep callback", () => {
    // The one ordering this change deliberately alters. Delivery used to
    // interleave the channels per changed path; planning before firing groups
    // them instead. Pinned so the trade stays visible.
    const doc: any = createDoc(Doc)
    const order: string[] = []
    subscribe(doc, () => order.push("deep:root"))
    subscribeNode(doc.top, () => order.push("own:top"))
    subscribeNode(doc.outer.x, () => order.push("own:outer.x"))

    batch(doc, (d: any) => {
      d.top.set(1)
      d.outer.x.set(2)
    })

    expect(order).toEqual(["own:top", "own:outer.x", "deep:root"])
  })

  it("merges a node's own change with its descendants' into one changeset", () => {
    const doc: any = createDoc(Doc)
    const atOuter = record(doc.outer)

    batch(doc, (d: any) => {
      d.outer.set({ x: 1, y: 2 })
      d.outer.x.set(3)
    })

    expect(atOuter.changesets).toHaveLength(1)
    // The node's own change carries the empty relative path, rendered "root".
    expect(atOuter.paths).toEqual(["root", "x"])
  })

  it("leaves the own-path channel untouched", () => {
    const doc: any = createDoc(Doc)
    const seen: Changeset<Op>[] = []
    subscribeNode(doc.outer.x, cs => seen.push(cs as any))

    batch(doc, (d: any) => {
      d.outer.x.set(1)
      d.outer.x.set(2)
      d.top.set(3)
    })

    // Two changes at this node, one changeset, and nothing from `top`.
    expect(seen).toHaveLength(1)
    expect(seen[0]?.changes).toHaveLength(2)
  })

  it("carries aborted and the whole op trace when a batch throws", () => {
    const doc: any = createDoc(Doc)
    const seen = record(doc)

    expect(() =>
      batch(doc, (d: any) => {
        d.top.set(1)
        d.outer.x.set(2)
        throw new Error("boom")
      }),
    ).toThrow("boom")

    // One changeset, flagged, holding forward and inverse entries that net to
    // identity at every path.
    expect(seen.changesets).toHaveLength(1)
    expect(seen.changesets[0]?.aborted).toBe(true)
    expect(seen.changesets[0]?.changes.length).toBeGreaterThan(2)
  })

  it("shares one changeset object across every callback at a key", () => {
    const doc: any = createDoc(Doc)
    const received: Changeset<Op>[] = []
    subscribe(doc, cs => received.push(cs))
    subscribe(doc, cs => received.push(cs))

    batch(doc, (d: any) => d.top.set(1))

    expect(received).toHaveLength(2)
    expect(received[0]).toBe(received[1])
  })

  it("commits to the substrate before any subscriber runs", () => {
    // `wrappedFlush` calls the substrate's flush before delivering, so a
    // subscriber reading document state sees the finished batch.
    const doc: any = createDoc(Doc)
    let seenTop: number | undefined
    subscribe(doc, () => {
      seenTop = doc.top()
    })

    batch(doc, (d: any) => {
      d.top.set(41)
      d.top.set(42)
    })

    expect(seenTop).toBe(42)
  })

  it("puts a re-entrant batch's changes in a separate changeset", () => {
    const doc: any = createDoc(Doc)
    const seen = record(doc)
    let reentered = false

    subscribe(doc, () => {
      if (reentered) return
      reentered = true
      batch(doc, (d: any) => d.top.set(99))
    })

    batch(doc, (d: any) => d.outer.x.set(1))

    // The originating batch, then the re-entrant one in a fresh sub-tick.
    expect(seen.changesets).toHaveLength(2)
    expect(seen.changesets[0]?.changes[0]?.path.format()).toBe("outer.x")
    expect(seen.changesets[1]?.changes[0]?.path.format()).toBe("top")
  })
})

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
// "tidy" into something subtly different, and `@kyneta/reactive` and
// `@kyneta/index` both consume the exact shape.

import type { Changeset } from "@kyneta/changefeed"
import { describe, expect, it } from "vitest"
import type { Op } from "../basic/index.js"
import { batch, createDoc, Schema, subscribe } from "../basic/index.js"
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
  it("delivers one changeset PER CHANGED PATH, not one per batch", () => {
    // Three writes in one batch produce three changesets, each with one change.
    // Grouping them into a single changeset would be tidier and would break
    // `@kyneta/reactive` and `@kyneta/index`, which consume this shape.
    const doc: any = createDoc(Doc)
    const seen = record(doc)

    batch(doc, (writable: any) => {
      writable.outer.x.set(1)
      writable.outer.y.set(2)
      writable.top.set(3)
    })

    expect(seen.changesets).toHaveLength(3)
    expect(
      seen.changesets.every(changeset => changeset.changes.length === 1),
    ).toBe(true)
    expect(seen.paths.sort()).toEqual(["outer.x", "outer.y", "top"])
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

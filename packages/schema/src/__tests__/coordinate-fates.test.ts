// Refs obey the identity rule: one carrier per coordinate, alive exactly
// while the coordinate exists.

import { describe, expect, it } from "vitest"
import { batch, createDoc, Schema } from "../basic/index.js"
import { hasRemove } from "../interpreters/writable.js"
import { deleted } from "../ref/address.js"

const Doc = Schema.struct({
  outer: Schema.struct({
    mode: Schema.discriminatedUnion("type", [
      Schema.struct({
        type: Schema.string("a"),
        a: Schema.struct({ n: Schema.number() }),
      }),
      Schema.struct({ type: Schema.string("b"), b: Schema.string() }),
    ]),
    opt: Schema.struct({ x: Schema.number() }).nullable(),
    items: Schema.list(Schema.struct({ tags: Schema.list(Schema.string()) })),
    m: Schema.record(
      Schema.struct({
        n: Schema.number(),
        tags: Schema.list(Schema.string()),
        sub: Schema.record(Schema.number()),
      }),
    ),
  }),
  tree: Schema.tree(Schema.struct({ label: Schema.string() })),
})

const entry = (n: number) => ({ n, tags: ["t"], sub: { s: 1 } })

function fixture() {
  const doc: any = createDoc(Doc)
  doc.outer.set({
    mode: { type: "a", a: { n: 1 } },
    opt: { x: 1 },
    items: [{ tags: ["p", "q"] }, { tags: [] }],
    m: { k: entry(1), j: entry(2) },
  })
  return doc
}

describe("one carrier per coordinate", () => {
  it("product fields, including sums and nullables, keep their identity across a replace of their parent", () => {
    const doc = fixture()
    const mode = doc.outer.mode
    const opt = doc.outer.opt
    const items = doc.outer.items
    doc.outer.set({ mode: { type: "b", b: "x" }, opt: null, items: [], m: {} })
    expect(doc.outer.mode).toBe(mode)
    expect(doc.outer.opt).toBe(opt)
    expect(doc.outer.items).toBe(items)
  })

  it("a tree node has one carrier", () => {
    const doc = fixture()
    const id = doc.tree.create({ data: { label: "x" } })
    expect(doc.tree.node(id)).toBe(doc.tree.node(id))
  })
})

describe("a coordinate lives exactly while it exists", () => {
  it("a map key a parent replace removes is dead, and at() no longer finds it", () => {
    const doc = fixture()
    const k = doc.outer.m.at("k")
    doc.outer.set({
      mode: { type: "a", a: { n: 1 } },
      opt: null,
      items: [],
      m: { j: entry(2) },
    })
    expect(doc.outer.m.at("k")).toBeUndefined()
    expect(deleted(k)).toBe(true)
  })

  it("a list item inside a rewritten subtree dies, and at() mints a new carrier", () => {
    const doc = fixture()
    const first = doc.outer.items.at(0)
    doc.outer.set({
      mode: { type: "a", a: { n: 1 } },
      opt: null,
      items: [{ tags: ["r"] }],
      m: {},
    })
    expect(deleted(first)).toBe(true)
    expect(doc.outer.items.at(0)).not.toBe(first)
    expect(doc.outer.items.at(0).tags()).toEqual(["r"])
  })

  it("deleting an item kills the refs nested inside it", () => {
    const doc = fixture()
    const tag = doc.outer.items.at(0).tags.at(0)
    const tags = doc.outer.items.at(0).tags
    doc.outer.items.delete(0)
    expect(deleted(tag)).toBe(true)
    expect(deleted(tags)).toBe(true)
  })

  it("a tree node's data field dies with its node", () => {
    const doc = fixture()
    const id = doc.tree.create({ data: { label: "x" } })
    const label = doc.tree.node(id).label
    doc.tree.delete(id)
    expect(deleted(label)).toBe(true)
    expect(doc.tree.node(id)).toBeUndefined()
  })

  it("an inactive variant's field is dead, and revives with the same identity", () => {
    const doc = fixture()
    const a = doc.outer.mode.a
    const n = doc.outer.mode.a.n
    doc.outer.mode.set({ type: "b", b: "x" })
    expect(deleted(a)).toBe(true)
    expect(deleted(n)).toBe(true)

    doc.outer.mode.set({ type: "a", a: { n: 5 } })
    expect(deleted(a)).toBe(false)
    expect(deleted(n)).toBe(false)
    expect(doc.outer.mode.a).toBe(a)
    expect(doc.outer.mode.a.n).toBe(n)
    expect(n()).toBe(5)
  })

  it("a null nullable's fields are dead, and revive with the same identity", () => {
    const doc = fixture()
    const x = doc.outer.opt.x
    doc.outer.opt.set(null)
    expect(deleted(x)).toBe(true)
    doc.outer.opt.set({ x: 3 })
    expect(deleted(x)).toBe(false)
    expect(doc.outer.opt.x).toBe(x)
    expect(x()).toBe(3)
  })

  it("a deleted key set again revives its ref, with the same identity, and what was kept below it", () => {
    const doc = fixture()
    const k = doc.outer.m.at("k")
    const n = k.n
    const s = k.sub.at("s")
    const tag = k.tags.at(0)
    doc.outer.m.delete("k")
    expect(deleted(k)).toBe(true)
    expect(deleted(n)).toBe(true)
    expect(deleted(s)).toBe(true)
    expect(deleted(tag)).toBe(true)

    doc.outer.m.set("k", entry(7))
    expect(doc.outer.m.at("k")).toBe(k)
    expect(deleted(k)).toBe(false)
    expect(k.n).toBe(n)
    expect(deleted(n)).toBe(false)
    expect(n()).toBe(7)
    // A map entry below revives with its key.
    expect(deleted(s)).toBe(false)
    expect(k.sub.at("s")).toBe(s)
    // A list item never comes back.
    expect(deleted(tag)).toBe(true)
    expect(k.tags.at(0)).not.toBe(tag)
  })

  it("a map clear with set keeps the re-set key's ref, and settles what is below it by existence", () => {
    const doc = fixture()
    const k = doc.outer.m.at("k")
    const j = doc.outer.m.at("j")
    const n = k.n
    const s = k.sub.at("s")
    const tag = k.tags.at(0)
    batch(doc, (d: any) => {
      d.outer.m.clear()
      d.outer.m.set("k", { n: 3, tags: ["t"], sub: {} })
    })
    expect(deleted(k)).toBe(false)
    expect(doc.outer.m.at("k")).toBe(k)
    expect(deleted(j)).toBe(true)
    expect(deleted(n)).toBe(false)
    expect(deleted(s)).toBe(true)
    expect(deleted(tag)).toBe(true)
  })

  it("direct deletes and in-place edits behave as before", () => {
    const doc = fixture()
    const first = doc.outer.items.at(0)
    const second = doc.outer.items.at(1)
    doc.outer.items.delete(0)
    expect(deleted(first)).toBe(true)
    expect(doc.outer.items.at(0)).toBe(second)
    const j = doc.outer.m.at("j")
    j.n.set(9)
    expect(doc.outer.m.at("j")).toBe(j)
    expect(deleted(j)).toBe(false)
  })

  it("same-named fields of different kinds across a variant switch", () => {
    const Shape = Schema.struct({
      shape: Schema.discriminatedUnion("type", [
        Schema.struct({
          type: Schema.string("s"),
          x: Schema.struct({ p: Schema.number() }),
        }),
        Schema.struct({
          type: Schema.string("r"),
          x: Schema.record(Schema.number()),
        }),
      ]),
    })
    const doc: any = createDoc(Shape)
    doc.shape.set({ type: "s", x: { p: 1 } })
    const p = doc.shape.x.p
    expect(p()).toBe(1)

    doc.shape.set({ type: "r", x: { p: 2, q: 3 } })
    expect(deleted(p)).toBe(true)
    expect(doc.shape.x()).toEqual({ p: 2, q: 3 })
    expect(doc.shape.x.at("p")()).toBe(2)
    expect(deleted(doc.shape.x.at("p"))).toBe(false)
  })
})

describe("[REMOVE] goes exactly on the children of lists, maps and sets", () => {
  it("is on list items and map entries, not on tree nodes or product fields", () => {
    const doc = fixture()
    expect(hasRemove(doc.outer.items.at(0))).toBe(true)
    expect(hasRemove(doc.outer.m.at("k"))).toBe(true)
    const id = doc.tree.create({ data: { label: "x" } })
    expect(hasRemove(doc.tree.node(id))).toBe(false)
    expect(hasRemove(doc.outer.opt)).toBe(false)
    expect(hasRemove(doc.outer.m.at("k").n)).toBe(false)
  })
})

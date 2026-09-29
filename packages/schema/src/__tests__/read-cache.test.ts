// read-cache — a read keeps its identity until what it read changes.
import { describe, expect, it } from "vitest"
import { batch, createDoc, Schema } from "../basic/index.js"
import { TRANSACT } from "../interpreters/writable.js"
import { __countCachedReads } from "../read-cache.js"

const Doc = Schema.struct({
  title: Schema.string(),
  items: Schema.list(
    Schema.struct({
      title: Schema.string(),
      tags: Schema.list(Schema.string()),
    }),
  ),
  m: Schema.record(Schema.struct({ n: Schema.number() })),
  opt: Schema.struct({ x: Schema.number() }).nullable(),
  tree: Schema.tree(Schema.struct({ label: Schema.string() })),
  s: Schema.set(Schema.struct({ n: Schema.number() })),
})

function fixture() {
  const doc: any = createDoc(Doc)
  batch(doc, (d: any) => {
    d.title.set("t")
    d.items.push({ title: "a", tags: [] }, { title: "b", tags: [] })
    d.m.set("k", { n: 1 })
    d.m.set("j", { n: 2 })
  })
  return doc
}

const contextOf = (doc: any) => doc[TRANSACT] as object

describe("a read is stable", () => {
  it("with no write in between, ref() === ref(), at the root and below", () => {
    const doc = fixture()
    expect(doc()).toBe(doc())
    expect(doc.items()).toBe(doc.items())
    expect(doc.items.at(0)()).toBe(doc.items.at(0)())
    expect(doc.m()).toBe(doc.m())
  })

  it("a write rewrites its path and ancestors, and shares every other subtree", () => {
    const doc = fixture()
    const before = doc()
    doc.items.at(1).title.set("B")
    const after = doc()
    expect(after).not.toBe(before)
    expect(after.items).not.toBe(before.items)
    expect(after.items[1]).not.toBe(before.items[1])
    expect(after.items[0]).toBe(before.items[0])
    expect(after.m).toBe(before.m)
    expect(after.items[1].tags).toBe(before.items[1].tags)
  })
})

describe("sequences", () => {
  it("an insert before an item keeps that item's read", () => {
    const doc = fixture()
    const first = doc.items.at(0)()
    doc.items.insert(0, { title: "z", tags: [] })
    expect(doc.items.at(1)()).toBe(first)
    expect(doc.items()[1]).toBe(first)
  })

  it("a deleted item's read leaves with it", () => {
    const doc = fixture()
    doc()
    const before = __countCachedReads(contextOf(doc))
    doc.items.delete(0)
    doc()
    // The deleted item held two reads (itself and its tags); the root and
    // `items` were rewritten and read again.
    expect(__countCachedReads(contextOf(doc))).toBe(before - 2)
  })
})

describe("maps", () => {
  it("set, delete and clear rewrite only the keys they name", () => {
    const doc = fixture()
    const j = doc.m.at("j")()
    doc.m.set("k", { n: 5 })
    expect(doc.m.at("j")()).toBe(j)
    doc.m.delete("k")
    expect(doc.m.at("j")()).toBe(j)
    expect(doc.m()).toEqual({ j: { n: 2 } })
    doc.m.clear()
    expect(doc.m()).toEqual({})
  })
})

describe("replacement and sums", () => {
  it("a struct set rewrites its whole subtree", () => {
    const doc = fixture()
    const items = doc.items()
    batch(doc, (d: any) => d.items.at(0).set({ title: "x", tags: ["q"] }))
    expect(doc.items()).not.toBe(items)
    expect(doc.items.at(0)()).toEqual({ title: "x", tags: ["q"] })
  })

  it("a nullable shifting null → object → null reads correctly", () => {
    const doc = fixture()
    expect(doc.opt()).toBe(null)
    doc.opt.set({ x: 1 })
    expect(doc.opt()).toEqual({ x: 1 })
    expect(doc.opt()).toBe(doc.opt())
    doc.opt.set(null)
    expect(doc.opt()).toBe(null)
  })
})

describe("trees", () => {
  it("a move keeps each node's data read; a delete drops it", () => {
    const doc = fixture()
    const a = doc.tree.create({ data: { label: "a" } })
    const b = doc.tree.create({ data: { label: "b" } })
    const data = doc.tree.node(a)()
    doc.tree.move(a, { parent: b, index: 0 })
    expect(doc.tree.node(a)()).toBe(data)
    const tree = doc.tree()
    expect(tree.find((n: any) => n.id === a).data).toBe(data)
    doc.tree.delete(a)
    expect(doc.tree.node(a)).toBeUndefined()
    expect(doc.tree().map((n: any) => n.id)).toEqual([b])
  })
})

describe("batches", () => {
  it("a write inside a batch is visible to a read in the same batch", () => {
    const doc = fixture()
    doc()
    batch(doc, (d: any) => {
      d.title.set("new")
      expect(doc.title()).toBe("new")
      expect(doc().title).toBe("new")
    })
  })

  it("an aborted batch leaves doc() equal to its value before", () => {
    const doc = fixture()
    const before = doc()
    expect(() =>
      batch(doc, (d: any) => {
        d.items.at(0).title.set("x")
        d.m.delete("k")
        expect(doc().m).toEqual({ j: { n: 2 } })
        throw new Error("abort")
      }),
    ).toThrow("abort")
    expect(doc()).toEqual(before)
  })
})

describe("freezing", () => {
  it("mutating a read throws", () => {
    const doc = fixture()
    expect(() => {
      doc().items[0].title = "x"
    }).toThrow(TypeError)
    expect(() => doc.items().push({})).toThrow(TypeError)
  })

  it("a read handed back to a write is copied, and the copy can be written into", () => {
    const doc = fixture()
    doc.items.push(doc.items.at(0)())
    doc.items.at(2).tags.push("new")
    doc.items.at(2).title.set("c")
    expect(doc.items.at(2)()).toEqual({ title: "c", tags: ["new"] })
    expect(doc.items.at(0)()).toEqual({ title: "a", tags: [] })
  })
})

describe("set reads", () => {
  it("a read of a set does not change under a later add, and has() and iteration agree with it", () => {
    const doc = fixture()
    doc.s.add({ n: 1 })
    const members = doc.s()
    doc.s.add({ n: 2 })
    expect(members).toEqual([{ n: 1 }])
    expect(doc.s()).toEqual([{ n: 1 }, { n: 2 }])
    expect(doc.s.has({ n: 2 })).toBe(true)
    expect([...doc.s]).toEqual(doc.s())
    expect(doc.s.size).toBe(2)
    expect(Object.isFrozen(doc.s()[0])).toBe(true)
  })
})

// read-identity — a read is σ's own value, frozen, and keeps its identity
// until a write copies it.
import { describe, expect, it } from "vitest"
import { batch, createDoc, Schema } from "../basic/index.js"
import { __countKeptRefs, coordinatePath } from "../coordinate-trie.js"
import {
  bottomInterpreter,
  interpret,
  plainReader,
  type RefContext,
  unwrap,
  withNavigation,
  withReadable,
} from "../index.js"
import { TRANSACT } from "../interpreters/writable.js"
import { RawPath } from "../path.js"

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

const contextOf = (doc: any) => doc[TRANSACT] as RefContext

/** σ at `path`, as the store holds it. */
const sigma = (doc: any, path = RawPath.empty): any =>
  contextOf(doc).reader.read(path)

/** The number of coordinates in the document's trie. */
const trieSize = (doc: any): number => {
  const trie = coordinatePath(contextOf(doc), RawPath.empty).trie
  return trie.below(trie.root).length
}

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

describe("a read is σ", () => {
  it("a read of a record is the very object σ holds there", () => {
    const doc = fixture()
    expect(doc.m()).toBe(sigma(doc, RawPath.empty.field("m")))
  })

  it("a value read keeps no refs", () => {
    const doc = fixture()
    doc.m()
    doc()
    expect(__countKeptRefs(contextOf(doc))).toBe(0)
  })
})

describe("bytes", () => {
  const Bytes = Schema.struct({
    b: Schema.bytes(),
    inner: Schema.struct({ b: Schema.bytes() }),
  })

  it("a leaf read and a read inside a struct are Uint8Arrays", () => {
    const doc: any = createDoc(Bytes)
    batch(doc, (d: any) => {
      d.b.set(new Uint8Array([1, 2]))
      d.inner.b.set(new Uint8Array([3]))
    })
    expect(doc.b()).toBeInstanceOf(Uint8Array)
    expect(doc.inner().b).toBeInstanceOf(Uint8Array)
    expect([...doc.inner().b]).toEqual([3])
  })

  it("a write never shares the caller's byte array", () => {
    const doc: any = createDoc(Bytes)
    const bytes = new Uint8Array([1])
    doc.b.set(bytes)
    bytes[0] = 9
    expect([...doc.b()]).toEqual([1])
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

describe(".get reads one child without a ref", () => {
  function wide() {
    const doc: any = createDoc(Doc)
    batch(doc, (d: any) => {
      for (let i = 0; i < 1000; i++) d.m.set(`k${i}`, { n: i })
    })
    return doc
  }

  it("creates no trie node, and freezes only that entry", () => {
    const doc = wide()
    const record = doc.m
    const nodes = trieSize(doc)
    const m = sigma(doc, RawPath.empty.field("m"))
    // A value that entered σ by a write is already frozen: the op shares it.
    // An entry σ built itself is not, until a read freezes it.
    record.at("k1").n.set(-1)
    record.at("k2").n.set(-2)
    expect(Object.isFrozen(m.k1)).toBe(false)
    expect(trieSize(doc)).toBe(nodes + 4)

    expect(record.get("k1")).toEqual({ n: -1 })
    expect(trieSize(doc)).toBe(nodes + 4)
    expect(Object.isFrozen(m.k1)).toBe(true)
    expect(Object.isFrozen(m.k2)).toBe(false)
    expect(Object.isFrozen(m)).toBe(false)
  })

  it("a following write into another entry copies nothing", () => {
    const doc = wide()
    const read = doc.m.get("k1")
    const root = sigma(doc)
    const m = root.m
    doc.m.at("k2").n.set(-2)
    expect(sigma(doc)).toBe(root)
    expect(sigma(doc).m).toBe(m)
    expect(doc.m.get("k1")).toBe(read)
  })

  it("after a whole-record read, a write copies only the spine", () => {
    const doc = wide()
    const before = doc.m()
    doc.m.at("k2").n.set(-2)
    const after = sigma(doc, RawPath.empty.field("m"))
    expect(after).not.toBe(before)
    expect(after.k1).toBe(before.k1)
    expect(after.k2).not.toBe(before.k2)
  })

  it("a missing key or index is undefined", () => {
    const doc = fixture()
    expect(doc.m.get("missing")).toBeUndefined()
    expect(doc.m.get("constructor")).toBeUndefined()
    expect(doc.items.get(5)).toBeUndefined()
    expect(doc.items.get(-1)).toBeUndefined()
  })

  it("a sequence's .get(i) is σ's item", () => {
    const doc = fixture()
    expect(doc.items.get(0)).toBe(sigma(doc, RawPath.empty.field("items"))[0])
    expect(doc.items.get(0)).toBe(doc.items()[0])
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

  it("a write into a node's data under a frozen forest copies the forest, the node and the data", () => {
    const doc = fixture()
    const a = doc.tree.create({ data: { label: "a" } })
    const b = doc.tree.create({ data: { label: "b" } })
    const before = doc.tree()
    doc.tree.node(a).label.set("A")
    const after = doc.tree()
    expect(after).not.toBe(before)
    const at = (forest: any, id: string) => forest.find((n: any) => n.id === id)
    expect(at(after, a)).not.toBe(at(before, a))
    expect(at(after, a).data).toEqual({ label: "A" })
    expect(at(after, b)).toBe(at(before, b))
    expect(at(before, a).data).toEqual({ label: "a" })
  })
})

describe("batches", () => {
  it("a read inside a batch sees the batch's earlier writes, and a later write does not change it", () => {
    const doc = fixture()
    doc()
    batch(doc, (d: any) => {
      d.title.set("new")
      expect(doc.title()).toBe("new")
      const read = doc()
      expect(read.title).toBe("new")
      d.title.set("newer")
      expect(read.title).toBe("new")
      expect(doc().title).toBe("newer")
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

  it("a read handed back to a write is shared, and a write into either copies it first", () => {
    const doc = fixture()
    const read = doc.items.at(0)()
    doc.items.push(read)
    expect(doc.items.at(2)()).toBe(read)
    doc.items.at(2).tags.push("new")
    doc.items.at(2).title.set("c")
    expect(doc.items.at(2)()).toEqual({ title: "c", tags: ["new"] })
    expect(doc.items.at(0)()).toBe(read)
    expect(read).toEqual({ title: "a", tags: [] })
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

describe("unwrap(doc) on plain", () => {
  it("is the current root after a write replaced a frozen root", () => {
    const doc = fixture()
    const before = doc()
    expect(unwrap(doc)).toBe(before)
    doc.title.set("u")
    expect(unwrap(doc)).not.toBe(before)
    expect(unwrap(doc)).toBe(sigma(doc))
    expect((unwrap(doc) as { title: string }).title).toBe("u")
  })
})

describe("read-only stacks", () => {
  const readOnly = withReadable(withNavigation(bottomInterpreter))
  const Partial = Schema.struct({
    a: Schema.struct({ x: Schema.number(), y: Schema.string() }),
    list: Schema.list(Schema.number()),
  })

  it("a read copies the caller's value, and never freezes it", () => {
    const value = { a: { x: 1, y: "y" }, list: [1, 2] }
    const doc: any = interpret(Partial, readOnly, {
      reader: plainReader({ current: value }),
    })
    const read = doc()
    expect(read).toEqual(value)
    expect(read).not.toBe(value)
    expect(Object.isFrozen(read.a)).toBe(true)
    expect(Object.isFrozen(value)).toBe(false)
    expect(Object.isFrozen(value.a)).toBe(false)
    expect(doc.list.get(1)).toBe(2)
  })

  it("a bytes read is a copy of the caller's Uint8Array", () => {
    const bytes = new Uint8Array([1, 2])
    const doc: any = interpret(Schema.struct({ b: Schema.bytes() }), readOnly, {
      reader: plainReader({ current: { b: bytes } }),
    })
    const read = doc.b()
    expect(read).toBeInstanceOf(Uint8Array)
    expect(read).not.toBe(bytes)
    expect([...doc().b]).toEqual([1, 2])
  })

  it("a read completes a partial value", () => {
    const doc: any = interpret(Partial, readOnly, {
      reader: plainReader({ current: { a: { x: 1 } } }),
    })
    expect(doc()).toEqual({ a: { x: 1, y: "" }, list: [] })
    expect(doc.a()).toEqual({ x: 1, y: "" })
  })
})

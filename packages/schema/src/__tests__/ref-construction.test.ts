// ref construction — a ref is its state, bound; what it does lives on one
// prototype per schema node and position.
import { CHANGEFEED } from "@kyneta/changefeed"
import { describe, expect, it } from "vitest"
import { batch, createDoc, Schema } from "../basic/index.js"
import { DELETED, REMOVE } from "../index.js"
import { STATE } from "../ref/state.js"

const Row = Schema.struct({ n: Schema.number() })

const Doc = Schema.struct({
  rows: Schema.record(Row),
  first: Row,
  items: Schema.list(Schema.string()),
  named: Schema.struct({ name: Schema.string(), length: Schema.number() }),
  tree: Schema.tree(Schema.struct({ label: Schema.string() })),
  content: Schema.discriminatedUnion("type", [
    Schema.struct({ type: Schema.string("text"), body: Schema.string() }),
    Schema.struct({ type: Schema.string("image"), url: Schema.string() }),
  ]),
})

function fixture(): any {
  const doc: any = createDoc(Doc)
  batch(doc, (d: any) => {
    d.rows.set("a", { n: 1 })
    d.rows.set("b", { n: 2 })
    d.items.push("x", "y", "z")
    d.named.set({ name: "N", length: 7 })
    d.content.set({ type: "text", body: "hello" })
  })
  return doc
}

describe("prototypes", () => {
  it("two entries of one record share a prototype; an entry and a field of one schema node do not", () => {
    const doc = fixture()
    const a = doc.rows.at("a")
    const b = doc.rows.at("b")
    expect(Object.getPrototypeOf(a)).toBe(Object.getPrototypeOf(b))
    expect(Object.getPrototypeOf(a)).not.toBe(Object.getPrototypeOf(doc.first))
  })

  it("a struct's fields are its own enumerable keys", () => {
    const doc = fixture()
    expect(Object.keys(doc.rows.at("a"))).toEqual(["n"])
    expect(Object.keys(doc)).toEqual(Object.keys(Doc.fields))
  })

  it("a list's length counts its items, and fields named name and length read the fields", () => {
    const doc = fixture()
    expect(doc.items.length).toBe(3)
    expect(doc.named.name()).toBe("N")
    expect(doc.named.length()).toBe(7)
  })

  it("call, apply and bind work on a ref", () => {
    const doc = fixture()
    const n = doc.rows.at("a").n
    expect(n.call(undefined)).toBe(1)
    expect(n.apply(undefined, [])).toBe(1)
    expect(n.bind(undefined)()).toBe(1)
  })
})

describe("members need their ref", () => {
  it("calling a detached member is a type error", () => {
    const doc = createDoc(Schema.struct({ n: Schema.number() }))
    const set = doc.n.set
    // @ts-expect-error: `set` declares its ref as `this`
    expect(() => set(1)).toThrow('"set" was called without its ref')
  })

  it("a detached set throws an error naming it, with the wrapped form", () => {
    const doc = fixture()
    const set = doc.rows.at("a").n.set
    expect(() => set(3)).toThrow(
      '"set" was called without its ref; pass (v) => ref.set(v)',
    )
  })
})

describe("state", () => {
  it("a feed is made on first use and kept", () => {
    const doc = fixture()
    const n = doc.rows.at("a").n
    expect(n[STATE].lazy).toBeUndefined()
    expect(n[CHANGEFEED]).toBe(n[CHANGEFEED])
    expect(n[STATE].lazy?.changefeed).toBe(n[CHANGEFEED])
  })
})

describe("position", () => {
  it("the root has no [DELETED]; an entry has [DELETED] and [REMOVE]; a tree node has [DELETED] alone", () => {
    const doc = fixture()
    expect(DELETED in doc).toBe(false)
    const entry = doc.rows.at("a")
    expect(DELETED in entry).toBe(true)
    expect(REMOVE in entry).toBe(true)
    const id = doc.tree.create({ data: { label: "x" } })
    const node = doc.tree.node(id)
    expect(DELETED in node).toBe(true)
    expect(REMOVE in node).toBe(false)
  })
})

describe("sums", () => {
  it("a sum field reads, navigates and writes through its active variant", () => {
    const doc = fixture()
    const content = doc.content
    expect(content()).toEqual({ type: "text", body: "hello" })
    expect(content.type).toBe("text")
    content.body.set("bye")
    expect(content.body()).toBe("bye")
  })

  it("a held sum ref sees a variant switch", () => {
    const doc = fixture()
    const content = doc.content
    content.set({ type: "image", url: "u" })
    expect(content.type).toBe("image")
    expect(content.url()).toBe("u")
    expect(Object.keys(content)).toContain("url")
  })
})

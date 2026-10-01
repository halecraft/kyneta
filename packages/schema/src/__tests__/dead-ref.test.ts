// dead-ref — a ref whose coordinate is gone reads `undefined`, whatever its
// kind and whatever its type says. Ask `deleted(ref)` to tell absent from a
// value.
import { describe, expect, it } from "vitest"
import { batch, createDoc, Schema } from "../basic/index.js"
import { deleted } from "../index.js"

const Doc = Schema.struct({
  names: Schema.list(Schema.string()),
  texts: Schema.record(Schema.text()),
  counts: Schema.record(Schema.counter()),
  rows: Schema.record(Schema.struct({ n: Schema.number() })),
})

function fixture() {
  const doc: any = createDoc(Doc)
  batch(doc, (d: any) => {
    d.names.push("a", "b")
    d.texts.set("t", "hello")
    d.counts.set("c", 3)
    d.rows.set("r", { n: 1 })
  })
  return doc
}

describe("a dead ref reads undefined", () => {
  it("a scalar", () => {
    const doc = fixture()
    const name = doc.names.at(0)
    expect(name()).toBe("a")
    doc.names.delete(0, 1)
    expect(deleted(name)).toBe(true)
    expect(name()).toBeUndefined()
  })

  it("a text, whose template string is still empty", () => {
    const doc = fixture()
    const text = doc.texts.at("t")
    expect(text()).toBe("hello")
    doc.texts.delete("t")
    expect(deleted(text)).toBe(true)
    expect(text()).toBeUndefined()
    expect(`${text}`).toBe("")
  })

  it("a counter", () => {
    const doc = fixture()
    const count = doc.counts.at("c")
    expect(count()).toBe(3)
    doc.counts.delete("c")
    expect(deleted(count)).toBe(true)
    expect(count()).toBeUndefined()
  })

  it("a struct, and its fields", () => {
    const doc = fixture()
    const row = doc.rows.at("r")
    const n = row.n
    expect(row()).toEqual({ n: 1 })
    doc.rows.delete("r")
    expect(deleted(row)).toBe(true)
    expect(row()).toBeUndefined()
    expect(n()).toBeUndefined()
  })
})

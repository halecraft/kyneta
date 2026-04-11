// create-doc — unit tests for generic createDoc and sync functions.

import { describe, expect, it } from "vitest"
import { json } from "../bind.js"
import { createDoc } from "../create-doc.js"
import { change } from "../facade/change.js"
import { subscribe } from "../facade/observe.js"
import { NATIVE } from "../native.js"
import { Schema } from "../schema.js"
import { exportEntirety, merge, version } from "../sync.js"
import { unwrap } from "../unwrap.js"

const TestSchema = Schema.struct({
  title: Schema.string(),
  count: Schema.number(),
  items: Schema.list(
    Schema.struct.json({
      name: Schema.string(),
    }),
  ),
})

describe("createDoc(json.bind(schema))", () => {
  it("creates a working ref with default values", () => {
    const doc = createDoc(json.bind(TestSchema))
    expect(doc.title()).toBe("")
    expect(doc.count()).toBe(0)
    expect(doc.items.length).toBe(0)
  })

  it("supports change() mutations", () => {
    const doc = createDoc(json.bind(TestSchema))
    change(doc, (d: any) => {
      d.title.set("Hello")
      d.count.set(42)
    })
    expect(doc.title()).toBe("Hello")
    expect(doc.count()).toBe(42)
  })

  it("supports subscribe() observation", () => {
    const doc = createDoc(json.bind(TestSchema))
    const events: unknown[] = []
    subscribe(doc, cs => events.push(cs))
    change(doc, (d: any) => {
      d.title.set("Updated")
    })
    expect(events.length).toBe(1)
  })

  it("root ref has [NATIVE] set to PlainState", () => {
    const doc = createDoc(json.bind(TestSchema))
    const native = (doc as any)[NATIVE]
    expect(native).toBeDefined()
    expect(typeof native).toBe("object")
    expect(native).toHaveProperty("title")
  })

  it("root ref has [SUBSTRATE] for sync functions", () => {
    const doc = createDoc(json.bind(TestSchema))
    // version() should work — proves [SUBSTRATE] is set
    const v = version(doc)
    expect(v).toBeDefined()
  })
})

describe("createDoc round-trip with exportEntirety", () => {
  it("round-trips via exportEntirety and createDoc(bound, payload)", () => {
    const bound = json.bind(TestSchema)
    const doc1 = createDoc(bound)
    change(doc1, (d: any) => {
      d.title.set("Round-trip")
      d.count.set(99)
      d.items.push({ name: "item1" })
    })

    const payload = exportEntirety(doc1)
    const doc2 = createDoc(bound, payload)

    expect(doc2.title()).toBe("Round-trip")
    expect(doc2.count()).toBe(99)
    expect(doc2.items.length).toBe(1)
  })
})

describe("generic sync functions", () => {
  it("version() returns a Version", () => {
    const doc = createDoc(json.bind(TestSchema))
    const v = version(doc)
    expect(v).toBeDefined()
  })

  it("version() advances after change", () => {
    const doc = createDoc(json.bind(TestSchema))
    const v1 = version(doc)
    change(doc, (d: any) => d.title.set("updated"))
    const v2 = version(doc)
    // PlainVersion is a monotonic integer — v2 should be greater
    expect((v2 as any).value).toBeGreaterThan((v1 as any).value)
  })

  it("merge() integrates state from exportEntirety", () => {
    const bound = json.bind(TestSchema)
    const doc1 = createDoc(bound)
    const doc2 = createDoc(bound)

    change(doc1, (d: any) => {
      d.title.set("From doc1")
    })

    const payload = exportEntirety(doc1)
    merge(doc2, payload)

    expect(doc2.title()).toBe("From doc1")
  })

  it("throws for non-root refs", () => {
    const doc = createDoc(json.bind(TestSchema))
    expect(() => version(doc.title as any)).toThrow("Sync functions")
  })
})

describe("unwrap() with createDoc", () => {
  it("returns PlainState at root", () => {
    const doc = createDoc(json.bind(TestSchema))
    const native = unwrap(doc as any)
    expect(native).toBeDefined()
    expect(typeof native).toBe("object")
  })

  it("returns undefined for scalar fields", () => {
    const doc = createDoc(json.bind(TestSchema))
    expect(unwrap(doc.title as any)).toBeUndefined()
  })
})

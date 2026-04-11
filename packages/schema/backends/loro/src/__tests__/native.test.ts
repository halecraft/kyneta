// native — integration tests for [NATIVE] on Loro substrate.

import { change, NATIVE, Schema, unwrap } from "@kyneta/schema"
import { describe, expect, it } from "vitest"
import { createDoc, loro } from "../index.js"

const TestSchema = Schema.struct({
  title: Schema.text(),
  count: Schema.counter(),
  items: Schema.list(
    Schema.struct.json({
      name: Schema.string(),
      done: Schema.boolean(),
    }),
  ),
  theme: Schema.string(),
  settings: Schema.struct.json({
    darkMode: Schema.boolean(),
  }),
})

const bound = loro.bind(TestSchema)

describe("[NATIVE] on Loro substrate", () => {
  it("root ref [NATIVE] returns LoroDoc", () => {
    const doc = createDoc(bound)
    const native = (doc as any)[NATIVE]
    expect(native).toBeDefined()
    // LoroDoc has version(), export(), import() methods
    expect(typeof native.version).toBe("function")
    expect(typeof native.export).toBe("function")
    expect(typeof native.import).toBe("function")
  })

  it("text field [NATIVE] returns LoroText", () => {
    const doc = createDoc(bound)
    const native = (doc.title as any)[NATIVE]
    expect(native).toBeDefined()
    // LoroText has insert(), delete() native methods
    expect(typeof native.insert).toBe("function")
    expect(typeof native.delete).toBe("function")
    expect(native.toString()).toBe("")
  })

  it("counter field [NATIVE] returns LoroCounter", () => {
    const doc = createDoc(bound)
    const native = (doc.count as any)[NATIVE]
    expect(native).toBeDefined()
    // LoroCounter has increment() method
    expect(typeof native.increment).toBe("function")
  })

  it("list field [NATIVE] returns LoroList", () => {
    const doc = createDoc(bound)
    const native = (doc.items as any)[NATIVE]
    expect(native).toBeDefined()
    // LoroList has push(), insert(), delete() methods
    expect(typeof native.push).toBe("function")
    expect(typeof native.insert).toBe("function")
    expect(typeof native.delete).toBe("function")
  })

  it("scalar field [NATIVE] returns undefined", () => {
    const doc = createDoc(bound)
    const native = (doc.theme as any)[NATIVE]
    expect(native).toBeUndefined()
  })

  it("[NATIVE] is non-enumerable on all refs", () => {
    const doc = createDoc(bound)
    expect(Object.keys(doc)).not.toContain(NATIVE)
    expect(Object.keys(doc.title as any)).not.toContain(NATIVE)
  })
})

describe("unwrap() with Loro", () => {
  it("returns LoroDoc at root", () => {
    const doc = createDoc(bound)
    const native = unwrap(doc as any)
    expect(typeof native.version).toBe("function")
  })

  it("returns LoroText for text field", () => {
    const doc = createDoc(bound)
    const native = unwrap(doc.title as any)
    expect(typeof native.insert).toBe("function")
  })

  it("returns undefined for scalar field", () => {
    const doc = createDoc(bound)
    expect(unwrap(doc.theme as any)).toBeUndefined()
  })

  it("native text reflects mutations", () => {
    const doc = createDoc(bound)
    change(doc, (d: any) => {
      d.title.insert(0, "Hello")
    })
    const native = (doc.title as any)[NATIVE]
    expect(native.toString()).toBe("Hello")
  })
})

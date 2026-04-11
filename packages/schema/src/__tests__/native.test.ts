// native — unit tests for [NATIVE] symbol property on plain substrate.

import { describe, expect, it } from "vitest"
import { createDoc } from "../basic/index.js"
import { NATIVE } from "../native.js"
import { Schema } from "../schema.js"
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

describe("[NATIVE] on plain substrate", () => {
  it("root ref has [NATIVE] set to PlainState", () => {
    const doc = createDoc(TestSchema)
    const native = (doc as any)[NATIVE]
    expect(native).toBeDefined()
    expect(typeof native).toBe("object")
    // PlainState is the backing object — it should have the schema fields
    expect(native).toHaveProperty("title")
    expect(native).toHaveProperty("count")
    expect(native).toHaveProperty("items")
  })

  it("scalar field has [NATIVE] set to undefined", () => {
    const doc = createDoc(TestSchema)
    const native = (doc.title as any)[NATIVE]
    expect(native).toBeUndefined()
  })

  it("scalar number field has [NATIVE] set to undefined", () => {
    const doc = createDoc(TestSchema)
    const native = (doc.count as any)[NATIVE]
    expect(native).toBeUndefined()
  })

  it("[NATIVE] is non-enumerable", () => {
    const doc = createDoc(TestSchema)
    const keys = Object.keys(doc)
    expect(keys).not.toContain(NATIVE)
    // Also check it doesn't show up in for...in
    const props: string[] = []
    for (const k in doc) props.push(k)
    expect(props).not.toContain(String(NATIVE))
  })
})

describe("unwrap()", () => {
  it("returns the same value as ref[NATIVE]", () => {
    const doc = createDoc(TestSchema)
    expect(unwrap(doc as any)).toBe((doc as any)[NATIVE])
  })

  it("returns undefined for scalar fields", () => {
    const doc = createDoc(TestSchema)
    expect(unwrap(doc.title as any)).toBeUndefined()
  })

  it("throws for null/undefined", () => {
    expect(() => unwrap(null as any)).toThrow()
    expect(() => unwrap(undefined as any)).toThrow()
  })
})

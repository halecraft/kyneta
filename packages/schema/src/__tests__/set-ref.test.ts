// set-ref — Integration tests for the `SetRef` interface.
//
// Sets are ref-layer leaf-shaped: `.has(value)`, `.add(value)`,
// `.delete(value)`, `.clear()`, `.size`, `[Symbol.iterator]`, callable
// returning `Plain<I>[]`. No `.at(value)`.

import { describe, expect, expectTypeOf, it } from "vitest"
import type { SchemaNode } from "../index.js"
import {
  interpret,
  observation,
  plainContext,
  readable,
  Schema,
  writable,
} from "../index.js"
import type { Plain } from "../interpreter-types.js"

function createSetDoc(schema: SchemaNode, initial: unknown): any {
  const store = { tags: initial }
  const ctx = plainContext(store as Record<string, unknown>)
  return (interpret as any)(schema, ctx)
    .with(readable)
    .with(writable)
    .with(observation)
    .done()
}

describe("SetRef: primitive items (Schema.set(Schema.string()))", () => {
  const setSchema = Schema.struct({
    tags: Schema.set(Schema.string()),
  })

  it(".has returns false initially, true after .add", () => {
    const doc = createSetDoc(setSchema, [])
    expect(doc.tags.has("a")).toBe(false)
    doc.tags.add("a")
    expect(doc.tags.has("a")).toBe(true)
  })

  it(".size reflects member count", () => {
    const doc = createSetDoc(setSchema, [])
    expect(doc.tags.size).toBe(0)
    doc.tags.add("a")
    doc.tags.add("b")
    expect(doc.tags.size).toBe(2)
    doc.tags.delete("a")
    expect(doc.tags.size).toBe(1)
  })

  it("[Symbol.iterator] iterates plain values in stored order", () => {
    const doc = createSetDoc(setSchema, ["alpha", "beta"])
    const collected: string[] = []
    for (const v of doc.tags) {
      collected.push(v)
    }
    expect(collected).toEqual(["alpha", "beta"])
  })

  it("() returns string[] (Array.isArray true)", () => {
    const doc = createSetDoc(setSchema, ["alpha"])
    const snapshot = doc.tags()
    expect(Array.isArray(snapshot)).toBe(true)
    expect(snapshot).toEqual(["alpha"])
  })

  it(".clear empties the set", () => {
    const doc = createSetDoc(setSchema, ["a", "b", "c"])
    doc.tags.clear()
    expect(doc.tags.size).toBe(0)
    expect(doc.tags()).toEqual([])
  })

  it("no .at method exists (sets are leaf-shaped, not addressable)", () => {
    const doc = createSetDoc(setSchema, ["a"])
    expect(doc.tags.at).toBeUndefined()
  })
})

describe("SetRef: object items use content equality", () => {
  const objectSetSchema = Schema.struct({
    tags: Schema.set(Schema.struct({ name: Schema.string() })),
  })

  it(".has matches content, not identity", () => {
    const doc = createSetDoc(objectSetSchema, [])

    doc.tags.add({ name: "a" })

    // A *different* object with the same content matches.
    expect(doc.tags.has({ name: "a" })).toBe(true)
    expect(doc.tags.has({ name: "b" })).toBe(false)
  })

  it(".delete matches by content", () => {
    const doc = createSetDoc(objectSetSchema, [{ name: "a" }, { name: "b" }])

    const removed = doc.tags.delete({ name: "a" })
    expect(removed).toBe(true)
    expect(doc.tags()).toEqual([{ name: "b" }])
  })

  it("re-adding a structurally-equal member is idempotent", () => {
    const doc = createSetDoc(objectSetSchema, [{ name: "a" }])

    doc.tags.add({ name: "a" })
    expect(doc.tags.size).toBe(1)
    expect(doc.tags()).toEqual([{ name: "a" }])
  })
})

describe("Type-level: Plain<set> matches the runtime call signature", () => {
  it("Plain<SetSchema> = array", () => {
    const schema = Schema.struct({
      tags: Schema.set(Schema.string()),
    })
    expectTypeOf<Plain<typeof schema>>().toEqualTypeOf<{ tags: string[] }>()
  })
})

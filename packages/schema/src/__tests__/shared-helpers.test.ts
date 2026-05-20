import { describe, expect, it } from "vitest"
import {
  interpret,
  plainContext,
  readable,
  Schema,
  writable,
} from "../index.js"
import { at } from "../interpreters/sequence-helpers.js"

// ===========================================================================
// at() — the cursor-positioning primitive
// ===========================================================================

describe("at: cursor-positioning primitive", () => {
  it("emits bare op at index 0 (no retain prefix)", () => {
    expect(at(0, { insert: "x" })).toEqual([{ insert: "x" }])
  })

  it("emits retain + op at positive index", () => {
    expect(at(3, { delete: 1 })).toEqual([{ retain: 3 }, { delete: 1 }])
  })

  it("emits retain + op at index 1 (boundary)", () => {
    expect(at(1, { insert: [42] })).toEqual([{ retain: 1 }, { insert: [42] }])
  })

  it("preserves op type through generic parameter", () => {
    const result = at(5, { insert: "hello", extra: true })
    expect(result).toEqual([{ retain: 5 }, { insert: "hello", extra: true }])
  })
})

// ===========================================================================
// Movable ↔ Sequence parity
//
// Movable delegates to the same installListWriteOps helper as sequence.
// This test ensures the contract holds through the full interpreter stack.
// ===========================================================================

describe("movable list has the same write surface as sequence", () => {
  const movableSchema = Schema.struct({
    items: Schema.movableList(Schema.struct({ name: Schema.string() })),
  })

  const sequenceSchema = Schema.struct({
    items: Schema.list(Schema.struct({ name: Schema.string() })),
  })

  function createDoc(schema: any) {
    const store = { items: [{ name: "a" }] }
    const ctx = plainContext(store)
    // Cast avoids TS2589 — the fluent builder produces deeply recursive
    // types when S is widened to `any`. Same pattern as createRef().
    const doc = (interpret as any)(schema, ctx)
      .with(readable)
      .with(writable)
      .done()
    return { store, doc }
  }

  it("push/insert/delete produce identical store mutations", () => {
    const seq = createDoc(sequenceSchema)
    const mov = createDoc(movableSchema)

    seq.doc.items.push({ name: "b" })
    mov.doc.items.push({ name: "b" })
    expect(seq.store.items).toEqual(mov.store.items)

    seq.doc.items.insert(1, { name: "x" })
    mov.doc.items.insert(1, { name: "x" })
    expect(seq.store.items).toEqual(mov.store.items)

    seq.doc.items.delete(0)
    mov.doc.items.delete(0)
    expect(seq.store.items).toEqual(mov.store.items)
  })
})

// ===========================================================================
// Set ↔ Map parity
//
// Set delegates to the same installKeyedWriteOps helper as map.
// This test ensures the contract holds through the full interpreter stack.
// ===========================================================================

describe("set kind has a value-addressed write surface", () => {
  // Sets are distinct from maps after the refactor: storage is `T[]`,
  // mutation is value-addressed (`.add(v)`, `.delete(v)`, `.clear()`),
  // and `.has(v)` is content-equal membership.

  const setSchema = Schema.struct({
    tags: Schema.set(Schema.string()),
  })

  function createSetDoc(initial: string[]) {
    const store = { tags: initial }
    const ctx = plainContext(store)
    // Cast avoids TS2589 — same pattern as above and createRef().
    const doc = (interpret as any)(setSchema, ctx)
      .with(readable)
      .with(writable)
      .done()
    return { store, doc }
  }

  it(".add appends a new member; storage is T[]", () => {
    const { doc, store } = createSetDoc(["alpha"])

    doc.tags.add("beta")
    expect(store.tags).toEqual(["alpha", "beta"])
  })

  it(".add of an existing member is idempotent", () => {
    const { doc, store } = createSetDoc(["alpha"])

    doc.tags.add("alpha")
    expect(store.tags).toEqual(["alpha"])
  })

  it(".delete removes by value and returns boolean", () => {
    const { doc, store } = createSetDoc(["alpha", "beta"])

    const removed = doc.tags.delete("alpha")
    expect(removed).toBe(true)
    expect(store.tags).toEqual(["beta"])

    const noop = doc.tags.delete("alpha")
    expect(noop).toBe(false)
  })

  it(".clear empties the set", () => {
    const { doc, store } = createSetDoc(["alpha", "beta"])

    doc.tags.clear()
    expect(store.tags).toEqual([])
  })
})

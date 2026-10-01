import { describe, expect, it } from "vitest"
import { Schema } from "../index.js"
import { TRANSACT } from "../ref/write.js"
import { contextOver, docOver, refOver } from "./stack.js"

// ===========================================================================
// Shared fixtures
// ===========================================================================

const structuralDocSchema = Schema.struct({
  settings: Schema.struct({
    darkMode: Schema.boolean(),
    fontSize: Schema.number(),
  }),
  metadata: Schema.record(Schema.any()),
})

const _annotatedDocSchema = Schema.struct({
  title: Schema.text(),
  count: Schema.counter(),
  messages: Schema.list(
    Schema.struct({
      author: Schema.string(),
      body: Schema.string(),
    }),
  ),
})

function createNavDoc(storeOverrides: Record<string, unknown> = {}) {
  const store = {
    settings: { darkMode: false, fontSize: 14 },
    metadata: { version: 1 },
    ...storeOverrides,
  }
  const doc = docOver(structuralDocSchema, store) as any
  const ctx = doc[TRANSACT]
  return { store, ctx, doc }
}

// ===========================================================================
// Product: field getters
// ===========================================================================

describe("navigation: product field getters", () => {
  it("defines enumerable getters for each schema field", () => {
    const { doc } = createNavDoc()
    // Product field keys should be enumerable
    const keys = Object.keys(doc)
    expect(keys).toContain("settings")
    expect(keys).toContain("metadata")
  })

  it("field getters return child carriers (callable functions)", () => {
    const { doc } = createNavDoc()
    expect(typeof doc.settings).toBe("function")
    expect(typeof doc.metadata).toBe("function")
  })

  it("nested product field getters work", () => {
    const { doc } = createNavDoc()
    const settings = doc.settings
    expect(typeof settings.darkMode).toBe("function")
    expect(typeof settings.fontSize).toBe("function")
  })
})

// ===========================================================================
// Sequence: .at(), .length, [Symbol.iterator]
// ===========================================================================

describe("navigation: sequence navigation", () => {
  const seqSchema = Schema.list(Schema.string())

  function createSeqDoc(items: string[]) {
    const store = items as any
    const result = docOver(seqSchema, store) as any
    const ctx = result[TRANSACT]
    return { store, ctx, result }
  }

  it(".at(i) returns a child carrier", () => {
    const { result } = createSeqDoc(["a", "b", "c"])
    const child = result.at(0)
    expect(typeof child).toBe("function")
  })

  it(".at(-1) returns undefined", () => {
    const { result } = createSeqDoc(["a", "b", "c"])
    expect(result.at(-1)).toBeUndefined()
  })

  it(".at(out-of-bounds) returns undefined", () => {
    const { result } = createSeqDoc(["a", "b"])
    expect(result.at(2)).toBeUndefined()
    expect(result.at(99)).toBeUndefined()
  })

  it(".length reflects store array length", () => {
    const { result } = createSeqDoc(["a", "b", "c"])
    expect(result.length).toBe(3)
  })

  it(".length is 0 for empty array", () => {
    const { result } = createSeqDoc([])
    expect(result.length).toBe(0)
  })

  it("[Symbol.iterator] yields child carriers", () => {
    const { result } = createSeqDoc(["a", "b"])
    const items = [...result]
    expect(items).toHaveLength(2)
    expect(typeof items[0]).toBe("function")
    expect(typeof items[1]).toBe("function")
  })

  it("[Symbol.iterator] yields nothing for empty array", () => {
    const { result } = createSeqDoc([])
    const items = [...result]
    expect(items).toHaveLength(0)
  })
})

// ===========================================================================
// Map: .at(), .has(), .keys(), .size, .entries(), .values(), iterator
// ===========================================================================

describe("navigation: map navigation", () => {
  const mapSchema = Schema.record(Schema.number())

  function createMapDoc(data: Record<string, number>) {
    const store = data as any
    const result = docOver(mapSchema, store) as any
    const ctx = result[TRANSACT]
    return { store, ctx, result }
  }

  it(".at(key) returns a child carrier for existing key", () => {
    const { result } = createMapDoc({ x: 1, y: 2 })
    const child = result.at("x")
    expect(typeof child).toBe("function")
  })

  it(".at(missingKey) returns undefined", () => {
    const { result } = createMapDoc({ x: 1 })
    expect(result.at("missing")).toBeUndefined()
  })

  it(".has(key) returns true for existing key", () => {
    const { result } = createMapDoc({ x: 1 })
    expect(result.has("x")).toBe(true)
  })

  it(".has(key) returns false for missing key", () => {
    const { result } = createMapDoc({ x: 1 })
    expect(result.has("y")).toBe(false)
  })

  it(".keys() returns store keys", () => {
    const { result } = createMapDoc({ a: 1, b: 2, c: 3 })
    expect(result.keys()).toEqual(["a", "b", "c"])
  })

  it(".keys() returns empty array for empty map", () => {
    const { result } = createMapDoc({})
    expect(result.keys()).toEqual([])
  })

  it(".size reflects store key count", () => {
    const { result } = createMapDoc({ a: 1, b: 2 })
    expect(result.size).toBe(2)
  })

  it(".entries() yields [key, carrier] pairs", () => {
    const { result } = createMapDoc({ x: 1, y: 2 })
    const entries = [...result.entries()]
    expect(entries).toHaveLength(2)
    expect(entries[0]?.[0]).toBe("x")
    expect(typeof entries[0]?.[1]).toBe("function")
    expect(entries[1]?.[0]).toBe("y")
    expect(typeof entries[1]?.[1]).toBe("function")
  })

  it(".values() yields carriers", () => {
    const { result } = createMapDoc({ x: 1, y: 2 })
    const values = [...result.values()]
    expect(values).toHaveLength(2)
    expect(typeof values[0]).toBe("function")
  })

  it("[Symbol.iterator] yields [key, carrier] pairs", () => {
    const { result } = createMapDoc({ x: 1 })
    const entries = [...result]
    expect(entries).toHaveLength(1)
    expect(entries[0]?.[0]).toBe("x")
    expect(typeof entries[0]?.[1]).toBe("function")
  })
})

// ===========================================================================
// Sum dispatch
// ===========================================================================

describe("navigation: sum dispatch", () => {
  it("discriminated union dispatches to correct variant", () => {
    const schema = Schema.struct({
      item: Schema.discriminatedUnion("type", [
        Schema.struct({ type: Schema.string("text"), body: Schema.string() }),
        Schema.struct({ type: Schema.string("image"), url: Schema.string() }),
      ]),
    })
    const store = { item: { type: "image", url: "pic.png" } }
    const doc = docOver(schema, store) as any
    const _ctx = doc[TRANSACT]

    // item should be a carrier (the resolved variant)
    expect(typeof doc.item).toBe("function")
    // The variant is a product with 'type' and 'url' fields
    expect(Object.keys(doc.item)).toContain("type")
    expect(Object.keys(doc.item)).toContain("url")
  })

  it("sum addressing proxy perfectly tracks state shifts for discriminated unions", () => {
    const schema = Schema.struct({
      server: Schema.discriminatedUnion("type", [
        Schema.struct({ type: Schema.string("absent") }),
        Schema.struct({
          type: Schema.string("present"),
          peerId: Schema.string(),
        }),
      ]),
    })
    const store: any = { server: { type: "absent" } }
    const doc = docOver(schema, store) as any
    const _ctx = doc[TRANSACT]

    // Capture the ref identity
    const serverRef = doc.server
    expect(typeof serverRef).toBe("function")

    // When absent, peerId is undefined on the proxy
    expect(serverRef.peerId).toBeUndefined()
    expect(serverRef.type).toBe("absent")

    // Mutate the store directly
    store.server = { type: "present", peerId: "1234" }

    // The held proxy forwards to the new active variant.
    expect(typeof serverRef.peerId).toBe("function")
    // A discriminant reads as its raw value, not a ref.
    expect(serverRef.type).toBe("present")
  })

  it("nullable sum dispatches based on null/non-null", () => {
    const schema = Schema.struct({
      bio: Schema.string().nullable(),
    })

    // Non-null case
    const store1 = { bio: "hello" }
    const doc1 = docOver(schema, store1) as any
    const _ctx1 = doc1[TRANSACT]
    // bio resolves to the string variant (a carrier)
    expect(typeof doc1.bio).toBe("function")

    // Null case
    const store2 = { bio: null }
    const doc2 = docOver(schema, store2) as any
    const _ctx2 = doc2[TRANSACT]
    // bio resolves to the null variant (a carrier)
    expect(typeof doc2.bio).toBe("function")
  })

  it("sum addressing proxy allows a .nullable() sequence ref to track across variant changes", () => {
    const schema = Schema.struct({
      maybeList: Schema.list(Schema.string()).nullable(),
    })
    const store: any = { maybeList: null }
    const doc = docOver(schema, store) as any
    const _ctx = doc[TRANSACT]

    const maybeListRef = doc.maybeList
    expect(typeof maybeListRef).toBe("function")

    // Array.from fails since the function isn't iterable
    expect(typeof maybeListRef[Symbol.iterator]).toBe("undefined")

    // Mutate store to an array
    store.maybeList = ["a", "b"]

    // Using the EXACT SAME ref identity, we can now iterate it like a sequence
    expect(typeof maybeListRef[Symbol.iterator]).toBe("function")

    // Spread iterator and map to values
    const arr = [...maybeListRef]
    expect(arr).toHaveLength(2)
    expect(typeof arr[0]).toBe("function")
  })

  it("sum proxy dynamically updates ownKeys across variant shifts", () => {
    const schema = Schema.struct({
      server: Schema.discriminatedUnion("type", [
        Schema.struct({ type: Schema.string("absent") }),
        Schema.struct({
          type: Schema.string("present"),
          peerId: Schema.string(),
        }),
      ]),
    })
    const store: any = { server: { type: "absent" } }
    const doc = docOver(schema, store) as any
    const _ctx = doc[TRANSACT]

    const keysBefore = Object.keys(doc.server)
    expect(keysBefore).toContain("type")
    expect(keysBefore).not.toContain("peerId")

    store.server = { type: "present", peerId: "123" }

    const keysAfter = Object.keys(doc.server)
    expect(keysAfter).toContain("type")
    expect(keysAfter).toContain("peerId")
  })
})

// ===========================================================================
// Annotated: delegation
// ===========================================================================

describe("navigation: first-class types", () => {
  it("struct with first-class type children has field getters", () => {
    const schema = Schema.struct({
      title: Schema.text(),
      count: Schema.counter(),
    })
    const store = { title: "Hello", count: 0 }
    const doc = docOver(schema, store) as any
    const _ctx = doc[TRANSACT]

    // product — field getters should work
    expect(Object.keys(doc)).toContain("title")
    expect(Object.keys(doc)).toContain("count")
    expect(typeof doc.title).toBe("function")
    expect(typeof doc.count).toBe("function")
  })

  it("movableList delegates to inner sequence", () => {
    const schema = Schema.struct({
      list: Schema.movableList(Schema.struct({ title: Schema.string() })),
    })
    const result = docOver(schema, { list: [{ title: "A" }, { title: "B" }] })
      .list as any

    // Sequence navigation should be present
    expect(result.length).toBe(2)
    expect(typeof result.at).toBe("function")
    const child = result.at(0)
    expect(typeof child).toBe("function")
  })
})

// ===========================================================================
// Integration: navigate and write
// ===========================================================================

describe("navigation: navigate and write", () => {
  it("product field navigation works", () => {
    const schema = Schema.struct({
      title: Schema.string(),
      count: Schema.number(),
    })
    const store = { title: "hello", count: 0 }
    const ctx = contextOver(schema, store)
    const doc = refOver(schema, ctx) as any

    expect(Object.keys(doc)).toContain("title")
    expect(typeof doc.title).toBe("function")
  })

  it(".set() works on navigated scalar child", () => {
    const schema = Schema.struct({
      title: Schema.string(),
    })
    const store: Record<string, unknown> = { title: "hello" }
    const ctx = contextOver(schema, store)
    const doc = refOver(schema, ctx) as any

    doc.title.set("world")
    expect(store.title).toBe("world")
  })

  it("sequence .at(i) returns a navigable+writable ref", () => {
    const schema = Schema.struct({
      items: Schema.list(Schema.struct({ name: Schema.string() })),
    })
    const store = { items: [{ name: "a" }, { name: "b" }] }
    const ctx = contextOver(schema, store)
    const doc = refOver(schema, ctx) as any

    expect(doc.items.length).toBe(2)
    const item = doc.items.at(0)
    expect(typeof item).toBe("function")

    // Can navigate to the child's field
    expect(typeof item.name).toBe("function")

    // Can mutate through navigation
    item.name.set("updated")
    expect(store.items[0].name).toBe("updated")
  })

  it(".push() works on sequence", () => {
    const schema = Schema.struct({
      items: Schema.list(Schema.string()),
    })
    const store = { items: ["a", "b"] }
    const ctx = contextOver(schema, store)
    const doc = refOver(schema, ctx) as any

    doc.items.push("c")
    expect(store.items).toEqual(["a", "b", "c"])
  })

  it("text .update() works without reading layer", () => {
    const schema = Schema.struct({
      title: Schema.text(),
    })
    const store = { title: "hello" }
    const ctx = contextOver(schema, store)
    const doc = refOver(schema, ctx) as any

    doc.title.update("world")
    expect(store.title).toBe("world")
  })

  it("map .set() and .delete() work", () => {
    const schema = Schema.struct({
      labels: Schema.record(Schema.string()),
    })
    const store = { labels: { color: "red" } }
    const ctx = contextOver(schema, store)
    const doc = refOver(schema, ctx) as any

    doc.labels.set("size", "large")
    expect((store.labels as any).size).toBe("large")

    doc.labels.delete("color")
    expect((store.labels as any).color).toBeUndefined()
  })
})

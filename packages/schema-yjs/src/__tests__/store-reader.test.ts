import { describe, expect, it } from "vitest"
import * as Y from "yjs"
import { Schema } from "@kyneta/schema"
import { yjsStoreReader } from "../store-reader.js"
import { populateRoot } from "../populate.js"

// ===========================================================================
// Helpers
// ===========================================================================

/**
 * Create a Y.Doc populated from a schema and seed, return the doc + reader.
 */
function setup(
  schema: ReturnType<typeof Schema.doc>,
  seed?: Record<string, unknown>,
) {
  const doc = new Y.Doc()
  populateRoot(doc, schema, seed)
  const reader = yjsStoreReader(doc, schema)
  return { doc, reader }
}

/** Key path segment helper */
function key(k: string) {
  return { type: "key" as const, key: k }
}

/** Index path segment helper */
function idx(i: number) {
  return { type: "index" as const, index: i }
}

// ===========================================================================
// Schemas used across tests
// ===========================================================================

const TextSchema = Schema.doc({
  title: Schema.annotated("text"),
  subtitle: Schema.annotated("text"),
})

const ScalarSchema = Schema.doc({
  name: Schema.string(),
  count: Schema.number(),
  active: Schema.boolean(),
})

const NestedStructSchema = Schema.doc({
  profile: Schema.struct({
    first: Schema.string(),
    last: Schema.string(),
    address: Schema.struct({
      city: Schema.string(),
      zip: Schema.string(),
    }),
  }),
})

const ListSchema = Schema.doc({
  items: Schema.list(Schema.string()),
  structs: Schema.list(
    Schema.struct({
      name: Schema.string(),
      done: Schema.boolean(),
    }),
  ),
})

const MapSchema = Schema.doc({
  labels: Schema.record(Schema.string()),
})

const MixedSchema = Schema.doc({
  title: Schema.annotated("text"),
  count: Schema.number(),
  items: Schema.list(
    Schema.struct({
      name: Schema.string(),
      done: Schema.boolean(),
    }),
  ),
  meta: Schema.struct({
    author: Schema.string(),
    tags: Schema.list(Schema.string()),
  }),
  labels: Schema.record(Schema.string()),
})

// ===========================================================================
// Tests
// ===========================================================================

describe("YjsStoreReader", () => {
  // -------------------------------------------------------------------------
  // read
  // -------------------------------------------------------------------------

  describe("read", () => {
    it("reads Y.Text as string", () => {
      const { reader } = setup(TextSchema, { title: "Hello", subtitle: "" })
      expect(reader.read([key("title")])).toBe("Hello")
      expect(reader.read([key("subtitle")])).toBe("")
    })

    it("reads Y.Text with default empty string", () => {
      const { reader } = setup(TextSchema)
      expect(reader.read([key("title")])).toBe("")
    })

    it("reads plain scalars (string, number, boolean)", () => {
      const { reader } = setup(ScalarSchema, {
        name: "Alice",
        count: 42,
        active: true,
      })
      expect(reader.read([key("name")])).toBe("Alice")
      expect(reader.read([key("count")])).toBe(42)
      expect(reader.read([key("active")])).toBe(true)
    })

    it("reads scalar defaults", () => {
      const { reader } = setup(ScalarSchema)
      expect(reader.read([key("name")])).toBe("")
      expect(reader.read([key("count")])).toBe(0)
      expect(reader.read([key("active")])).toBe(false)
    })

    it("reads nested struct fields", () => {
      const { reader } = setup(NestedStructSchema, {
        profile: {
          first: "Jane",
          last: "Doe",
          address: { city: "Portland", zip: "97201" },
        },
      })
      expect(reader.read([key("profile"), key("first")])).toBe("Jane")
      expect(reader.read([key("profile"), key("last")])).toBe("Doe")
      expect(
        reader.read([key("profile"), key("address"), key("city")]),
      ).toBe("Portland")
      expect(
        reader.read([key("profile"), key("address"), key("zip")]),
      ).toBe("97201")
    })

    it("reads nested struct as plain object", () => {
      const { reader } = setup(NestedStructSchema, {
        profile: {
          first: "Jane",
          last: "Doe",
          address: { city: "Portland", zip: "97201" },
        },
      })
      const profile = reader.read([key("profile")]) as Record<string, unknown>
      expect(profile.first).toBe("Jane")
      expect(profile.last).toBe("Doe")
      expect((profile.address as Record<string, unknown>).city).toBe("Portland")
    })

    it("reads list items by index", () => {
      const { reader } = setup(ListSchema, {
        items: ["a", "b", "c"],
        structs: [],
      })
      expect(reader.read([key("items"), idx(0)])).toBe("a")
      expect(reader.read([key("items"), idx(1)])).toBe("b")
      expect(reader.read([key("items"), idx(2)])).toBe("c")
    })

    it("reads list as plain array", () => {
      const { reader } = setup(ListSchema, {
        items: ["x", "y"],
        structs: [],
      })
      expect(reader.read([key("items")])).toEqual(["x", "y"])
    })

    it("reads struct items within lists", () => {
      const { reader } = setup(ListSchema, {
        items: [],
        structs: [
          { name: "Task 1", done: false },
          { name: "Task 2", done: true },
        ],
      })
      expect(reader.read([key("structs"), idx(0), key("name")])).toBe(
        "Task 1",
      )
      expect(reader.read([key("structs"), idx(1), key("done")])).toBe(true)
      const item = reader.read([key("structs"), idx(0)]) as Record<
        string,
        unknown
      >
      expect(item.name).toBe("Task 1")
      expect(item.done).toBe(false)
    })

    it("reads map entries", () => {
      const { reader } = setup(MapSchema, {
        labels: { bug: "red", feature: "green" },
      })
      expect(reader.read([key("labels"), key("bug")])).toBe("red")
      expect(reader.read([key("labels"), key("feature")])).toBe("green")
    })

    it("reads map as plain object", () => {
      const { reader } = setup(MapSchema, {
        labels: { bug: "red", feature: "green" },
      })
      expect(reader.read([key("labels")])).toEqual({
        bug: "red",
        feature: "green",
      })
    })

    it("reads root as full JSON object", () => {
      const { reader } = setup(ScalarSchema, {
        name: "Bob",
        count: 7,
        active: false,
      })
      const root = reader.read([]) as Record<string, unknown>
      expect(root.name).toBe("Bob")
      expect(root.count).toBe(7)
      expect(root.active).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // arrayLength
  // -------------------------------------------------------------------------

  describe("arrayLength", () => {
    it("returns 0 for empty list", () => {
      const { reader } = setup(ListSchema, { items: [], structs: [] })
      expect(reader.arrayLength([key("items")])).toBe(0)
    })

    it("returns correct length for populated list", () => {
      const { reader } = setup(ListSchema, {
        items: ["a", "b", "c"],
        structs: [],
      })
      expect(reader.arrayLength([key("items")])).toBe(3)
    })

    it("returns correct length for struct list", () => {
      const { reader } = setup(ListSchema, {
        items: [],
        structs: [
          { name: "A", done: false },
          { name: "B", done: true },
        ],
      })
      expect(reader.arrayLength([key("structs")])).toBe(2)
    })

    it("returns 0 for non-list paths", () => {
      const { reader } = setup(ScalarSchema, { name: "test", count: 0, active: true })
      expect(reader.arrayLength([key("name")])).toBe(0)
    })
  })

  // -------------------------------------------------------------------------
  // keys
  // -------------------------------------------------------------------------

  describe("keys", () => {
    it("returns keys of a Y.Map (record)", () => {
      const { reader } = setup(MapSchema, {
        labels: { bug: "red", feature: "green", docs: "blue" },
      })
      const k = reader.keys([key("labels")])
      expect(k.sort()).toEqual(["bug", "docs", "feature"])
    })

    it("returns keys of empty map", () => {
      const { reader } = setup(MapSchema, { labels: {} })
      expect(reader.keys([key("labels")])).toEqual([])
    })

    it("returns keys of nested struct (product stored as Y.Map)", () => {
      const { reader } = setup(NestedStructSchema, {
        profile: {
          first: "Jane",
          last: "Doe",
          address: { city: "Portland", zip: "97201" },
        },
      })
      const k = reader.keys([key("profile")])
      expect(k.sort()).toEqual(["address", "first", "last"])
    })

    it("returns keys of nested struct's nested struct", () => {
      const { reader } = setup(NestedStructSchema, {
        profile: {
          first: "Jane",
          last: "Doe",
          address: { city: "Portland", zip: "97201" },
        },
      })
      const k = reader.keys([key("profile"), key("address")])
      expect(k.sort()).toEqual(["city", "zip"])
    })

    it("returns empty array for non-map paths", () => {
      const { reader } = setup(ScalarSchema, { name: "test", count: 0, active: true })
      expect(reader.keys([key("name")])).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  // hasKey
  // -------------------------------------------------------------------------

  describe("hasKey", () => {
    it("returns true for existing key in record", () => {
      const { reader } = setup(MapSchema, {
        labels: { bug: "red" },
      })
      expect(reader.hasKey([key("labels")], "bug")).toBe(true)
    })

    it("returns false for missing key in record", () => {
      const { reader } = setup(MapSchema, {
        labels: { bug: "red" },
      })
      expect(reader.hasKey([key("labels")], "nonexistent")).toBe(false)
    })

    it("returns true for existing key in struct (Y.Map)", () => {
      const { reader } = setup(NestedStructSchema, {
        profile: {
          first: "Jane",
          last: "Doe",
          address: { city: "Portland", zip: "97201" },
        },
      })
      expect(reader.hasKey([key("profile")], "first")).toBe(true)
      expect(reader.hasKey([key("profile")], "address")).toBe(true)
    })

    it("returns false for missing key in struct", () => {
      const { reader } = setup(NestedStructSchema, {
        profile: {
          first: "Jane",
          last: "Doe",
          address: { city: "Portland", zip: "97201" },
        },
      })
      expect(reader.hasKey([key("profile")], "nonexistent")).toBe(false)
    })

    it("returns false for non-map paths", () => {
      const { reader } = setup(ScalarSchema, { name: "test", count: 0, active: true })
      expect(reader.hasKey([key("name")], "anything")).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // Liveness — mutations via raw Yjs API immediately visible
  // -------------------------------------------------------------------------

  describe("liveness", () => {
    it("text mutations are immediately visible", () => {
      const { doc, reader } = setup(TextSchema, { title: "Hello" })
      expect(reader.read([key("title")])).toBe("Hello")

      // Mutate via raw Yjs API
      const rootMap = doc.getMap("root")
      const text = rootMap.get("title") as Y.Text
      text.insert(5, " World")
      expect(reader.read([key("title")])).toBe("Hello World")
    })

    it("scalar mutations are immediately visible", () => {
      const { doc, reader } = setup(ScalarSchema, {
        name: "Alice",
        count: 0,
        active: false,
      })
      expect(reader.read([key("name")])).toBe("Alice")

      const rootMap = doc.getMap("root")
      rootMap.set("name", "Bob")
      expect(reader.read([key("name")])).toBe("Bob")
    })

    it("list mutations are immediately visible", () => {
      const { doc, reader } = setup(ListSchema, {
        items: ["a"],
        structs: [],
      })
      expect(reader.arrayLength([key("items")])).toBe(1)

      const rootMap = doc.getMap("root")
      const items = rootMap.get("items") as Y.Array<string>
      items.push(["b", "c"])
      expect(reader.arrayLength([key("items")])).toBe(3)
      expect(reader.read([key("items"), idx(1)])).toBe("b")
      expect(reader.read([key("items"), idx(2)])).toBe("c")
    })

    it("map mutations are immediately visible", () => {
      const { doc, reader } = setup(MapSchema, {
        labels: { bug: "red" },
      })
      expect(reader.hasKey([key("labels")], "feature")).toBe(false)

      const rootMap = doc.getMap("root")
      const labels = rootMap.get("labels") as Y.Map<string>
      labels.set("feature", "green")
      expect(reader.hasKey([key("labels")], "feature")).toBe(true)
      expect(reader.read([key("labels"), key("feature")])).toBe("green")
      expect(reader.keys([key("labels")]).sort()).toEqual(["bug", "feature"])
    })

    it("struct field mutations are immediately visible", () => {
      const { doc, reader } = setup(NestedStructSchema, {
        profile: {
          first: "Jane",
          last: "Doe",
          address: { city: "Portland", zip: "97201" },
        },
      })
      expect(reader.read([key("profile"), key("first")])).toBe("Jane")

      const rootMap = doc.getMap("root")
      const profile = rootMap.get("profile") as Y.Map<unknown>
      profile.set("first", "John")
      expect(reader.read([key("profile"), key("first")])).toBe("John")
    })

    it("nested struct mutations are immediately visible", () => {
      const { doc, reader } = setup(NestedStructSchema, {
        profile: {
          first: "Jane",
          last: "Doe",
          address: { city: "Portland", zip: "97201" },
        },
      })
      const rootMap = doc.getMap("root")
      const profile = rootMap.get("profile") as Y.Map<unknown>
      const address = profile.get("address") as Y.Map<string>
      address.set("city", "Seattle")
      expect(
        reader.read([key("profile"), key("address"), key("city")]),
      ).toBe("Seattle")
    })

    it("list delete + insert mutations are immediately visible", () => {
      const { doc, reader } = setup(ListSchema, {
        items: ["a", "b", "c"],
        structs: [],
      })
      const rootMap = doc.getMap("root")
      const items = rootMap.get("items") as Y.Array<string>

      items.delete(1, 1) // remove "b"
      expect(reader.arrayLength([key("items")])).toBe(2)
      expect(reader.read([key("items")])).toEqual(["a", "c"])

      items.insert(1, ["x"])
      expect(reader.read([key("items")])).toEqual(["a", "x", "c"])
    })
  })

  // -------------------------------------------------------------------------
  // Mixed schema — complex document with all types
  // -------------------------------------------------------------------------

  describe("mixed schema", () => {
    it("reads all field types in a complex document", () => {
      const { reader } = setup(MixedSchema, {
        title: "My Doc",
        count: 7,
        items: [
          { name: "Task 1", done: false },
          { name: "Task 2", done: true },
        ],
        meta: {
          author: "Alice",
          tags: ["draft", "v2"],
        },
        labels: { priority: "high" },
      })

      // Text
      expect(reader.read([key("title")])).toBe("My Doc")

      // Scalar
      expect(reader.read([key("count")])).toBe(7)

      // List of structs
      expect(reader.arrayLength([key("items")])).toBe(2)
      expect(reader.read([key("items"), idx(0), key("name")])).toBe("Task 1")
      expect(reader.read([key("items"), idx(1), key("done")])).toBe(true)

      // Nested struct with nested list
      expect(reader.read([key("meta"), key("author")])).toBe("Alice")
      expect(reader.arrayLength([key("meta"), key("tags")])).toBe(2)
      expect(reader.read([key("meta"), key("tags"), idx(0)])).toBe("draft")

      // Record (map)
      expect(reader.read([key("labels"), key("priority")])).toBe("high")
      expect(reader.hasKey([key("labels")], "priority")).toBe(true)
      expect(reader.keys([key("labels")])).toEqual(["priority"])
    })
  })
})
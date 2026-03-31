import { RawPath, Schema } from "@kyneta/schema"
import { describe, expect, it } from "vitest"
import * as Y from "yjs"
import { ensureContainers } from "../populate.js"
import { yjsStoreReader } from "../store-reader.js"

// ===========================================================================
// Helpers
// ===========================================================================

/**
 * Create a Y.Doc with containers matching the schema, populate it using
 * direct Yjs API calls, and return the doc + reader.
 *
 * After `ensureContainers` the doc has the correct shared types but no
 * values. We populate values via raw Yjs API within a single transact.
 */
function setup(
  schema: ReturnType<typeof Schema.doc>,
  seed?: Record<string, unknown>,
) {
  const doc = new Y.Doc()
  ensureContainers(doc, schema)
  if (seed) {
    doc.transact(() => {
      const rootMap = doc.getMap("root")
      populateSeed(rootMap, schema, seed)
    })
  }
  const reader = yjsStoreReader(doc, schema)
  return { doc, reader }
}

/**
 * Recursively populate a Y.Map from a seed object, guided by the schema.
 *
 * - text fields → Y.Text.insert(0, value)
 * - scalar fields → Y.Map.set(key, value)
 * - product (struct) fields → recurse into the existing Y.Map child
 * - sequence (list) fields → push items into the existing Y.Array child
 * - map (record) fields → set entries on the existing Y.Map child
 */
function populateSeed(
  ymap: Y.Map<unknown>,
  schema: ReturnType<typeof Schema.doc>,
  seed: Record<string, unknown>,
) {
  const rootProduct = unwrapToProduct(schema)
  if (!rootProduct) return

  for (const [key, value] of Object.entries(seed)) {
    if (value === undefined) continue
    const fieldSchema = (rootProduct.fields as Record<string, any>)[key]
    if (!fieldSchema) continue

    populateField(ymap, key, fieldSchema, value)
  }
}

function populateField(
  ymap: Y.Map<unknown>,
  key: string,
  fieldSchema: any,
  value: unknown,
) {
  const tag = fieldSchema._kind === "annotated" ? fieldSchema.tag : undefined

  if (tag === "text") {
    // Text field — the Y.Text was already created by ensureContainers
    const text = ymap.get(key) as Y.Text
    if (text && typeof value === "string" && value.length > 0) {
      text.insert(0, value)
    }
    return
  }

  const structural = unwrapAnnotations(fieldSchema)

  switch (structural._kind) {
    case "product": {
      // Struct — recurse into the existing Y.Map
      const childMap = ymap.get(key) as Y.Map<unknown>
      if (childMap && typeof value === "object" && value !== null) {
        for (const [childKey, childValue] of Object.entries(
          value as Record<string, unknown>,
        )) {
          const childFieldSchema = (structural.fields as Record<string, any>)[
            childKey
          ]
          if (!childFieldSchema) continue
          populateField(childMap, childKey, childFieldSchema, childValue)
        }
      }
      return
    }

    case "sequence": {
      // List — push items into the existing Y.Array
      const arr = ymap.get(key) as Y.Array<unknown>
      if (arr && Array.isArray(value)) {
        for (const item of value) {
          const itemSchema = structural.item
          if (itemSchema && unwrapAnnotations(itemSchema)._kind === "product") {
            // Struct items: create a Y.Map for each
            const itemMap = buildStructMap(
              unwrapAnnotations(itemSchema),
              item as Record<string, unknown>,
            )
            arr.push([itemMap])
          } else {
            arr.push([item])
          }
        }
      }
      return
    }

    case "map": {
      // Record — set entries on the existing Y.Map
      const childMap = ymap.get(key) as Y.Map<unknown>
      if (childMap && typeof value === "object" && value !== null) {
        for (const [entryKey, entryValue] of Object.entries(
          value as Record<string, unknown>,
        )) {
          childMap.set(entryKey, entryValue)
        }
      }
      return
    }

    default: {
      // Scalar — set plain value
      ymap.set(key, value)
      return
    }
  }
}

/**
 * Build a Y.Map for a struct item (used inside Y.Array).
 */
function buildStructMap(
  productSchema: any,
  seed: Record<string, unknown>,
): Y.Map<unknown> {
  const map = new Y.Map<unknown>()
  for (const [key, fieldSchema] of Object.entries(
    productSchema.fields as Record<string, any>,
  )) {
    const value = seed[key]
    if (value === undefined) continue

    const tag = fieldSchema._kind === "annotated" ? fieldSchema.tag : undefined
    if (tag === "text") {
      const text = new Y.Text()
      if (typeof value === "string" && value.length > 0) {
        text.insert(0, value)
      }
      map.set(key, text)
      continue
    }

    const structural = unwrapAnnotations(fieldSchema)
    switch (structural._kind) {
      case "product": {
        map.set(
          key,
          buildStructMap(structural, value as Record<string, unknown>),
        )
        break
      }
      case "sequence": {
        const arr = new Y.Array()
        if (Array.isArray(value)) {
          for (const item of value) {
            const itemSchema = structural.element ?? structural.schema
            if (
              itemSchema &&
              unwrapAnnotations(itemSchema)._kind === "product"
            ) {
              arr.push([
                buildStructMap(
                  unwrapAnnotations(itemSchema),
                  item as Record<string, unknown>,
                ),
              ])
            } else {
              arr.push([item])
            }
          }
        }
        map.set(key, arr)
        break
      }
      case "map": {
        const childMap = new Y.Map()
        if (typeof value === "object" && value !== null) {
          for (const [k, v] of Object.entries(
            value as Record<string, unknown>,
          )) {
            childMap.set(k, v)
          }
        }
        map.set(key, childMap)
        break
      }
      default:
        map.set(key, value)
        break
    }
  }
  return map
}

function unwrapToProduct(schema: any): any {
  let s = schema
  while (s._kind === "annotated" && s.schema !== undefined) {
    s = s.schema
  }
  if (s._kind === "product") return s
  return null
}

function unwrapAnnotations(schema: any): any {
  let s = schema
  while (s._kind === "annotated" && s.schema !== undefined) {
    s = s.schema
  }
  return s
}

/** Build a RawPath from variadic key/index segments. */
function p(...segs: (string | number)[]): RawPath {
  let path = RawPath.empty
  for (const s of segs) {
    path = typeof s === "string" ? path.field(s) : path.item(s)
  }
  return path
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
      expect(reader.read(p("title"))).toBe("Hello")
      expect(reader.read(p("subtitle"))).toBe("")
    })

    it("reads Y.Text with default empty string", () => {
      const { reader } = setup(TextSchema)
      expect(reader.read(p("title"))).toBe("")
    })

    it("reads plain scalars (string, number, boolean)", () => {
      const { reader } = setup(ScalarSchema, {
        name: "Alice",
        count: 42,
        active: true,
      })
      expect(reader.read(p("name"))).toBe("Alice")
      expect(reader.read(p("count"))).toBe(42)
      expect(reader.read(p("active"))).toBe(true)
    })

    it("reads scalar defaults", () => {
      const { reader } = setup(ScalarSchema)
      expect(reader.read(p("name"))).toBe("")
      expect(reader.read(p("count"))).toBe(0)
      expect(reader.read(p("active"))).toBe(false)
    })

    it("reads nested struct fields", () => {
      const { reader } = setup(NestedStructSchema, {
        profile: {
          first: "Jane",
          last: "Doe",
          address: { city: "Portland", zip: "97201" },
        },
      })
      expect(reader.read(p("profile", "first"))).toBe("Jane")
      expect(reader.read(p("profile", "last"))).toBe("Doe")
      expect(reader.read(p("profile", "address", "city"))).toBe("Portland")
      expect(reader.read(p("profile", "address", "zip"))).toBe("97201")
    })

    it("reads nested struct as plain object", () => {
      const { reader } = setup(NestedStructSchema, {
        profile: {
          first: "Jane",
          last: "Doe",
          address: { city: "Portland", zip: "97201" },
        },
      })
      const profile = reader.read(p("profile")) as Record<string, unknown>
      expect(profile.first).toBe("Jane")
      expect(profile.last).toBe("Doe")
      expect((profile.address as Record<string, unknown>).city).toBe("Portland")
    })

    it("reads list items by index", () => {
      const { reader } = setup(ListSchema, {
        items: ["a", "b", "c"],
        structs: [],
      })
      expect(reader.read(p("items", 0))).toBe("a")
      expect(reader.read(p("items", 1))).toBe("b")
      expect(reader.read(p("items", 2))).toBe("c")
    })

    it("reads list as plain array", () => {
      const { reader } = setup(ListSchema, {
        items: ["x", "y"],
        structs: [],
      })
      expect(reader.read(p("items"))).toEqual(["x", "y"])
    })

    it("reads struct items within lists", () => {
      const { reader } = setup(ListSchema, {
        items: [],
        structs: [
          { name: "Task 1", done: false },
          { name: "Task 2", done: true },
        ],
      })
      expect(reader.read(p("structs", 0, "name"))).toBe("Task 1")
      expect(reader.read(p("structs", 1, "done"))).toBe(true)
      const item = reader.read(p("structs", 0)) as Record<string, unknown>
      expect(item.name).toBe("Task 1")
      expect(item.done).toBe(false)
    })

    it("reads map entries", () => {
      const { reader } = setup(MapSchema, {
        labels: { bug: "red", feature: "green" },
      })
      expect(reader.read(p("labels", "bug"))).toBe("red")
      expect(reader.read(p("labels", "feature"))).toBe("green")
    })

    it("reads map as plain object", () => {
      const { reader } = setup(MapSchema, {
        labels: { bug: "red", feature: "green" },
      })
      expect(reader.read(p("labels"))).toEqual({
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
      const root = reader.read(RawPath.empty) as Record<string, unknown>
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
      expect(reader.arrayLength(p("items"))).toBe(0)
    })

    it("returns correct length for populated list", () => {
      const { reader } = setup(ListSchema, {
        items: ["a", "b", "c"],
        structs: [],
      })
      expect(reader.arrayLength(p("items"))).toBe(3)
    })

    it("returns correct length for struct list", () => {
      const { reader } = setup(ListSchema, {
        items: [],
        structs: [
          { name: "A", done: false },
          { name: "B", done: true },
        ],
      })
      expect(reader.arrayLength(p("structs"))).toBe(2)
    })

    it("returns 0 for non-list paths", () => {
      const { reader } = setup(ScalarSchema, {
        name: "test",
        count: 0,
        active: true,
      })
      expect(reader.arrayLength(p("name"))).toBe(0)
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
      const k = reader.keys(p("labels"))
      expect(k.sort()).toEqual(["bug", "docs", "feature"])
    })

    it("returns keys of empty map", () => {
      const { reader } = setup(MapSchema, { labels: {} })
      expect(reader.keys(p("labels"))).toEqual([])
    })

    it("returns keys of nested struct (product stored as Y.Map)", () => {
      const { reader } = setup(NestedStructSchema, {
        profile: {
          first: "Jane",
          last: "Doe",
          address: { city: "Portland", zip: "97201" },
        },
      })
      const k = reader.keys(p("profile"))
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
      const k = reader.keys(p("profile", "address"))
      expect(k.sort()).toEqual(["city", "zip"])
    })

    it("returns empty array for non-map paths", () => {
      const { reader } = setup(ScalarSchema, {
        name: "test",
        count: 0,
        active: true,
      })
      expect(reader.keys(p("name"))).toEqual([])
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
      expect(reader.hasKey(p("labels"), "bug")).toBe(true)
    })

    it("returns false for missing key in record", () => {
      const { reader } = setup(MapSchema, {
        labels: { bug: "red" },
      })
      expect(reader.hasKey(p("labels"), "nonexistent")).toBe(false)
    })

    it("returns true for existing key in struct (Y.Map)", () => {
      const { reader } = setup(NestedStructSchema, {
        profile: {
          first: "Jane",
          last: "Doe",
          address: { city: "Portland", zip: "97201" },
        },
      })
      expect(reader.hasKey(p("profile"), "first")).toBe(true)
      expect(reader.hasKey(p("profile"), "address")).toBe(true)
    })

    it("returns false for missing key in struct", () => {
      const { reader } = setup(NestedStructSchema, {
        profile: {
          first: "Jane",
          last: "Doe",
          address: { city: "Portland", zip: "97201" },
        },
      })
      expect(reader.hasKey(p("profile"), "nonexistent")).toBe(false)
    })

    it("returns false for non-map paths", () => {
      const { reader } = setup(ScalarSchema, {
        name: "test",
        count: 0,
        active: true,
      })
      expect(reader.hasKey(p("name"), "anything")).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // Liveness — mutations via raw Yjs API immediately visible
  // -------------------------------------------------------------------------

  describe("liveness", () => {
    it("text mutations are immediately visible", () => {
      const { doc, reader } = setup(TextSchema, { title: "Hello" })
      expect(reader.read(p("title"))).toBe("Hello")

      // Mutate via raw Yjs API
      const rootMap = doc.getMap("root")
      const text = rootMap.get("title") as Y.Text
      text.insert(5, " World")
      expect(reader.read(p("title"))).toBe("Hello World")
    })

    it("scalar mutations are immediately visible", () => {
      const { doc, reader } = setup(ScalarSchema, {
        name: "Alice",
        count: 0,
        active: false,
      })
      expect(reader.read(p("name"))).toBe("Alice")

      const rootMap = doc.getMap("root")
      rootMap.set("name", "Bob")
      expect(reader.read(p("name"))).toBe("Bob")
    })

    it("list mutations are immediately visible", () => {
      const { doc, reader } = setup(ListSchema, {
        items: ["a"],
        structs: [],
      })
      expect(reader.arrayLength(p("items"))).toBe(1)

      const rootMap = doc.getMap("root")
      const items = rootMap.get("items") as Y.Array<string>
      items.push(["b", "c"])
      expect(reader.arrayLength(p("items"))).toBe(3)
      expect(reader.read(p("items", 1))).toBe("b")
      expect(reader.read(p("items", 2))).toBe("c")
    })

    it("map mutations are immediately visible", () => {
      const { doc, reader } = setup(MapSchema, {
        labels: { bug: "red" },
      })
      expect(reader.hasKey(p("labels"), "feature")).toBe(false)

      const rootMap = doc.getMap("root")
      const labels = rootMap.get("labels") as Y.Map<string>
      labels.set("feature", "green")
      expect(reader.hasKey(p("labels"), "feature")).toBe(true)
      expect(reader.read(p("labels", "feature"))).toBe("green")
      expect(reader.keys(p("labels")).sort()).toEqual(["bug", "feature"])
    })

    it("struct field mutations are immediately visible", () => {
      const { doc, reader } = setup(NestedStructSchema, {
        profile: {
          first: "Jane",
          last: "Doe",
          address: { city: "Portland", zip: "97201" },
        },
      })
      expect(reader.read(p("profile", "first"))).toBe("Jane")

      const rootMap = doc.getMap("root")
      const profile = rootMap.get("profile") as Y.Map<unknown>
      profile.set("first", "John")
      expect(reader.read(p("profile", "first"))).toBe("John")
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
      expect(reader.read(p("profile", "address", "city"))).toBe("Seattle")
    })

    it("list delete + insert mutations are immediately visible", () => {
      const { doc, reader } = setup(ListSchema, {
        items: ["a", "b", "c"],
        structs: [],
      })
      const rootMap = doc.getMap("root")
      const items = rootMap.get("items") as Y.Array<string>

      items.delete(1, 1) // remove "b"
      expect(reader.arrayLength(p("items"))).toBe(2)
      expect(reader.read(p("items"))).toEqual(["a", "c"])

      items.insert(1, ["x"])
      expect(reader.read(p("items"))).toEqual(["a", "x", "c"])
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
      expect(reader.read(p("title"))).toBe("My Doc")

      // Scalar
      expect(reader.read(p("count"))).toBe(7)

      // List of structs
      expect(reader.arrayLength(p("items"))).toBe(2)
      expect(reader.read(p("items", 0, "name"))).toBe("Task 1")
      expect(reader.read(p("items", 1, "done"))).toBe(true)

      // Nested struct with nested list
      expect(reader.read(p("meta", "author"))).toBe("Alice")
      expect(reader.arrayLength(p("meta", "tags"))).toBe(2)
      expect(reader.read(p("meta", "tags", 0))).toBe("draft")

      // Record (map)
      expect(reader.read(p("labels", "priority"))).toBe("high")
      expect(reader.hasKey(p("labels"), "priority")).toBe(true)
      expect(reader.keys(p("labels"))).toEqual(["priority"])
    })
  })
})

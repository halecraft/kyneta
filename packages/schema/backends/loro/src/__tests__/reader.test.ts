import type { Reader } from "@kyneta/schema"
import { RawPath, Schema } from "@kyneta/schema"
import { LoroDoc, LoroList, LoroMap, LoroMovableList } from "loro-crdt"
import { describe, expect, it } from "vitest"
import { LoroSchema } from "../loro-schema.js"
import { loroReader } from "../reader.js"

// ===========================================================================
// Helpers
// ===========================================================================

/**
 * Create a doc + store reader from a schema, applying a setup function
 * to populate the doc via native Loro API before creating the reader.
 */
function createReader(
  schema: ReturnType<typeof Schema.doc | typeof LoroSchema.doc>,
  setup: (doc: LoroDoc) => void,
): { doc: LoroDoc; reader: Reader } {
  const doc = new LoroDoc()
  setup(doc)
  doc.commit()
  return { doc, reader: loroReader(doc, schema) }
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
// Test schemas
// ===========================================================================

const SimpleDocSchema = LoroSchema.doc({
  title: LoroSchema.text(),
  count: LoroSchema.counter(),
  theme: Schema.string(),
})

const ListDocSchema = LoroSchema.doc({
  items: Schema.list(
    Schema.struct({
      name: Schema.string(),
      done: Schema.boolean(),
    }),
  ),
})

const MapDocSchema = LoroSchema.doc({
  labels: Schema.record(Schema.string()),
})

const NestedDocSchema = LoroSchema.doc({
  settings: Schema.struct({
    darkMode: Schema.boolean(),
    fontSize: Schema.number(),
  }),
})

const MovableListDocSchema = LoroSchema.doc({
  tasks: LoroSchema.movableList(
    Schema.struct({
      title: Schema.string(),
      priority: Schema.number(),
    }),
  ),
})

// ===========================================================================
// Tests
// ===========================================================================

describe("loroReader", () => {
  // -------------------------------------------------------------------------
  // Scalar reads (text, counter)
  // -------------------------------------------------------------------------

  describe("read: scalars", () => {
    it("reads a LoroText as a string", () => {
      const { reader } = createReader(SimpleDocSchema, doc => {
        doc.getText("title").insert(0, "Hello World")
      })
      expect(reader.read(p("title"))).toBe("Hello World")
    })

    it("reads an empty LoroText as empty string", () => {
      const { reader } = createReader(SimpleDocSchema, _doc => {
        // getText auto-creates; no insert
        _doc.getText("title")
      })
      expect(reader.read(p("title"))).toBe("")
    })

    it("reads a LoroCounter as a number", () => {
      const { reader } = createReader(SimpleDocSchema, doc => {
        doc.getCounter("count").increment(42)
      })
      expect(reader.read(p("count"))).toBe(42)
    })

    it("reads a LoroCounter with zero value", () => {
      const { reader } = createReader(SimpleDocSchema, doc => {
        doc.getCounter("count") // auto-creates at 0
      })
      expect(reader.read(p("count"))).toBe(0)
    })
  })

  // -------------------------------------------------------------------------
  // Nested struct reads
  // -------------------------------------------------------------------------

  describe("read: nested structs", () => {
    it("reads a nested scalar field", () => {
      const { reader } = createReader(NestedDocSchema, doc => {
        const settings = doc.getMap("settings")
        settings.set("darkMode", true)
        settings.set("fontSize", 16)
      })
      expect(reader.read(p("settings", "darkMode"))).toBe(true)
      expect(reader.read(p("settings", "fontSize"))).toBe(16)
    })

    it("reads a nested struct as a plain object (product read)", () => {
      const { reader } = createReader(NestedDocSchema, doc => {
        const settings = doc.getMap("settings")
        settings.set("darkMode", false)
        settings.set("fontSize", 14)
      })
      const result = reader.read(p("settings"))
      expect(result).toEqual({ darkMode: false, fontSize: 14 })
    })
  })

  // -------------------------------------------------------------------------
  // List reads
  // -------------------------------------------------------------------------

  describe("read: lists", () => {
    it("reads a list item (struct inside list)", () => {
      const { reader } = createReader(ListDocSchema, doc => {
        const list = doc.getList("items")
        const map = list.insertContainer(0, new LoroMap())
        map.set("name", "Task 1")
        map.set("done", false)
      })
      const item = reader.read(p("items", 0))
      expect(item).toEqual({ name: "Task 1", done: false })
    })

    it("reads a scalar field inside a list item", () => {
      const { reader } = createReader(ListDocSchema, doc => {
        const list = doc.getList("items")
        const map = list.insertContainer(0, new LoroMap())
        map.set("name", "Buy milk")
        map.set("done", true)
      })
      expect(reader.read(p("items", 0, "name"))).toBe("Buy milk")
      expect(reader.read(p("items", 0, "done"))).toBe(true)
    })

    it("reads multiple list items", () => {
      const { reader } = createReader(ListDocSchema, doc => {
        const list = doc.getList("items")
        const m0 = list.insertContainer(0, new LoroMap())
        m0.set("name", "First")
        m0.set("done", false)
        const m1 = list.insertContainer(1, new LoroMap())
        m1.set("name", "Second")
        m1.set("done", true)
      })
      expect(reader.read(p("items", 0, "name"))).toBe("First")
      expect(reader.read(p("items", 1, "name"))).toBe("Second")
    })
  })

  // -------------------------------------------------------------------------
  // Map reads (record)
  // -------------------------------------------------------------------------

  describe("read: maps", () => {
    it("reads a map entry", () => {
      const { reader } = createReader(MapDocSchema, doc => {
        const labels = doc.getMap("labels")
        labels.set("bug", "red")
        labels.set("feature", "blue")
      })
      expect(reader.read(p("labels", "bug"))).toBe("red")
      expect(reader.read(p("labels", "feature"))).toBe("blue")
    })
  })

  // -------------------------------------------------------------------------
  // MovableList reads
  // -------------------------------------------------------------------------

  describe("read: movable lists", () => {
    it("reads a movable list item", () => {
      const { reader } = createReader(MovableListDocSchema, doc => {
        const tasks = doc.getMovableList("tasks")
        const m = tasks.insertContainer(0, new LoroMap())
        m.set("title", "Urgent task")
        m.set("priority", 1)
      })
      const item = reader.read(p("tasks", 0))
      expect(item).toEqual({ title: "Urgent task", priority: 1 })
    })

    it("reads a field inside a movable list item", () => {
      const { reader } = createReader(MovableListDocSchema, doc => {
        const tasks = doc.getMovableList("tasks")
        const m = tasks.insertContainer(0, new LoroMap())
        m.set("title", "Do laundry")
        m.set("priority", 3)
      })
      expect(reader.read(p("tasks", 0, "title"))).toBe("Do laundry")
    })
  })

  // -------------------------------------------------------------------------
  // arrayLength
  // -------------------------------------------------------------------------

  describe("arrayLength", () => {
    it("returns 0 for an empty list", () => {
      const { reader } = createReader(ListDocSchema, doc => {
        doc.getList("items") // auto-creates empty
      })
      expect(reader.arrayLength(p("items"))).toBe(0)
    })

    it("returns correct length after inserts", () => {
      const { reader } = createReader(ListDocSchema, doc => {
        const list = doc.getList("items")
        list.insertContainer(0, new LoroMap())
        list.insertContainer(1, new LoroMap())
        list.insertContainer(2, new LoroMap())
      })
      expect(reader.arrayLength(p("items"))).toBe(3)
    })

    it("returns correct length for movable list", () => {
      const { reader } = createReader(MovableListDocSchema, doc => {
        const tasks = doc.getMovableList("tasks")
        tasks.insertContainer(0, new LoroMap())
        tasks.insertContainer(1, new LoroMap())
      })
      expect(reader.arrayLength(p("tasks"))).toBe(2)
    })

    it("returns 0 for a non-list container", () => {
      const { reader } = createReader(NestedDocSchema, doc => {
        doc.getMap("settings")
      })
      expect(reader.arrayLength(p("settings"))).toBe(0)
    })
  })

  // -------------------------------------------------------------------------
  // keys
  // -------------------------------------------------------------------------

  describe("keys", () => {
    it("returns keys for a LoroMap", () => {
      const { reader } = createReader(MapDocSchema, doc => {
        const labels = doc.getMap("labels")
        labels.set("bug", "red")
        labels.set("feature", "blue")
        labels.set("chore", "gray")
      })
      const k = reader.keys(p("labels"))
      expect(k).toContain("bug")
      expect(k).toContain("feature")
      expect(k).toContain("chore")
      expect(k).toHaveLength(3)
    })

    it("returns empty array for an empty map", () => {
      const { reader } = createReader(MapDocSchema, doc => {
        doc.getMap("labels")
      })
      expect(reader.keys(p("labels"))).toEqual([])
    })

    it("returns keys for a nested struct (LoroMap)", () => {
      const { reader } = createReader(NestedDocSchema, doc => {
        const settings = doc.getMap("settings")
        settings.set("darkMode", false)
        settings.set("fontSize", 14)
      })
      const k = reader.keys(p("settings"))
      expect(k).toContain("darkMode")
      expect(k).toContain("fontSize")
    })

    it("returns empty array for a non-map container", () => {
      const { reader } = createReader(ListDocSchema, doc => {
        doc.getList("items")
      })
      expect(reader.keys(p("items"))).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  // hasKey
  // -------------------------------------------------------------------------

  describe("hasKey", () => {
    it("returns true for an existing key", () => {
      const { reader } = createReader(MapDocSchema, doc => {
        doc.getMap("labels").set("bug", "red")
      })
      expect(reader.hasKey(p("labels"), "bug")).toBe(true)
    })

    it("returns false for a missing key", () => {
      const { reader } = createReader(MapDocSchema, doc => {
        doc.getMap("labels").set("bug", "red")
      })
      expect(reader.hasKey(p("labels"), "missing")).toBe(false)
    })

    it("returns false for non-map container", () => {
      const { reader } = createReader(ListDocSchema, doc => {
        doc.getList("items")
      })
      expect(reader.hasKey(p("items"), "anything")).toBe(false)
    })

    it("works on nested map (struct)", () => {
      const { reader } = createReader(NestedDocSchema, doc => {
        const settings = doc.getMap("settings")
        settings.set("darkMode", true)
      })
      expect(reader.hasKey(p("settings"), "darkMode")).toBe(true)
      expect(reader.hasKey(p("settings"), "fontSize")).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // Liveness: mutations are immediately visible
  // -------------------------------------------------------------------------

  describe("liveness", () => {
    it("reflects text mutations immediately", () => {
      const { doc, reader } = createReader(SimpleDocSchema, d => {
        d.getText("title").insert(0, "Hello")
      })
      expect(reader.read(p("title"))).toBe("Hello")

      // Mutate after reader creation
      doc.getText("title").insert(5, " World")
      doc.commit()
      expect(reader.read(p("title"))).toBe("Hello World")
    })

    it("reflects counter mutations immediately", () => {
      const { doc, reader } = createReader(SimpleDocSchema, d => {
        d.getCounter("count").increment(1)
      })
      expect(reader.read(p("count"))).toBe(1)

      doc.getCounter("count").increment(9)
      doc.commit()
      expect(reader.read(p("count"))).toBe(10)
    })

    it("reflects list length changes immediately", () => {
      const { doc, reader } = createReader(ListDocSchema, d => {
        d.getList("items")
      })
      expect(reader.arrayLength(p("items"))).toBe(0)

      doc.getList("items").insertContainer(0, new LoroMap())
      doc.commit()
      expect(reader.arrayLength(p("items"))).toBe(1)
    })
  })

  // -------------------------------------------------------------------------
  // Dynamic zone navigation: doc → list → [i] → struct field
  // -------------------------------------------------------------------------

  describe("dynamic zone navigation", () => {
    it("navigates through list into struct fields created by insertContainer", () => {
      const schema = LoroSchema.doc({
        people: Schema.list(
          Schema.struct({
            name: Schema.string(),
            age: Schema.number(),
          }),
        ),
      })

      const { reader } = createReader(schema, doc => {
        const list = doc.getList("people")
        const alice = list.insertContainer(0, new LoroMap())
        alice.set("name", "Alice")
        alice.set("age", 30)
        const bob = list.insertContainer(1, new LoroMap())
        bob.set("name", "Bob")
        bob.set("age", 25)
      })

      expect(reader.read(p("people", 0, "name"))).toBe("Alice")
      expect(reader.read(p("people", 0, "age"))).toBe(30)
      expect(reader.read(p("people", 1, "name"))).toBe("Bob")
      expect(reader.read(p("people", 1, "age"))).toBe(25)
      expect(reader.arrayLength(p("people"))).toBe(2)
    })
  })

  // -------------------------------------------------------------------------
  // Concurrent peer scenario
  // -------------------------------------------------------------------------

  describe("concurrent peers", () => {
    it("sees merged items after sync between two peers", () => {
      const schema = LoroSchema.doc({
        items: Schema.list(
          Schema.struct({
            name: Schema.string(),
            peer: Schema.number(),
          }),
        ),
      })

      const doc1 = new LoroDoc()
      const doc2 = new LoroDoc()

      // Both start with an empty list
      doc1.getList("items")
      doc1.commit()
      doc2.getList("items")
      doc2.commit()

      // Sync to share base state
      const u1 = doc1.export({ mode: "update", from: doc2.version() })
      const u2 = doc2.export({ mode: "update", from: doc1.version() })
      doc2.import(u1)
      doc1.import(u2)

      // Peer 1 inserts
      const m1 = doc1.getList("items").insertContainer(0, new LoroMap())
      m1.set("name", "FromPeer1")
      m1.set("peer", 1)
      doc1.commit()

      // Peer 2 independently inserts
      const m2 = doc2.getList("items").insertContainer(0, new LoroMap())
      m2.set("name", "FromPeer2")
      m2.set("peer", 2)
      doc2.commit()

      // Sync bidirectionally
      const sync1 = doc1.export({ mode: "update", from: doc2.version() })
      const sync2 = doc2.export({ mode: "update", from: doc1.version() })
      doc2.import(sync1)
      doc1.import(sync2)

      // Both docs should now have 2 items
      const reader1 = loroReader(doc1, schema)
      const reader2 = loroReader(doc2, schema)

      expect(reader1.arrayLength(p("items"))).toBe(2)
      expect(reader2.arrayLength(p("items"))).toBe(2)

      // Both should see the same items (convergence)
      const names1 = [
        reader1.read(p("items", 0, "name")),
        reader1.read(p("items", 1, "name")),
      ].sort()
      const names2 = [
        reader2.read(p("items", 0, "name")),
        reader2.read(p("items", 1, "name")),
      ].sort()

      expect(names1).toEqual(names2)
      expect(names1).toContain("FromPeer1")
      expect(names1).toContain("FromPeer2")
    })
  })
})

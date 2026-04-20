import { describe, expect, it } from "vitest"
import {
  advanceSchema,
  KIND,
  type RawSegment,
  rawIndex,
  rawKey,
  Schema,
} from "../index.js"

// ===========================================================================
// advanceSchema — pure schema descent for a single path segment
// ===========================================================================

const key = (k: string): RawSegment => rawKey(k)
const index = (i: number): RawSegment => rawIndex(i)

describe("advanceSchema", () => {
  // -------------------------------------------------------------------------
  // Product
  // -------------------------------------------------------------------------

  describe("product", () => {
    const schema = Schema.struct({
      title: Schema.string(),
      count: Schema.number(),
      nested: Schema.struct({
        flag: Schema.boolean(),
      }),
    })

    it("key segment returns the field schema", () => {
      const result = advanceSchema(schema, key("title"))
      expect(result[KIND]).toBe("scalar")
      expect((result as any).scalarKind).toBe("string")
    })

    it("key segment returns a nested product schema", () => {
      const result = advanceSchema(schema, key("nested"))
      expect(result[KIND]).toBe("product")
      expect(Object.keys((result as any).fields)).toEqual(["flag"])
    })

    it("throws on unknown field", () => {
      expect(() => advanceSchema(schema, key("missing"))).toThrow(
        'product has no field "missing"',
      )
    })

    it("throws on index segment", () => {
      expect(() => advanceSchema(schema, index(0))).toThrow(
        "product expects a key segment",
      )
    })
  })

  // -------------------------------------------------------------------------
  // Sequence
  // -------------------------------------------------------------------------

  describe("sequence", () => {
    const schema = Schema.list(
      Schema.struct({ name: Schema.string(), done: Schema.boolean() }),
    )

    it("index segment returns the item schema", () => {
      const result = advanceSchema(schema, index(0))
      expect(result[KIND]).toBe("product")
      expect(Object.keys((result as any).fields)).toContain("name")
    })

    it("any index returns the same item schema", () => {
      const r0 = advanceSchema(schema, index(0))
      const r99 = advanceSchema(schema, index(99))
      expect(r0).toBe(r99) // referentially identical
    })

    it("throws on key segment", () => {
      expect(() => advanceSchema(schema, key("foo"))).toThrow(
        "sequence expects an index segment",
      )
    })
  })

  // -------------------------------------------------------------------------
  // Map
  // -------------------------------------------------------------------------

  describe("map", () => {
    const schema = Schema.record(Schema.number())

    it("key segment returns the item schema", () => {
      const result = advanceSchema(schema, key("anything"))
      expect(result[KIND]).toBe("scalar")
      expect((result as any).scalarKind).toBe("number")
    })

    it("any key returns the same item schema", () => {
      const r1 = advanceSchema(schema, key("a"))
      const r2 = advanceSchema(schema, key("z"))
      expect(r1).toBe(r2) // referentially identical
    })

    it("throws on index segment", () => {
      expect(() => advanceSchema(schema, index(0))).toThrow(
        "map expects a key segment",
      )
    })
  })

  // -------------------------------------------------------------------------
  // Struct (was doc) — product dispatch
  // -------------------------------------------------------------------------

  describe("struct", () => {
    const schema = Schema.struct({
      title: Schema.string(),
      count: Schema.number(),
    })

    it("returns field schema for key segment", () => {
      const result = advanceSchema(schema, key("title"))
      expect(result[KIND]).toBe("scalar")
      expect((result as any).scalarKind).toBe("string")
    })

    it("returns field schema for all fields", () => {
      const result = advanceSchema(schema, key("count"))
      expect(result[KIND]).toBe("scalar")
      expect((result as any).scalarKind).toBe("number")
    })
  })

  // -------------------------------------------------------------------------
  // MovableList — movable sequence dispatch
  // -------------------------------------------------------------------------

  describe("movableList", () => {
    const schema = Schema.movableList(Schema.struct({ name: Schema.string() }))

    it("index segment returns the item schema", () => {
      const result = advanceSchema(schema, index(0))
      expect(result[KIND]).toBe("product")
      expect(Object.keys((result as any).fields)).toContain("name")
    })
  })

  // -------------------------------------------------------------------------
  // Text/Counter — leaf types, cannot advance
  // -------------------------------------------------------------------------

  describe("leaf types", () => {
    it("throws when advancing into text (leaf type, no inner schema)", () => {
      const schema = Schema.text()
      expect(() => advanceSchema(schema, key("anything"))).toThrow(
        "cannot advance into text",
      )
    })

    it("throws when advancing into counter (leaf type, no inner schema)", () => {
      const schema = Schema.counter()
      expect(() => advanceSchema(schema, index(0))).toThrow(
        "cannot advance into counter",
      )
    })
  })

  // -------------------------------------------------------------------------
  // Tree — delegates to nodeData
  // -------------------------------------------------------------------------

  describe("tree", () => {
    const schema = Schema.tree(Schema.struct({ label: Schema.string() }))

    it("delegates to nodeData and returns field schema", () => {
      const result = advanceSchema(schema, key("label"))
      expect(result[KIND]).toBe("scalar")
      expect((result as any).scalarKind).toBe("string")
    })
  })

  // -------------------------------------------------------------------------
  // Scalar — cannot advance
  // -------------------------------------------------------------------------

  describe("scalar", () => {
    it("throws when advancing into a scalar", () => {
      expect(() => advanceSchema(Schema.string(), key("x"))).toThrow(
        "cannot advance into a scalar",
      )
    })
  })

  // -------------------------------------------------------------------------
  // Sum — cannot advance
  // -------------------------------------------------------------------------

  describe("sum", () => {
    it("throws when advancing through a sum", () => {
      const schema = Schema.string().nullable()
      expect(() => advanceSchema(schema, key("x"))).toThrow(
        "cannot advance through a sum",
      )
    })
  })

  // -------------------------------------------------------------------------
  // Multi-step descent (product → sequence → product)
  // -------------------------------------------------------------------------

  describe("multi-step descent", () => {
    const schema = Schema.struct({
      items: Schema.list(
        Schema.struct({
          name: Schema.string(),
          tags: Schema.list(Schema.string()),
        }),
      ),
      settings: Schema.struct({
        darkMode: Schema.boolean(),
      }),
    })

    it("product → sequence → product → scalar", () => {
      const step1 = advanceSchema(schema, key("items")) // → sequence
      expect(step1[KIND]).toBe("sequence")

      const step2 = advanceSchema(step1, index(0)) // → product (item)
      expect(step2[KIND]).toBe("product")

      const step3 = advanceSchema(step2, key("name")) // → scalar
      expect(step3[KIND]).toBe("scalar")
      expect((step3 as any).scalarKind).toBe("string")
    })

    it("product → sequence → product → sequence → scalar", () => {
      const step1 = advanceSchema(schema, key("items"))
      const step2 = advanceSchema(step1, index(0))
      const step3 = advanceSchema(step2, key("tags"))
      expect(step3[KIND]).toBe("sequence")

      const step4 = advanceSchema(step3, index(0))
      expect(step4[KIND]).toBe("scalar")
      expect((step4 as any).scalarKind).toBe("string")
    })

    it("product → product → scalar", () => {
      const step1 = advanceSchema(schema, key("settings"))
      expect(step1[KIND]).toBe("product")

      const step2 = advanceSchema(step1, key("darkMode"))
      expect(step2[KIND]).toBe("scalar")
      expect((step2 as any).scalarKind).toBe("boolean")
    })
  })

  // -------------------------------------------------------------------------
  // Result that is a sum (returned as-is, not advanced through)
  // -------------------------------------------------------------------------

  describe("result is a sum", () => {
    const schema = Schema.struct({
      bio: Schema.string().nullable(),
    })

    it("product field returning a sum returns the sum node", () => {
      const result = advanceSchema(schema, key("bio"))
      expect(result[KIND]).toBe("sum")
    })
  })

  // -------------------------------------------------------------------------
  // Annotated doc with annotations
  // -------------------------------------------------------------------------

  describe("struct with first-class types", () => {
    const schema = Schema.struct({
      title: Schema.text(),
      count: Schema.counter(),
      tasks: Schema.movableList(
        Schema.struct({
          name: Schema.string(),
          done: Schema.boolean(),
        }),
      ),
    })

    it("returns text schema for text field", () => {
      const result = advanceSchema(schema, key("title"))
      expect(result[KIND]).toBe("text")
    })

    it("returns counter schema for counter field", () => {
      const result = advanceSchema(schema, key("count"))
      expect(result[KIND]).toBe("counter")
    })

    it("returns movable schema for movableList field", () => {
      const result = advanceSchema(schema, key("tasks"))
      expect(result[KIND]).toBe("movable")
    })

    it("can descend through movableList into item struct", () => {
      const step1 = advanceSchema(schema, key("tasks")) // → movable sequence
      const step2 = advanceSchema(step1, index(0)) // → product (struct)
      expect(step2[KIND]).toBe("product")
      expect(Object.keys((step2 as any).fields)).toContain("name")
    })
  })
})

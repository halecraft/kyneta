import { describe, expect, it } from "vitest"
import type { PathSegment } from "../index.js"
import { advanceSchema, LoroSchema, Schema } from "../index.js"

// ===========================================================================
// advanceSchema — pure schema descent for a single path segment
// ===========================================================================

const key = (k: string): PathSegment => ({ type: "key", key: k })
const index = (i: number): PathSegment => ({ type: "index", index: i })

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
      expect(result._kind).toBe("scalar")
      expect((result as any).scalarKind).toBe("string")
    })

    it("key segment returns a nested product schema", () => {
      const result = advanceSchema(schema, key("nested"))
      expect(result._kind).toBe("product")
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
      expect(result._kind).toBe("product")
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
      expect(result._kind).toBe("scalar")
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
  // Annotated — doc (unwraps to product)
  // -------------------------------------------------------------------------

  describe("annotated: doc", () => {
    const schema = Schema.doc({
      title: Schema.string(),
      count: Schema.number(),
    })

    it("unwraps doc annotation and returns field schema", () => {
      const result = advanceSchema(schema, key("title"))
      expect(result._kind).toBe("scalar")
      expect((result as any).scalarKind).toBe("string")
    })

    it("unwraps doc annotation for all fields", () => {
      const result = advanceSchema(schema, key("count"))
      expect(result._kind).toBe("scalar")
      expect((result as any).scalarKind).toBe("number")
    })
  })

  // -------------------------------------------------------------------------
  // Annotated — movable (unwraps to sequence)
  // -------------------------------------------------------------------------

  describe("annotated: movable", () => {
    const schema = LoroSchema.movableList(
      Schema.struct({ name: Schema.string() }),
    )

    it("unwraps movable annotation and returns item schema", () => {
      const result = advanceSchema(schema, index(0))
      expect(result._kind).toBe("product")
      expect(Object.keys((result as any).fields)).toContain("name")
    })
  })

  // -------------------------------------------------------------------------
  // Annotated — text/counter (leaf, no inner schema)
  // -------------------------------------------------------------------------

  describe("annotated: leaf", () => {
    it("throws when advancing into text annotation (no inner schema)", () => {
      const schema = LoroSchema.text()
      expect(() => advanceSchema(schema, key("anything"))).toThrow(
        "leaf annotation",
      )
    })

    it("throws when advancing into counter annotation (no inner schema)", () => {
      const schema = LoroSchema.counter()
      expect(() => advanceSchema(schema, index(0))).toThrow("leaf annotation")
    })
  })

  // -------------------------------------------------------------------------
  // Annotated — tree (unwraps to inner)
  // -------------------------------------------------------------------------

  describe("annotated: tree", () => {
    const schema = Schema.annotated(
      "tree",
      Schema.struct({ label: Schema.string() }),
    )

    it("unwraps tree annotation and returns field schema", () => {
      const result = advanceSchema(schema, key("label"))
      expect(result._kind).toBe("scalar")
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
      const schema = Schema.nullable(Schema.string())
      expect(() => advanceSchema(schema, key("x"))).toThrow(
        "cannot advance through a sum",
      )
    })
  })

  // -------------------------------------------------------------------------
  // Multi-step descent (product → sequence → product)
  // -------------------------------------------------------------------------

  describe("multi-step descent", () => {
    const schema = Schema.doc({
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
      expect(step1._kind).toBe("sequence")

      const step2 = advanceSchema(step1, index(0)) // → product (item)
      expect(step2._kind).toBe("product")

      const step3 = advanceSchema(step2, key("name")) // → scalar
      expect(step3._kind).toBe("scalar")
      expect((step3 as any).scalarKind).toBe("string")
    })

    it("product → sequence → product → sequence → scalar", () => {
      const step1 = advanceSchema(schema, key("items"))
      const step2 = advanceSchema(step1, index(0))
      const step3 = advanceSchema(step2, key("tags"))
      expect(step3._kind).toBe("sequence")

      const step4 = advanceSchema(step3, index(0))
      expect(step4._kind).toBe("scalar")
      expect((step4 as any).scalarKind).toBe("string")
    })

    it("product → product → scalar", () => {
      const step1 = advanceSchema(schema, key("settings"))
      expect(step1._kind).toBe("product")

      const step2 = advanceSchema(step1, key("darkMode"))
      expect(step2._kind).toBe("scalar")
      expect((step2 as any).scalarKind).toBe("boolean")
    })
  })

  // -------------------------------------------------------------------------
  // Result that is a sum (returned as-is, not advanced through)
  // -------------------------------------------------------------------------

  describe("result is a sum", () => {
    const schema = Schema.struct({
      bio: Schema.nullable(Schema.string()),
    })

    it("product field returning a sum returns the sum node", () => {
      const result = advanceSchema(schema, key("bio"))
      expect(result._kind).toBe("sum")
    })
  })

  // -------------------------------------------------------------------------
  // LoroSchema doc with Loro annotations
  // -------------------------------------------------------------------------

  describe("LoroSchema doc", () => {
    const schema = LoroSchema.doc({
      title: LoroSchema.text(),
      count: LoroSchema.counter(),
      tasks: LoroSchema.movableList(
        Schema.struct({
          name: Schema.string(),
          done: Schema.boolean(),
        }),
      ),
    })

    it("returns text annotation for text field", () => {
      const result = advanceSchema(schema, key("title"))
      expect(result._kind).toBe("annotated")
      expect((result as any).tag).toBe("text")
    })

    it("returns counter annotation for counter field", () => {
      const result = advanceSchema(schema, key("count"))
      expect(result._kind).toBe("annotated")
      expect((result as any).tag).toBe("counter")
    })

    it("returns movable annotation for movableList field", () => {
      const result = advanceSchema(schema, key("tasks"))
      expect(result._kind).toBe("annotated")
      expect((result as any).tag).toBe("movable")
    })

    it("can descend through movableList into item struct", () => {
      const step1 = advanceSchema(schema, key("tasks")) // → annotated("movable", sequence)
      const step2 = advanceSchema(step1, index(0)) // → product (struct)
      expect(step2._kind).toBe("product")
      expect(Object.keys((step2 as any).fields)).toContain("name")
    })
  })
})

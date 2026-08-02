// step-schema — one segment of schema descent.
//
// `stepSchema` is the primitive every traversal in the package rests on:
// `walkPath` drives it, and `foldPath`, `pathSchema`, `findOpaqueBoundary` and
// the `ephemeral` substrate's schema lookup are all projections of `walkPath`. It
// is total — it never throws — and reports one of three outcomes:
//
//   descend   an ordinary child; keep walking
//   boundary  the child is stored as ONE opaque plain value, so the schema has
//             nothing further to offer and the rest of the path resolves
//             against the value instead
//   mismatch  the path does not fit the schema, with a ready-to-use reason
//
// Assertions here read the returned tag rather than catching a thrown message.
// That is deliberate: the tag is data, and it separates `descend` from
// `boundary` — a distinction any throw-or-return API has to flatten into a
// single "it worked", because both cases hand back a schema.
//
// The boundary rule is covered at the traversal level too, in fold-path.test.ts
// — including the subtler question of *when* a fold stops. What is pinned here
// is the primitive underneath it, which matters because a second consumer of
// the same predicate is arriving outside `walkPath`.
//
// `stepSchema` is package-internal by design (see its own doc comment, and
// TECHNICAL.md §"Why one traversal, not many"), so this imports it directly
// from `../schema.js` rather than through the public entry point.

import { describe, expect, it } from "vitest"
import {
  KIND,
  type RawSegment,
  rawEntry,
  rawField,
  rawIndex,
  Schema,
} from "../index.js"
import { type Schema as SchemaNode, stepSchema } from "../schema.js"

const field = (k: string): RawSegment => rawField(k)
const entry = (k: string): RawSegment => rawEntry(k)
const index = (i: number): RawSegment => rawIndex(i)

/**
 * Take one step that is expected to succeed, and hand back the child schema.
 *
 * The expected kind is stated at every call site rather than defaulted
 * silently, because `descend` versus `boundary` is the distinction this suite
 * exists to pin.
 */
function stepTo(
  schema: SchemaNode,
  segment: RawSegment,
  kind: "descend" | "boundary" = "descend",
): SchemaNode {
  const step = stepSchema(schema, segment)
  expect(step).toMatchObject({ kind })
  return (step as { schema: SchemaNode }).schema
}

/** Take one step that is expected to fail, and hand back the reason. */
function stepFails(schema: SchemaNode, segment: RawSegment): string {
  const step = stepSchema(schema, segment)
  expect(step.kind).toBe("mismatch")
  return (step as { reason: string }).reason
}

describe("stepSchema", () => {
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

    it("field segment returns the field schema", () => {
      const result = stepTo(schema, field("title"))
      expect(result[KIND]).toBe("scalar")
      expect((result as any).scalarKind).toBe("string")
    })

    it("field segment returns a nested product schema", () => {
      const result = stepTo(schema, field("nested"))
      expect(result[KIND]).toBe("product")
      expect(Object.keys((result as any).fields)).toEqual(["flag"])
    })

    it("mismatches on unknown field", () => {
      expect(stepFails(schema, field("missing"))).toContain(
        'product has no field "missing"',
      )
    })

    it("mismatches on index segment", () => {
      expect(stepFails(schema, index(0))).toContain(
        "product expects a field segment",
      )
    })

    it("mismatches on entry segment", () => {
      expect(stepFails(schema, entry("title"))).toContain(
        "product expects a field segment",
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
      const result = stepTo(schema, index(0))
      expect(result[KIND]).toBe("product")
      expect(Object.keys((result as any).fields)).toContain("name")
    })

    it("any index returns the same item schema", () => {
      expect(stepTo(schema, index(0))).toBe(stepTo(schema, index(99)))
    })

    it("mismatches on field segment", () => {
      expect(stepFails(schema, field("foo"))).toContain(
        "sequence expects an index segment",
      )
    })
  })

  // -------------------------------------------------------------------------
  // Map
  // -------------------------------------------------------------------------

  describe("map", () => {
    const schema = Schema.record(Schema.number())

    it("entry segment returns the item schema", () => {
      const result = stepTo(schema, entry("anything"))
      expect(result[KIND]).toBe("scalar")
      expect((result as any).scalarKind).toBe("number")
    })

    it("any entry returns the same item schema", () => {
      expect(stepTo(schema, entry("a"))).toBe(stepTo(schema, entry("z")))
    })

    it("mismatches on index segment", () => {
      expect(stepFails(schema, index(0))).toContain(
        "map expects an entry segment",
      )
    })

    it("mismatches on field segment", () => {
      expect(stepFails(schema, field("anything"))).toContain(
        "map expects an entry segment",
      )
    })
  })

  // -------------------------------------------------------------------------
  // Struct — product dispatch
  // -------------------------------------------------------------------------

  describe("struct", () => {
    const schema = Schema.struct({
      title: Schema.string(),
      count: Schema.number(),
    })

    it("returns field schema for a field segment", () => {
      const result = stepTo(schema, field("title"))
      expect(result[KIND]).toBe("scalar")
      expect((result as any).scalarKind).toBe("string")
    })

    it("returns field schema for all fields", () => {
      const result = stepTo(schema, field("count"))
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
      const result = stepTo(schema, index(0))
      expect(result[KIND]).toBe("product")
      expect(Object.keys((result as any).fields)).toContain("name")
    })

    it("mismatches on field segment", () => {
      expect(stepFails(schema, field("name"))).toContain(
        "movable sequence expects an index segment",
      )
    })
  })

  // -------------------------------------------------------------------------
  // Leaf types — nothing inside to descend into
  // -------------------------------------------------------------------------

  describe("leaf types", () => {
    it("mismatches when stepping into text", () => {
      expect(stepFails(Schema.text(), field("anything"))).toContain(
        "cannot advance into text",
      )
    })

    it("mismatches when stepping into counter", () => {
      expect(stepFails(Schema.counter(), index(0))).toContain(
        "cannot advance into counter",
      )
    })

    it("mismatches when stepping into richtext", () => {
      const schema = Schema.richText({ bold: { expand: "after" } } as any)
      expect(stepFails(schema, field("anything"))).toContain(
        "cannot advance into richtext",
      )
    })

    it("mismatches when stepping into a scalar", () => {
      expect(stepFails(Schema.string(), field("x"))).toContain(
        "cannot advance into a scalar",
      )
    })
  })

  // -------------------------------------------------------------------------
  // Tree — entry segments (node ids) advance into the per-node data schema
  // -------------------------------------------------------------------------

  describe("tree", () => {
    const schema = Schema.tree(Schema.struct({ label: Schema.string() }))

    it("entry segment (node id) returns the item schema", () => {
      const result = stepTo(schema, entry("node-1"))
      expect(result[KIND]).toBe("product")
      expect(Object.keys((result as any).fields)).toContain("label")
    })

    it("mismatches on field segment", () => {
      expect(stepFails(schema, field("label"))).toContain(
        "tree expects an entry segment",
      )
    })

    it("mismatches on index segment", () => {
      expect(stepFails(schema, index(0))).toContain(
        "tree expects an entry segment",
      )
    })
  })

  // -------------------------------------------------------------------------
  // Set — entry segments, like map
  // -------------------------------------------------------------------------

  describe("set", () => {
    const schema = Schema.set(Schema.string())

    it("entry segment returns the item schema", () => {
      expect(stepTo(schema, entry("v"))[KIND]).toBe("scalar")
    })

    it("mismatches on index segment", () => {
      expect(stepFails(schema, index(0))).toContain(
        "set expects an entry segment",
      )
    })
  })

  // -------------------------------------------------------------------------
  // Opaque boundaries
  // -------------------------------------------------------------------------
  //
  // Two schema shapes are stored as one plain value rather than as nested CRDT
  // containers: a `sum` (which is what `.nullable()` expands to) and a
  // `.json()` node. Stepping to one of those yields `boundary`, telling the
  // traversal that the remaining segments resolve against the value.
  //
  // The rule to keep straight is that **boundary-ness attaches to the child,
  // not to the parent**. Landing ON a sum is a boundary; stepping THROUGH one
  // is a mismatch, because a sum resolves by inspecting a value rather than by
  // reading the next path segment. And a `.json()` node's own fields are
  // ordinary children, so descending *within* one is an ordinary `descend`.
  //
  // Getting the two directions backwards is the mistake three separate
  // hand-rolled walkers made before the traversal was consolidated — see
  // TECHNICAL.md §"Why one traversal, not many".

  describe("opaque boundaries", () => {
    it("stepping TO a sum is a boundary, and hands back the sum itself", () => {
      const schema = Schema.struct({ bio: Schema.string().nullable() })
      const result = stepTo(schema, field("bio"), "boundary")
      expect(result[KIND]).toBe("sum")
    })

    it("stepping TO a .json() struct is a boundary", () => {
      const schema = Schema.struct({
        blob: Schema.struct.json({ a: Schema.string() }),
      })
      // The kind is still "product" — a json node is an ordinary product
      // carrying a marker. The boundary-ness comes from the marker.
      expect(stepTo(schema, field("blob"), "boundary")[KIND]).toBe("product")
    })

    it("stepping TO a .json() collection is a boundary", () => {
      const schema = Schema.struct({
        blob: Schema.list.json(Schema.string()),
      })
      expect(stepTo(schema, field("blob"), "boundary")[KIND]).toBe("sequence")
    })

    it("stepping WITHIN a .json() subtree is an ordinary descend", () => {
      // The substrate stores the whole subtree as one value, but that is a fact
      // about the parent. Its fields are ordinary children, and a walk that has
      // already decided to look inside gets no further boundary signal.
      const schema = Schema.struct.json({ inner: Schema.string() })
      expect(stepTo(schema, field("inner"))[KIND]).toBe("scalar")
    })

    it("stepping THROUGH a sum is a mismatch", () => {
      const schema = Schema.string().nullable()
      expect(stepFails(schema, field("x"))).toContain(
        "cannot advance through a sum",
      )
    })
  })

  // -------------------------------------------------------------------------
  // Multi-step descent
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
      const step1 = stepTo(schema, field("items"))
      expect(step1[KIND]).toBe("sequence")

      const step2 = stepTo(step1, index(0))
      expect(step2[KIND]).toBe("product")

      const step3 = stepTo(step2, field("name"))
      expect(step3[KIND]).toBe("scalar")
      expect((step3 as any).scalarKind).toBe("string")
    })

    it("product → sequence → product → sequence → scalar", () => {
      const step2 = stepTo(stepTo(schema, field("items")), index(0))
      const step3 = stepTo(step2, field("tags"))
      expect(step3[KIND]).toBe("sequence")

      const step4 = stepTo(step3, index(0))
      expect(step4[KIND]).toBe("scalar")
      expect((step4 as any).scalarKind).toBe("string")
    })

    it("product → product → scalar", () => {
      const step1 = stepTo(schema, field("settings"))
      expect(step1[KIND]).toBe("product")

      const step2 = stepTo(step1, field("darkMode"))
      expect(step2[KIND]).toBe("scalar")
      expect((step2 as any).scalarKind).toBe("boolean")
    })
  })

  // -------------------------------------------------------------------------
  // First-class CRDT types as product fields
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

    it("returns text schema for a text field", () => {
      expect(stepTo(schema, field("title"))[KIND]).toBe("text")
    })

    it("returns counter schema for a counter field", () => {
      expect(stepTo(schema, field("count"))[KIND]).toBe("counter")
    })

    it("returns movable schema for a movableList field", () => {
      expect(stepTo(schema, field("tasks"))[KIND]).toBe("movable")
    })

    it("descends through movableList into the item struct", () => {
      const step2 = stepTo(stepTo(schema, field("tasks")), index(0))
      expect(step2[KIND]).toBe("product")
      expect(Object.keys((step2 as any).fields)).toContain("name")
    })
  })
})

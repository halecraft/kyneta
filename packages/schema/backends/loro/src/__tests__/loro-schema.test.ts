import type { ExtractCaps, ProductSchema, SchemaNode, SequenceSchema } from "@kyneta/schema"
import { Schema } from "@kyneta/schema"
import { describe, expect, expectTypeOf, it } from "vitest"
import { LoroSchema } from "../loro-schema.js"

// ===========================================================================
// LoroSchema.plain.* constructors enforce PlainSchema constraint
// ===========================================================================

describe("type-level: LoroSchema.plain.* constructors enforce PlainSchema constraint", () => {
  it("plain.struct accepts plain scalars", () => {
    const s = LoroSchema.plain.struct({
      name: LoroSchema.plain.string(),
      count: LoroSchema.plain.number(),
      active: LoroSchema.plain.boolean(),
    })
    // Return type is ProductSchema (not PlainProductSchema) — works with Plain<S>
    expectTypeOf(s).toMatchTypeOf<ProductSchema>()
    expectTypeOf(s).toMatchTypeOf<SchemaNode>()
  })

  it("plain.struct accepts nested plain struct", () => {
    const inner = LoroSchema.plain.struct({ x: LoroSchema.plain.string() })
    const outer = LoroSchema.plain.struct({ nested: inner })
    expectTypeOf(outer).toMatchTypeOf<ProductSchema>()
  })

  it("plain.record accepts plain schema item", () => {
    const s = LoroSchema.plain.record(LoroSchema.plain.string())
    expectTypeOf(s).toMatchTypeOf<SchemaNode>()
  })

  it("plain.array accepts plain schema item", () => {
    const s = LoroSchema.plain.array(LoroSchema.plain.number())
    expectTypeOf(s).toMatchTypeOf<SequenceSchema>()
  })

  it("plain.union accepts plain variants", () => {
    const s = LoroSchema.plain.union(Schema.string(), Schema.number())
    expectTypeOf(s).toMatchTypeOf<SchemaNode>()
  })

  it("plain.discriminatedUnion accepts plain product variants", () => {
    const s = LoroSchema.plain.discriminatedUnion("type", [
      LoroSchema.plain.struct({
        type: LoroSchema.plain.string("a"),
        x: LoroSchema.plain.string(),
      }),
      LoroSchema.plain.struct({
        type: LoroSchema.plain.string("b"),
        y: LoroSchema.plain.number(),
      }),
    ])
    expectTypeOf(s).toMatchTypeOf<SchemaNode>()
  })

  // The following tests verify that first-class CRDT types are rejected.
  // They use @ts-expect-error to confirm compile-time rejection.

  it("plain.struct rejects TextSchema", () => {
    // @ts-expect-error — TextSchema does not extend PlainSchema
    LoroSchema.plain.struct({ title: LoroSchema.text() })
  })

  it("plain.struct rejects CounterSchema", () => {
    // @ts-expect-error — CounterSchema does not extend PlainSchema
    LoroSchema.plain.struct({ count: LoroSchema.counter() })
  })

  it("plain.record rejects TextSchema", () => {
    // @ts-expect-error — TextSchema does not extend PlainSchema
    LoroSchema.plain.record(LoroSchema.text())
  })

  it("plain.array rejects TextSchema", () => {
    // @ts-expect-error — TextSchema does not extend PlainSchema
    LoroSchema.plain.array(LoroSchema.text())
  })

  it("plain.struct rejects nested first-class type via sequence", () => {
    // @ts-expect-error — SequenceSchema<TextSchema> does not extend PlainSchema
    LoroSchema.plain.struct({ items: Schema.list(LoroSchema.text()) })
  })

  it("plain.nullable accepts plain schema", () => {
    const s = LoroSchema.plain.nullable(LoroSchema.plain.string())
    expectTypeOf(s).toMatchTypeOf<SchemaNode>()
  })

  it("plain.nullable rejects TextSchema", () => {
    // @ts-expect-error — TextSchema does not extend PlainSchema
    LoroSchema.plain.nullable(LoroSchema.text())
  })
})

// ===========================================================================
// LoroSchema.doc field constraints (LoroDocFieldSchema)
// ===========================================================================

describe("type-level: LoroSchema.doc accepts valid field schemas", () => {
  it("accepts LoroSchema.text()", () => {
    const s = LoroSchema.doc({ title: LoroSchema.text() })
    expectTypeOf(s).toMatchTypeOf<SchemaNode>()
  })

  it("accepts LoroSchema.counter()", () => {
    const s = LoroSchema.doc({ count: LoroSchema.counter() })
    expectTypeOf(s).toMatchTypeOf<SchemaNode>()
  })

  it("accepts LoroSchema.struct(...)", () => {
    const s = LoroSchema.doc({
      settings: LoroSchema.struct({ a: LoroSchema.plain.string() }),
    })
    expectTypeOf(s).toMatchTypeOf<SchemaNode>()
  })

  it("accepts LoroSchema.list(...)", () => {
    const s = LoroSchema.doc({
      items: LoroSchema.list(LoroSchema.plain.string()),
    })
    expectTypeOf(s).toMatchTypeOf<SchemaNode>()
  })

  it("accepts LoroSchema.record(...)", () => {
    const s = LoroSchema.doc({
      peers: LoroSchema.record(LoroSchema.plain.boolean()),
    })
    expectTypeOf(s).toMatchTypeOf<SchemaNode>()
  })

  it("accepts LoroSchema.plain.boolean() (goes to _props)", () => {
    const s = LoroSchema.doc({ darkMode: LoroSchema.plain.boolean() })
    expectTypeOf(s).toMatchTypeOf<SchemaNode>()
  })

  it("accepts LoroSchema.plain.string() (goes to _props)", () => {
    const s = LoroSchema.doc({ theme: LoroSchema.plain.string() })
    expectTypeOf(s).toMatchTypeOf<SchemaNode>()
  })

  it("accepts LoroSchema.plain.struct(...) (goes to _props)", () => {
    const s = LoroSchema.doc({
      config: LoroSchema.plain.struct({ x: LoroSchema.plain.number() }),
    })
    expectTypeOf(s).toMatchTypeOf<SchemaNode>()
  })
})

// ===========================================================================
// LoroSchema namespace — removed constructors
// ===========================================================================

describe("type-level: LoroSchema namespace excludes non-container constructors", () => {
  it("LoroSchema.boolean does not exist", () => {
    // @ts-expect-error — removed: use LoroSchema.plain.boolean()
    expect(LoroSchema.boolean).toBeUndefined()
  })

  it("LoroSchema.string does not exist", () => {
    // @ts-expect-error — removed: use LoroSchema.plain.string()
    expect(LoroSchema.string).toBeUndefined()
  })

  it("LoroSchema.number does not exist", () => {
    // @ts-expect-error — removed: use LoroSchema.plain.number()
    expect(LoroSchema.number).toBeUndefined()
  })

  it("LoroSchema.scalar does not exist", () => {
    // @ts-expect-error — removed: low-level grammar
    expect(LoroSchema.scalar).toBeUndefined()
  })

  it("LoroSchema.union does not exist", () => {
    // @ts-expect-error — removed: use LoroSchema.plain.union()
    expect(LoroSchema.union).toBeUndefined()
  })

  it("LoroSchema.nullable does not exist", () => {
    // @ts-expect-error — removed: use LoroSchema.plain.nullable()
    expect(LoroSchema.nullable).toBeUndefined()
  })

  it("LoroSchema.annotated does not exist", () => {
    // @ts-expect-error — removed: low-level grammar
    expect(LoroSchema.annotated).toBeUndefined()
  })
})

// ===========================================================================
// LoroSchema constructors propagate [CAPS] for bind-time constraint enforcement
// ===========================================================================

describe("type-level: LoroSchema constructors propagate capabilities", () => {
  it("LoroSchema.text() → ExtractCaps yields 'text'", () => {
    const s = LoroSchema.text()
    type Caps = ExtractCaps<typeof s>
    expectTypeOf<Caps>().toEqualTypeOf<"text">()
  })

  it("LoroSchema.counter() → ExtractCaps yields 'counter'", () => {
    const s = LoroSchema.counter()
    type Caps = ExtractCaps<typeof s>
    expectTypeOf<Caps>().toEqualTypeOf<"counter">()
  })

  it("LoroSchema.movableList(plain item) → ExtractCaps yields 'movable'", () => {
    const s = LoroSchema.movableList(LoroSchema.plain.string())
    type Caps = ExtractCaps<typeof s>
    expectTypeOf<Caps>().toEqualTypeOf<"movable">()
  })

  it("LoroSchema.tree(plain struct) → ExtractCaps yields 'tree' | 'json'", () => {
    const s = LoroSchema.tree(LoroSchema.plain.struct({ label: LoroSchema.plain.string() }))
    type Caps = ExtractCaps<typeof s>
    expectTypeOf<Caps>().toEqualTypeOf<"tree" | "json">()
  })

  it("LoroSchema.doc with mixed containers → ExtractCaps yields all caps", () => {
    const s = LoroSchema.doc({
      title: LoroSchema.text(),
      count: LoroSchema.counter(),
      items: LoroSchema.list(LoroSchema.plain.struct({ name: LoroSchema.plain.string() })),
    })
    type Caps = ExtractCaps<typeof s>
    expectTypeOf<Caps>().toEqualTypeOf<"text" | "counter" | "json">()
  })

  it("LoroSchema.movableList with plain inner → ExtractCaps propagates caps", () => {
    const s = LoroSchema.doc({
      items: LoroSchema.movableList(LoroSchema.plain.struct({
        label: LoroSchema.plain.string(),
      })),
      title: LoroSchema.text(),
    })
    type Caps = ExtractCaps<typeof s>
    expectTypeOf<Caps>().toEqualTypeOf<"movable" | "json" | "text">()
  })
})
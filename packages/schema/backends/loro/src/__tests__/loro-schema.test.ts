import type {
  AnnotatedSchema,
  ProductSchema,
  SchemaNode,
  SequenceSchema,
} from "@kyneta/schema"
import { Schema } from "@kyneta/schema"
import { describe, expectTypeOf, it } from "vitest"
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

  // The following tests verify that AnnotatedSchema is rejected.
  // They use @ts-expect-error to confirm compile-time rejection.

  it("plain.struct rejects AnnotatedSchema (text)", () => {
    // @ts-expect-error — AnnotatedSchema<"text"> does not extend PlainSchema
    LoroSchema.plain.struct({ title: LoroSchema.text() })
  })

  it("plain.struct rejects AnnotatedSchema (counter)", () => {
    // @ts-expect-error — AnnotatedSchema<"counter"> does not extend PlainSchema
    LoroSchema.plain.struct({ count: LoroSchema.counter() })
  })

  it("plain.record rejects AnnotatedSchema", () => {
    // @ts-expect-error — AnnotatedSchema does not extend PlainSchema
    LoroSchema.plain.record(LoroSchema.text())
  })

  it("plain.array rejects AnnotatedSchema", () => {
    // @ts-expect-error — AnnotatedSchema does not extend PlainSchema
    LoroSchema.plain.array(LoroSchema.text())
  })

  it("plain.struct rejects nested AnnotatedSchema via sequence", () => {
    // @ts-expect-error — SequenceSchema<AnnotatedSchema> does not extend PlainSchema
    LoroSchema.plain.struct({ items: Schema.list(LoroSchema.text()) })
  })
})

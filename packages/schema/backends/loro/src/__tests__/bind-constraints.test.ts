// bind-constraints — compile-time and runtime tests for loro.bind() caps enforcement.
//
// Verifies that `loro.bind()` rejects schemas containing capabilities
// that Loro doesn't support (set) at COMPILE TIME via the `RestrictCaps`
// / `AllowedCaps` mechanism, while accepting capabilities it does support
// (text, counter, movable, tree, json) and plain schemas.

import {
  type BoundSchema,
  type ExtractCaps,
  json,
  Schema,
} from "@kyneta/schema"
import { describe, expect, expectTypeOf, it } from "vitest"
import { loro } from "../bind-loro.js"

// ===========================================================================
// §1 — Compile-time acceptance: schemas that loro.bind() SHOULD accept
// ===========================================================================

describe("loro.bind() accepts Loro-compatible schemas", () => {
  it("plain schema (no caps)", () => {
    const schema = Schema.struct({
      name: Schema.string(),
      count: Schema.number(),
      active: Schema.boolean(),
    })
    const bound = loro.bind(schema)
    expect(bound).toBeDefined()
    expect(bound.schema).toBe(schema)
    expectTypeOf(bound).toMatchTypeOf<BoundSchema<typeof schema>>()
  })

  it("schema with text", () => {
    const schema = Schema.struct({
      title: Schema.text(),
    })
    const bound = loro.bind(schema)
    expect(bound).toBeDefined()
    expect(bound.schema).toBe(schema)
  })

  it("schema with counter", () => {
    const schema = Schema.struct({
      count: Schema.counter(),
    })
    const bound = loro.bind(schema)
    expect(bound).toBeDefined()
    expect(bound.schema).toBe(schema)
  })

  it("schema with movableList", () => {
    const schema = Schema.struct({
      items: Schema.movableList(Schema.string()),
    })
    const bound = loro.bind(schema)
    expect(bound).toBeDefined()
    expect(bound.schema).toBe(schema)
  })

  it("schema with tree", () => {
    const schema = Schema.struct({
      hierarchy: Schema.tree(Schema.struct({ label: Schema.string() })),
    })
    const bound = loro.bind(schema)
    expect(bound).toBeDefined()
    expect(bound.schema).toBe(schema)
  })

  it("schema with text + counter + plain scalars", () => {
    const schema = Schema.struct({
      title: Schema.text(),
      count: Schema.counter(),
      active: Schema.boolean(),
      tags: Schema.list(Schema.string()),
    })
    const bound = loro.bind(schema)
    expect(bound).toBeDefined()
  })

  it("deeply nested text is accepted", () => {
    const schema = Schema.struct({
      channels: Schema.list(
        Schema.struct({
          meta: Schema.record(
            Schema.struct({
              description: Schema.text(),
            }),
          ),
        }),
      ),
    })
    const bound = loro.bind(schema)
    expect(bound).toBeDefined()
  })

  it("json merge boundary is accepted", () => {
    const schema = Schema.struct({
      title: Schema.text(),
      metadata: Schema.struct.json({
        version: Schema.number(),
        tags: Schema.list(Schema.string()),
      }),
    })
    const bound = loro.bind(schema)
    expect(bound).toBeDefined()
  })

  it("preserves full schema type through bind()", () => {
    const schema = Schema.struct({
      title: Schema.text(),
      count: Schema.counter(),
      items: Schema.list(
        Schema.struct({ name: Schema.string(), done: Schema.boolean() }),
      ),
    })
    const bound = loro.bind(schema)
    expectTypeOf(bound.schema).toEqualTypeOf(schema)
  })
})

// ===========================================================================
// §2 — Compile-time rejection: schemas that loro.bind() SHOULD reject
// ===========================================================================

describe("loro.bind() rejects schemas with unsupported caps", () => {
  it("rejects set", () => {
    const schema = Schema.struct({
      tags: Schema.set(Schema.string()),
    })
    // @ts-expect-error — set is not in LoroCaps
    loro.bind(schema)
  })

  it("rejects deeply nested set", () => {
    const schema = Schema.struct({
      items: Schema.list(
        Schema.struct({
          meta: Schema.record(
            Schema.struct({ tags: Schema.set(Schema.string()) }),
          ),
        }),
      ),
    })
    // @ts-expect-error — set is deeply nested but still caught
    loro.bind(schema)
  })

  it("rejects mix of supported and unsupported (text + set)", () => {
    const schema = Schema.struct({
      title: Schema.text(),
      tags: Schema.set(Schema.string()),
    })
    // @ts-expect-error — set is not in LoroCaps
    loro.bind(schema)
  })
})

// ===========================================================================
// §3 — Cross-substrate: same schema, different bind targets
// ===========================================================================

describe("cross-substrate: universal schema vs substrate-specific schema", () => {
  const universalSchema = Schema.struct({
    title: Schema.text(),
    items: Schema.list(
      Schema.struct({
        name: Schema.string(),
        done: Schema.boolean(),
      }),
    ),
  })

  const loroSpecificSchema = Schema.struct({
    title: Schema.text(),
    count: Schema.counter(),
    tasks: Schema.movableList(Schema.struct({ name: Schema.string() })),
  })

  it("universal schema is Loro-compatible (ExtractCaps check)", () => {
    type Caps = ExtractCaps<typeof universalSchema>
    expectTypeOf<Caps>().toEqualTypeOf<"text">()
  })

  it("Loro-specific schema ExtractCaps check", () => {
    type Caps = ExtractCaps<typeof loroSpecificSchema>
    expectTypeOf<Caps>().toEqualTypeOf<"text" | "counter" | "movable">()
  })

  it("universal schema binds to loro", () => {
    const bound = loro.bind(universalSchema)
    expect(bound).toBeDefined()
    expect(bound.schema).toBe(universalSchema)
  })

  it("Loro-specific schema binds to loro", () => {
    const bound = loro.bind(loroSpecificSchema)
    expect(bound).toBeDefined()
    expect(bound.schema).toBe(loroSpecificSchema)
  })

  it("json.bind() accepts schemas with all caps (AllowedCaps = string)", () => {
    const schema = Schema.struct({
      title: Schema.text(),
      count: Schema.counter(),
      tasks: Schema.movableList(Schema.string()),
    })
    const bound = json.bind(schema)
    expect(bound).toBeDefined()
    expect(bound.schema).toBe(schema)
  })
})

// ===========================================================================
// §4 — Edge cases
// ===========================================================================

describe("bind constraint edge cases", () => {
  it("discriminated union with all-plain variants is accepted", () => {
    const schema = Schema.struct({
      content: Schema.discriminatedUnion("type", [
        Schema.struct({
          type: Schema.string("text"),
          body: Schema.string(),
        }),
        Schema.struct({
          type: Schema.string("image"),
          url: Schema.string(),
        }),
      ]),
    })
    const bound = loro.bind(schema)
    expect(bound).toBeDefined()
  })

  it("struct with set alongside plain variants is rejected", () => {
    const schema = Schema.struct({
      content: Schema.discriminatedUnion("type", [
        Schema.struct({
          type: Schema.string("text"),
          body: Schema.string(),
        }),
        Schema.struct({
          type: Schema.string("image"),
          url: Schema.string(),
        }),
      ]),
      tags: Schema.set(Schema.string()),
    })
    // @ts-expect-error — set taints the whole schema
    loro.bind(schema)
  })

  it("multiple text fields are all accepted", () => {
    const schema = Schema.struct({
      title: Schema.text(),
      body: Schema.text(),
      summary: Schema.text(),
    })
    const bound = loro.bind(schema)
    expect(bound).toBeDefined()
  })

  it("plain-only schema (no caps at all) is accepted", () => {
    const schema = Schema.struct({
      name: Schema.string(),
      age: Schema.number(),
      active: Schema.boolean(),
      tags: Schema.list(Schema.string()),
      address: Schema.struct({
        street: Schema.string(),
        city: Schema.string(),
      }),
      metadata: Schema.record(Schema.any()),
    })
    const bound = loro.bind(schema)
    expect(bound).toBeDefined()
  })
})

// ===========================================================================
// §5 — Root kind rejection: bind() requires a product (struct) root
// ===========================================================================

describe("loro.bind() rejects non-product root schemas", () => {
  it("rejects bare list at root", () => {
    // @ts-expect-error — SequenceSchema is not ProductSchema
    loro.bind(Schema.list(Schema.string()))
  })

  it("rejects bare record at root", () => {
    // @ts-expect-error — MapSchema is not ProductSchema
    loro.bind(Schema.record(Schema.string()))
  })

  it("rejects bare text at root", () => {
    // @ts-expect-error — TextSchema is not ProductSchema
    loro.bind(Schema.text())
  })

  it("rejects bare counter at root", () => {
    // @ts-expect-error — CounterSchema is not ProductSchema
    loro.bind(Schema.counter())
  })

  it("rejects bare scalar at root", () => {
    // @ts-expect-error — ScalarSchema is not ProductSchema
    loro.bind(Schema.string())
  })

  it("rejects list of structs at root", () => {
    // @ts-expect-error — SequenceSchema<ProductSchema> is still not ProductSchema
    loro.bind(Schema.list(Schema.struct({ name: Schema.string() })))
  })
})

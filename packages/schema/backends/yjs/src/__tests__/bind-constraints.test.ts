// bind-constraints — compile-time and runtime tests for yjs.bind() caps enforcement.
//
// Verifies that `yjs.bind()` rejects schemas containing capabilities
// that Yjs doesn't support (counter, movable, tree, set) at COMPILE TIME
// via the `RestrictCaps` / `AllowedCaps` mechanism, while accepting
// capabilities it does support (text) and plain schemas.

import {
  type BoundSchema,
  type ExtractCaps,
  json,
  Schema,
} from "@kyneta/schema"
import { describe, expect, expectTypeOf, it } from "vitest"
import { yjs } from "../bind-yjs.js"

// ===========================================================================
// §1 — Compile-time acceptance: schemas that yjs.bind() SHOULD accept
// ===========================================================================

describe("yjs.bind() accepts Yjs-compatible schemas", () => {
  it("plain schema (no caps)", () => {
    const schema = Schema.struct({
      name: Schema.string(),
      count: Schema.number(),
      active: Schema.boolean(),
    })
    const bound = yjs.bind(schema)
    expect(bound).toBeDefined()
    expect(bound.schema).toBe(schema)
    expectTypeOf(bound).toMatchTypeOf<BoundSchema<typeof schema>>()
  })

  it("schema with text", () => {
    const schema = Schema.struct({
      title: Schema.text(),
    })
    const bound = yjs.bind(schema)
    expect(bound).toBeDefined()
    expect(bound.schema).toBe(schema)
  })

  it("schema with text + plain scalars", () => {
    const schema = Schema.struct({
      title: Schema.text(),
      count: Schema.number(),
      active: Schema.boolean(),
      tags: Schema.list(Schema.string()),
    })
    const bound = yjs.bind(schema)
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
    const bound = yjs.bind(schema)
    expect(bound).toBeDefined()
  })

  it("optional text field alongside plain scalars is accepted", () => {
    const schema = Schema.struct({
      title: Schema.text(),
      draft: Schema.text(),
      count: Schema.number(),
    })
    const bound = yjs.bind(schema)
    expect(bound).toBeDefined()
  })

  it("preserves full schema type through bind()", () => {
    const schema = Schema.struct({
      title: Schema.text(),
      items: Schema.list(
        Schema.struct({ name: Schema.string(), done: Schema.boolean() }),
      ),
    })
    const bound = yjs.bind(schema)
    expectTypeOf(bound.schema).toEqualTypeOf(schema)
  })

  it("json merge boundary is accepted", () => {
    const schema = Schema.struct({
      title: Schema.text(),
      metadata: Schema.struct.json({
        version: Schema.number(),
        tags: Schema.list(Schema.string()),
      }),
    })
    const bound = yjs.bind(schema)
    expect(bound).toBeDefined()
  })
})

// ===========================================================================
// §2 — Compile-time rejection: schemas that yjs.bind() SHOULD reject
// ===========================================================================

describe("yjs.bind() rejects schemas with unsupported caps", () => {
  it("rejects counter", () => {
    const schema = Schema.struct({
      count: Schema.counter(),
    })
    // @ts-expect-error — counter is not in YjsCaps
    yjs.bind(schema)
  })

  it("rejects movableList", () => {
    const schema = Schema.struct({
      items: Schema.movableList(Schema.string()),
    })
    // @ts-expect-error — movable is not in YjsCaps
    yjs.bind(schema)
  })

  it("rejects tree", () => {
    const schema = Schema.struct({
      hierarchy: Schema.tree(
        Schema.struct({ label: Schema.string() }),
      ),
    })
    // @ts-expect-error — tree is not in YjsCaps
    yjs.bind(schema)
  })

  it("rejects set", () => {
    const schema = Schema.struct({
      tags: Schema.set(Schema.string()),
    })
    // @ts-expect-error — set is not in YjsCaps
    yjs.bind(schema)
  })

  it("rejects deeply nested counter", () => {
    const schema = Schema.struct({
      items: Schema.list(
        Schema.struct({
          meta: Schema.record(
            Schema.struct({ hits: Schema.counter() }),
          ),
        }),
      ),
    })
    // @ts-expect-error — counter is deeply nested but still caught
    yjs.bind(schema)
  })

  it("rejects mix of supported and unsupported (text + counter)", () => {
    const schema = Schema.struct({
      title: Schema.text(),
      views: Schema.counter(),
    })
    // @ts-expect-error — counter is not in YjsCaps
    yjs.bind(schema)
  })

  it("rejects counter inside list", () => {
    const schema = Schema.struct({
      scores: Schema.list(
        Schema.struct({ value: Schema.counter() }),
      ),
    })
    // @ts-expect-error — counter nested inside list struct
    yjs.bind(schema)
  })
})

// ===========================================================================
// §3 — Cross-substrate: same schema, different bind targets
// ===========================================================================

describe("cross-substrate: universal schema vs substrate-specific schema", () => {
  // A schema using only universally-supported features
  const universalSchema = Schema.struct({
    title: Schema.text(),
    items: Schema.list(
      Schema.struct({
        name: Schema.string(),
        done: Schema.boolean(),
      }),
    ),
  })

  // A schema using Loro-specific features (counter, movable)
  const loroSpecificSchema = Schema.struct({
    title: Schema.text(),
    count: Schema.counter(),
    tasks: Schema.movableList(
      Schema.struct({ name: Schema.string() }),
    ),
  })

  it("universal schema is Yjs-compatible (ExtractCaps check)", () => {
    type Caps = ExtractCaps<typeof universalSchema>
    // Only "text" — in YjsCaps
    expectTypeOf<Caps>().toEqualTypeOf<"text">()
  })

  it("Loro-specific schema is NOT Yjs-compatible (ExtractCaps check)", () => {
    type Caps = ExtractCaps<typeof loroSpecificSchema>
    // Includes "counter" and "movable" which are NOT in YjsCaps
    expectTypeOf<Caps>().toEqualTypeOf<"text" | "counter" | "movable">()
  })

  it("universal schema binds to yjs", () => {
    const bound = yjs.bind(universalSchema)
    expect(bound).toBeDefined()
    expect(bound.schema).toBe(universalSchema)
  })

  it("Loro-specific schema is rejected by yjs.bind()", () => {
    // @ts-expect-error — counter and movable not in YjsCaps
    yjs.bind(loroSpecificSchema)
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
// §4 — Edge cases: discriminated unions, multiple text fields
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
    const bound = yjs.bind(schema)
    expect(bound).toBeDefined()
  })

  it("struct with counter alongside plain variants is rejected", () => {
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
      hits: Schema.counter(),
    })
    // @ts-expect-error — counter taints the whole schema
    yjs.bind(schema)
  })

  it("multiple text fields are all accepted", () => {
    const schema = Schema.struct({
      title: Schema.text(),
      body: Schema.text(),
      summary: Schema.text(),
    })
    const bound = yjs.bind(schema)
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
    const bound = yjs.bind(schema)
    expect(bound).toBeDefined()
  })
})
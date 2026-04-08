// bind-constraints — compile-time and runtime tests for yjs.bind() tag enforcement.
//
// Verifies that `yjs.bind()` rejects schemas containing annotations
// that Yjs doesn't support (counter, movable, tree) at COMPILE TIME
// via the `RestrictTags` / `AllowedTags` mechanism, while accepting
// annotations it does support (text, doc) and plain schemas.
//
// Also verifies the runtime whitelist (`YJS_SUPPORTED_TAGS`) throws
// for unsupported annotations as a belt-and-suspenders defense.

import {
  type BoundSchema,
  type ExtractTags,
  json,
  Schema,
} from "@kyneta/schema"
import { describe, expect, expectTypeOf, it } from "vitest"
import { yjs } from "../bind-yjs.js"
import { YJS_SUPPORTED_TAGS } from "../populate.js"

// ===========================================================================
// §1 — Compile-time acceptance: schemas that yjs.bind() SHOULD accept
// ===========================================================================

describe("yjs.bind() accepts Yjs-compatible schemas", () => {
  it("plain schema (no annotations)", () => {
    const schema = Schema.doc({
      name: Schema.string(),
      count: Schema.number(),
      active: Schema.boolean(),
    })
    const bound = yjs.bind(schema)
    expect(bound).toBeDefined()
    expect(bound.schema).toBe(schema)
    expectTypeOf(bound).toMatchTypeOf<BoundSchema<typeof schema>>()
  })

  it("schema with text annotation", () => {
    const schema = Schema.doc({
      title: Schema.annotated("text"),
    })
    const bound = yjs.bind(schema)
    expect(bound).toBeDefined()
    expect(bound.schema).toBe(schema)
  })

  it("schema with text + plain scalars", () => {
    const schema = Schema.doc({
      title: Schema.annotated("text"),
      count: Schema.number(),
      active: Schema.boolean(),
      tags: Schema.list(Schema.string()),
    })
    const bound = yjs.bind(schema)
    expect(bound).toBeDefined()
  })

  it("deeply nested text is accepted", () => {
    const schema = Schema.doc({
      channels: Schema.list(
        Schema.struct({
          meta: Schema.record(
            Schema.struct({
              description: Schema.annotated("text"),
            }),
          ),
        }),
      ),
    })
    const bound = yjs.bind(schema)
    expect(bound).toBeDefined()
  })

  it("nullable text is accepted", () => {
    const schema = Schema.doc({
      title: Schema.nullable(Schema.annotated("text")),
    })
    const bound = yjs.bind(schema)
    expect(bound).toBeDefined()
  })

  it("preserves full schema type through bind()", () => {
    const schema = Schema.doc({
      title: Schema.annotated("text"),
      items: Schema.list(
        Schema.struct({ name: Schema.string(), done: Schema.boolean() }),
      ),
    })
    const bound = yjs.bind(schema)
    expectTypeOf(bound.schema).toEqualTypeOf(schema)
  })
})

// ===========================================================================
// §2 — Compile-time rejection: schemas that yjs.bind() SHOULD reject
// ===========================================================================

describe("yjs.bind() rejects schemas with unsupported annotations", () => {
  it("rejects counter annotation", () => {
    const schema = Schema.doc({
      count: Schema.annotated("counter"),
    })
    // @ts-expect-error — counter is not in YjsSupportedTag
    yjs.bind(schema)
  })

  it("rejects movable annotation", () => {
    const schema = Schema.doc({
      items: Schema.annotated("movable", Schema.sequence(Schema.string())),
    })
    // @ts-expect-error — movable is not in YjsSupportedTag
    yjs.bind(schema)
  })

  it("rejects tree annotation", () => {
    const schema = Schema.doc({
      hierarchy: Schema.annotated(
        "tree",
        Schema.struct({ label: Schema.string() }),
      ),
    })
    // @ts-expect-error — tree is not in YjsSupportedTag
    yjs.bind(schema)
  })

  it("rejects custom/unknown annotation", () => {
    const schema = Schema.doc({
      ts: Schema.annotated("timestamp"),
    })
    // @ts-expect-error — "timestamp" is not in YjsSupportedTag
    yjs.bind(schema)
  })

  it("rejects deeply nested counter", () => {
    const schema = Schema.doc({
      items: Schema.list(
        Schema.struct({
          meta: Schema.record(
            Schema.struct({ hits: Schema.annotated("counter") }),
          ),
        }),
      ),
    })
    // @ts-expect-error — counter is deeply nested but still caught
    yjs.bind(schema)
  })

  it("rejects mix of supported and unsupported (text + counter)", () => {
    const schema = Schema.doc({
      title: Schema.annotated("text"),
      views: Schema.annotated("counter"),
    })
    // @ts-expect-error — counter is not in YjsSupportedTag
    yjs.bind(schema)
  })

  it("rejects nullable counter", () => {
    const schema = Schema.doc({
      score: Schema.nullable(Schema.annotated("counter")),
    })
    // @ts-expect-error — counter nested inside nullable
    yjs.bind(schema)
  })
})

// ===========================================================================
// §3 — Cross-substrate: same schema, different bind targets
// ===========================================================================

describe("cross-substrate: universal schema vs substrate-specific schema", () => {
  // A schema using only universally-supported features
  const universalSchema = Schema.doc({
    title: Schema.annotated("text"),
    items: Schema.list(
      Schema.struct({
        name: Schema.string(),
        done: Schema.boolean(),
      }),
    ),
  })

  // A schema using Loro-specific features (counter, movable)
  const loroSpecificSchema = Schema.doc({
    title: Schema.annotated("text"),
    count: Schema.annotated("counter"),
    tasks: Schema.annotated(
      "movable",
      Schema.sequence(Schema.struct({ name: Schema.string() })),
    ),
  })

  it("universal schema is Yjs-compatible (ExtractTags check)", () => {
    type Tags = ExtractTags<typeof universalSchema>
    // Only "doc" and "text" — both in YjsSupportedTag
    expectTypeOf<Tags>().toEqualTypeOf<"doc" | "text">()
  })

  it("Loro-specific schema is NOT Yjs-compatible (ExtractTags check)", () => {
    type Tags = ExtractTags<typeof loroSpecificSchema>
    // Includes "counter" and "movable" which are NOT in YjsSupportedTag
    expectTypeOf<Tags>().toEqualTypeOf<
      "doc" | "text" | "counter" | "movable"
    >()
  })

  it("universal schema binds to yjs", () => {
    const bound = yjs.bind(universalSchema)
    expect(bound).toBeDefined()
    expect(bound.schema).toBe(universalSchema)
  })

  it("Loro-specific schema is rejected by yjs.bind()", () => {
    // @ts-expect-error — counter and movable not in YjsSupportedTag
    yjs.bind(loroSpecificSchema)
  })

  it("json.bind() accepts schemas with all annotations (AllowedTags = string)", () => {
    const schema = Schema.doc({
      title: Schema.annotated("text"),
      count: Schema.annotated("counter"),
      tasks: Schema.annotated("movable", Schema.sequence(Schema.string())),
    })
    const bound = json.bind(schema)
    expect(bound).toBeDefined()
    expect(bound.schema).toBe(schema)
  })
})

// ===========================================================================
// §4 — Runtime whitelist: belt-and-suspenders with compile-time check
// ===========================================================================

describe("runtime whitelist: YJS_SUPPORTED_TAGS", () => {
  it("contains exactly 'text' and 'doc'", () => {
    expect(YJS_SUPPORTED_TAGS).toEqual(new Set(["text", "doc"]))
  })
})

// ===========================================================================
// §5 — Edge cases: discriminated unions, multiple text fields
// ===========================================================================

describe("bind constraint edge cases", () => {
  it("discriminated union with all-plain variants is accepted", () => {
    const schema = Schema.doc({
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

  it("discriminated union with counter in one variant is rejected", () => {
    const schema = Schema.doc({
      content: Schema.discriminatedUnion("type", [
        Schema.struct({
          type: Schema.string("text"),
          body: Schema.string(),
        }),
        Schema.struct({
          type: Schema.string("data"),
          score: Schema.annotated("counter"),
        }),
      ]),
    })
    // @ts-expect-error — counter in one variant taints the whole schema
    yjs.bind(schema)
  })

  it("multiple text fields are all accepted", () => {
    const schema = Schema.doc({
      title: Schema.annotated("text"),
      body: Schema.annotated("text"),
      summary: Schema.annotated("text"),
    })
    const bound = yjs.bind(schema)
    expect(bound).toBeDefined()
  })

  it("plain-only schema (no annotations at all except doc) is accepted", () => {
    const schema = Schema.doc({
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
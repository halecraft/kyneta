import { describe, expectTypeOf, it } from "vitest"
import {
  Schema,
  type ScalarSchema,
  type ProductSchema,
  type SequenceSchema,
  type MapSchema,
  type AnnotatedSchema,
  type PositionalSumSchema,
  type DiscriminatedSumSchema,
  type ScalarKind,
  type SchemaNode,
  type Writable,
  type Plain,
  type ScalarPlain,
  type ScalarRef,
  type TextRef,
  type CounterRef,
  type SequenceRef,
} from "../index.js"

// ---------------------------------------------------------------------------
// Strict narrowing tests — toEqualTypeOf finds the REAL boundaries where
// type information is lost. These are the tests that matter.
// ---------------------------------------------------------------------------

describe("type-level: scalar kind literal preservation", () => {
  it("Schema.scalar('string') → scalarKind is literal 'string'", () => {
    const s = Schema.scalar("string")
    expectTypeOf(s.scalarKind).toEqualTypeOf<"string">()
  })

  it("Schema.scalar('number') → scalarKind is literal 'number'", () => {
    const s = Schema.scalar("number")
    expectTypeOf(s.scalarKind).toEqualTypeOf<"number">()
  })

  it("Schema.scalar('boolean') → scalarKind is literal 'boolean'", () => {
    const s = Schema.scalar("boolean")
    expectTypeOf(s.scalarKind).toEqualTypeOf<"boolean">()
  })

  it("Schema.string() → scalarKind is literal 'string'", () => {
    const s = Schema.string()
    expectTypeOf(s.scalarKind).toEqualTypeOf<"string">()
  })

  it("Schema.number() → scalarKind is literal 'number'", () => {
    const s = Schema.number()
    expectTypeOf(s.scalarKind).toEqualTypeOf<"number">()
  })

  it("Schema.boolean() → scalarKind is literal 'boolean'", () => {
    const s = Schema.boolean()
    expectTypeOf(s.scalarKind).toEqualTypeOf<"boolean">()
  })
})

describe("type-level: annotation tag literal preservation", () => {
  it("Schema.text() → tag is literal 'text', not string", () => {
    const s = Schema.text()
    expectTypeOf(s.tag).toEqualTypeOf<"text">()
  })

  it("Schema.counter() → tag is literal 'counter'", () => {
    const s = Schema.counter()
    expectTypeOf(s.tag).toEqualTypeOf<"counter">()
  })

  it("Schema.doc() → tag is literal 'doc'", () => {
    const s = Schema.doc({ title: Schema.text() })
    expectTypeOf(s.tag).toEqualTypeOf<"doc">()
  })

  it("Schema.movableList() → tag is literal 'movable'", () => {
    const s = Schema.movableList(Schema.string())
    expectTypeOf(s.tag).toEqualTypeOf<"movable">()
  })

  it("Schema.tree() → tag is literal 'tree'", () => {
    const s = Schema.tree(Schema.struct({ label: Schema.string() }))
    expectTypeOf(s.tag).toEqualTypeOf<"tree">()
  })

  it("Schema.annotated('custom') → tag is literal 'custom'", () => {
    const s = Schema.annotated("custom")
    expectTypeOf(s.tag).toEqualTypeOf<"custom">()
  })

  it("Schema.annotated('custom') → tag is NOT widened to string", () => {
    const s = Schema.annotated("custom")
    // This should fail if tag is widened to `string`
    expectTypeOf(s.tag).not.toEqualTypeOf<string>()
  })
})

describe("type-level: product field key and type preservation", () => {
  it("Schema.product fields are typed, not Record<string, Schema>", () => {
    const s = Schema.product({
      name: Schema.scalar("string"),
      age: Schema.scalar("number"),
    })

    // Field keys should be known at the type level
    expectTypeOf(s.fields).toHaveProperty("name")
    expectTypeOf(s.fields).toHaveProperty("age")

    // Accessing a known field should give back the specific schema type
    expectTypeOf(s.fields.name._kind).toEqualTypeOf<"scalar">()
    expectTypeOf(s.fields.age._kind).toEqualTypeOf<"scalar">()
  })

  it("Schema.struct fields preserve specific schema subtypes", () => {
    const s = Schema.struct({
      title: Schema.text(),
      count: Schema.counter(),
      tags: Schema.list(Schema.string()),
    })

    // Each field should be its specific schema subtype
    expectTypeOf(s.fields.title._kind).toEqualTypeOf<"annotated">()
    expectTypeOf(s.fields.count._kind).toEqualTypeOf<"annotated">()
    expectTypeOf(s.fields.tags._kind).toEqualTypeOf<"sequence">()
  })

  it("Schema.product does NOT allow access to non-existent field keys", () => {
    const s = Schema.product({
      name: Schema.scalar("string"),
    })

    // @ts-expect-error — 'nonexistent' should not be a valid key
    s.fields.nonexistent
  })

  it("Schema.doc inner product preserves field types through annotation", () => {
    const s = Schema.doc({
      title: Schema.text(),
      items: Schema.list(Schema.string()),
    })

    // The inner schema should be a typed product, not just Schema | undefined
    const inner = s.schema
    expectTypeOf(inner).not.toBeUndefined()

    // Can we see through to the product's fields?
    // This requires the inner schema to be typed as ProductSchema<...>, not just Schema
    if (inner && inner._kind === "product") {
      expectTypeOf(inner.fields).toHaveProperty("title")
      expectTypeOf(inner.fields).toHaveProperty("items")
    }
  })
})

describe("type-level: sequence and map item type preservation", () => {
  it("Schema.sequence item is the exact subtype, not just Schema", () => {
    const s = Schema.sequence(Schema.scalar("string"))
    expectTypeOf(s.item._kind).toEqualTypeOf<"scalar">()
  })

  it("Schema.list item preserves the inner struct type", () => {
    const s = Schema.list(
      Schema.struct({
        name: Schema.string(),
        active: Schema.boolean(),
      }),
    )
    // item should be ProductSchema (or narrower), not just Schema
    expectTypeOf(s.item._kind).toEqualTypeOf<"product">()
  })

  it("Schema.map item is the exact subtype, not just Schema", () => {
    const s = Schema.map(Schema.scalar("number"))
    expectTypeOf(s.item._kind).toEqualTypeOf<"scalar">()
  })
})

describe("type-level: sum variant preservation", () => {
  it("Schema.discriminatedSum discriminant is a literal string", () => {
    const s = Schema.discriminatedSum("kind", {
      a: Schema.product({ x: Schema.scalar("string") }),
    })
    expectTypeOf(s.discriminant).toEqualTypeOf<"kind">()
    // Should NOT be widened to string
    expectTypeOf(s.discriminant).not.toEqualTypeOf<string>()
  })

  it("Schema.discriminatedSum variantMap keys are known", () => {
    const s = Schema.discriminatedSum("type", {
      text: Schema.product({ content: Schema.scalar("string") }),
      image: Schema.product({ url: Schema.scalar("string") }),
    })
    expectTypeOf(s.variantMap).toHaveProperty("text")
    expectTypeOf(s.variantMap).toHaveProperty("image")
  })
})

describe("type-level: nested composition preserves types end-to-end", () => {
  it("a full doc schema preserves types through multiple levels of nesting", () => {
    const s = Schema.doc({
      title: Schema.text(),
      count: Schema.counter(),
      messages: Schema.list(
        Schema.struct({
          author: Schema.string(),
          body: Schema.text(),
        }),
      ),
      settings: Schema.struct({
        darkMode: Schema.boolean(),
        fontSize: Schema.number(),
      }),
      metadata: Schema.record(Schema.any()),
    })

    // Top-level: annotated("doc")
    expectTypeOf(s.tag).toEqualTypeOf<"doc">()

    // Inner product's fields should be typed
    const inner = s.schema!
    if (inner._kind === "product") {
      // title is annotated("text")
      const title = inner.fields.title
      expectTypeOf(title._kind).toEqualTypeOf<"annotated">()

      // messages is a sequence
      const messages = inner.fields.messages
      expectTypeOf(messages._kind).toEqualTypeOf<"sequence">()

      // settings is a product
      const settings = inner.fields.settings
      expectTypeOf(settings._kind).toEqualTypeOf<"product">()

      // metadata is a map
      const metadata = inner.fields.metadata
      expectTypeOf(metadata._kind).toEqualTypeOf<"map">()
    }
  })
})

// ---------------------------------------------------------------------------
// Phase 2: Writable<S> — the type-level catamorphism
// ---------------------------------------------------------------------------

describe("type-level: ScalarPlain maps scalar kinds to TS types", () => {
  it("ScalarPlain<'string'> = string", () => {
    expectTypeOf<ScalarPlain<"string">>().toEqualTypeOf<string>()
  })

  it("ScalarPlain<'number'> = number", () => {
    expectTypeOf<ScalarPlain<"number">>().toEqualTypeOf<number>()
  })

  it("ScalarPlain<'boolean'> = boolean", () => {
    expectTypeOf<ScalarPlain<"boolean">>().toEqualTypeOf<boolean>()
  })

  it("ScalarPlain<'null'> = null", () => {
    expectTypeOf<ScalarPlain<"null">>().toEqualTypeOf<null>()
  })

  it("ScalarPlain<'undefined'> = undefined", () => {
    expectTypeOf<ScalarPlain<"undefined">>().toEqualTypeOf<undefined>()
  })

  it("ScalarPlain<'bytes'> = Uint8Array", () => {
    expectTypeOf<ScalarPlain<"bytes">>().toEqualTypeOf<Uint8Array>()
  })

  it("ScalarPlain<'any'> = unknown", () => {
    expectTypeOf<ScalarPlain<"any">>().toEqualTypeOf<unknown>()
  })
})

describe("type-level: Writable<S> for leaf annotations", () => {
  it("Writable<text()> = TextRef", () => {
    type Result = Writable<ReturnType<typeof Schema.text>>
    expectTypeOf<Result>().toEqualTypeOf<TextRef>()
  })

  it("Writable<counter()> = CounterRef", () => {
    type Result = Writable<ReturnType<typeof Schema.counter>>
    expectTypeOf<Result>().toEqualTypeOf<CounterRef>()
  })
})

describe("type-level: Writable<S> for scalars", () => {
  it("Writable<string()> = ScalarRef<string>", () => {
    type Result = Writable<ReturnType<typeof Schema.string>>
    expectTypeOf<Result>().toEqualTypeOf<ScalarRef<string>>()
  })

  it("Writable<number()> = ScalarRef<number>", () => {
    type Result = Writable<ReturnType<typeof Schema.number>>
    expectTypeOf<Result>().toEqualTypeOf<ScalarRef<number>>()
  })

  it("Writable<boolean()> = ScalarRef<boolean>", () => {
    type Result = Writable<ReturnType<typeof Schema.boolean>>
    expectTypeOf<Result>().toEqualTypeOf<ScalarRef<boolean>>()
  })
})

describe("type-level: Writable<S> for products and structs", () => {
  it("Writable<struct({...})> has typed fields", () => {
    const s = Schema.struct({
      name: Schema.string(),
      active: Schema.boolean(),
    })
    type Result = Writable<typeof s>
    expectTypeOf<Result>().toEqualTypeOf<{
      readonly name: ScalarRef<string>
      readonly active: ScalarRef<boolean>
    }>()
  })

  it("Writable<struct with text and counter> maps annotations", () => {
    const s = Schema.struct({
      title: Schema.text(),
      count: Schema.counter(),
    })
    type Result = Writable<typeof s>
    expectTypeOf<Result>().toEqualTypeOf<{
      readonly title: TextRef
      readonly count: CounterRef
    }>()
  })
})

describe("type-level: Writable<S> for sequences", () => {
  it("Writable<list(plain.string())> = SequenceRef<ScalarRef<string>>", () => {
    const s = Schema.list(Schema.string())
    type Result = Writable<typeof s>
    expectTypeOf<Result>().toEqualTypeOf<SequenceRef<ScalarRef<string>>>()
  })

  it("Writable<list(struct({...}))> has typed item refs", () => {
    const s = Schema.list(
      Schema.struct({
        name: Schema.string(),
        body: Schema.text(),
      }),
    )
    type Result = Writable<typeof s>
    expectTypeOf<Result>().toEqualTypeOf<
      SequenceRef<{
        readonly name: ScalarRef<string>
        readonly body: TextRef
      }>
    >()
  })
})

describe("type-level: Writable<S> for doc (annotated + product)", () => {
  it("Writable<doc({...})> unwraps the annotation and maps the inner product", () => {
    const s = Schema.doc({
      title: Schema.text(),
      count: Schema.counter(),
      settings: Schema.struct({
        darkMode: Schema.boolean(),
        fontSize: Schema.number(),
      }),
    })
    type Result = Writable<typeof s>
    expectTypeOf<Result>().toEqualTypeOf<{
      readonly title: TextRef
      readonly count: CounterRef
      readonly settings: {
        readonly darkMode: ScalarRef<boolean>
        readonly fontSize: ScalarRef<number>
      }
    }>()
  })
})

describe("type-level: Writable<S> end-to-end realistic schema", () => {
  it("a full chat doc schema produces fully typed refs", () => {
    const chatDoc = Schema.doc({
      title: Schema.text(),
      count: Schema.counter(),
      messages: Schema.list(
        Schema.struct({
          author: Schema.string(),
          body: Schema.text(),
        }),
      ),
      settings: Schema.struct({
        darkMode: Schema.boolean(),
        fontSize: Schema.number(),
      }),
      metadata: Schema.record(Schema.any()),
    })

    type Doc = Writable<typeof chatDoc>

    // Top-level fields are correctly typed
    expectTypeOf<Doc["title"]>().toEqualTypeOf<TextRef>()
    expectTypeOf<Doc["count"]>().toEqualTypeOf<CounterRef>()

    // Nested sequence of structs
    expectTypeOf<Doc["messages"]>().toEqualTypeOf<
      SequenceRef<{
        readonly author: ScalarRef<string>
        readonly body: TextRef
      }>
    >()

    // Nested struct
    expectTypeOf<Doc["settings"]>().toEqualTypeOf<{
      readonly darkMode: ScalarRef<boolean>
      readonly fontSize: ScalarRef<number>
    }>()

    // Record (dynamic keys)
    expectTypeOf<Doc["metadata"]>().toEqualTypeOf<{
      readonly [key: string]: ScalarRef<unknown>
    }>()
  })
})

// ---------------------------------------------------------------------------
// Plain<S> — the type-level catamorphism for plain JS types
// ---------------------------------------------------------------------------

describe("type-level: Plain<S> for leaf annotations", () => {
  it("Plain<text()> = string", () => {
    type Result = Plain<ReturnType<typeof Schema.text>>
    expectTypeOf<Result>().toEqualTypeOf<string>()
  })

  it("Plain<counter()> = number", () => {
    type Result = Plain<ReturnType<typeof Schema.counter>>
    expectTypeOf<Result>().toEqualTypeOf<number>()
  })
})

describe("type-level: Plain<S> for scalars", () => {
  it("Plain<string()> = string", () => {
    type Result = Plain<ReturnType<typeof Schema.string>>
    expectTypeOf<Result>().toEqualTypeOf<string>()
  })

  it("Plain<number()> = number", () => {
    type Result = Plain<ReturnType<typeof Schema.number>>
    expectTypeOf<Result>().toEqualTypeOf<number>()
  })

  it("Plain<boolean()> = boolean", () => {
    type Result = Plain<ReturnType<typeof Schema.boolean>>
    expectTypeOf<Result>().toEqualTypeOf<boolean>()
  })

  it("Plain<null()> = null", () => {
    type Result = Plain<ReturnType<typeof Schema.null>>
    expectTypeOf<Result>().toEqualTypeOf<null>()
  })

  it("Plain<undefined()> = undefined", () => {
    type Result = Plain<ReturnType<typeof Schema.undefined>>
    expectTypeOf<Result>().toEqualTypeOf<undefined>()
  })

  it("Plain<bytes()> = Uint8Array", () => {
    type Result = Plain<ReturnType<typeof Schema.bytes>>
    expectTypeOf<Result>().toEqualTypeOf<Uint8Array>()
  })

  it("Plain<any()> = unknown", () => {
    type Result = Plain<ReturnType<typeof Schema.any>>
    expectTypeOf<Result>().toEqualTypeOf<unknown>()
  })
})

describe("type-level: Plain<S> for products and structs", () => {
  it("Plain<struct({...})> has typed fields", () => {
    const s = Schema.struct({
      name: Schema.string(),
      active: Schema.boolean(),
    })
    type Result = Plain<typeof s>
    expectTypeOf<Result>().toEqualTypeOf<{
      name: string
      active: boolean
    }>()
  })

  it("Plain<struct with text and counter> maps annotations to primitives", () => {
    const s = Schema.struct({
      title: Schema.text(),
      count: Schema.counter(),
    })
    type Result = Plain<typeof s>
    expectTypeOf<Result>().toEqualTypeOf<{
      title: string
      count: number
    }>()
  })
})

describe("type-level: Plain<S> for sequences", () => {
  it("Plain<list(plain.string())> = string[]", () => {
    const s = Schema.list(Schema.string())
    type Result = Plain<typeof s>
    expectTypeOf<Result>().toEqualTypeOf<string[]>()
  })

  it("Plain<list(struct({...}))> has typed item objects", () => {
    const s = Schema.list(
      Schema.struct({
        name: Schema.string(),
        body: Schema.text(),
      }),
    )
    type Result = Plain<typeof s>
    expectTypeOf<Result>().toEqualTypeOf<
      { name: string; body: string }[]
    >()
  })
})

describe("type-level: Plain<S> for maps", () => {
  it("Plain<record(plain.number())> = { [key: string]: number }", () => {
    const s = Schema.record(Schema.number())
    type Result = Plain<typeof s>
    expectTypeOf<Result>().toEqualTypeOf<{ [key: string]: number }>()
  })

  it("Plain<record(plain.any())> = { [key: string]: unknown }", () => {
    const s = Schema.record(Schema.any())
    type Result = Plain<typeof s>
    expectTypeOf<Result>().toEqualTypeOf<{ [key: string]: unknown }>()
  })
})

describe("type-level: Plain<S> for movable list", () => {
  it("Plain<movableList(plain.string())> = string[]", () => {
    const s = Schema.movableList(Schema.string())
    type Result = Plain<typeof s>
    expectTypeOf<Result>().toEqualTypeOf<string[]>()
  })

  it("Plain<movableList(struct({...}))> = typed object[]", () => {
    const s = Schema.movableList(
      Schema.struct({
        id: Schema.number(),
        label: Schema.string(),
      }),
    )
    type Result = Plain<typeof s>
    expectTypeOf<Result>().toEqualTypeOf<
      { id: number; label: string }[]
    >()
  })
})

describe("type-level: Plain<S> for doc (annotated + product)", () => {
  it("Plain<doc({...})> unwraps the annotation and maps the inner product", () => {
    const s = Schema.doc({
      title: Schema.text(),
      count: Schema.counter(),
      settings: Schema.struct({
        darkMode: Schema.boolean(),
        fontSize: Schema.number(),
      }),
    })
    type Result = Plain<typeof s>
    expectTypeOf<Result>().toEqualTypeOf<{
      title: string
      count: number
      settings: {
        darkMode: boolean
        fontSize: number
      }
    }>()
  })
})

describe("type-level: Plain<S> end-to-end realistic schema", () => {
  it("a full chat doc schema produces fully typed plain object", () => {
    const chatDoc = Schema.doc({
      title: Schema.text(),
      count: Schema.counter(),
      messages: Schema.list(
        Schema.struct({
          author: Schema.string(),
          body: Schema.text(),
        }),
      ),
      settings: Schema.struct({
        darkMode: Schema.boolean(),
        fontSize: Schema.number(),
      }),
      metadata: Schema.record(Schema.any()),
    })

    type Doc = Plain<typeof chatDoc>

    // Top-level fields are correctly typed
    expectTypeOf<Doc["title"]>().toEqualTypeOf<string>()
    expectTypeOf<Doc["count"]>().toEqualTypeOf<number>()

    // Nested sequence of structs → typed object array
    expectTypeOf<Doc["messages"]>().toEqualTypeOf<
      { author: string; body: string }[]
    >()

    // Nested struct → typed object
    expectTypeOf<Doc["settings"]>().toEqualTypeOf<{
      darkMode: boolean
      fontSize: number
    }>()

    // Record (dynamic keys)
    expectTypeOf<Doc["metadata"]>().toEqualTypeOf<{
      [key: string]: unknown
    }>()
  })
})
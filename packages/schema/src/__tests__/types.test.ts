import { describe, expectTypeOf, it } from "vitest"
import {
  Schema,
  LoroSchema,
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
  type ProductRef,
  type WritableMapRef,
  type PlainSchema,
  type PlainProductSchema,
  type PlainSequenceSchema,
  type PlainMapSchema,
  type PlainPositionalSumSchema,
  type PlainDiscriminatedSumSchema,
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
  it("Schema.doc() → tag is literal 'doc'", () => {
    const s = Schema.doc({ title: Schema.string() })
    expectTypeOf(s.tag).toEqualTypeOf<"doc">()
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
      title: Schema.string(),
      count: Schema.number(),
      tags: Schema.list(Schema.string()),
    })

    // Each field should be its specific schema subtype
    expectTypeOf(s.fields.title._kind).toEqualTypeOf<"scalar">()
    expectTypeOf(s.fields.count._kind).toEqualTypeOf<"scalar">()
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
      title: Schema.string(),
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
      title: Schema.string(),
      count: Schema.number(),
      messages: Schema.list(
        Schema.struct({
          author: Schema.string(),
          body: Schema.string(),
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
      // title is scalar("string")
      const title = inner.fields.title
      expectTypeOf(title._kind).toEqualTypeOf<"scalar">()

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
  it("Writable<struct({...})> has typed fields and .set()", () => {
    const s = Schema.struct({
      name: Schema.string(),
      active: Schema.boolean(),
    })
    type Result = Writable<typeof s>
    expectTypeOf<Result>().toEqualTypeOf<
      {
        readonly name: ScalarRef<string>
        readonly active: ScalarRef<boolean>
      } & ProductRef<{ name: string; active: boolean }>
    >()
  })

  it("Writable<ProductSchema<{ x: ScalarSchema<'number'> }>> has .set({ x: number })", () => {
    type Result = Writable<ProductSchema<{ x: ScalarSchema<"number"> }>>
    expectTypeOf<Result>().toHaveProperty("set")
    expectTypeOf<Result["set"]>().toBeFunction()
    expectTypeOf<Result["set"]>().toEqualTypeOf<(value: { x: number }) => void>()
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
        active: Schema.boolean(),
      }),
    )
    type Result = Writable<typeof s>
    expectTypeOf<Result>().toEqualTypeOf<
      SequenceRef<
        {
          readonly name: ScalarRef<string>
          readonly active: ScalarRef<boolean>
        } & ProductRef<{ name: string; active: boolean }>
      >
    >()
  })
})

describe("type-level: Writable<S> for doc (annotated + product)", () => {
  it("Writable<doc({...})> unwraps the annotation and maps the inner product", () => {
    const s = Schema.doc({
      title: Schema.string(),
      settings: Schema.struct({
        darkMode: Schema.boolean(),
        fontSize: Schema.number(),
      }),
    })
    type Result = Writable<typeof s>
    expectTypeOf<Result>().toEqualTypeOf<
      {
        readonly title: ScalarRef<string>
        readonly settings: {
          readonly darkMode: ScalarRef<boolean>
          readonly fontSize: ScalarRef<number>
        } & ProductRef<{ darkMode: boolean; fontSize: number }>
      } & ProductRef<{
        title: string
        settings: { darkMode: boolean; fontSize: number }
      }>
    >()
  })
})

describe("type-level: Writable<S> end-to-end structural schema", () => {
  it("a pure structural doc schema produces fully typed refs", () => {
    const docSchema = Schema.doc({
      title: Schema.string(),
      count: Schema.number(),
      messages: Schema.list(
        Schema.struct({
          author: Schema.string(),
          body: Schema.string(),
        }),
      ),
      settings: Schema.struct({
        darkMode: Schema.boolean(),
        fontSize: Schema.number(),
      }),
      metadata: Schema.record(Schema.any()),
    })

    type Doc = Writable<typeof docSchema>

    // Top-level fields are correctly typed
    expectTypeOf<Doc["title"]>().toEqualTypeOf<ScalarRef<string>>()
    expectTypeOf<Doc["count"]>().toEqualTypeOf<ScalarRef<number>>()

    // Nested sequence of structs
    expectTypeOf<Doc["messages"]>().toEqualTypeOf<
      SequenceRef<
        {
          readonly author: ScalarRef<string>
          readonly body: ScalarRef<string>
        } & ProductRef<{ author: string; body: string }>
      >
    >()

    // Nested struct
    expectTypeOf<Doc["settings"]>().toEqualTypeOf<
      {
        readonly darkMode: ScalarRef<boolean>
        readonly fontSize: ScalarRef<number>
      } & ProductRef<{ darkMode: boolean; fontSize: number }>
    >()

    // Record (dynamic keys) — Map-like mutation interface
    expectTypeOf<Doc["metadata"]>().toEqualTypeOf<WritableMapRef<unknown>>()
  })
})

// ---------------------------------------------------------------------------
// Plain<S> — the type-level catamorphism for plain JS types
// ---------------------------------------------------------------------------



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

  it("Plain<struct with scalars> maps to plain types", () => {
    const s = Schema.struct({
      title: Schema.string(),
      count: Schema.number(),
    })
    type Result = Plain<typeof s>
    expectTypeOf<Result>().toEqualTypeOf<{
      title: string
      count: number
    }>()
  })
})

describe("type-level: Plain<S> for sequences", () => {
  it("Plain<list(string())> = string[]", () => {
    const s = Schema.list(Schema.string())
    type Result = Plain<typeof s>
    expectTypeOf<Result>().toEqualTypeOf<string[]>()
  })

  it("Plain<list(struct({...}))> has typed item objects", () => {
    const s = Schema.list(
      Schema.struct({
        name: Schema.string(),
        body: Schema.string(),
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

describe("type-level: Plain<S> for doc (annotated + product)", () => {
  it("Plain<doc({...})> unwraps the annotation and maps the inner product", () => {
    const s = Schema.doc({
      title: Schema.string(),
      count: Schema.number(),
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

describe("type-level: Plain<S> end-to-end structural schema", () => {
  it("a pure structural doc schema produces fully typed plain object", () => {
    const docSchema = Schema.doc({
      title: Schema.string(),
      count: Schema.number(),
      messages: Schema.list(
        Schema.struct({
          author: Schema.string(),
          body: Schema.string(),
        }),
      ),
      settings: Schema.struct({
        darkMode: Schema.boolean(),
        fontSize: Schema.number(),
      }),
      metadata: Schema.record(Schema.any()),
    })

    type Doc = Plain<typeof docSchema>

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

// ===========================================================================
// LoroSchema tests — Loro-specific annotation types
// ===========================================================================

describe("type-level: LoroSchema annotation tag literal preservation", () => {
  it("LoroSchema.text() → tag is literal 'text'", () => {
    const s = LoroSchema.text()
    expectTypeOf(s.tag).toEqualTypeOf<"text">()
  })

  it("LoroSchema.counter() → tag is literal 'counter'", () => {
    const s = LoroSchema.counter()
    expectTypeOf(s.tag).toEqualTypeOf<"counter">()
  })

  it("LoroSchema.movableList() → tag is literal 'movable'", () => {
    const s = LoroSchema.movableList(LoroSchema.plain.string())
    expectTypeOf(s.tag).toEqualTypeOf<"movable">()
  })

  it("LoroSchema.tree() → tag is literal 'tree'", () => {
    const s = LoroSchema.tree(LoroSchema.plain.struct({ label: LoroSchema.plain.string() }))
    expectTypeOf(s.tag).toEqualTypeOf<"tree">()
  })
})

describe("type-level: Writable<S> for Loro leaf annotations", () => {
  it("Writable<text()> = TextRef", () => {
    type Result = Writable<ReturnType<typeof LoroSchema.text>>
    expectTypeOf<Result>().toEqualTypeOf<TextRef>()
  })

  it("Writable<counter()> = CounterRef", () => {
    type Result = Writable<ReturnType<typeof LoroSchema.counter>>
    expectTypeOf<Result>().toEqualTypeOf<CounterRef>()
  })

  it("Writable<struct with text and counter> maps annotations", () => {
    const s = Schema.struct({
      title: LoroSchema.text(),
      count: LoroSchema.counter(),
    })
    type Result = Writable<typeof s>
    expectTypeOf<Result>().toEqualTypeOf<{
      readonly title: TextRef
      readonly count: CounterRef
    } & ProductRef<{ title: string; count: number }>>()
  })
})

describe("type-level: Writable<S> end-to-end Loro schema", () => {
  it("a Loro doc schema produces fully typed refs", () => {
    const loroDoc = LoroSchema.doc({
      title: LoroSchema.text(),
      count: LoroSchema.counter(),
      messages: Schema.list(
        Schema.struct({
          author: Schema.string(),
          body: LoroSchema.text(),
        }),
      ),
      settings: LoroSchema.plain.struct({
        darkMode: LoroSchema.plain.boolean(),
        fontSize: LoroSchema.plain.number(),
      }),
      metadata: Schema.record(LoroSchema.plain.any()),
    })

    type Doc = Writable<typeof loroDoc>

    expectTypeOf<Doc["title"]>().toEqualTypeOf<TextRef>()
    expectTypeOf<Doc["count"]>().toEqualTypeOf<CounterRef>()

    expectTypeOf<Doc["messages"]>().toEqualTypeOf<
      SequenceRef<
        {
          readonly author: ScalarRef<string>
          readonly body: TextRef
        } & ProductRef<{ author: string; body: string }>
      >
    >()

    expectTypeOf<Doc["settings"]>().toEqualTypeOf<
      {
        readonly darkMode: ScalarRef<boolean>
        readonly fontSize: ScalarRef<number>
      } & ProductRef<{ darkMode: boolean; fontSize: number }>
    >()

    expectTypeOf<Doc["metadata"]>().toEqualTypeOf<WritableMapRef<unknown>>()
  })
})

describe("type-level: Plain<S> for Loro leaf annotations", () => {
  it("Plain<text()> = string", () => {
    type Result = Plain<ReturnType<typeof LoroSchema.text>>
    expectTypeOf<Result>().toEqualTypeOf<string>()
  })

  it("Plain<counter()> = number", () => {
    type Result = Plain<ReturnType<typeof LoroSchema.counter>>
    expectTypeOf<Result>().toEqualTypeOf<number>()
  })
})

describe("type-level: Plain<S> for Loro movable list", () => {
  it("Plain<movableList(string())> = string[]", () => {
    const s = LoroSchema.movableList(LoroSchema.plain.string())
    type Result = Plain<typeof s>
    expectTypeOf<Result>().toEqualTypeOf<string[]>()
  })

  it("Plain<movableList(struct({...}))> = typed object[]", () => {
    const s = LoroSchema.movableList(
      LoroSchema.plain.struct({
        id: LoroSchema.plain.number(),
        label: LoroSchema.plain.string(),
      }),
    )
    type Result = Plain<typeof s>
    expectTypeOf<Result>().toEqualTypeOf<
      { id: number; label: string }[]
    >()
  })
})

describe("type-level: Plain<S> end-to-end Loro schema", () => {
  it("a Loro doc schema produces fully typed plain object", () => {
    const loroDoc = LoroSchema.doc({
      title: LoroSchema.text(),
      count: LoroSchema.counter(),
      messages: Schema.list(
        Schema.struct({
          author: Schema.string(),
          body: LoroSchema.text(),
        }),
      ),
      settings: LoroSchema.plain.struct({
        darkMode: LoroSchema.plain.boolean(),
        fontSize: LoroSchema.plain.number(),
      }),
      metadata: Schema.record(LoroSchema.plain.any()),
    })

    type Doc = Plain<typeof loroDoc>

    expectTypeOf<Doc["title"]>().toEqualTypeOf<string>()
    expectTypeOf<Doc["count"]>().toEqualTypeOf<number>()

    expectTypeOf<Doc["messages"]>().toEqualTypeOf<
      { author: string; body: string }[]
    >()

    expectTypeOf<Doc["settings"]>().toEqualTypeOf<{
      darkMode: boolean
      fontSize: number
    }>()

    expectTypeOf<Doc["metadata"]>().toEqualTypeOf<{
      [key: string]: unknown
    }>()
  })
})

// ===========================================================================
// Constrained scalar tests — Phase 2
// ===========================================================================

describe("type-level: Plain<S> for constrained scalars", () => {
  it("Plain<string('a', 'b')> = 'a' | 'b'", () => {
    const s = Schema.string("a", "b")
    type Result = Plain<typeof s>
    expectTypeOf<Result>().toEqualTypeOf<"a" | "b">()
  })

  it("Plain<number(1, 2, 3)> = 1 | 2 | 3", () => {
    const s = Schema.number(1, 2, 3)
    type Result = Plain<typeof s>
    expectTypeOf<Result>().toEqualTypeOf<1 | 2 | 3>()
  })

  it("Plain<boolean(true)> = true", () => {
    const s = Schema.boolean(true)
    type Result = Plain<typeof s>
    expectTypeOf<Result>().toEqualTypeOf<true>()
  })

  it("unconstrained string() still produces string", () => {
    const s = Schema.string()
    type Result = Plain<typeof s>
    expectTypeOf<Result>().toEqualTypeOf<string>()
  })

  it("unconstrained number() still produces number", () => {
    const s = Schema.number()
    type Result = Plain<typeof s>
    expectTypeOf<Result>().toEqualTypeOf<number>()
  })

  it("unconstrained boolean() still produces boolean", () => {
    const s = Schema.boolean()
    type Result = Plain<typeof s>
    expectTypeOf<Result>().toEqualTypeOf<boolean>()
  })

  it("constrained scalar in a struct narrows the field type", () => {
    const s = Schema.struct({
      visibility: Schema.string("public", "private"),
      count: Schema.number(),
    })
    type Result = Plain<typeof s>
    expectTypeOf<Result>().toEqualTypeOf<{
      visibility: "public" | "private"
      count: number
    }>()
  })
})

describe("type-level: Writable<S> for constrained scalars", () => {
  it("Writable<string('a', 'b')> = ScalarRef<'a' | 'b'>", () => {
    const s = Schema.string("a", "b")
    type Result = Writable<typeof s>
    expectTypeOf<Result>().toEqualTypeOf<ScalarRef<"a" | "b">>()
  })

  it("Writable<number(1, 2)> = ScalarRef<1 | 2>", () => {
    const s = Schema.number(1, 2)
    type Result = Writable<typeof s>
    expectTypeOf<Result>().toEqualTypeOf<ScalarRef<1 | 2>>()
  })

  it("unconstrained Writable<string()> = ScalarRef<string> (unchanged)", () => {
    type Result = Writable<ReturnType<typeof Schema.string>>
    expectTypeOf<Result>().toEqualTypeOf<ScalarRef<string>>()
  })
})

describe("type-level: ScalarSchema constraint type parameter", () => {
  it("Schema.string('x', 'y') has constraint field typed as readonly ('x' | 'y')[]", () => {
    const s = Schema.string("x", "y")
    expectTypeOf(s.constraint).toEqualTypeOf<readonly ("x" | "y")[] | undefined>()
  })

  it("Schema.string() has no constraint at runtime", () => {
    const s = Schema.string()
    expectTypeOf(s.constraint).toEqualTypeOf<readonly string[] | undefined>()
  })

  it("Schema.scalar('string') produces ScalarSchema<'string'> (backward compat)", () => {
    const s = Schema.scalar("string")
    expectTypeOf(s.scalarKind).toEqualTypeOf<"string">()
    expectTypeOf(s._kind).toEqualTypeOf<"scalar">()
  })
})

// ===========================================================================
// PlainSchema constraint tests
// ===========================================================================

describe("type-level: PlainSchema accepts annotation-free schemas", () => {
  it("ScalarSchema extends PlainSchema", () => {
    expectTypeOf<ScalarSchema<"string">>().toMatchTypeOf<PlainSchema>()
    expectTypeOf<ScalarSchema<"number">>().toMatchTypeOf<PlainSchema>()
    expectTypeOf<ScalarSchema<"boolean">>().toMatchTypeOf<PlainSchema>()
  })

  it("PlainProductSchema extends PlainSchema", () => {
    expectTypeOf<PlainProductSchema<{ x: ScalarSchema<"string"> }>>().toMatchTypeOf<PlainSchema>()
  })

  it("PlainSequenceSchema extends PlainSchema", () => {
    expectTypeOf<PlainSequenceSchema<ScalarSchema<"string">>>().toMatchTypeOf<PlainSchema>()
  })

  it("PlainMapSchema extends PlainSchema", () => {
    expectTypeOf<PlainMapSchema<ScalarSchema<"number">>>().toMatchTypeOf<PlainSchema>()
  })

  it("nested plain product of sequence of scalars extends PlainSchema", () => {
    type Nested = PlainProductSchema<{
      items: PlainSequenceSchema<ScalarSchema<"string">>
    }>
    expectTypeOf<Nested>().toMatchTypeOf<PlainSchema>()
  })

  it("PlainPositionalSumSchema extends PlainSchema", () => {
    type NullableString = PlainPositionalSumSchema<[ScalarSchema<"null">, ScalarSchema<"string">]>
    expectTypeOf<NullableString>().toMatchTypeOf<PlainSchema>()
  })

  it("PlainDiscriminatedSumSchema extends PlainSchema", () => {
    type Disc = PlainDiscriminatedSumSchema<"type", {
      a: PlainProductSchema<{ x: ScalarSchema<"string"> }>
    }>
    expectTypeOf<Disc>().toMatchTypeOf<PlainSchema>()
  })
})

describe("type-level: PlainSchema is a subtype of Schema", () => {
  it("PlainProductSchema extends Schema", () => {
    expectTypeOf<PlainProductSchema<{ x: ScalarSchema<"string"> }>>().toMatchTypeOf<SchemaNode>()
  })

  it("PlainSequenceSchema extends Schema", () => {
    expectTypeOf<PlainSequenceSchema<ScalarSchema<"string">>>().toMatchTypeOf<SchemaNode>()
  })

  it("PlainMapSchema extends Schema", () => {
    expectTypeOf<PlainMapSchema<ScalarSchema<"number">>>().toMatchTypeOf<SchemaNode>()
  })
})

describe("type-level: PlainSchema rejects annotated schemas", () => {
  it("AnnotatedSchema<'text'> does NOT extend PlainSchema", () => {
    expectTypeOf<AnnotatedSchema<"text">>().not.toMatchTypeOf<PlainSchema>()
  })

  it("AnnotatedSchema<'counter'> does NOT extend PlainSchema", () => {
    expectTypeOf<AnnotatedSchema<"counter">>().not.toMatchTypeOf<PlainSchema>()
  })

  it("AnnotatedSchema<'movable', SequenceSchema> does NOT extend PlainSchema", () => {
    expectTypeOf<AnnotatedSchema<"movable", SequenceSchema<ScalarSchema<"string">>>>().not.toMatchTypeOf<PlainSchema>()
  })

  it("AnnotatedSchema<'doc', ProductSchema> does NOT extend PlainSchema", () => {
    expectTypeOf<AnnotatedSchema<"doc", ProductSchema>>().not.toMatchTypeOf<PlainSchema>()
  })

  it("ProductSchema containing AnnotatedSchema does NOT extend PlainProductSchema", () => {
    type Bad = ProductSchema<{ x: AnnotatedSchema<"text"> }>
    expectTypeOf<Bad>().not.toMatchTypeOf<PlainProductSchema>()
  })
})

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

  it("plain.struct accepts plain array inside", () => {
    const arr = LoroSchema.plain.array(LoroSchema.plain.string())
    const s = LoroSchema.plain.struct({ items: arr })
    expectTypeOf(s).toMatchTypeOf<ProductSchema>()
  })

  it("plain.struct accepts nullable plain scalar", () => {
    const nullable = Schema.nullable(Schema.string())
    const s = LoroSchema.plain.struct({ bio: nullable })
    expectTypeOf(s).toMatchTypeOf<ProductSchema>()
  })

  it("plain.struct rejects LoroSchema.text()", () => {
    // @ts-expect-error — CRDT annotation inside plain struct
    LoroSchema.plain.struct({ title: LoroSchema.text() })
  })

  it("plain.struct rejects LoroSchema.counter()", () => {
    // @ts-expect-error — CRDT annotation inside plain struct
    LoroSchema.plain.struct({ count: LoroSchema.counter() })
  })

  it("plain.array rejects LoroSchema.text()", () => {
    // @ts-expect-error — CRDT annotation as plain array item
    LoroSchema.plain.array(LoroSchema.text())
  })

  it("plain.record rejects LoroSchema.counter()", () => {
    // @ts-expect-error — CRDT annotation as plain record item
    LoroSchema.plain.record(LoroSchema.counter())
  })

  it("plain.struct rejects nullable wrapping a CRDT annotation", () => {
    const nullableText = Schema.nullable(LoroSchema.text())
    // @ts-expect-error — annotation nested inside sum inside plain struct
    LoroSchema.plain.struct({ bio: nullableText })
  })

  it("Plain<S> and Writable<S> still work for plain.struct results", () => {
    const s = LoroSchema.plain.struct({
      name: LoroSchema.plain.string(),
      active: LoroSchema.plain.boolean(),
    })
    type P = Plain<typeof s>
    expectTypeOf<P>().toEqualTypeOf<{ name: string; active: boolean }>()

    type W = Writable<typeof s>
    expectTypeOf<W>().toEqualTypeOf<
      {
        readonly name: ScalarRef<string>
        readonly active: ScalarRef<boolean>
      } & ProductRef<{ name: string; active: boolean }>
    >()
  })
})
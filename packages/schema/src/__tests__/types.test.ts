import { describe, expectTypeOf, it } from "vitest"
import {
  type AnnotatedSchema,
  bottomInterpreter,
  CHANGEFEED,
  type ChangefeedBrand,
  type CounterRef,
  change,
  changefeed,
  type HasCaching,
  type HasCall,
  type HasChangefeed,
  type HasRead,
  type HasTransact,
  type InterpretBuilder,
  type Interpreter,
  type InterpreterLayer,
  interpret,
  type MapSchema,
  type NavigableMapRef,
  type NavigableSequenceRef,
  type Plain,
  type PlainDiscriminatedSumSchema,
  type PlainMapSchema,
  type PlainPositionalSumSchema,
  type PlainProductSchema,
  type PlainSchema,
  type PlainSequenceSchema,
  type ProductRef,
  type ProductSchema,
  plainContext,
  plainStoreReader,
  type Readable,
  type ReadableBrand,
  type ReadableMapRef,
  type ReadableSequenceRef,
  type Ref,
  type RefContext,
  type Resolve,
  type ResolveCarrier,
  type RRef,
  type RWRef,
  readable,
  type ScalarPlain,
  type ScalarRef,
  type ScalarSchema,
  Schema,
  type SchemaNode,
  type SequenceRef,
  type SequenceSchema,
  subscribe,
  subscribeNode,
  type TextRef,
  TRANSACT,
  type WithTransact,
  type Wrap,
  type Writable,
  type WritableBrand,
  type WritableContext,
  type WritableMapRef,
  withCaching,
  withChangefeed,
  withNavigation,
  withReadable,
  withWritable,
  writable,
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
    const s = Schema.discriminatedSum("kind", [
      Schema.product({
        kind: Schema.scalar("string", ["a"]),
        x: Schema.scalar("string"),
      }),
    ])
    expectTypeOf(s.discriminant).toEqualTypeOf<"kind">()
    // Should NOT be widened to string
    expectTypeOf(s.discriminant).not.toEqualTypeOf<string>()
  })

  it("Schema.discriminatedSum variants array preserves types", () => {
    const s = Schema.discriminatedSum("type", [
      Schema.product({
        type: Schema.scalar("string", ["text"]),
        content: Schema.scalar("string"),
      }),
      Schema.product({
        type: Schema.scalar("string", ["image"]),
        url: Schema.scalar("string"),
      }),
    ])
    // variants is a tuple — length is known at the type level
    expectTypeOf(s.variants).toEqualTypeOf<
      [
        ProductSchema<{
          type: ScalarSchema<"string", string>
          content: ScalarSchema<"string", string>
        }>,
        ProductSchema<{
          type: ScalarSchema<"string", string>
          url: ScalarSchema<"string", string>
        }>,
      ]
    >()
    // variantMap is derived at runtime — typed as Record<string, ProductSchema>
    expectTypeOf(s.variantMap).toEqualTypeOf<
      Readonly<Record<string, ProductSchema>>
    >()
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
// Writable<S> — the type-level catamorphism
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
    expectTypeOf<Result["set"]>().toEqualTypeOf<
      (value: { x: number }) => void
    >()
  })
})

describe("type-level: Writable<S> for sequences", () => {
  it("Writable<list(plain.string())> = SequenceRef (mutation-only, no type param)", () => {
    const s = Schema.list(Schema.string())
    type Result = Writable<typeof s>
    expectTypeOf<Result>().toEqualTypeOf<SequenceRef>()
  })

  it("Writable<list(struct({...}))> = SequenceRef (mutation-only)", () => {
    const s = Schema.list(
      Schema.struct({
        name: Schema.string(),
        active: Schema.boolean(),
      }),
    )
    type Result = Writable<typeof s>
    expectTypeOf<Result>().toEqualTypeOf<SequenceRef>()
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

    // Nested sequence of structs — mutation-only (no type param)
    expectTypeOf<Doc["messages"]>().toEqualTypeOf<SequenceRef>()

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
    expectTypeOf<Result>().toEqualTypeOf<{ name: string; body: string }[]>()
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
// Annotation tests — annotation-specific types
// ===========================================================================

describe("type-level: annotation tag literal preservation", () => {
  it("Schema.annotated('text') → tag is literal 'text'", () => {
    const s = Schema.annotated("text")
    expectTypeOf(s.tag).toEqualTypeOf<"text">()
  })

  it("Schema.annotated('counter') → tag is literal 'counter'", () => {
    const s = Schema.annotated("counter")
    expectTypeOf(s.tag).toEqualTypeOf<"counter">()
  })

  it("Schema.annotated('movable') → tag is literal 'movable'", () => {
    const s = Schema.annotated("movable", Schema.list(Schema.string()))
    expectTypeOf(s.tag).toEqualTypeOf<"movable">()
  })

  it("Schema.annotated('tree') → tag is literal 'tree'", () => {
    const s = Schema.annotated(
      "tree",
      Schema.struct({ label: Schema.string() }),
    )
    expectTypeOf(s.tag).toEqualTypeOf<"tree">()
  })
})

describe("type-level: Writable<S> for leaf annotations", () => {
  it("Writable<text()> = TextRef", () => {
    const s = Schema.annotated("text")
    type Result = Writable<typeof s>
    expectTypeOf<Result>().toEqualTypeOf<TextRef>()
  })

  it("Writable<counter()> = CounterRef", () => {
    const s = Schema.annotated("counter")
    type Result = Writable<typeof s>
    expectTypeOf<Result>().toEqualTypeOf<CounterRef>()
  })

  it("Writable<struct with text and counter> maps annotations", () => {
    const s = Schema.struct({
      title: Schema.annotated("text"),
      count: Schema.annotated("counter"),
    })
    type Result = Writable<typeof s>
    expectTypeOf<Result>().toEqualTypeOf<
      {
        readonly title: TextRef
        readonly count: CounterRef
      } & ProductRef<{ title: string; count: number }>
    >()
  })
})

describe("type-level: Writable<S> end-to-end annotated schema", () => {
  it("an annotated doc schema produces fully typed refs", () => {
    const loroDoc = Schema.doc({
      title: Schema.annotated("text"),
      count: Schema.annotated("counter"),
      messages: Schema.list(
        Schema.struct({
          author: Schema.string(),
          body: Schema.annotated("text"),
        }),
      ),
      settings: Schema.struct({
        darkMode: Schema.boolean(),
        fontSize: Schema.number(),
      }),
      metadata: Schema.record(Schema.any()),
    })

    type Doc = Writable<typeof loroDoc>

    expectTypeOf<Doc["title"]>().toEqualTypeOf<TextRef>()
    expectTypeOf<Doc["count"]>().toEqualTypeOf<CounterRef>()

    expectTypeOf<Doc["messages"]>().toEqualTypeOf<SequenceRef>()

    expectTypeOf<Doc["settings"]>().toEqualTypeOf<
      {
        readonly darkMode: ScalarRef<boolean>
        readonly fontSize: ScalarRef<number>
      } & ProductRef<{ darkMode: boolean; fontSize: number }>
    >()

    expectTypeOf<Doc["metadata"]>().toEqualTypeOf<WritableMapRef<unknown>>()
  })
})

describe("type-level: Plain<S> for leaf annotations", () => {
  it("Plain<text()> = string", () => {
    const s = Schema.annotated("text")
    type Result = Plain<typeof s>
    expectTypeOf<Result>().toEqualTypeOf<string>()
  })

  it("Plain<counter()> = number", () => {
    const s = Schema.annotated("counter")
    type Result = Plain<typeof s>
    expectTypeOf<Result>().toEqualTypeOf<number>()
  })
})

describe("type-level: Plain<S> for movable list", () => {
  it("Plain<movableList(string())> = string[]", () => {
    const s = Schema.annotated("movable", Schema.list(Schema.string()))
    type Result = Plain<typeof s>
    expectTypeOf<Result>().toEqualTypeOf<string[]>()
  })

  it("Plain<movableList(struct({...}))> = typed object[]", () => {
    const s = Schema.annotated(
      "movable",
      Schema.list(
        Schema.struct({
          id: Schema.number(),
          label: Schema.string(),
        }),
      ),
    )
    type Result = Plain<typeof s>
    expectTypeOf<Result>().toEqualTypeOf<{ id: number; label: string }[]>()
  })
})

describe("type-level: Plain<S> end-to-end annotated schema", () => {
  it("an annotated doc schema produces fully typed plain object", () => {
    const loroDoc = Schema.doc({
      title: Schema.annotated("text"),
      count: Schema.annotated("counter"),
      messages: Schema.list(
        Schema.struct({
          author: Schema.string(),
          body: Schema.annotated("text"),
        }),
      ),
      settings: Schema.struct({
        darkMode: Schema.boolean(),
        fontSize: Schema.number(),
      }),
      metadata: Schema.record(Schema.any()),
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
// Constrained scalar tests
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
    expectTypeOf(s.constraint).toEqualTypeOf<
      readonly ("x" | "y")[] | undefined
    >()
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
    expectTypeOf<
      PlainProductSchema<{ x: ScalarSchema<"string"> }>
    >().toMatchTypeOf<PlainSchema>()
  })

  it("PlainSequenceSchema extends PlainSchema", () => {
    expectTypeOf<
      PlainSequenceSchema<ScalarSchema<"string">>
    >().toMatchTypeOf<PlainSchema>()
  })

  it("PlainMapSchema extends PlainSchema", () => {
    expectTypeOf<
      PlainMapSchema<ScalarSchema<"number">>
    >().toMatchTypeOf<PlainSchema>()
  })

  it("nested plain product of sequence of scalars extends PlainSchema", () => {
    type Nested = PlainProductSchema<{
      items: PlainSequenceSchema<ScalarSchema<"string">>
    }>
    expectTypeOf<Nested>().toMatchTypeOf<PlainSchema>()
  })

  it("PlainPositionalSumSchema extends PlainSchema", () => {
    type NullableString = PlainPositionalSumSchema<
      [ScalarSchema<"null">, ScalarSchema<"string">]
    >
    expectTypeOf<NullableString>().toMatchTypeOf<PlainSchema>()
  })

  it("PlainDiscriminatedSumSchema extends PlainSchema", () => {
    type Disc = PlainDiscriminatedSumSchema<
      "type",
      [
        PlainProductSchema<{
          type: ScalarSchema<"string", "a">
          x: ScalarSchema<"string">
        }>,
      ]
    >
    expectTypeOf<Disc>().toMatchTypeOf<PlainSchema>()
  })
})

describe("type-level: PlainSchema is a subtype of Schema", () => {
  it("PlainProductSchema extends Schema", () => {
    expectTypeOf<
      PlainProductSchema<{ x: ScalarSchema<"string"> }>
    >().toMatchTypeOf<SchemaNode>()
  })

  it("PlainSequenceSchema extends Schema", () => {
    expectTypeOf<
      PlainSequenceSchema<ScalarSchema<"string">>
    >().toMatchTypeOf<SchemaNode>()
  })

  it("PlainMapSchema extends Schema", () => {
    expectTypeOf<
      PlainMapSchema<ScalarSchema<"number">>
    >().toMatchTypeOf<SchemaNode>()
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
    expectTypeOf<
      AnnotatedSchema<"movable", SequenceSchema<ScalarSchema<"string">>>
    >().not.toMatchTypeOf<PlainSchema>()
  })

  it("AnnotatedSchema<'doc', ProductSchema> does NOT extend PlainSchema", () => {
    expectTypeOf<
      AnnotatedSchema<"doc", ProductSchema>
    >().not.toMatchTypeOf<PlainSchema>()
  })

  it("ProductSchema containing AnnotatedSchema does NOT extend PlainProductSchema", () => {
    type Bad = ProductSchema<{ x: AnnotatedSchema<"text"> }>
    expectTypeOf<Bad>().not.toMatchTypeOf<PlainProductSchema>()
  })
})

// ===========================================================================
// NavigableSequenceRef / NavigableMapRef type hierarchy
// ===========================================================================

describe("type-level: NavigableSequenceRef extends correctly", () => {
  it("ReadableSequenceRef extends NavigableSequenceRef", () => {
    expectTypeOf<ReadableSequenceRef<string, string>>().toMatchTypeOf<
      NavigableSequenceRef<string>
    >()
  })

  it("NavigableSequenceRef does NOT satisfy ReadableSequenceRef", () => {
    // NavigableSequenceRef lacks call signature and .get()
    expectTypeOf<NavigableSequenceRef<string>>().not.toMatchTypeOf<
      ReadableSequenceRef<string, string>
    >()
  })
})

describe("type-level: NavigableMapRef extends correctly", () => {
  it("ReadableMapRef extends NavigableMapRef", () => {
    expectTypeOf<ReadableMapRef<string, string>>().toMatchTypeOf<
      NavigableMapRef<string>
    >()
  })

  it("NavigableMapRef does NOT satisfy ReadableMapRef", () => {
    // NavigableMapRef lacks call signature and .get()
    expectTypeOf<NavigableMapRef<string>>().not.toMatchTypeOf<
      ReadableMapRef<string, string>
    >()
  })
})

describe("type-level: SequenceRef is mutation-only", () => {
  it("SequenceRef has push, insert, delete", () => {
    expectTypeOf<SequenceRef>().toHaveProperty("push")
    expectTypeOf<SequenceRef>().toHaveProperty("insert")
    expectTypeOf<SequenceRef>().toHaveProperty("delete")
  })

  it("SequenceRef does NOT have .at(), .length, or [Symbol.iterator]", () => {
    expectTypeOf<SequenceRef>().not.toHaveProperty("at")
    expectTypeOf<SequenceRef>().not.toHaveProperty("length")
  })

  it("SequenceRef does NOT satisfy NavigableSequenceRef", () => {
    expectTypeOf<SequenceRef>().not.toMatchTypeOf<NavigableSequenceRef>()
  })
})

// ===========================================================================
// Ref<S> — unified recursive type
// ===========================================================================

describe("type-level: Ref<S> for scalars", () => {
  it("Ref<string()> has .set() and () call signature", () => {
    type Result = Ref<ReturnType<typeof Schema.string>>
    // Has reading: callable
    expectTypeOf<Result>().toBeCallableWith()
    // Has mutation: .set()
    expectTypeOf<Result>().toHaveProperty("set")
    // Has TRANSACT
    expectTypeOf<Result>().toHaveProperty(TRANSACT)
  })

  it("Ref<number()> has .set() and () call signature", () => {
    type Result = Ref<ReturnType<typeof Schema.number>>
    expectTypeOf<Result>().toBeCallableWith()
    expectTypeOf<Result>().toHaveProperty("set")
    expectTypeOf<Result>().toHaveProperty(TRANSACT)
  })
})

describe("type-level: Ref<S> for products", () => {
  it("Ref<ProductSchema<{ x: ScalarSchema }>> — .x has .set() AND () call", () => {
    type Result = Ref<ProductSchema<{ x: ScalarSchema<"number"> }>>
    // Product is callable (returns snapshot)
    expectTypeOf<Result>().toBeCallableWith()
    // Product has .set() (ProductRef)
    expectTypeOf<Result>().toHaveProperty("set")
    // Product has field access
    expectTypeOf<Result>().toHaveProperty("x")
    // Child field is callable
    type Child = Result["x"]
    expectTypeOf<Child>().toBeCallableWith()
    // Child field has .set()
    expectTypeOf<Child>().toHaveProperty("set")
    // Child field has TRANSACT
    expectTypeOf<Child>().toHaveProperty(TRANSACT)
    // Product itself has TRANSACT
    expectTypeOf<Result>().toHaveProperty(TRANSACT)
  })
})

describe("type-level: Ref<S> for sequences", () => {
  it("Ref<SequenceSchema<ScalarSchema>> — .at(0) returns ref with .set() AND ()", () => {
    type Result = Ref<SequenceSchema<ScalarSchema<"string", string>>>
    // Has reading: callable (returns array snapshot)
    expectTypeOf<Result>().toBeCallableWith()
    // Has navigation: .at()
    expectTypeOf<Result>().toHaveProperty("at")
    // Has reading: .get()
    expectTypeOf<Result>().toHaveProperty("get")
    // Has mutation: .push(), .insert(), .delete()
    expectTypeOf<Result>().toHaveProperty("push")
    expectTypeOf<Result>().toHaveProperty("insert")
    expectTypeOf<Result>().toHaveProperty("delete")
    // Has navigation: .length
    expectTypeOf<Result>().toHaveProperty("length")
    // Has TRANSACT
    expectTypeOf<Result>().toHaveProperty(TRANSACT)
  })

  it("Ref sequence .at() returns Ref<child> with both read and write", () => {
    type SeqRef = Ref<SequenceSchema<ScalarSchema<"string", string>>>
    // .at() returns Ref<ScalarSchema> | undefined
    type ChildOrUndef = ReturnType<SeqRef["at"]>
    // Narrow away undefined
    type Child = Exclude<ChildOrUndef, undefined>
    // Child is callable (reading)
    expectTypeOf<Child>().toBeCallableWith()
    // Child has .set() (mutation)
    expectTypeOf<Child>().toHaveProperty("set")
    // Child has TRANSACT
    expectTypeOf<Child>().toHaveProperty(TRANSACT)
  })
})

describe("type-level: Ref<S> for maps", () => {
  it("Ref<MapSchema<ScalarSchema>> — .at(key) returns ref with .set() AND ()", () => {
    type Result = Ref<MapSchema<ScalarSchema<"number", number>>>
    // Has reading: callable (returns record snapshot)
    expectTypeOf<Result>().toBeCallableWith()
    // Has navigation: .at(), .has(), .keys(), .size
    expectTypeOf<Result>().toHaveProperty("at")
    expectTypeOf<Result>().toHaveProperty("has")
    expectTypeOf<Result>().toHaveProperty("keys")
    expectTypeOf<Result>().toHaveProperty("size")
    // Has reading: .get()
    expectTypeOf<Result>().toHaveProperty("get")
    // Has mutation: .set(), .delete(), .clear()
    expectTypeOf<Result>().toHaveProperty("set")
    expectTypeOf<Result>().toHaveProperty("delete")
    expectTypeOf<Result>().toHaveProperty("clear")
    // Has TRANSACT
    expectTypeOf<Result>().toHaveProperty(TRANSACT)
  })

  it("Ref map .at() returns Ref<child> with both read and write", () => {
    type MapRef = Ref<MapSchema<ScalarSchema<"number", number>>>
    type ChildOrUndef = ReturnType<MapRef["at"]>
    type Child = Exclude<ChildOrUndef, undefined>
    // Child is callable (reading)
    expectTypeOf<Child>().toBeCallableWith()
    // Child has .set() (mutation)
    expectTypeOf<Child>().toHaveProperty("set")
    // Child has TRANSACT
    expectTypeOf<Child>().toHaveProperty(TRANSACT)
  })
})

describe("type-level: Ref<S> for annotated doc with text", () => {
  it("Ref<doc({ title: text() })> — .title has .insert() AND () call", () => {
    const s = Schema.doc({
      title: Schema.annotated("text"),
      count: Schema.annotated("counter"),
    })
    type Doc = Ref<typeof s>
    // Doc is callable
    expectTypeOf<Doc>().toBeCallableWith()
    // Doc has TRANSACT
    expectTypeOf<Doc>().toHaveProperty(TRANSACT)
    // Doc has .set() (ProductRef)
    expectTypeOf<Doc>().toHaveProperty("set")
    // .title: text — callable + TextRef mutation
    type Title = Doc["title"]
    expectTypeOf<Title>().toBeCallableWith()
    expectTypeOf<Title>().toHaveProperty("insert")
    expectTypeOf<Title>().toHaveProperty("delete")
    expectTypeOf<Title>().toHaveProperty("update")
    expectTypeOf<Title>().toHaveProperty(TRANSACT)
    // .count: counter — callable + CounterRef mutation
    type Count = Doc["count"]
    expectTypeOf<Count>().toBeCallableWith()
    expectTypeOf<Count>().toHaveProperty("increment")
    expectTypeOf<Count>().toHaveProperty("decrement")
    expectTypeOf<Count>().toHaveProperty(TRANSACT)
  })
})

describe("type-level: Ref<S> end-to-end", () => {
  it("full doc schema produces unified type with read + write + transact", () => {
    const docSchema = Schema.doc({
      title: Schema.annotated("text"),
      count: Schema.annotated("counter"),
      messages: Schema.list(
        Schema.struct({
          author: Schema.string(),
          body: Schema.annotated("text"),
        }),
      ),
      settings: Schema.struct({
        darkMode: Schema.boolean(),
        fontSize: Schema.number(),
      }),
      metadata: Schema.record(Schema.any()),
    })

    type Doc = Ref<typeof docSchema>

    // Doc is callable
    expectTypeOf<Doc>().toBeCallableWith()
    // Doc has TRANSACT at top level
    expectTypeOf<Doc>().toHaveProperty(TRANSACT)

    // Leaf annotations: callable + mutation + TRANSACT
    type Title = Doc["title"]
    expectTypeOf<Title>().toBeCallableWith()
    expectTypeOf<Title>().toHaveProperty("insert")
    expectTypeOf<Title>().toHaveProperty(TRANSACT)

    type Count = Doc["count"]
    expectTypeOf<Count>().toBeCallableWith()
    expectTypeOf<Count>().toHaveProperty("increment")
    expectTypeOf<Count>().toHaveProperty(TRANSACT)

    // Sequence: navigation + reading + mutation + TRANSACT
    type Messages = Doc["messages"]
    expectTypeOf<Messages>().toBeCallableWith()
    expectTypeOf<Messages>().toHaveProperty("at")
    expectTypeOf<Messages>().toHaveProperty("push")
    expectTypeOf<Messages>().toHaveProperty("length")
    expectTypeOf<Messages>().toHaveProperty(TRANSACT)

    // Sequence child via .at(): Ref<struct> with read + write
    type MsgOrUndef = ReturnType<Messages["at"]>
    type Msg = Exclude<MsgOrUndef, undefined>
    expectTypeOf<Msg>().toBeCallableWith()
    expectTypeOf<Msg>().toHaveProperty("set") // ProductRef
    expectTypeOf<Msg>().toHaveProperty(TRANSACT)
    // Nested field access
    type Author = Msg["author"]
    expectTypeOf<Author>().toBeCallableWith()
    expectTypeOf<Author>().toHaveProperty("set") // ScalarRef
    type Body = Msg["body"]
    expectTypeOf<Body>().toBeCallableWith()
    expectTypeOf<Body>().toHaveProperty("insert") // TextRef

    // Nested struct
    type Settings = Doc["settings"]
    expectTypeOf<Settings>().toBeCallableWith()
    expectTypeOf<Settings>().toHaveProperty("set")
    expectTypeOf<Settings>().toHaveProperty(TRANSACT)
    type DarkMode = Settings["darkMode"]
    expectTypeOf<DarkMode>().toBeCallableWith()
    expectTypeOf<DarkMode>().toHaveProperty("set")

    // Map: navigation + reading + mutation + TRANSACT
    type Metadata = Doc["metadata"]
    expectTypeOf<Metadata>().toBeCallableWith()
    expectTypeOf<Metadata>().toHaveProperty("at")
    expectTypeOf<Metadata>().toHaveProperty("has")
    expectTypeOf<Metadata>().toHaveProperty("keys")
    expectTypeOf<Metadata>().toHaveProperty("set") // WritableMapRef
    expectTypeOf<Metadata>().toHaveProperty("delete")
    expectTypeOf<Metadata>().toHaveProperty("clear")
    expectTypeOf<Metadata>().toHaveProperty(TRANSACT)
  })
})

describe("type-level: Ref<S> no .at() overload conflict on sequences", () => {
  it("ReadableSequenceRef & SequenceRef has no .at() conflict (SequenceRef has no .at())", () => {
    // This is the core fix — ReadableSequenceRef provides .at() returning Ref<I>,
    // and SequenceRef provides only push/insert/delete. No conflicting .at() signatures.
    type Combined = ReadableSequenceRef<
      Ref<ScalarSchema<"string", string>>,
      string
    > &
      SequenceRef
    expectTypeOf<Combined>().toHaveProperty("at")
    expectTypeOf<Combined>().toHaveProperty("push")
    expectTypeOf<Combined>().toHaveProperty("length")
    // .at() returns Ref<Scalar> | undefined — no overload ambiguity
    type Child = Exclude<ReturnType<Combined["at"]>, undefined>
    expectTypeOf<Child>().toBeCallableWith()
    expectTypeOf<Child>().toHaveProperty("set")
  })
})

describe("type-level: WithTransact helper", () => {
  it("WithTransact<T> adds HasTransact to T", () => {
    type Base = { x: number }
    type Result = WithTransact<Base>
    expectTypeOf<Result>().toHaveProperty("x")
    expectTypeOf<Result>().toHaveProperty(TRANSACT)
  })

  it("WithTransact<T> is equivalent to Wrap<T, 'rw'>", () => {
    type Base = { x: number }
    expectTypeOf<WithTransact<Base>>().toEqualTypeOf<Wrap<Base, "rw">>()
  })
})

// ===========================================================================
// Ref tier differentiation: RRef, RWRef, Ref
// ===========================================================================

describe("type-level: RRef<S> is Readable<S>", () => {
  it("RRef<ScalarSchema> equals Readable<ScalarSchema>", () => {
    type S = ScalarSchema<"number">
    expectTypeOf<RRef<S>>().toEqualTypeOf<Readable<S>>()
  })

  it("RRef<ProductSchema> equals Readable<ProductSchema>", () => {
    type S = ProductSchema<{ x: ScalarSchema<"number"> }>
    expectTypeOf<RRef<S>>().toEqualTypeOf<Readable<S>>()
  })
})

describe("type-level: RWRef<S> has HasTransact but not HasChangefeed", () => {
  it("RWRef<scalar> has set, call signature, and [TRANSACT]", () => {
    type Result = RWRef<ScalarSchema<"number">>
    expectTypeOf<Result>().toBeCallableWith()
    expectTypeOf<Result>().toHaveProperty("set")
    expectTypeOf<Result>().toHaveProperty(TRANSACT)
  })

  it("RWRef<scalar> does NOT have [CHANGEFEED]", () => {
    type Result = RWRef<ScalarSchema<"number">>
    // HasChangefeed requires [CHANGEFEED] property — RWRef should not have it
    type HasCF = Result extends HasChangefeed ? true : false
    expectTypeOf<HasCF>().toEqualTypeOf<false>()
  })

  it("RWRef<product> children also lack [CHANGEFEED]", () => {
    type S = ProductSchema<{ x: ScalarSchema<"number"> }>
    type Child = RWRef<S>["x"]
    // Child has TRANSACT
    expectTypeOf<Child>().toHaveProperty(TRANSACT)
    // Child does NOT have CHANGEFEED
    type ChildHasCF = Child extends HasChangefeed ? true : false
    expectTypeOf<ChildHasCF>().toEqualTypeOf<false>()
  })
})

describe("type-level: Ref<S> has HasTransact AND HasChangefeed", () => {
  it("Ref<scalar> has set, call signature, [TRANSACT], and [CHANGEFEED]", () => {
    type Result = Ref<ScalarSchema<"number">>
    expectTypeOf<Result>().toBeCallableWith()
    expectTypeOf<Result>().toHaveProperty("set")
    expectTypeOf<Result>().toHaveProperty(TRANSACT)
    expectTypeOf<Result>().toHaveProperty(CHANGEFEED)
  })

  it("Ref<scalar> extends HasChangefeed", () => {
    type Result = Ref<ScalarSchema<"number">>
    type HasCF = Result extends HasChangefeed ? true : false
    expectTypeOf<HasCF>().toEqualTypeOf<true>()
  })

  it("Ref<product> children also have [CHANGEFEED] — recursive threading", () => {
    type S = ProductSchema<{ x: ScalarSchema<"number"> }>
    type Child = Ref<S>["x"]
    expectTypeOf<Child>().toHaveProperty(TRANSACT)
    expectTypeOf<Child>().toHaveProperty(CHANGEFEED)
    type ChildHasCF = Child extends HasChangefeed ? true : false
    expectTypeOf<ChildHasCF>().toEqualTypeOf<true>()
  })

  it("Ref<sequence> .at() result has [CHANGEFEED]", () => {
    type S = SequenceSchema<ScalarSchema<"string", string>>
    type AtResult = Exclude<ReturnType<Ref<S>["at"]>, undefined>
    expectTypeOf<AtResult>().toHaveProperty(TRANSACT)
    expectTypeOf<AtResult>().toHaveProperty(CHANGEFEED)
  })

  it("Ref<doc> with text field — child text ref has [CHANGEFEED]", () => {
    const s = Schema.doc({
      title: Schema.annotated("text"),
      count: Schema.annotated("counter"),
    })
    type Doc = Ref<typeof s>
    expectTypeOf<Doc>().toHaveProperty(CHANGEFEED)
    type Title = Doc["title"]
    expectTypeOf<Title>().toHaveProperty(CHANGEFEED)
    expectTypeOf<Title>().toHaveProperty("insert")
    type Count = Doc["count"]
    expectTypeOf<Count>().toHaveProperty(CHANGEFEED)
    expectTypeOf<Count>().toHaveProperty("increment")
  })
})

describe("type-level: Wrap<T, M> dispatches by mode", () => {
  it("Wrap<T, 'rw'> has HasTransact but not HasChangefeed", () => {
    type Base = { x: number }
    type Result = Wrap<Base, "rw">
    expectTypeOf<Result>().toHaveProperty("x")
    expectTypeOf<Result>().toHaveProperty(TRANSACT)
    type HasCF = Result extends HasChangefeed ? true : false
    expectTypeOf<HasCF>().toEqualTypeOf<false>()
  })

  it("Wrap<T, 'rwc'> has HasTransact AND HasChangefeed", () => {
    type Base = { x: number }
    type Result = Wrap<Base, "rwc">
    expectTypeOf<Result>().toHaveProperty("x")
    expectTypeOf<Result>().toHaveProperty(TRANSACT)
    expectTypeOf<Result>().toHaveProperty(CHANGEFEED)
  })
})

// ===========================================================================
// Fluent builder inference: Resolve<S, Brands>
// ===========================================================================

describe("type-level: Resolve<S, Brands> selects the correct tier", () => {
  type S = ProductSchema<{ x: ScalarSchema<"number"> }>

  it("ReadableBrand → RRef<S>", () => {
    type Result = Resolve<S, ReadableBrand>
    expectTypeOf<Result>().toEqualTypeOf<RRef<S>>()
  })

  it("ReadableBrand & WritableBrand → RWRef<S>", () => {
    type Result = Resolve<S, ReadableBrand & WritableBrand>
    expectTypeOf<Result>().toEqualTypeOf<RWRef<S>>()
  })

  it("ReadableBrand & WritableBrand & ChangefeedBrand → Ref<S>", () => {
    type Result = Resolve<S, ReadableBrand & WritableBrand & ChangefeedBrand>
    expectTypeOf<Result>().toEqualTypeOf<Ref<S>>()
  })

  it("unknown brands → unknown", () => {
    type Result = Resolve<S, unknown>
    expectTypeOf<Result>().toEqualTypeOf<unknown>()
  })

  it("WritableBrand alone (no readable) → unknown", () => {
    type Result = Resolve<S, WritableBrand>
    expectTypeOf<Result>().toEqualTypeOf<unknown>()
  })

  it("ChangefeedBrand alone (no readable or writable) → unknown", () => {
    type Result = Resolve<S, ChangefeedBrand>
    expectTypeOf<Result>().toEqualTypeOf<unknown>()
  })

  it("brand accumulation is order-independent", () => {
    // writable & readable (reversed order) → same as readable & writable
    type WR = Resolve<S, WritableBrand & ReadableBrand>
    type RW = Resolve<S, ReadableBrand & WritableBrand>
    expectTypeOf<WR>().toEqualTypeOf<RW>()
    expectTypeOf<WR>().toEqualTypeOf<RWRef<S>>()

    // changefeed & writable & readable (reversed) → same as canonical order
    type CWR = Resolve<S, ChangefeedBrand & WritableBrand & ReadableBrand>
    type RWC = Resolve<S, ReadableBrand & WritableBrand & ChangefeedBrand>
    expectTypeOf<CWR>().toEqualTypeOf<RWC>()
    expectTypeOf<CWR>().toEqualTypeOf<Ref<S>>()
  })
})

// ===========================================================================
// Fluent builder: .done() inference
// ===========================================================================

describe("type-level: fluent builder .done() infers correct tier", () => {
  const pointSchema = Schema.doc({
    x: Schema.number(),
    y: Schema.number(),
  })

  it(".with(readable).done() → RRef<S>", () => {
    const ctx: RefContext = { store: plainStoreReader({ x: 0, y: 0 }) }
    const result = interpret(pointSchema, ctx).with(readable).done()
    expectTypeOf(result).toEqualTypeOf<RRef<typeof pointSchema>>()
  })

  it(".with(readable).with(writable).done() → RWRef<S>", () => {
    const ctx = plainContext({ x: 0, y: 0 })
    const result = interpret(pointSchema, ctx)
      .with(readable)
      .with(writable)
      .done()
    expectTypeOf(result).toEqualTypeOf<RWRef<typeof pointSchema>>()
  })

  it(".with(readable).with(writable).with(changefeed).done() → Ref<S>", () => {
    const ctx = plainContext({ x: 0, y: 0 })
    const result = interpret(pointSchema, ctx)
      .with(readable)
      .with(writable)
      .with(changefeed)
      .done()
    expectTypeOf(result).toEqualTypeOf<Ref<typeof pointSchema>>()
  })

  it("full-stack result has [TRANSACT] and [CHANGEFEED]", () => {
    const ctx = plainContext({ x: 0, y: 0 })
    const result = interpret(pointSchema, ctx)
      .with(readable)
      .with(writable)
      .with(changefeed)
      .done()
    expectTypeOf(result).toHaveProperty(TRANSACT)
    expectTypeOf(result).toHaveProperty(CHANGEFEED)
  })

  it("read-only result does NOT have .set or [TRANSACT]", () => {
    const ctx: RefContext = { store: plainStoreReader({ x: 0, y: 0 }) }
    const result = interpret(pointSchema, ctx).with(readable).done()
    // RRef<S> = Readable<S> — no mutation, no transact
    type HasSet = typeof result extends { set: any } ? true : false
    expectTypeOf<HasSet>().toEqualTypeOf<false>()
    type HasTx = typeof result extends HasTransact ? true : false
    expectTypeOf<HasTx>().toEqualTypeOf<false>()
  })

  it("custom unbranded layer .done() → unknown", () => {
    const tagging: InterpreterLayer<RefContext, RefContext> = {
      name: "tagging",
      transform(base: Interpreter<RefContext, any>) {
        return base
      },
    }
    const ctx: RefContext = { store: plainStoreReader({ x: 0, y: 0 }) }
    const result = interpret(pointSchema, ctx).with(tagging).done()
    expectTypeOf(result).toEqualTypeOf<unknown>()
  })
})

// ===========================================================================
// ResolveCarrier<S, A> — structural dispatch on carrier capabilities
// ===========================================================================

describe("type-level: ResolveCarrier<S, A> selects the correct tier", () => {
  type S = ProductSchema<{ x: ScalarSchema<"number"> }>

  it("HasRead & HasTransact & HasChangefeed → Ref<S>", () => {
    type Result = ResolveCarrier<S, HasRead & HasTransact & HasChangefeed>
    expectTypeOf<Result>().toEqualTypeOf<Ref<S>>()
  })

  it("HasRead & HasCaching & HasTransact → RWRef<S>", () => {
    type Result = ResolveCarrier<S, HasRead & HasCaching & HasTransact>
    expectTypeOf<Result>().toEqualTypeOf<RWRef<S>>()
  })

  it("HasRead & HasTransact (no changefeed) → RWRef<S>", () => {
    type Result = ResolveCarrier<S, HasRead & HasTransact>
    expectTypeOf<Result>().toEqualTypeOf<RWRef<S>>()
  })

  it("HasCall & HasTransact (no HasRead) → raw A fallback (can't read → not a ref tier)", () => {
    type A = HasCall & HasTransact
    type Result = ResolveCarrier<S, A>
    // HasTransact is present but HasRead is absent — a write-only carrier
    // can't read, so it has no business being typed as RWRef<S> (which
    // promises a call signature returning Plain<S>). Falls through to raw A.
    type IsRWRef = Result extends RWRef<S> ? true : false
    expectTypeOf<IsRWRef>().toEqualTypeOf<false>()
    // Still has HasTransact (preserved from A)
    expectTypeOf<Result>().toMatchTypeOf<HasTransact>()
  })

  it("HasRead & HasCaching (no HasTransact) → raw A fallback (preserves carrier brands)", () => {
    type A = HasRead & HasCaching
    type Result = ResolveCarrier<S, A>
    // Read-only stacks fall through to raw A (preserves carrier brands)
    type IsRWRef = Result extends RWRef<S> ? true : false
    expectTypeOf<IsRWRef>().toEqualTypeOf<false>()
    // Still has HasRead and HasCaching (preserved from A)
    expectTypeOf<Result>().toMatchTypeOf<HasRead>()
    expectTypeOf<Result>().toMatchTypeOf<HasCaching>()
  })
})

// ===========================================================================
// Three-arg interpret: honest transformer return types
// ===========================================================================

describe("type-level: withWritable contributes HasTransact to A", () => {
  it("withWritable return type includes HasTransact", () => {
    const interp = withWritable(
      withCaching(withReadable(withNavigation(bottomInterpreter))),
    )
    // The interpreter's A type should include HasTransact
    expectTypeOf(interp).toMatchTypeOf<
      Interpreter<WritableContext, HasTransact>
    >()
  })

  it("withWritable(bottom) return type includes HasTransact", () => {
    const interp = withWritable(bottomInterpreter)
    expectTypeOf(interp).toMatchTypeOf<
      Interpreter<WritableContext, HasTransact>
    >()
  })
})

describe("type-level: withChangefeed contributes HasChangefeed to A", () => {
  it("withChangefeed return type includes HasChangefeed", () => {
    const interp = withChangefeed(
      withWritable(
        withCaching(withReadable(withNavigation(bottomInterpreter))),
      ),
    )
    expectTypeOf(interp).toMatchTypeOf<Interpreter<RefContext, HasChangefeed>>()
  })

  it("full stack has HasTransact & HasChangefeed in carrier type", () => {
    const interp = withChangefeed(
      withWritable(
        withCaching(withReadable(withNavigation(bottomInterpreter))),
      ),
    )
    expectTypeOf(interp).toMatchTypeOf<
      Interpreter<RefContext, HasTransact & HasChangefeed>
    >()
  })
})

// ===========================================================================
// InterpretBuilder carries schema type and brands
// ===========================================================================

describe("type-level: InterpretBuilder<S, Ctx, Brands>", () => {
  it("two-arg interpret returns InterpretBuilder with schema type", () => {
    const pointSchema = Schema.doc({ x: Schema.number(), y: Schema.number() })
    const ctx: RefContext = { store: plainStoreReader({ x: 0, y: 0 }) }
    const builder = interpret(pointSchema, ctx)
    expectTypeOf(builder).toMatchTypeOf<
      InterpretBuilder<typeof pointSchema, RefContext, unknown>
    >()
  })

  it("field access on inferred builder result is well-typed", () => {
    const docSchema = Schema.doc({ title: Schema.string() })
    const ctx: RefContext = { store: plainStoreReader({ title: "hi" }) }
    const result = interpret(docSchema, ctx).with(readable).done()
    // RRef<S> = Readable<S> — should be callable
    expectTypeOf(result.title).toBeCallableWith()
  })
})

// ===========================================================================
// change() callback inference from fluent-built docs
// ===========================================================================

describe("type-level: change() callback infers draft type from fluent-built doc", () => {
  const docSchema = Schema.doc({
    title: Schema.annotated("text"),
    count: Schema.annotated("counter"),
    items: Schema.list(Schema.struct({ name: Schema.string() })),
    settings: Schema.struct({
      darkMode: Schema.boolean(),
    }),
  })

  it("full-stack .done() result is accepted by change() without cast", () => {
    const ctx = plainContext({
      title: "",
      count: 0,
      items: [],
      settings: { darkMode: false },
    })
    const doc = interpret(docSchema, ctx)
      .with(readable)
      .with(writable)
      .with(changefeed)
      .done()

    // change() should accept doc without any cast — D is inferred as Ref<S>
    expectTypeOf(change).toBeCallableWith(doc, () => {})
  })

  it("callback parameter d has typed field access (not any)", () => {
    const ctx = plainContext({
      title: "",
      count: 0,
      items: [],
      settings: { darkMode: false },
    })
    const doc = interpret(docSchema, ctx)
      .with(readable)
      .with(writable)
      .with(changefeed)
      .done()

    // The callback d should have the same type as doc — verify typed methods exist.
    // If d were `any`, these assertions would vacuously pass, so we also
    // check that a non-existent field is NOT present.
    change(doc, d => {
      expectTypeOf(d.title.insert).toBeFunction()
      expectTypeOf(d.count.increment).toBeFunction()
      expectTypeOf(d.items.push).toBeFunction()
      expectTypeOf(d.settings.darkMode.set).toBeFunction()
      // d should NOT have arbitrary fields — proves it's not `any`
      type HasBogus = typeof d extends { bogusField: any } ? true : false
      expectTypeOf<HasBogus>().toEqualTypeOf<false>()
    })
  })

  it("RWRef .done() result is accepted by change() (has HasTransact)", () => {
    const ctx = plainContext({
      title: "",
      count: 0,
      items: [],
      settings: { darkMode: false },
    })
    const doc = interpret(docSchema, ctx).with(readable).with(writable).done()

    // RWRef<S> has HasTransact — change() should accept it
    expectTypeOf(change).toBeCallableWith(doc, () => {})
  })
})

// ===========================================================================
// Fluent .done() results satisfy facade function signatures
// ===========================================================================

describe("type-level: fluent results are accepted by facade functions", () => {
  const schema = Schema.doc({ x: Schema.number() })

  it("subscribeNode() accepts Ref<S> field from full-stack .done()", () => {
    const ctx = plainContext({ x: 0 })
    const doc = interpret(schema, ctx)
      .with(readable)
      .with(writable)
      .with(changefeed)
      .done()

    // subscribeNode requires HasChangefeed — Ref<S> children have it
    expectTypeOf(subscribeNode).toBeCallableWith(doc.x, () => {})
  })

  it("subscribe() accepts Ref<S> from full-stack .done()", () => {
    const ctx = plainContext({ x: 0 })
    const doc = interpret(schema, ctx)
      .with(readable)
      .with(writable)
      .with(changefeed)
      .done()

    // subscribe requires HasComposedChangefeed on composite refs
    // doc is a product ref — should be accepted
    expectTypeOf(subscribe).toBeCallableWith(doc, () => {})
  })
})

// ===========================================================================
// Sum type resolution — discriminated sums, nullable, positional sums
// ===========================================================================

// Shared schema fixtures for sum type tests
const _discUnionSchema = Schema.discriminatedUnion("type", [
  Schema.struct({ type: Schema.string("text"), body: Schema.string() }),
  Schema.struct({
    type: Schema.string("image"),
    url: Schema.string(),
    caption: Schema.string(),
  }),
])

const _nullableStringSchema = Schema.nullable(Schema.string())

describe("type-level: Ref<S> for discriminated sums (hybrid discriminant)", () => {
  it("Ref<DiscriminatedSumSchema> resolves to union of variant product refs (not unknown)", () => {
    type Result = Ref<typeof _discUnionSchema>
    // Should NOT be unknown — discriminated sums now resolve
    expectTypeOf<Result>().not.toEqualTypeOf<unknown>()
  })

  it("discriminant field is a raw string literal, not a ref", () => {
    type Result = Ref<typeof _discUnionSchema>
    // The .type field should be a plain string literal union, not a ScalarRef
    type TypeField = Result extends { readonly type: infer T } ? T : never
    expectTypeOf<TypeField>().toEqualTypeOf<"text" | "image">()
  })

  it("discriminant field has no .set() — not writable", () => {
    type Result = Ref<typeof _discUnionSchema>
    type TypeField = Result extends { readonly type: infer T } ? T : never
    // A raw string literal has no .set method
    type HasSet = TypeField extends { set: any } ? true : false
    expectTypeOf<HasSet>().toEqualTypeOf<false>()
  })

  it("narrowing via discriminant gives access to variant-specific fields", () => {
    type Result = Ref<typeof _discUnionSchema>
    // Extract the text variant by narrowing on the discriminant
    type TextVariant = Extract<Result, { readonly type: "text" }>
    // body should exist on the text variant and be a ref (not never)
    type BodyField = TextVariant extends { readonly body: infer B } ? B : never
    expectTypeOf<BodyField>().not.toEqualTypeOf<never>()
    // body should be callable (it's a full ref)
    type BodyReturn = BodyField extends (...args: any[]) => infer R ? R : never
    expectTypeOf<BodyReturn>().toEqualTypeOf<string>()
  })

  it("narrowing excludes fields from other variants", () => {
    type Result = Ref<typeof _discUnionSchema>
    type TextVariant = Extract<Result, { readonly type: "text" }>
    // url should NOT exist on the text variant
    type HasUrl = TextVariant extends { readonly url: any } ? true : false
    expectTypeOf<HasUrl>().toEqualTypeOf<false>()
  })

  it("switch exhaustiveness — default: never compiles", () => {
    type Result = Ref<typeof _discUnionSchema>
    // Verify that the discriminant union is exactly "text" | "image"
    // so a switch with both cases + default: never would compile
    type TypeField = Result extends { readonly type: infer T } ? T : never
    type Remaining = Exclude<TypeField, "text" | "image">
    expectTypeOf<Remaining>().toEqualTypeOf<never>()
  })
})

describe("type-level: Ref<S> for nullable sums", () => {
  it("Ref<nullable(string)> has .set(string | null) — not never", () => {
    type Result = Ref<typeof _nullableStringSchema>
    type SetParam = Result extends { set: (value: infer P) => void } ? P : never
    expectTypeOf<SetParam>().toEqualTypeOf<string | null>()
  })

  it("Ref<nullable(string)> call signature returns string | null", () => {
    type Result = Ref<typeof _nullableStringSchema>
    type CallReturn = Result extends (...args: any[]) => infer R ? R : never
    expectTypeOf<CallReturn>().toEqualTypeOf<string | null>()
  })
})

describe("type-level: RRef<S> for discriminated sums (hybrid discriminant)", () => {
  it("RRef<DiscriminatedSumSchema> resolves (not unknown)", () => {
    type Result = RRef<typeof _discUnionSchema>
    expectTypeOf<Result>().not.toEqualTypeOf<unknown>()
  })

  it("RRef discriminant field is a raw string literal", () => {
    type Result = RRef<typeof _discUnionSchema>
    type TypeField = Result extends { readonly type: infer T } ? T : never
    expectTypeOf<TypeField>().toEqualTypeOf<"text" | "image">()
  })

  it("RRef<nullable(string)> call signature returns string | null", () => {
    type Result = RRef<typeof _nullableStringSchema>
    type CallReturn = Result extends (...args: any[]) => infer R ? R : never
    expectTypeOf<CallReturn>().toEqualTypeOf<string | null>()
  })
})

describe("type-level: RWRef<S> for sums", () => {
  it("RWRef<DiscriminatedSumSchema> resolves (not unknown)", () => {
    type Result = RWRef<typeof _discUnionSchema>
    expectTypeOf<Result>().not.toEqualTypeOf<unknown>()
  })

  it("RWRef discriminant field is a raw string literal", () => {
    type Result = RWRef<typeof _discUnionSchema>
    type TypeField = Result extends { readonly type: infer T } ? T : never
    expectTypeOf<TypeField>().toEqualTypeOf<"text" | "image">()
  })

  it("RWRef<nullable(string)> has .set(string | null) — not never", () => {
    type Result = RWRef<typeof _nullableStringSchema>
    type SetParam = Result extends { set: (value: infer P) => void } ? P : never
    expectTypeOf<SetParam>().toEqualTypeOf<string | null>()
  })
})

describe("type-level: Writable<S> for sums", () => {
  it("Writable<nullable(string)> has .set(string | null)", () => {
    type Result = Writable<typeof _nullableStringSchema>
    type SetParam = Result extends { set: (value: infer P) => void } ? P : never
    expectTypeOf<SetParam>().toEqualTypeOf<string | null>()
  })

  it("Writable<DiscriminatedSumSchema> resolves (not unknown)", () => {
    type Result = Writable<typeof _discUnionSchema>
    expectTypeOf<Result>().not.toEqualTypeOf<unknown>()
  })

  it("Writable discriminant field is a raw string literal, not a ScalarRef", () => {
    type Result = Writable<typeof _discUnionSchema>
    type TypeField = Result extends { readonly type: infer T } ? T : never
    expectTypeOf<TypeField>().toEqualTypeOf<"text" | "image">()
  })
})

describe("type-level: general positional sums must NOT collapse (collapse boundary)", () => {
  it("Ref<union(string, number)> distributes — not a single collapsed ref", () => {
    const unionSchema = Schema.union(Schema.string(), Schema.number())
    type Result = Ref<typeof unionSchema>
    // Should distribute: SchemaRef<string> | SchemaRef<number>
    // Each arm has its own .set() — the union of .set(string) | .set(number)
    // does NOT collapse into .set(string | number)
    type SetParam = Result extends { set: (value: infer P) => void } ? P : never
    // Contravariant parameter intersection: string & number = never
    // This confirms distribution happened (NOT collapsed like nullable)
    expectTypeOf<SetParam>().toEqualTypeOf<never>()
  })

  it("Writable<union(string, number)> resolves (not unknown) and distributes", () => {
    const unionSchema = Schema.union(Schema.string(), Schema.number())
    type Result = Writable<typeof unionSchema>
    // Should NOT be unknown — was unknown before the fix
    expectTypeOf<Result>().not.toEqualTypeOf<unknown>()
    // Should distribute: ScalarRef<string> | ScalarRef<number>
    type SetParam = Result extends { set: (value: infer P) => void } ? P : never
    // Contravariant intersection confirms distribution
    expectTypeOf<SetParam>().toEqualTypeOf<never>()
  })
})

describe("type-level: nullable composite — inner is a product, not a scalar", () => {
  const nullableStructSchema = Schema.nullable(
    Schema.struct({
      x: Schema.string(),
    }),
  )

  it("Ref<nullable(struct({ x: string() }))> call returns { x: string } | null", () => {
    type Result = Ref<typeof nullableStructSchema>
    type CallReturn = Result extends (...args: any[]) => infer R ? R : never
    expectTypeOf<CallReturn>().toEqualTypeOf<{ x: string } | null>()
  })

  it("Ref<nullable(struct({ x: string() }))> has .set({ x: string } | null)", () => {
    type Result = Ref<typeof nullableStructSchema>
    type SetParam = Result extends { set: (value: infer P) => void } ? P : never
    expectTypeOf<SetParam>().toEqualTypeOf<{ x: string } | null>()
  })
})

describe("type-level: sums nested inside products (composition)", () => {
  it("Ref<struct({ bio: nullable(string) })> — .bio has .set(string | null)", () => {
    const s = Schema.struct({
      bio: Schema.nullable(Schema.string()),
    })
    type Doc = Ref<typeof s>
    type Bio = Doc["bio"]
    type SetParam = Bio extends { set: (value: infer P) => void } ? P : never
    expectTypeOf<SetParam>().toEqualTypeOf<string | null>()
  })

  it("Ref<doc({ content: discriminatedUnion(...) })> — .content narrows via discriminant", () => {
    const s = Schema.doc({
      content: Schema.discriminatedUnion("type", [
        Schema.struct({ type: Schema.string("text"), body: Schema.string() }),
        Schema.struct({ type: Schema.string("image"), url: Schema.string() }),
      ]),
    })
    type Doc = Ref<typeof s>
    type Content = Doc["content"]
    expectTypeOf<Content>().not.toEqualTypeOf<unknown>()
    // Discriminant is a raw literal, enabling standard TS narrowing
    type TypeField = Content extends { readonly type: infer T } ? T : never
    expectTypeOf<TypeField>().toEqualTypeOf<"text" | "image">()
  })
})

describe("type-level: Plain<S> regression guards for sums", () => {
  it("Plain<nullable(string)> = string | null", () => {
    type Result = Plain<typeof _nullableStringSchema>
    expectTypeOf<Result>().toEqualTypeOf<string | null>()
  })

  it("Plain<DiscriminatedSumSchema> = union of variant plain types", () => {
    type Result = Plain<typeof _discUnionSchema>
    // Should be the union of the two variant product plains
    type Expected =
      | { type: "text"; body: string }
      | { type: "image"; url: string; caption: string }
    expectTypeOf<Result>().toEqualTypeOf<Expected>()
  })
})

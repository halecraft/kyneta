import { CHANGEFEED, type HasChangefeed } from "@kyneta/changefeed"
import { describe, expect, expectTypeOf, it } from "vitest"
import type { ReplaceChange } from "../change.js"
import { own, replaceChange, trustAsOwned } from "../change.js"
import {
  BACKING_DOC,
  batch,
  type CounterSchema,
  type ExtractLaws,
  KIND,
  type MapSchema,
  MIGRATION_CHAIN,
  type MovableSequenceSchema,
  type NavigableMapRef,
  type NavigableSequenceRef,
  type Plain,
  type PlainDiscriminatedSumSchema,
  type PlainMapSchema,
  type PlainPositionalSumSchema,
  type PlainProductSchema,
  type PlainSchema,
  type PlainSequenceSchema,
  type ProductSchema,
  type Readable,
  type ReadableMapRef,
  type ReadableSequenceRef,
  type Ref,
  type RestrictLaws,
  type RRef,
  type ScalarPlain,
  type ScalarSchema,
  Schema,
  type SchemaNode,
  type SequenceRef,
  type SequenceSchema,
  subscribe,
  subscribeNode,
  type TextSchema,
  TRANSACT,
  type TreeSchema,
  type Wrap,
} from "../index.js"
import type { DeepReadonly } from "./deep-readonly.js"
import { contextOver, refOver } from "./stack.js"

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

describe("type-level: first-class type KIND literal preservation", () => {
  it("Schema.struct() → KIND is literal 'product'", () => {
    const s = Schema.struct({ title: Schema.string() })
    expectTypeOf(s[KIND]).toEqualTypeOf<"product">()
  })

  it("Schema.text() → KIND is literal 'text'", () => {
    const s = Schema.text()
    expectTypeOf(s[KIND]).toEqualTypeOf<"text">()
  })

  it("Schema.counter() → KIND is literal 'counter'", () => {
    const s = Schema.counter()
    expectTypeOf(s[KIND]).toEqualTypeOf<"counter">()
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
    expectTypeOf(s.fields.name[KIND]).toEqualTypeOf<"scalar">()
    expectTypeOf(s.fields.age[KIND]).toEqualTypeOf<"scalar">()
  })

  it("Schema.struct fields preserve specific schema subtypes", () => {
    const s = Schema.struct({
      title: Schema.string(),
      count: Schema.number(),
      tags: Schema.list(Schema.string()),
    })

    // Each field should be its specific schema subtype
    expectTypeOf(s.fields.title[KIND]).toEqualTypeOf<"scalar">()
    expectTypeOf(s.fields.count[KIND]).toEqualTypeOf<"scalar">()
    expectTypeOf(s.fields.tags[KIND]).toEqualTypeOf<"sequence">()
  })

  it("Schema.product does NOT allow access to non-existent field keys", () => {
    const s = Schema.product({
      name: Schema.scalar("string"),
    })

    // @ts-expect-error — 'nonexistent' should not be a valid key
    s.fields.nonexistent
  })

  it("Schema.struct preserves field types directly", () => {
    const s = Schema.struct({
      title: Schema.string(),
      items: Schema.list(Schema.string()),
    })

    // Fields should be directly accessible on the struct
    expectTypeOf(s.fields).toHaveProperty("title")
    expectTypeOf(s.fields).toHaveProperty("items")
  })
})

describe("type-level: sequence and map item type preservation", () => {
  it("Schema.sequence item is the exact subtype, not just Schema", () => {
    const s = Schema.sequence(Schema.scalar("string"))
    expectTypeOf(s.item[KIND]).toEqualTypeOf<"scalar">()
  })

  it("Schema.list item preserves the inner struct type", () => {
    const s = Schema.list(
      Schema.struct({
        name: Schema.string(),
        active: Schema.boolean(),
      }),
    )
    // item should be ProductSchema (or narrower), not just Schema
    expectTypeOf(s.item[KIND]).toEqualTypeOf<"product">()
  })

  it("Schema.map item is the exact subtype, not just Schema", () => {
    const s = Schema.map(Schema.scalar("number"))
    expectTypeOf(s.item[KIND]).toEqualTypeOf<"scalar">()
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
        ProductSchema<
          {
            type: ScalarSchema<"string", string>
            content: ScalarSchema<"string", string>
          },
          "lww-per-key" | "lww"
        >,
        ProductSchema<
          {
            type: ScalarSchema<"string", string>
            url: ScalarSchema<"string", string>
          },
          "lww-per-key" | "lww"
        >,
      ]
    >()
    // variantMap is derived at runtime — typed as Record<string, PlainProductSchema>
    expectTypeOf(s.variantMap).toEqualTypeOf<
      Readonly<Record<string, PlainProductSchema>>
    >()
  })
})

describe("type-level: nested composition preserves types end-to-end", () => {
  it("a full struct schema preserves types through multiple levels of nesting", () => {
    const s = Schema.struct({
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

    // Top-level: product
    expectTypeOf(s[KIND]).toEqualTypeOf<"product">()

    // Fields should be typed
    const title = s.fields.title
    expectTypeOf(title[KIND]).toEqualTypeOf<"scalar">()

    const messages = s.fields.messages
    expectTypeOf(messages[KIND]).toEqualTypeOf<"sequence">()

    const settings = s.fields.settings
    expectTypeOf(settings[KIND]).toEqualTypeOf<"product">()

    const metadata = s.fields.metadata
    expectTypeOf(metadata[KIND]).toEqualTypeOf<"map">()
  })
})

// ---------------------------------------------------------------------------
// ScalarPlain — scalar kinds to TypeScript types
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
    expectTypeOf<Result>().toEqualTypeOf<
      DeepReadonly<{
        name: string
        active: boolean
      }>
    >()
  })

  it("Plain<struct with scalars> maps to plain types", () => {
    const s = Schema.struct({
      title: Schema.string(),
      count: Schema.number(),
    })
    type Result = Plain<typeof s>
    expectTypeOf<Result>().toEqualTypeOf<
      DeepReadonly<{
        title: string
        count: number
      }>
    >()
  })
})

describe("type-level: Plain<S> for sequences", () => {
  it("Plain<list(string())> = string[]", () => {
    const s = Schema.list(Schema.string())
    type Result = Plain<typeof s>
    expectTypeOf<Result>().toEqualTypeOf<DeepReadonly<string[]>>()
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
      DeepReadonly<{ name: string; body: string }[]>
    >()
  })
})

describe("type-level: Plain<S> for maps", () => {
  it("Plain<record(plain.number())> = { [key: string]: number }", () => {
    const s = Schema.record(Schema.number())
    type Result = Plain<typeof s>
    expectTypeOf<Result>().toEqualTypeOf<
      DeepReadonly<{ [key: string]: number }>
    >()
  })

  it("Plain<record(plain.any())> = { [key: string]: unknown }", () => {
    const s = Schema.record(Schema.any())
    type Result = Plain<typeof s>
    expectTypeOf<Result>().toEqualTypeOf<
      DeepReadonly<{ [key: string]: unknown }>
    >()
  })
})

describe("type-level: Plain<S> for struct", () => {
  it("Plain<struct({...})> maps the inner product", () => {
    const s = Schema.struct({
      title: Schema.string(),
      count: Schema.number(),
      settings: Schema.struct({
        darkMode: Schema.boolean(),
        fontSize: Schema.number(),
      }),
    })
    type Result = Plain<typeof s>
    expectTypeOf<Result>().toEqualTypeOf<
      DeepReadonly<{
        title: string
        count: number
        settings: {
          darkMode: boolean
          fontSize: number
        }
      }>
    >()
  })
})

describe("type-level: Plain<S> end-to-end structural schema", () => {
  it("a pure structural schema produces fully typed plain object", () => {
    const docSchema = Schema.struct({
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
      DeepReadonly<{ author: string; body: string }[]>
    >()

    // Nested struct → typed object
    expectTypeOf<Doc["settings"]>().toEqualTypeOf<
      DeepReadonly<{
        darkMode: boolean
        fontSize: number
      }>
    >()

    // Record (dynamic keys)
    expectTypeOf<Doc["metadata"]>().toEqualTypeOf<
      DeepReadonly<{
        [key: string]: unknown
      }>
    >()
  })
})

// ===========================================================================
// Annotation tests — annotation-specific types
// ===========================================================================

describe("type-level: first-class type KIND preservation", () => {
  it("Schema.text() → KIND is literal 'text'", () => {
    const s = Schema.text()
    expectTypeOf(s[KIND]).toEqualTypeOf<"text">()
  })

  it("Schema.counter() → KIND is literal 'counter'", () => {
    const s = Schema.counter()
    expectTypeOf(s[KIND]).toEqualTypeOf<"counter">()
  })

  it("Schema.movableList() → KIND is literal 'movable'", () => {
    const s = Schema.movableList(Schema.string())
    expectTypeOf(s[KIND]).toEqualTypeOf<"movable">()
  })

  it("Schema.tree() → KIND is literal 'tree'", () => {
    const s = Schema.tree(Schema.struct({ label: Schema.string() }))
    expectTypeOf(s[KIND]).toEqualTypeOf<"tree">()
  })
})

describe("type-level: Plain<S> for first-class types", () => {
  it("Plain<text()> = string", () => {
    const s = Schema.text()
    type Result = Plain<typeof s>
    expectTypeOf<Result>().toEqualTypeOf<string>()
  })

  it("Plain<counter()> = number", () => {
    const s = Schema.counter()
    type Result = Plain<typeof s>
    expectTypeOf<Result>().toEqualTypeOf<number>()
  })
})

describe("type-level: Plain<S> for movable list", () => {
  it("Plain<movableList(string())> = string[]", () => {
    const s = Schema.movableList(Schema.string())
    type Result = Plain<typeof s>
    expectTypeOf<Result>().toEqualTypeOf<DeepReadonly<string[]>>()
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
      DeepReadonly<{ id: number; label: string }[]>
    >()
  })
})

describe("type-level: Plain<S> end-to-end schema with first-class types", () => {
  it("a schema with first-class types produces fully typed plain object", () => {
    const loroDoc = Schema.struct({
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

    type Doc = Plain<typeof loroDoc>

    expectTypeOf<Doc["title"]>().toEqualTypeOf<string>()
    expectTypeOf<Doc["count"]>().toEqualTypeOf<number>()

    expectTypeOf<Doc["messages"]>().toEqualTypeOf<
      DeepReadonly<{ author: string; body: string }[]>
    >()

    expectTypeOf<Doc["settings"]>().toEqualTypeOf<
      DeepReadonly<{
        darkMode: boolean
        fontSize: number
      }>
    >()

    expectTypeOf<Doc["metadata"]>().toEqualTypeOf<
      DeepReadonly<{
        [key: string]: unknown
      }>
    >()
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
    expectTypeOf<Result>().toEqualTypeOf<
      DeepReadonly<{
        visibility: "public" | "private"
        count: number
      }>
    >()
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
    expectTypeOf(s[KIND]).toEqualTypeOf<"scalar">()
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

describe("type-level: PlainSchema rejects first-class CRDT types", () => {
  it("TextSchema does NOT extend PlainSchema", () => {
    expectTypeOf<TextSchema>().not.toMatchTypeOf<PlainSchema>()
  })

  it("CounterSchema does NOT extend PlainSchema", () => {
    expectTypeOf<CounterSchema>().not.toMatchTypeOf<PlainSchema>()
  })

  it("MovableSequenceSchema does NOT extend PlainSchema", () => {
    expectTypeOf<
      MovableSequenceSchema<ScalarSchema<"string">>
    >().not.toMatchTypeOf<PlainSchema>()
  })

  it("TreeSchema does NOT extend PlainSchema", () => {
    expectTypeOf<TreeSchema<ProductSchema>>().not.toMatchTypeOf<PlainSchema>()
  })

  it("ProductSchema containing TextSchema does NOT extend PlainProductSchema", () => {
    type Bad = ProductSchema<{ x: TextSchema }>
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

describe("type-level: Ref<S> for struct with text", () => {
  it("Ref<struct({ title: text() })> — .title has .insert() AND () call", () => {
    const s = Schema.struct({
      title: Schema.text(),
      count: Schema.counter(),
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
  it("full schema produces unified type with read + write + transact", () => {
    const docSchema = Schema.struct({
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

// ===========================================================================
// Ref tiers: RRef, Ref
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

  it("Ref<struct> with text field — child text ref has [CHANGEFEED]", () => {
    const s = Schema.struct({
      title: Schema.text(),
      count: Schema.counter(),
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

describe("type-level: Wrap<T> adds every ref's cross-cutting concerns", () => {
  it("Wrap<T> has HasTransact AND HasChangefeed", () => {
    type Base = { x: number }
    type Result = Wrap<Base>
    expectTypeOf<Result>().toHaveProperty("x")
    expectTypeOf<Result>().toHaveProperty(TRANSACT)
    expectTypeOf<Result>().toHaveProperty(CHANGEFEED)
  })
})

// ===========================================================================
// batch() callback inference from fluent-built docs
// ===========================================================================

describe("type-level: batch() callback infers draft type from a doc", () => {
  const docSchema = Schema.struct({
    title: Schema.text(),
    count: Schema.counter(),
    items: Schema.list(Schema.struct({ name: Schema.string() })),
    settings: Schema.struct({
      darkMode: Schema.boolean(),
    }),
  })

  it("a doc is accepted by batch() without cast", () => {
    const ctx = contextOver(docSchema, {
      title: "",
      count: 0,
      items: [],
      settings: { darkMode: false },
    })
    const doc = refOver(docSchema, ctx)

    // batch() should accept doc without any cast — D is inferred as Ref<S>
    expectTypeOf(batch).toBeCallableWith(doc, () => {})
  })

  it("callback parameter d has typed field access (not any)", () => {
    const ctx = contextOver(docSchema, {
      title: "",
      count: 0,
      items: [],
      settings: { darkMode: false },
    })
    const doc = refOver(docSchema, ctx)

    // The callback d should have the same type as doc — verify typed methods exist.
    // If d were `any`, these assertions would vacuously pass, so we also
    // check that a non-existent field is NOT present.
    batch(doc, d => {
      expectTypeOf(d.title.insert).toBeFunction()
      expectTypeOf(d.count.increment).toBeFunction()
      expectTypeOf(d.items.push).toBeFunction()
      expectTypeOf(d.settings.darkMode.set).toBeFunction()
      // d should NOT have arbitrary fields — proves it's not `any`
      type HasBogus = typeof d extends { bogusField: any } ? true : false
      expectTypeOf<HasBogus>().toEqualTypeOf<false>()
    })
  })
})

// ===========================================================================
// Refs satisfy facade function signatures
// ===========================================================================

describe("type-level: refs are accepted by facade functions", () => {
  const schema = Schema.struct({ x: Schema.number() })

  it("subscribeNode() accepts a Ref<S> field", () => {
    const ctx = contextOver(schema, { x: 0 })
    const doc = refOver(schema, ctx)

    // subscribeNode requires HasChangefeed — Ref<S> children have it
    expectTypeOf(subscribeNode).toBeCallableWith(doc.x, () => {})
  })

  it("subscribe() accepts a Ref<S>", () => {
    const ctx = contextOver(schema, { x: 0 })
    const doc = refOver(schema, ctx)

    // subscribe accepts any schema-issued ref (HasRecursiveChangefeed).
    // Composites first: doc is a product ref.
    expectTypeOf(subscribe).toBeCallableWith(doc, () => {})
    // Leaves now also satisfy the contract — subscribeDescendants is the
    // trivial own-path lift, a leaf is a tree of size 1.
    expectTypeOf(subscribe).toBeCallableWith(doc.x, () => {})
  })
})

// ===========================================================================
// Sum type resolution — discriminated sums, nullable, positional sums
// ===========================================================================

// Shared schema fixtures for sum type tests
const _discUnionSchema = Schema.discriminatedUnion("type", [
  Schema.struct({
    type: Schema.string("text" as const),
    body: Schema.string(),
  }),
  Schema.struct({
    type: Schema.string("image" as const),
    url: Schema.string(),
    caption: Schema.string(),
  }),
])

const _nullableStringSchema = Schema.string().nullable()

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
    // Extract the "text" variant — note: the discriminant value collides with
    // the schema kind "text" in naming only. Here "text" is a discriminant string.
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

  it("non-discriminant field has NO .set() — sum interiors are read-only", () => {
    type Result = Ref<typeof _discUnionSchema>
    type TextVariant = Extract<Result, { readonly type: "text" }>
    type BodyField = TextVariant extends { readonly body: infer B } ? B : never
    type HasSet = BodyField extends { set: any } ? true : false
    expectTypeOf<HasSet>().toEqualTypeOf<false>()
  })

  it("union ref itself has .set() for whole-value replacement", () => {
    type Result = Ref<typeof _discUnionSchema>
    type HasSet = Result extends { set: (value: infer P) => void } ? P : never
    expectTypeOf<HasSet>().not.toEqualTypeOf<never>()
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
})

describe("type-level: nullable composite — inner is a product, not a scalar", () => {
  const nullableStructSchema = Schema.struct({
    x: Schema.string(),
  }).nullable()

  it("Ref<nullable(struct({ x: string() }))> call returns { x: string } | null", () => {
    type Result = Ref<typeof nullableStructSchema>
    type CallReturn = Result extends (...args: any[]) => infer R ? R : never
    expectTypeOf<CallReturn>().toEqualTypeOf<
      DeepReadonly<{ x: string } | null>
    >()
  })

  it("Ref<nullable(struct({ x: string() }))> has .set({ x: string } | null)", () => {
    type Result = Ref<typeof nullableStructSchema>
    type SetParam = Result extends { set: (value: infer P) => void } ? P : never
    expectTypeOf<SetParam>().toEqualTypeOf<DeepReadonly<{ x: string } | null>>()
  })
})

describe("type-level: sums nested inside products (composition)", () => {
  it("Ref<struct({ bio: nullable(string) })> — .bio has .set(string | null)", () => {
    const s = Schema.struct({
      bio: Schema.string().nullable(),
    })
    type Doc = Ref<typeof s>
    type Bio = Doc["bio"]
    type SetParam = Bio extends { set: (value: infer P) => void } ? P : never
    expectTypeOf<SetParam>().toEqualTypeOf<string | null>()
  })

  it("Ref<struct({ content: discriminatedUnion(...) })> — .content narrows via discriminant", () => {
    const s = Schema.struct({
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
    expectTypeOf<Result>().toEqualTypeOf<DeepReadonly<Expected>>()
  })
})

// ===========================================================================
// [KIND] serialization invisibility (Task 1.7)
// ===========================================================================

describe("[KIND] is invisible to serialization", () => {
  it("JSON.stringify does not include KIND", () => {
    const s = Schema.string()
    const json = JSON.stringify(s)
    expect(json).not.toContain("kyneta:kind")
    // Symbol keys are invisible to JSON.stringify — only data properties survive
    expect(JSON.parse(json)).toEqual({ scalarKind: "string" })
  })

  it("Object.keys does not include KIND", () => {
    const s = Schema.string()
    expect(Object.keys(s)).not.toContain(KIND.toString())
    expect(Object.keys(s)).not.toContain("Symbol(kyneta:kind)")
    expect(Object.keys(s)).toEqual(["scalarKind"])
  })

  // Cross-copy hardening — Symbol.for guarantees a single global identity for
  // `KIND` even if @kyneta/schema is dual-loaded (monorepo hoisting, ESM/CJS
  // interop). A regression to bare `Symbol(...)` would break every
  // `schema[KIND]` switch across module-copy boundaries silently.
  it("KIND, MIGRATION_CHAIN, BACKING_DOC use Symbol.for", () => {
    expect(KIND).toBe(Symbol.for("kyneta:kind"))
    expect(MIGRATION_CHAIN).toBe(Symbol.for("kyneta:migrationChain"))
    expect(BACKING_DOC).toBe(Symbol.for("kyneta:backingDoc"))
  })

  it("schema[KIND] is accessible and correctly valued", () => {
    expect(Schema.string()[KIND]).toBe("scalar")
    expect(Schema.struct({ x: Schema.string() })[KIND]).toBe("product")
    expect(Schema.list(Schema.string())[KIND]).toBe("sequence")
    expect(Schema.record(Schema.string())[KIND]).toBe("map")
    expect(Schema.union(Schema.string(), Schema.number())[KIND]).toBe("sum")
    expect(Schema.text()[KIND]).toBe("text")
    expect(Schema.counter()[KIND]).toBe("counter")
  })

  it("spread preserves [KIND]", () => {
    const s = Schema.string()
    const copy = { ...s }
    expect(copy[KIND]).toBe("scalar")
  })
})

// ===========================================================================
// [LAWS] phantom law accumulation
// ===========================================================================

describe("ExtractLaws: law accumulation through constructors", () => {
  it("scalars emit 'lww'", () => {
    type StringLaws = ExtractLaws<ReturnType<typeof Schema.string>>
    type NumberLaws = ExtractLaws<ReturnType<typeof Schema.number>>
    expectTypeOf<StringLaws>().toEqualTypeOf<"lww">()
    expectTypeOf<NumberLaws>().toEqualTypeOf<"lww">()
  })

  it("text() → 'positional-ot'", () => {
    const s = Schema.text()
    type Laws = ExtractLaws<typeof s>
    expectTypeOf<Laws>().toEqualTypeOf<"positional-ot">()
  })

  it("counter() → 'additive'", () => {
    const s = Schema.counter()
    type Laws = ExtractLaws<typeof s>
    expectTypeOf<Laws>().toEqualTypeOf<"additive">()
  })

  it("movableList(string) → 'positional-ot-move' | 'lww'", () => {
    const s = Schema.movableList(Schema.string())
    type Laws = ExtractLaws<typeof s>
    expectTypeOf<Laws>().toEqualTypeOf<"positional-ot-move" | "lww">()
  })

  it("tree(struct) → 'tree-move' | 'lww-per-key' | 'lww'", () => {
    const s = Schema.tree(Schema.struct({ label: Schema.string() }))
    type Laws = ExtractLaws<typeof s>
    expectTypeOf<Laws>().toEqualTypeOf<"tree-move" | "lww-per-key" | "lww">()
  })

  it("struct({ name: string }) → 'lww-per-key' | 'lww'", () => {
    const s = Schema.struct({ name: Schema.string() })
    type Laws = ExtractLaws<typeof s>
    expectTypeOf<Laws>().toEqualTypeOf<"lww-per-key" | "lww">()
  })

  it("struct({ title: text }) → 'lww-per-key' | 'positional-ot'", () => {
    const s = Schema.struct({ title: Schema.text() })
    type Laws = ExtractLaws<typeof s>
    expectTypeOf<Laws>().toEqualTypeOf<"lww-per-key" | "positional-ot">()
  })

  it("struct({ title: text, count: counter }) → 'lww-per-key' | 'positional-ot' | 'additive'", () => {
    const s = Schema.struct({
      title: Schema.text(),
      count: Schema.counter(),
    })
    type Laws = ExtractLaws<typeof s>
    expectTypeOf<Laws>().toEqualTypeOf<
      "lww-per-key" | "positional-ot" | "additive"
    >()
  })

  it("list(struct({ title: text })) → 'positional-ot' | 'lww-per-key'", () => {
    const s = Schema.list(Schema.struct({ title: Schema.text() }))
    type Laws = ExtractLaws<typeof s>
    expectTypeOf<Laws>().toEqualTypeOf<"positional-ot" | "lww-per-key">()
  })

  it("record(struct({ hits: counter })) → 'lww-per-key' | 'additive'", () => {
    const s = Schema.record(Schema.struct({ hits: Schema.counter() }))
    type Laws = ExtractLaws<typeof s>
    expectTypeOf<Laws>().toEqualTypeOf<"lww-per-key" | "additive">()
  })

  it("struct({ title: text }) → 'lww-per-key' | 'positional-ot'", () => {
    const s = Schema.struct({ title: Schema.text() })
    type Laws = ExtractLaws<typeof s>
    expectTypeOf<Laws>().toEqualTypeOf<"lww-per-key" | "positional-ot">()
  })

  it("struct({ count: counter }) → 'lww-per-key' | 'additive'", () => {
    const s = Schema.struct({ count: Schema.counter() })
    type Laws = ExtractLaws<typeof s>
    expectTypeOf<Laws>().toEqualTypeOf<"lww-per-key" | "additive">()
  })

  it("struct({ title: text, items: list(struct({ name: string, done: boolean })) }) → 'lww-per-key' | 'positional-ot' | 'lww'", () => {
    const s = Schema.struct({
      title: Schema.text(),
      items: Schema.list(
        Schema.struct({
          name: Schema.string(),
          done: Schema.boolean(),
        }),
      ),
    })
    type Laws = ExtractLaws<typeof s>
    expectTypeOf<Laws>().toEqualTypeOf<
      "lww-per-key" | "positional-ot" | "lww"
    >()
  })

  it("deep nesting: struct > list > struct > record > struct > counter (5 levels) → 'lww-per-key' | 'positional-ot' | 'additive'", () => {
    const s = Schema.struct({
      channels: Schema.list(
        Schema.struct({
          meta: Schema.record(
            Schema.struct({
              hits: Schema.counter(),
            }),
          ),
        }),
      ),
    })
    type Laws = ExtractLaws<typeof s>
    expectTypeOf<Laws>().toEqualTypeOf<
      "lww-per-key" | "positional-ot" | "additive"
    >()
  })

  it("struct with movableList(text) → 'lww-per-key' | 'positional-ot-move' | 'positional-ot'", () => {
    const s = Schema.struct({
      items: Schema.movableList(Schema.text()),
    })
    type Laws = ExtractLaws<typeof s>
    expectTypeOf<Laws>().toEqualTypeOf<
      "lww-per-key" | "positional-ot-move" | "positional-ot"
    >()
  })

  it("struct with tree(struct) → 'lww-per-key' | 'tree-move' | 'lww'", () => {
    const s = Schema.struct({
      hierarchy: Schema.tree(Schema.struct({ label: Schema.string() })),
    })
    type Laws = ExtractLaws<typeof s>
    expectTypeOf<Laws>().toEqualTypeOf<"lww-per-key" | "tree-move" | "lww">()
  })

  it("struct with counter → 'lww-per-key' | 'additive'", () => {
    const s = Schema.struct({
      count: Schema.counter(),
    })
    type Laws = ExtractLaws<typeof s>
    expectTypeOf<Laws>().toEqualTypeOf<"lww-per-key" | "additive">()
  })

  it("struct with text → 'lww-per-key' | 'positional-ot'", () => {
    const s = Schema.struct({
      title: Schema.text(),
    })
    type Laws = ExtractLaws<typeof s>
    expectTypeOf<Laws>().toEqualTypeOf<"lww-per-key" | "positional-ot">()
  })

  it("struct with text and counter → 'lww-per-key' | 'positional-ot' | 'additive'", () => {
    const s = Schema.struct({
      title: Schema.text(),
      count: Schema.counter(),
    })
    type Laws = ExtractLaws<typeof s>
    expectTypeOf<Laws>().toEqualTypeOf<
      "lww-per-key" | "positional-ot" | "additive"
    >()
  })

  it("struct with text in discriminatedUnion → laws from all variants", () => {
    const s = Schema.struct({
      content: Schema.discriminatedUnion("type", [
        Schema.struct({
          type: Schema.string("article" as const),
          body: Schema.string(),
        }),
        Schema.struct({
          type: Schema.string("data" as const),
          value: Schema.number(),
        }),
      ]),
      title: Schema.text(),
    })
    type Laws = ExtractLaws<typeof s>
    expectTypeOf<Laws>().toEqualTypeOf<
      "lww-per-key" | "lww-tag-replaced" | "lww" | "positional-ot"
    >()
  })
})

describe("ExtractLaws: laws survive generic constraints", () => {
  it("laws survive Record<string, Schema> boundary via product", () => {
    // This is the critical test: when fields flow through
    // F extends Record<string, Schema>, do laws survive?
    function makeStruct<F extends Record<string, SchemaNode>>(
      fields: F,
    ): ProductSchema<F, ExtractLaws<F[keyof F]>> {
      return Schema.struct(fields) as any
    }
    const s = makeStruct({
      title: Schema.text(),
      count: Schema.counter(),
    })
    type Laws = ExtractLaws<typeof s>
    expectTypeOf<Laws>().toEqualTypeOf<"positional-ot" | "additive">()
  })

  it("never exclusion → always false (never is excluded from any union)", () => {
    const s = Schema.struct({ count: Schema.counter() })
    type Laws = ExtractLaws<typeof s>
    // Exclude nothing → everything remains
    type Remaining = Exclude<Laws, never>
    expectTypeOf<Remaining>().toEqualTypeOf<"lww-per-key" | "additive">()
  })
})

describe("RestrictLaws: allowed-laws formulation", () => {
  it("RestrictLaws<S, string> always resolves to S (unconstrained substrates)", () => {
    const s = Schema.struct({
      title: Schema.text(),
      count: Schema.counter(),
      tasks: Schema.movableList(Schema.string()),
      hierarchy: Schema.tree(Schema.struct({ label: Schema.string() })),
    })
    // AllowedLaws = string means Exclude<T, string> is always never
    type Result = RestrictLaws<typeof s, string>
    expectTypeOf<Result>().toEqualTypeOf(s)
  })

  it("RestrictLaws resolves to never when laws exceed allowed set", () => {
    const s = Schema.struct({ count: Schema.counter() })
    type Result = RestrictLaws<typeof s, "positional-ot">
    expectTypeOf<Result>().toEqualTypeOf<never>()
  })
})

// ===========================================================================
// Schema.struct.json / Schema.list.json / Schema.record.json — PlainSchema constraint
// ===========================================================================

describe("type-level: .json() constructors enforce PlainSchema constraint", () => {
  it("struct.json accepts plain scalars", () => {
    const s = Schema.struct.json({
      name: Schema.string(),
      count: Schema.number(),
      active: Schema.boolean(),
    })
    expectTypeOf(s).toMatchTypeOf<ProductSchema>()
    expectTypeOf(s).toMatchTypeOf<SchemaNode>()
  })

  it("struct.json accepts nested plain struct", () => {
    const inner = Schema.struct.json({ x: Schema.string() })
    const outer = Schema.struct.json({ nested: inner })
    expectTypeOf(outer).toMatchTypeOf<ProductSchema>()
  })

  it("record.json accepts plain schema item", () => {
    const s = Schema.record.json(Schema.string())
    expectTypeOf(s).toMatchTypeOf<SchemaNode>()
  })

  it("list.json accepts plain schema item", () => {
    const s = Schema.list.json(Schema.number())
    expectTypeOf(s).toMatchTypeOf<SequenceSchema>()
  })

  it("struct.json rejects TextSchema", () => {
    // @ts-expect-error — TextSchema does not extend PlainSchema
    Schema.struct.json({ title: Schema.text() })
  })

  it("struct.json rejects CounterSchema", () => {
    // @ts-expect-error — CounterSchema does not extend PlainSchema
    Schema.struct.json({ count: Schema.counter() })
  })

  it("list.json rejects TextSchema", () => {
    // @ts-expect-error — TextSchema does not extend PlainSchema
    Schema.list.json(Schema.text())
  })

  it("record.json rejects TextSchema", () => {
    // @ts-expect-error — TextSchema does not extend PlainSchema
    Schema.record.json(Schema.text())
  })

  it("struct.json rejects nested first-class type via sequence", () => {
    // @ts-expect-error — SequenceSchema<TextSchema> does not extend PlainSchema
    Schema.struct.json({ items: Schema.list(Schema.text()) })
  })

  it("nested .json() composition is accepted", () => {
    const s = Schema.struct.json({
      x: Schema.struct.json({ y: Schema.string() }),
    })
    expectTypeOf(s).toMatchTypeOf<ProductSchema>()
  })
})

// ===========================================================================
// Owned — the change constructors require an owned payload
// ===========================================================================

describe("type-level: Owned<T> on change constructors", () => {
  it("an object payload must be owned", () => {
    // @ts-expect-error — a raw object is not Owned; call own() or trustAsOwned()
    replaceChange({ a: 1 })
    expectTypeOf(replaceChange(own({ a: 1 }))).toMatchTypeOf<
      ReplaceChange<{ a: number }>
    >()
    expectTypeOf(replaceChange(trustAsOwned({ a: 1 }))).toMatchTypeOf<
      ReplaceChange<{ a: number }>
    >()
  })

  it("a primitive payload needs no brand — nothing can alias it", () => {
    expectTypeOf(replaceChange(1)).toMatchTypeOf<ReplaceChange<number>>()
    expectTypeOf(replaceChange("x")).toMatchTypeOf<ReplaceChange<string>>()
  })

  it("Owned<T> is assignable wherever T is", () => {
    const owned = own({ a: 1 })
    expectTypeOf(owned).toMatchTypeOf<{ a: number }>()
  })
})

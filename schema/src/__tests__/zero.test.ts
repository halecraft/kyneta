import { describe, expect, it } from "vitest"
import { Schema, LoroSchema, Zero } from "../index.js"

// ===========================================================================
// Base grammar tests — Schema only, no Loro annotations
// ===========================================================================

describe("Zero.structural: scalars", () => {
  it("string → empty string", () => {
    expect(Zero.structural(Schema.scalar("string"))).toBe("")
  })

  it("number → 0", () => {
    expect(Zero.structural(Schema.scalar("number"))).toBe(0)
  })

  it("boolean → false", () => {
    expect(Zero.structural(Schema.scalar("boolean"))).toBe(false)
  })

  it("null → null", () => {
    expect(Zero.structural(Schema.scalar("null"))).toBe(null)
  })

  it("undefined → undefined", () => {
    expect(Zero.structural(Schema.scalar("undefined"))).toBe(undefined)
  })

  it("bytes → empty Uint8Array", () => {
    const result = Zero.structural(Schema.scalar("bytes"))
    expect(result).toBeInstanceOf(Uint8Array)
    expect((result as Uint8Array).length).toBe(0)
  })

  it("any → undefined", () => {
    expect(Zero.structural(Schema.scalar("any"))).toBe(undefined)
  })
})

describe("Zero.structural: structural kinds", () => {
  it("product → object with recursed field defaults", () => {
    expect(
      Zero.structural(
        Schema.product({
          name: Schema.scalar("string"),
          age: Schema.scalar("number"),
          active: Schema.scalar("boolean"),
        }),
      ),
    ).toEqual({ name: "", age: 0, active: false })
  })

  it("sequence → empty array", () => {
    expect(Zero.structural(Schema.sequence(Schema.scalar("string")))).toEqual(
      [],
    )
  })

  it("map → empty object", () => {
    expect(Zero.structural(Schema.map(Schema.scalar("number")))).toEqual({})
  })

  it("positional sum → first variant's zero", () => {
    expect(
      Zero.structural(
        Schema.sum([Schema.scalar("string"), Schema.scalar("number")]),
      ),
    ).toBe("")
  })

  it("positional sum with empty variants → undefined", () => {
    expect(Zero.structural(Schema.sum([]))).toBe(undefined)
  })

  it("discriminated sum → first variant with discriminant key injected", () => {
    expect(
      Zero.structural(
        Schema.discriminatedSum("type", {
          text: Schema.product({ content: Schema.scalar("string") }),
          image: Schema.product({ url: Schema.scalar("string") }),
        }),
      ),
    ).toEqual({ content: "", type: "text" })
  })
})

describe("Zero.structural: generic annotations", () => {
  it("unknown annotation without inner → undefined", () => {
    expect(Zero.structural(Schema.annotated("custom-thing"))).toBe(undefined)
  })

  it("unknown annotation with inner → delegates to inner", () => {
    expect(
      Zero.structural(Schema.annotated("custom", Schema.scalar("number"))),
    ).toBe(0)
  })
})

describe("Zero.structural: doc (structural root)", () => {
  it("doc with scalar fields", () => {
    expect(
      Zero.structural(
        Schema.doc({
          name: Schema.string(),
          count: Schema.number(),
          active: Schema.boolean(),
        }),
      ),
    ).toEqual({ name: "", count: 0, active: false })
  })

  it("doc with nested struct, list, record", () => {
    const schema = Schema.doc({
      settings: Schema.struct({
        darkMode: Schema.boolean(),
        fontSize: Schema.number(),
      }),
      tags: Schema.list(Schema.string()),
      metadata: Schema.record(Schema.any()),
    })

    expect(Zero.structural(schema)).toEqual({
      settings: { darkMode: false, fontSize: 0 },
      tags: [],
      metadata: {},
    })
  })
})

describe("Zero.overlay: base grammar", () => {
  const docSchema = Schema.doc({
    title: Schema.string(),
    count: Schema.number(),
    settings: Schema.struct({
      darkMode: Schema.boolean(),
      fontSize: Schema.number(),
    }),
    tags: Schema.list(Schema.string()),
  })

  it("returns fallback when primary is undefined", () => {
    const fallback = Zero.structural(docSchema)
    expect(Zero.overlay(undefined, fallback, docSchema)).toEqual(fallback)
  })

  it("returns fallback when primary is null", () => {
    const fallback = Zero.structural(docSchema)
    expect(Zero.overlay(null, fallback, docSchema)).toEqual(fallback)
  })

  it("primary wins at scalar leaves", () => {
    const primary = { title: "Custom" }
    const fallback = { title: "" }
    const schema = Schema.doc({ title: Schema.string() })
    const result = Zero.overlay(primary, fallback, schema) as Record<
      string,
      unknown
    >
    expect(result.title).toBe("Custom")
  })

  it("deep merges products per-key", () => {
    const primary = {
      title: "My Doc",
      settings: { darkMode: true },
    }
    const fallback = Zero.structural(docSchema)
    const result = Zero.overlay(primary, fallback, docSchema) as Record<
      string,
      unknown
    >

    // Primary wins where defined
    expect(result.title).toBe("My Doc")
    expect((result.settings as Record<string, unknown>).darkMode).toBe(true)

    // Fallback fills gaps
    expect(result.count).toBe(0)
    expect((result.settings as Record<string, unknown>).fontSize).toBe(0)
    expect(result.tags).toEqual([])
  })

  it("sequences: primary wins wholesale (no per-item merge)", () => {
    const schema = Schema.doc({
      items: Schema.list(Schema.string()),
    })
    const primary = { items: ["a", "b"] }
    const fallback = { items: ["x", "y", "z"] }
    const result = Zero.overlay(primary, fallback, schema) as Record<
      string,
      unknown
    >
    expect(result.items).toEqual(["a", "b"])
  })

  it("nested products recurse deeply", () => {
    const schema = Schema.doc({
      outer: Schema.struct({
        inner: Schema.struct({
          value: Schema.number(),
          label: Schema.string(),
        }),
      }),
    })
    const primary = { outer: { inner: { value: 42 } } }
    const fallback = Zero.structural(schema)
    const result = Zero.overlay(primary, fallback, schema) as {
      outer: { inner: { value: number; label: string } }
    }

    expect(result.outer.inner.value).toBe(42)
    expect(result.outer.inner.label).toBe("")
  })
})

describe("Zero.for and Zero.partial", () => {
  it("Zero.for is a passthrough identity", () => {
    const schema = Schema.doc({ x: Schema.number() })
    const value = { x: 42 }
    expect(Zero.for(schema, value)).toBe(value)
  })

  it("Zero.partial is a passthrough identity", () => {
    const schema = Schema.doc({ x: Schema.number() })
    const value = { x: 42 }
    expect(Zero.partial(schema, value)).toBe(value)
  })
})

// ===========================================================================
// LoroSchema tests — Loro-specific annotation defaults
// ===========================================================================

describe("Zero.structural: LoroSchema annotations", () => {
  it("text → empty string", () => {
    expect(Zero.structural(LoroSchema.text())).toBe("")
  })

  it("counter → 0", () => {
    expect(Zero.structural(LoroSchema.counter())).toBe(0)
  })

  it("movableList → empty array", () => {
    expect(
      Zero.structural(LoroSchema.movableList(LoroSchema.plain.string())),
    ).toEqual([])
  })

  it("doc with Loro annotations delegates correctly", () => {
    expect(
      Zero.structural(
        LoroSchema.doc({
          title: LoroSchema.text(),
          count: LoroSchema.counter(),
        }),
      ),
    ).toEqual({ title: "", count: 0 })
  })

  it("realistic Loro document schema", () => {
    const chatDoc = LoroSchema.doc({
      title: LoroSchema.text(),
      count: LoroSchema.counter(),
      messages: Schema.list(
        LoroSchema.plain.struct({
          author: LoroSchema.plain.string(),
          body: LoroSchema.text(),
        }),
      ),
      settings: LoroSchema.plain.struct({
        darkMode: LoroSchema.plain.boolean(),
        fontSize: LoroSchema.plain.number(),
      }),
      tags: Schema.list(LoroSchema.plain.string()),
      metadata: Schema.record(LoroSchema.plain.any()),
    })

    expect(Zero.structural(chatDoc)).toEqual({
      title: "",
      count: 0,
      messages: [],
      settings: { darkMode: false, fontSize: 0 },
      tags: [],
      metadata: {},
    })
  })
})
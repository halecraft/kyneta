import { describe, expect, it } from "vitest"
import { Schema, Zero } from "../index.js"

// ===========================================================================
// Base grammar tests — Schema only, no annotations
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

describe("Zero.structural: constrained scalars", () => {
  it("constrained string → first option", () => {
    expect(Zero.structural(Schema.string("public", "private"))).toBe("public")
  })

  it("constrained number → first option", () => {
    expect(Zero.structural(Schema.number(1, 2, 3))).toBe(1)
  })

  it("constrained boolean → first option", () => {
    expect(Zero.structural(Schema.boolean(true))).toBe(true)
  })

  it("unconstrained string still defaults to empty string", () => {
    expect(Zero.structural(Schema.string())).toBe("")
  })

  it("constrained scalar inside a struct uses constraint[0]", () => {
    const schema = Schema.struct({
      visibility: Schema.string("public", "private"),
      count: Schema.number(),
    })
    expect(Zero.structural(schema)).toEqual({
      visibility: "public",
      count: 0,
    })
  })

  it("Schema constrained string → first option", () => {
    expect(Zero.structural(Schema.string("a", "b"))).toBe("a")
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

  it("discriminated sum → first variant (discriminant field is part of product)", () => {
    expect(
      Zero.structural(
        Schema.discriminatedSum("type", [
          Schema.product({
            type: Schema.scalar("string", ["text"]),
            content: Schema.scalar("string"),
          }),
          Schema.product({
            type: Schema.scalar("string", ["image"]),
            url: Schema.scalar("string"),
          }),
        ]),
      ),
    ).toEqual({ type: "text", content: "" })
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

// Annotated tests — annotation-specific defaults
// ===========================================================================

describe("Zero.structural: annotated schemas", () => {
  it("text → empty string", () => {
    expect(Zero.structural(Schema.annotated("text"))).toBe("")
  })

  it("counter → 0", () => {
    expect(Zero.structural(Schema.annotated("counter"))).toBe(0)
  })

  it("movableList → empty array", () => {
    expect(
      Zero.structural(
        Schema.annotated("movable", Schema.list(Schema.string())),
      ),
    ).toEqual([])
  })

  it("doc with annotations delegates correctly", () => {
    expect(
      Zero.structural(
        Schema.doc({
          title: Schema.annotated("text"),
          count: Schema.annotated("counter"),
        }),
      ),
    ).toEqual({ title: "", count: 0 })
  })

  it("realistic annotated document schema", () => {
    const chatDoc = Schema.doc({
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
      tags: Schema.list(Schema.string()),
      metadata: Schema.record(Schema.any()),
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

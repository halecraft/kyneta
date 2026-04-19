import { describe, expect, it } from "vitest"
import type { Interpreter, Path } from "../index.js"
import {
  createInterpreter,
  interpret,
  KIND,
  plainInterpreter,
  Schema,
} from "../index.js"

// ===========================================================================
// Base grammar tests — Schema only, no Loro annotations
// ===========================================================================

describe("interpret: catamorphism laziness", () => {
  const docSchema = Schema.struct({
    title: Schema.string(),
    count: Schema.number(),
    settings: Schema.struct({
      darkMode: Schema.boolean(),
      fontSize: Schema.number(),
    }),
  })

  it("product field thunks are not forced until accessed", () => {
    let forceCount = 0

    const countingInterpreter = createInterpreter<void, unknown>(
      () => {
        forceCount++
        return "leaf"
      },
      {
        product: (_ctx, _path, _schema, fields) => fields,
      },
    )

    forceCount = 0
    const result = interpret(
      docSchema,
      countingInterpreter,
      undefined,
    ) as Record<string, () => unknown>
    expect(forceCount).toBe(0)

    // Force just title
    result.title()
    expect(forceCount).toBe(1)

    // Force settings — returns another product of thunks
    const settings = result.settings() as Record<string, () => unknown>
    expect(forceCount).toBe(1) // product itself doesn't force leaves

    // Force settings.darkMode
    settings.darkMode()
    expect(forceCount).toBe(2)

    // count was never forced
    expect(forceCount).toBe(2)
  })
})

describe("interpret: plain round-trip", () => {
  it("reads a flat document correctly", () => {
    const schema = Schema.struct({
      title: Schema.string(),
      count: Schema.number(),
    })

    const store = { title: "Hello", count: 42 }
    const result = interpret(schema, plainInterpreter, store)
    expect(result).toEqual(store)
  })

  it("reads a nested document with all structural kinds", () => {
    const schema = Schema.struct({
      title: Schema.string(),
      count: Schema.number(),
      messages: Schema.list(
        Schema.struct({
          author: Schema.string(),
          body: Schema.string(),
          likes: Schema.number(),
        }),
      ),
      settings: Schema.struct({
        darkMode: Schema.boolean(),
        fontSize: Schema.number(),
      }),
      tags: Schema.list(Schema.string()),
      metadata: Schema.record(Schema.any()),
    })

    const store = {
      title: "My Chat",
      count: 42,
      messages: [
        { author: "Alice", body: "Hello!", likes: 3 },
        { author: "Bob", body: "Hi there", likes: 1 },
      ],
      settings: { darkMode: true, fontSize: 16 },
      tags: ["general", "public"],
      metadata: { createdAt: "2024-01-01", version: 2 },
    }

    const result = interpret(schema, plainInterpreter, store)
    expect(result).toEqual(store)
  })

  it("handles missing data gracefully (returns undefined for missing leaves)", () => {
    const schema = Schema.struct({
      title: Schema.string(),
      count: Schema.number(),
    })

    // Sparse store — count is missing
    const store = { title: "Hello" }
    const result = interpret(schema, plainInterpreter, store) as Record<
      string,
      unknown
    >
    expect(result.title).toBe("Hello")
    expect(result.count).toBe(undefined)
  })
})

describe("interpret: schema constructors produce correct grammar nodes", () => {
  it("Schema.struct() produces a product", () => {
    const s = Schema.struct({ x: Schema.number() })
    expect(s[KIND]).toBe("product")
  })

  it("Schema.list() produces a sequence", () => {
    const s = Schema.list(Schema.string())
    expect(s[KIND]).toBe("sequence")
  })

  it("Schema.record() produces a map", () => {
    const s = Schema.record(Schema.any())
    expect(s[KIND]).toBe("map")
  })

  it("Schema.struct() produces a product node", () => {
    const s = Schema.struct({ title: Schema.string() })
    expect(s[KIND]).toBe("product")
  })

  it("Schema.string() produces a bare scalar", () => {
    const s = Schema.string()
    expect(s[KIND]).toBe("scalar")
    expect(s.scalarKind).toBe("string")
  })

  it("Schema.nullable() produces a positional sum with null first", () => {
    const s = Schema.nullable(Schema.string())
    expect(s[KIND]).toBe("sum")
    expect(s.variants).toHaveLength(2)
    expect(s.variants[0][KIND]).toBe("scalar")
    expect((s.variants[0] as any).scalarKind).toBe("null")
    expect(s.variants[1][KIND]).toBe("scalar")
    expect((s.variants[1] as any).scalarKind).toBe("string")
  })

  it("Schema.string('a', 'b') produces a constrained scalar", () => {
    const s = Schema.string("a", "b")
    expect(s[KIND]).toBe("scalar")
    expect(s.scalarKind).toBe("string")
    expect(s.constraint).toEqual(["a", "b"])
  })

  it("Schema.string() produces a scalar with no constraint field", () => {
    const s = Schema.string()
    expect(s[KIND]).toBe("scalar")
    expect(s.scalarKind).toBe("string")
    expect(s.constraint).toBeUndefined()
  })

  it("Schema.number(1, 2, 3) produces a constrained number scalar", () => {
    const s = Schema.number(1, 2, 3)
    expect(s[KIND]).toBe("scalar")
    expect(s.scalarKind).toBe("number")
    expect(s.constraint).toEqual([1, 2, 3])
  })

  it("Schema.boolean(true) produces a constrained boolean scalar", () => {
    const s = Schema.boolean(true)
    expect(s[KIND]).toBe("scalar")
    expect(s.scalarKind).toBe("boolean")
    expect(s.constraint).toEqual([true])
  })

  it("Schema.scalar('string') has no constraint (low-level)", () => {
    const s = Schema.scalar("string")
    expect(s.constraint).toBeUndefined()
  })
})

describe("interpret: path accumulation", () => {
  it("passes correct paths to the interpreter at each level", () => {
    const paths: Array<{ kind: string; path: Path }> = []

    const pathTracker: Interpreter<void, unknown> = {
      scalar(_ctx, path, schema) {
        paths.push({ kind: `scalar:${schema.scalarKind}`, path })
        return null
      },
      product(_ctx, path, _schema, fields) {
        paths.push({ kind: "product", path })
        const result: Record<string, unknown> = {}
        for (const [key, thunk] of Object.entries(fields)) {
          result[key] = thunk()
        }
        return result
      },
      sequence(_ctx, path, _schema, _item) {
        paths.push({ kind: "sequence", path })
        return []
      },
      map(_ctx, path, _schema, _item) {
        paths.push({ kind: "map", path })
        return {}
      },
      sum(_ctx, path, _schema, _variants) {
        paths.push({ kind: "sum", path })
        return null
      },
      text(_ctx, path, _schema) {
        paths.push({ kind: "text", path })
        return null
      },
      counter(_ctx, path, _schema) {
        paths.push({ kind: "counter", path })
        return null
      },
      set(_ctx, path, _schema, _item) {
        paths.push({ kind: "set", path })
        return null
      },
      tree(_ctx, path, _schema, _nodeData) {
        paths.push({ kind: "tree", path })
        return null
      },
      movable(_ctx, path, _schema, _item) {
        paths.push({ kind: "movable", path })
        return null
      },
      richtext(_ctx, path, _schema) {
        paths.push({ kind: "richtext", path })
        return null
      },
    }

    const schema = Schema.struct({
      title: Schema.string(),
      settings: Schema.struct({
        darkMode: Schema.boolean(),
      }),
    })

    interpret(schema, pathTracker, undefined)

    // Root: product at []
    expect(paths[0]?.kind).toBe("product")
    expect(paths[0]?.path.length).toBe(0)

    // title: scalar at [key:"title"]
    const titlePath = paths.find(p => p.kind === "scalar:string")
    expect(titlePath?.path.format()).toBe("title")

    // settings: product at [key:"settings"]
    const settingsPath = paths.find(
      p => p.kind === "product" && p.path.length === 1,
    )
    expect(settingsPath?.path.format()).toBe("settings")

    // darkMode: scalar at [key:"settings", key:"darkMode"]
    const darkModePath = paths.find(p => p.kind === "scalar:boolean")
    expect(darkModePath?.path.format()).toBe("settings.darkMode")
  })
})

// ===========================================================================
// First-class type constructor tests
// ===========================================================================

describe("interpret: first-class type constructors produce correct grammar nodes", () => {
  it("Schema.text() produces a text node", () => {
    const s = Schema.text()
    expect(s[KIND]).toBe("text")
  })

  it("Schema.counter() produces a counter node", () => {
    const s = Schema.counter()
    expect(s[KIND]).toBe("counter")
  })

  it("Schema.movableList(Schema.list(...)) produces a movable node", () => {
    const s = Schema.movableList(Schema.string())
    expect(s[KIND]).toBe("movable")
  })

  it("Schema.tree(...) produces a tree node", () => {
    const s = Schema.tree(Schema.struct({ label: Schema.string() }))
    expect(s[KIND]).toBe("tree")
  })
})

describe("interpret: discriminatedUnion constructor validation", () => {
  it("valid construction succeeds and builds variantMap", () => {
    const s = Schema.discriminatedUnion("type", [
      Schema.struct({ type: Schema.string("text"), body: Schema.string() }),
      Schema.struct({ type: Schema.string("image"), url: Schema.string() }),
    ])
    expect(s[KIND]).toBe("sum")
    expect(s.discriminant).toBe("type")
    expect(s.variants).toHaveLength(2)
    expect(s.variantMap).toHaveProperty("text")
    expect(s.variantMap).toHaveProperty("image")
    expect(s.variantMap.text).toBe(s.variants[0])
    expect(s.variantMap.image).toBe(s.variants[1])
  })

  it("throws if a variant lacks the discriminant field", () => {
    expect(() =>
      Schema.discriminatedUnion("type", [
        Schema.struct({ body: Schema.string() }),
      ]),
    ).toThrow(/missing the discriminant field "type"/)
  })

  it("throws if discriminant field is not a constrained string scalar", () => {
    expect(() =>
      Schema.discriminatedUnion("type", [
        Schema.struct({ type: Schema.string(), body: Schema.string() }),
      ]),
    ).toThrow(/must be a constrained string scalar/)
  })

  it("throws if discriminant field is a non-string scalar", () => {
    expect(() =>
      Schema.discriminatedUnion("type", [
        Schema.struct({ type: Schema.number(1), body: Schema.string() }),
      ]),
    ).toThrow(/must be a constrained string scalar/)
  })

  it("throws on duplicate discriminant values", () => {
    expect(() =>
      Schema.discriminatedUnion("type", [
        Schema.struct({ type: Schema.string("text"), a: Schema.string() }),
        Schema.struct({ type: Schema.string("text"), b: Schema.string() }),
      ]),
    ).toThrow(/duplicate discriminant value "text"/)
  })

  it("single variant is valid", () => {
    const s = Schema.discriminatedUnion("kind", [
      Schema.struct({ kind: Schema.string("solo"), data: Schema.number() }),
    ])
    expect(s.variants).toHaveLength(1)
    expect(s.variantMap).toHaveProperty("solo")
  })
})

describe("interpret: first-class types plain round-trip", () => {
  it("reads a document with first-class types correctly", () => {
    const schema = Schema.struct({
      title: Schema.text(),
      count: Schema.counter(),
      messages: Schema.movableList(
        Schema.struct({
          author: Schema.string(),
          body: Schema.text(),
        }),
      ),
    })

    const store = {
      title: "My Chat",
      count: 42,
      messages: [
        { author: "Alice", body: "Hello!" },
        { author: "Bob", body: "Hi there" },
      ],
    }

    const result = interpret(schema, plainInterpreter, store)
    expect(result).toEqual(store)
  })
})

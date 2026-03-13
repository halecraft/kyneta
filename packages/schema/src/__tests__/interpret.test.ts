import { describe, expect, it, vi } from "vitest"
import {
  Schema,
  LoroSchema,
  Zero,
  interpret,
  createInterpreter,
  plainInterpreter,
  enrich,
  CHANGEFEED,
  hasChangefeed,
  isNonNullObject,
} from "../index.js"
import type { Interpreter, Path } from "../index.js"

// ===========================================================================
// Base grammar tests — Schema only, no Loro annotations
// ===========================================================================

describe("interpret: catamorphism laziness", () => {
  const docSchema = Schema.doc({
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
        annotated: (_ctx, _path, schema, inner) => {
          if (inner) return inner()
          forceCount++
          return `annotated:${schema.tag}`
        },
      },
    )

    forceCount = 0
    const result = interpret(docSchema, countingInterpreter, undefined) as Record<string, () => unknown>
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
    const schema = Schema.doc({
      title: Schema.string(),
      count: Schema.number(),
    })

    const store = { title: "Hello", count: 42 }
    const result = interpret(schema, plainInterpreter, store)
    expect(result).toEqual(store)
  })

  it("reads a nested document with all structural kinds", () => {
    const schema = Schema.doc({
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
    const schema = Schema.doc({
      title: Schema.string(),
      count: Schema.number(),
    })

    // Sparse store — count is missing
    const store = { title: "Hello" }
    const result = interpret(schema, plainInterpreter, store) as Record<string, unknown>
    expect(result.title).toBe("Hello")
    expect(result.count).toBe(undefined)
  })
})

describe("interpret: schema constructors produce correct grammar nodes", () => {
  it("Schema.struct() produces a product", () => {
    const s = Schema.struct({ x: Schema.number() })
    expect(s._kind).toBe("product")
  })

  it("Schema.list() produces a sequence", () => {
    const s = Schema.list(Schema.string())
    expect(s._kind).toBe("sequence")
  })

  it("Schema.record() produces a map", () => {
    const s = Schema.record(Schema.any())
    expect(s._kind).toBe("map")
  })

  it("Schema.doc() produces annotated('doc', product(...))", () => {
    const s = Schema.doc({ title: Schema.string() })
    expect(s._kind).toBe("annotated")
    expect(s.tag).toBe("doc")
    expect(s.schema?._kind).toBe("product")
  })

  it("Schema.string() produces a bare scalar", () => {
    const s = Schema.string()
    expect(s._kind).toBe("scalar")
    expect(s.scalarKind).toBe("string")
  })

  it("Schema.nullable() produces a positional sum with null first", () => {
    const s = Schema.nullable(Schema.string())
    expect(s._kind).toBe("sum")
    expect(s.variants).toHaveLength(2)
    expect(s.variants[0]._kind).toBe("scalar")
    expect((s.variants[0] as any).scalarKind).toBe("null")
    expect(s.variants[1]._kind).toBe("scalar")
    expect((s.variants[1] as any).scalarKind).toBe("string")
  })

  it("Schema.annotated() produces annotated with custom tag", () => {
    const s = Schema.annotated("custom")
    expect(s._kind).toBe("annotated")
    expect(s.tag).toBe("custom")
  })

  it("Schema.string('a', 'b') produces a constrained scalar", () => {
    const s = Schema.string("a", "b")
    expect(s._kind).toBe("scalar")
    expect(s.scalarKind).toBe("string")
    expect(s.constraint).toEqual(["a", "b"])
  })

  it("Schema.string() produces a scalar with no constraint field", () => {
    const s = Schema.string()
    expect(s._kind).toBe("scalar")
    expect(s.scalarKind).toBe("string")
    expect(s.constraint).toBeUndefined()
  })

  it("Schema.number(1, 2, 3) produces a constrained number scalar", () => {
    const s = Schema.number(1, 2, 3)
    expect(s._kind).toBe("scalar")
    expect(s.scalarKind).toBe("number")
    expect(s.constraint).toEqual([1, 2, 3])
  })

  it("Schema.boolean(true) produces a constrained boolean scalar", () => {
    const s = Schema.boolean(true)
    expect(s._kind).toBe("scalar")
    expect(s.scalarKind).toBe("boolean")
    expect(s.constraint).toEqual([true])
  })

  it("Schema.scalar('string') has no constraint (low-level)", () => {
    const s = Schema.scalar("string")
    expect(s.constraint).toBeUndefined()
  })
})

describe("interpret: enrich combinator", () => {
  // A minimal object-producing interpreter for testing enrich.
  // Products force all thunks into a plain object; annotated nodes
  // delegate to inner; everything else returns an empty object.
  const objectInterpreter = createInterpreter<void, unknown>(
    () => ({}),
    {
      product: (_ctx, _path, _schema, fields) => {
        const r: Record<string, unknown> = {}
        for (const [k, t] of Object.entries(fields)) r[k] = t()
        return r
      },
      annotated: (_ctx, _path, _schema, inner) => inner ? inner() : ({}),
    },
  )

  it("enrich adds [CHANGEFEED] to every object result", () => {
    const CF_SYM = Symbol.for("kyneta:changefeed")

    const withCf = (result: unknown, _ctx: unknown, _path: Path) => {
      if (!isNonNullObject(result)) return {}
      if (CF_SYM in result) return {}
      return {
        [CF_SYM]: {
          get current() {
            return result
          },
          subscribe: () => () => {},
        },
      }
    }

    const enriched = enrich(objectInterpreter, withCf)
    const schema = Schema.doc({
      title: Schema.string(),
      settings: Schema.struct({
        darkMode: Schema.boolean(),
      }),
    })

    const result = interpret(schema, enriched, undefined)
    expect(hasChangefeed(result)).toBe(true)
  })

  it("enrich preserves product-level results", () => {
    const CF_SYM = Symbol.for("kyneta:changefeed")
    const withMarker = (result: unknown, _ctx: unknown, _path: Path) => {
      if (!isNonNullObject(result)) return {}
      return { [CF_SYM]: { current: "marker" } }
    }

    const enriched = enrich(objectInterpreter, withMarker)
    const schema = Schema.doc({
      settings: Schema.struct({
        darkMode: Schema.boolean(),
      }),
    })

    const result = interpret(schema, enriched, undefined) as Record<string | symbol, unknown>
    // The product result has the marker attached
    expect((result as any)[CF_SYM]).toEqual({ current: "marker" })
    // And the base values are preserved at the product level
    const settings = result.settings as Record<string, unknown>
    expect(settings).toBeDefined()
    expect(typeof settings).toBe("object")
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
      annotated(_ctx, path, schema, inner) {
        paths.push({ kind: `annotated:${schema.tag}`, path })
        return inner ? inner() : null
      },
    }

    const schema = Schema.doc({
      title: Schema.string(),
      settings: Schema.struct({
        darkMode: Schema.boolean(),
      }),
    })

    interpret(schema, pathTracker, undefined)

    // Root: annotated("doc") at []
    expect(paths[0]).toEqual({ kind: "annotated:doc", path: [] })

    // Inner product at [] (annotation doesn't advance path)
    expect(paths[1]).toEqual({ kind: "product", path: [] })

    // title: scalar at [key:"title"]
    const titlePath = paths.find((p) => p.kind === "scalar:string")
    expect(titlePath?.path).toEqual([{ type: "key", key: "title" }])

    // settings: product at [key:"settings"]
    const settingsPath = paths.find(
      (p) => p.kind === "product" && p.path.length === 1,
    )
    expect(settingsPath?.path).toEqual([{ type: "key", key: "settings" }])

    // darkMode: scalar at [key:"settings", key:"darkMode"]
    const darkModePath = paths.find((p) => p.kind === "scalar:boolean")
    expect(darkModePath?.path).toEqual([
      { type: "key", key: "settings" },
      { type: "key", key: "darkMode" },
    ])
  })
})

// ===========================================================================
// LoroSchema tests — Loro-specific annotation constructors
// ===========================================================================

describe("interpret: LoroSchema constructors produce correct grammar nodes", () => {
  it("LoroSchema.text() produces annotated with tag 'text'", () => {
    const s = LoroSchema.text()
    expect(s._kind).toBe("annotated")
    expect(s.tag).toBe("text")
  })

  it("LoroSchema.counter() produces annotated with tag 'counter'", () => {
    const s = LoroSchema.counter()
    expect(s._kind).toBe("annotated")
    expect(s.tag).toBe("counter")
  })

  it("LoroSchema.movableList() produces annotated('movable', sequence(...))", () => {
    const s = LoroSchema.movableList(Schema.string())
    expect(s._kind).toBe("annotated")
    expect(s.tag).toBe("movable")
    expect(s.schema?._kind).toBe("sequence")
  })

  it("LoroSchema.tree() produces annotated('tree', product(...))", () => {
    const s = LoroSchema.tree(Schema.struct({ label: Schema.string() }))
    expect(s._kind).toBe("annotated")
    expect(s.tag).toBe("tree")
    expect(s.schema?._kind).toBe("product")
  })
})

describe("interpret: LoroSchema plain round-trip with annotations", () => {
  it("reads a document with Loro annotations correctly", () => {
    const schema = LoroSchema.doc({
      title: LoroSchema.text(),
      count: LoroSchema.counter(),
      messages: LoroSchema.movableList(
        Schema.struct({
          author: Schema.string(),
          body: LoroSchema.text(),
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

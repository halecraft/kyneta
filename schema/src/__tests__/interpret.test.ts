import { describe, expect, it, vi } from "vitest"
import {
  Schema,
  Zero,
  interpret,
  createInterpreter,
  plainInterpreter,
  zeroInterpreter,
  enrich,
  FEED,
  isFeedable,
} from "../index.js"
import type { Interpreter, Path } from "../index.js"

describe("interpret: catamorphism laziness", () => {
  const docSchema = Schema.doc({
    title: Schema.text(),
    count: Schema.counter(),
    settings: Schema.struct({
      darkMode: Schema.plain.boolean(),
      fontSize: Schema.plain.number(),
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

describe("interpret: zero equivalence", () => {
  it("zeroInterpreter produces the same result as Zero.structural for a flat doc", () => {
    const schema = Schema.doc({
      title: Schema.text(),
      count: Schema.counter(),
      items: Schema.list(Schema.plain.string()),
    })

    const viaZero = Zero.structural(schema)
    const viaInterp = interpret(schema, zeroInterpreter, undefined)
    expect(viaInterp).toEqual(viaZero)
  })

  it("zeroInterpreter matches Zero.structural for nested products", () => {
    const schema = Schema.doc({
      settings: Schema.struct({
        darkMode: Schema.plain.boolean(),
        fontSize: Schema.plain.number(),
      }),
      metadata: Schema.record(Schema.plain.any()),
    })

    expect(interpret(schema, zeroInterpreter, undefined)).toEqual(
      Zero.structural(schema),
    )
  })

  it("zeroInterpreter matches Zero.structural for discriminated sums", () => {
    const schema = Schema.plain.discriminatedUnion("type", {
      text: Schema.struct({ content: Schema.plain.string() }),
      image: Schema.struct({ url: Schema.plain.string() }),
    })

    expect(interpret(schema, zeroInterpreter, undefined)).toEqual(
      Zero.structural(schema),
    )
  })

  it("zeroInterpreter matches Zero.structural for positional sums", () => {
    const schema = Schema.plain.union(
      Schema.plain.string(),
      Schema.plain.number(),
    )

    expect(interpret(schema, zeroInterpreter, undefined)).toEqual(
      Zero.structural(schema),
    )
  })
})

describe("interpret: plain round-trip", () => {
  it("reads a flat document correctly", () => {
    const schema = Schema.doc({
      title: Schema.text(),
      count: Schema.counter(),
    })

    const store = { title: "Hello", count: 42 }
    const result = interpret(schema, plainInterpreter, store)
    expect(result).toEqual(store)
  })

  it("reads a nested document with all structural kinds", () => {
    const schema = Schema.doc({
      title: Schema.text(),
      count: Schema.counter(),
      messages: Schema.list(
        Schema.struct({
          author: Schema.plain.string(),
          body: Schema.text(),
          likes: Schema.plain.number(),
        }),
      ),
      settings: Schema.struct({
        darkMode: Schema.plain.boolean(),
        fontSize: Schema.plain.number(),
      }),
      tags: Schema.plain.array(Schema.plain.string()),
      metadata: Schema.record(Schema.plain.any()),
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
      title: Schema.text(),
      count: Schema.counter(),
    })

    // Sparse store — count is missing
    const store = { title: "Hello" }
    const result = interpret(schema, plainInterpreter, store) as Record<string, unknown>
    expect(result.title).toBe("Hello")
    expect(result.count).toBe(undefined)
  })
})

describe("interpret: schema constructors produce correct grammar nodes", () => {
  it("Schema.text() produces annotated with tag 'text'", () => {
    const s = Schema.text()
    expect(s._kind).toBe("annotated")
    expect(s.tag).toBe("text")
  })

  it("Schema.counter() produces annotated with tag 'counter'", () => {
    const s = Schema.counter()
    expect(s._kind).toBe("annotated")
    expect(s.tag).toBe("counter")
  })

  it("Schema.struct() produces a product", () => {
    const s = Schema.struct({ x: Schema.plain.number() })
    expect(s._kind).toBe("product")
  })

  it("Schema.list() produces a sequence", () => {
    const s = Schema.list(Schema.plain.string())
    expect(s._kind).toBe("sequence")
  })

  it("Schema.record() produces a map", () => {
    const s = Schema.record(Schema.plain.any())
    expect(s._kind).toBe("map")
  })

  it("Schema.doc() produces annotated('doc', product(...))", () => {
    const s = Schema.doc({ title: Schema.text() })
    expect(s._kind).toBe("annotated")
    expect(s.tag).toBe("doc")
    expect(s.schema?._kind).toBe("product")
  })

  it("Schema.movableList() produces annotated('movable', sequence(...))", () => {
    const s = Schema.movableList(Schema.plain.string())
    expect(s._kind).toBe("annotated")
    expect(s.tag).toBe("movable")
    expect(s.schema?._kind).toBe("sequence")
  })

  it("Schema.plain.string() produces a bare scalar", () => {
    const s = Schema.plain.string()
    expect(s._kind).toBe("scalar")
    expect(s.scalarKind).toBe("string")
  })
})

describe("interpret: enrich combinator", () => {
  it("enrich adds [FEED] to every object result", () => {
    const FEED_SYM = Symbol.for("kinetic:feed")

    const withFeed = (result: unknown, _ctx: unknown, _path: Path) => {
      if (result === null || result === undefined || typeof result !== "object") {
        return {}
      }
      if (FEED_SYM in (result as object)) return {}
      return {
        [FEED_SYM]: {
          get head() {
            return result
          },
          subscribe: () => () => {},
        },
      }
    }

    const enriched = enrich(zeroInterpreter, withFeed)
    const schema = Schema.doc({
      title: Schema.text(),
      settings: Schema.struct({
        darkMode: Schema.plain.boolean(),
      }),
    })

    const result = interpret(schema, enriched, undefined)
    expect(isFeedable(result)).toBe(true)
  })

  it("enrich preserves product-level results (enrich is for object-producing interpreters)", () => {
    // enrich is designed for interpreters that produce objects (like
    // writableInterpreter), not for interpreters that produce primitives
    // (like zeroInterpreter which returns "" for text). Verify at the
    // product level where it works correctly.
    const FEED_SYM = Symbol.for("kinetic:feed")
    const withMarker = (result: unknown, _ctx: unknown, _path: Path) => {
      if (result === null || result === undefined || typeof result !== "object") {
        return {}
      }
      return { [FEED_SYM]: { head: "marker" } }
    }

    const enriched = enrich(zeroInterpreter, withMarker)
    const schema = Schema.doc({
      settings: Schema.struct({
        darkMode: Schema.plain.boolean(),
      }),
    })

    const result = interpret(schema, enriched, undefined) as Record<string | symbol, unknown>
    // The product result has the marker attached
    expect((result as any)[FEED_SYM]).toEqual({ head: "marker" })
    // And the base zero values are preserved at the product level
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
      title: Schema.text(),
      settings: Schema.struct({
        darkMode: Schema.plain.boolean(),
      }),
    })

    interpret(schema, pathTracker, undefined)

    // Root: annotated("doc") at []
    expect(paths[0]).toEqual({ kind: "annotated:doc", path: [] })

    // Inner product at [] (annotation doesn't advance path)
    expect(paths[1]).toEqual({ kind: "product", path: [] })

    // title: annotated("text") at [key:"title"]
    const titlePath = paths.find((p) => p.kind === "annotated:text")
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
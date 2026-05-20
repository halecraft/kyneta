import { describe, expect, expectTypeOf, it } from "vitest"
import type { MaterializeResolver, Plain } from "../index.js"
import { createMaterializeInterpreter, interpret, Schema } from "../index.js"
import type { Path } from "../interpret.js"

// ---------------------------------------------------------------------------
// Mock resolver helper
// ---------------------------------------------------------------------------

function mockResolver(
  overrides?: Partial<MaterializeResolver>,
): MaterializeResolver {
  return {
    resolveValue: () => undefined,
    resolveText: () => undefined,
    resolveCounter: () => undefined,
    resolveRichText: () => undefined,
    resolveLength: () => 0,
    resolveKeys: () => [],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createMaterializeInterpreter", () => {
  // ── Zero fallback ────────────────────────────────────────────────────────
  // A single composite schema exercises all zero-fallback paths in one pass:
  // scalar (string, number, boolean), text, counter, empty sequence, empty
  // map, and nested products. The all-undefined mock resolver triggers every
  // zero fallback path simultaneously.

  it("produces structural zeros for all schema kinds when resolver returns nothing", () => {
    const resolver = mockResolver()
    const interp = createMaterializeInterpreter(resolver)
    const schema = Schema.struct({
      title: Schema.text(),
      viewCount: Schema.counter(),
      name: Schema.string(),
      active: Schema.boolean(),
      tags: Schema.list(Schema.string()),
      metadata: Schema.record(Schema.any()),
      settings: Schema.struct({
        darkMode: Schema.boolean(),
        fontSize: Schema.number(),
      }),
    })

    const result = interpret(schema, interp, undefined)
    expect(result).toEqual({
      title: "",
      viewCount: 0,
      name: "",
      active: false,
      tags: [],
      metadata: {},
      settings: { darkMode: false, fontSize: 0 },
    })
  })

  // ── Nullable sum (positional) ────────────────────────────────────────────
  // The nullable sum is the bug-fix site: undefined → null, null → null
  // branch, non-null → inner branch. Each path through the sum handler is
  // a distinct behavioral contract.

  it("nullable sum: undefined from resolver → structural zero (null)", () => {
    const resolver = mockResolver()
    const interp = createMaterializeInterpreter(resolver)
    const schema = Schema.struct({ value: Schema.string().nullable() })

    const result = interpret(schema, interp, undefined)
    expect(result).toEqual({ value: null })
  })

  it("nullable sum: null from resolver → null branch", () => {
    const resolver = mockResolver({ resolveValue: () => null })
    const interp = createMaterializeInterpreter(resolver)
    const schema = Schema.struct({ value: Schema.number().nullable() })

    const result = interpret(schema, interp, undefined)
    expect(result).toEqual({ value: null })
  })

  it("nullable sum: non-null from resolver → inner branch", () => {
    const resolver = mockResolver({ resolveValue: () => "hello" })
    const interp = createMaterializeInterpreter(resolver)
    const schema = Schema.struct({ value: Schema.string().nullable() })

    const result = interpret(schema, interp, undefined)
    expect(result).toEqual({ value: "hello" })
  })

  // ── Discriminated sum ────────────────────────────────────────────────────

  it("discriminated sum: undefined from resolver → first variant zero", () => {
    const resolver = mockResolver()
    const interp = createMaterializeInterpreter(resolver)
    const schema = Schema.struct({
      node: Schema.discriminatedUnion("type", [
        Schema.struct({
          type: Schema.string("text"),
          content: Schema.string(),
        }),
        Schema.struct({ type: Schema.string("image"), url: Schema.string() }),
      ]),
    })

    const result = interpret(schema, interp, undefined)
    expect(result).toEqual({ node: { type: "text", content: "" } })
  })

  it("discriminated sum: dispatches to variant matching the discriminant", () => {
    const resolver = mockResolver({
      resolveValue: (path: Path) => {
        const formatted = path.format()
        if (formatted === "node") return { type: "image" }
        if (formatted === "node.type") return "image"
        if (formatted === "node.url") return "https://example.com/pic.png"
        return undefined
      },
    })
    const interp = createMaterializeInterpreter(resolver)
    const schema = Schema.struct({
      node: Schema.discriminatedUnion("type", [
        Schema.struct({
          type: Schema.string("text"),
          content: Schema.string(),
        }),
        Schema.struct({ type: Schema.string("image"), url: Schema.string() }),
      ]),
    })

    const result = interpret(schema, interp, undefined)
    expect(result).toEqual({
      node: { type: "image", url: "https://example.com/pic.png" },
    })
  })

  // ── Container shape resolution ───────────────────────────────────────────

  it("sequence: iterates resolveLength times", () => {
    const resolver = mockResolver({
      resolveLength: () => 3,
      resolveValue: () => "x",
    })
    const interp = createMaterializeInterpreter(resolver)
    const schema = Schema.struct({ items: Schema.list(Schema.string()) })

    const result = interpret(schema, interp, undefined)
    expect(result).toEqual({ items: ["x", "x", "x"] })
  })

  it("map: iterates resolveKeys entries", () => {
    const resolver = mockResolver({
      resolveKeys: () => ["a", "b"],
      resolveValue: () => 7,
    })
    const interp = createMaterializeInterpreter(resolver)
    const schema = Schema.struct({ data: Schema.record(Schema.number()) })

    const result = interpret(schema, interp, undefined)
    expect(result).toEqual({ data: { a: 7, b: 7 } })
  })

  // ── Set: array shape, distinct from map ─────────────────────────────────
  // Set materializes to T[] (matching Plain<SetSchema<I>> = Plain<I>[]),
  // NOT to Record<string, T>. This is the one place the catamorphism's
  // separate `set` branch carries semantic weight vs. `map`.

  it("set: empty resolver → []", () => {
    const resolver = mockResolver()
    const interp = createMaterializeInterpreter(resolver)
    const schema = Schema.struct({ tags: Schema.set(Schema.string()) })

    const result = interpret(schema, interp, undefined)
    expect(result).toEqual({ tags: [] })
    expect(Array.isArray((result as { tags: unknown }).tags)).toBe(true)
  })

  it("set: collects resolveKeys into array, item callback yields values", () => {
    const resolver = mockResolver({
      resolveKeys: () => ["alice", "bob"],
      resolveValue: (path: Path) => path.segments.at(-1)?.resolve(),
    })
    const interp = createMaterializeInterpreter(resolver)
    const schema = Schema.struct({ tags: Schema.set(Schema.string()) })

    const result = interpret(schema, interp, undefined)
    expect(result).toEqual({ tags: ["alice", "bob"] })
    expect(Array.isArray((result as { tags: unknown }).tags)).toBe(true)
  })

  it("type-level: Plain<set> is an array, distinct from Plain<map>", () => {
    const schema = Schema.struct({
      tags: Schema.set(Schema.string()),
      meta: Schema.record(Schema.string()),
    })
    expectTypeOf<Plain<typeof schema>>().toEqualTypeOf<{
      tags: string[]
      meta: { [key: string]: string }
    }>()
  })

  // ── Regression: sequence and movable use the same array-collector ───────
  // Phase 1 unified sequence/movable/set under shared collectArrayByLength /
  // collectArrayByKeys helpers. These assertions catch a regression where
  // any of the three diverges from array shape.

  it("regression: sequence, movable, set all produce arrays", () => {
    const resolver = mockResolver({
      resolveLength: () => 2,
      resolveKeys: () => ["x", "y"],
      resolveValue: () => "v",
    })
    const interp = createMaterializeInterpreter(resolver)
    const schema = Schema.struct({
      seq: Schema.list(Schema.string()),
      mov: Schema.movableList(Schema.string()),
      set: Schema.set(Schema.string()),
    })

    const result = interpret(schema, interp, undefined) as Record<
      string,
      unknown
    >
    expect(Array.isArray(result.seq)).toBe(true)
    expect(Array.isArray(result.mov)).toBe(true)
    expect(Array.isArray(result.set)).toBe(true)
  })
})

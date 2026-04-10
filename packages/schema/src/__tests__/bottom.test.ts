import { describe, expect, it } from "vitest"
import { interpret, Schema } from "../index.js"
import type { Interpreter } from "../interpret.js"
import type { HasCall, HasNavigation, HasRead } from "../interpreters/bottom.js"
import { bottomInterpreter, CALL, makeCarrier } from "../interpreters/bottom.js"

// ===========================================================================
// Shared fixtures
// ===========================================================================

const structuralDocSchema = Schema.struct({
  settings: Schema.struct({
    darkMode: Schema.boolean(),
    fontSize: Schema.number(),
  }),
  metadata: Schema.record(Schema.any()),
})

const annotatedDocSchema = Schema.struct({
  title: Schema.text(),
  count: Schema.counter(),
  messages: Schema.list(
    Schema.struct({
      author: Schema.string(),
      body: Schema.string(),
    }),
  ),
})

const sequenceSchema = Schema.list(Schema.string())

const mapSchema = Schema.record(Schema.number())

const sumSchema = Schema.struct({
  item: Schema.discriminatedUnion("type", [
    Schema.struct({ type: Schema.string("text"), body: Schema.string() }),
    Schema.struct({ type: Schema.string("image"), url: Schema.string() }),
  ]),
})

const nullableSchema = Schema.struct({
  bio: Schema.nullable(Schema.string()),
})

function interpretBottom(schema: Parameters<typeof interpret>[0]) {
  return interpret(schema, bottomInterpreter, undefined)
}

// ===========================================================================
// makeCarrier
// ===========================================================================

describe("makeCarrier", () => {
  it("returns a callable function", () => {
    const carrier = makeCarrier()
    expect(typeof carrier).toBe("function")
  })

  it("has a [CALL] symbol property", () => {
    const carrier = makeCarrier()
    expect(CALL in carrier).toBe(true)
    expect(typeof carrier[CALL]).toBe("function")
  })

  it("calling the carrier delegates to [CALL]", () => {
    const carrier = makeCarrier() as any
    // Replace the CALL slot with a spy
    let called = false
    carrier[CALL] = (...args: unknown[]) => {
      called = true
      return args
    }
    const result = carrier("a", "b")
    expect(called).toBe(true)
    expect(result).toEqual(["a", "b"])
  })

  it("calling the carrier with default CALL throws", () => {
    const carrier = makeCarrier() as any
    expect(() => carrier()).toThrow("No call behavior configured")
  })

  it("carrier is a real function object — properties can be attached", () => {
    const carrier = makeCarrier() as any
    carrier.customProp = 42
    expect(carrier.customProp).toBe(42)

    // Symbol properties work too
    const sym = Symbol("test")
    carrier[sym] = "hello"
    expect(carrier[sym]).toBe("hello")
  })

  it("[CALL] slot is writable", () => {
    const carrier = makeCarrier() as any
    carrier[CALL] = () => "replaced"
    expect(carrier()).toBe("replaced")
  })
})

// ===========================================================================
// bottomInterpreter: callable carriers for every schema kind
// ===========================================================================

describe("bottom: scalar", () => {
  it("produces a callable function carrier", () => {
    const result = interpretBottom(Schema.string()) as any
    expect(typeof result).toBe("function")
  })

  it("carrier has [CALL] symbol", () => {
    const result = interpretBottom(Schema.number()) as any
    expect(CALL in result).toBe(true)
  })

  it("calling the carrier throws (no call behavior configured)", () => {
    const result = interpretBottom(Schema.boolean()) as any
    expect(() => result()).toThrow("No call behavior configured")
  })
})

describe("bottom: product", () => {
  it("produces a callable function carrier", () => {
    const result = interpretBottom(
      Schema.struct({ name: Schema.string(), age: Schema.number() }),
    ) as any
    expect(typeof result).toBe("function")
  })

  it("carrier has [CALL] symbol", () => {
    const result = interpretBottom(Schema.struct({ x: Schema.string() })) as any
    expect(CALL in result).toBe(true)
  })

  it("field thunks are not eagerly forced", () => {
    // The bottom interpreter ignores field thunks entirely.
    // We verify this indirectly: the carrier has no field properties.
    const result = interpretBottom(
      Schema.struct({ name: Schema.string(), age: Schema.number() }),
    ) as any
    expect(Object.keys(result).length).toBe(0)
  })
})

describe("bottom: sequence", () => {
  it("produces a callable function carrier", () => {
    const result = interpretBottom(sequenceSchema) as any
    expect(typeof result).toBe("function")
  })

  it("carrier has [CALL] symbol", () => {
    const result = interpretBottom(sequenceSchema) as any
    expect(CALL in result).toBe(true)
  })
})

describe("bottom: map", () => {
  it("produces a callable function carrier", () => {
    const result = interpretBottom(mapSchema) as any
    expect(typeof result).toBe("function")
  })

  it("carrier has [CALL] symbol", () => {
    const result = interpretBottom(mapSchema) as any
    expect(CALL in result).toBe(true)
  })
})

describe("bottom: sum (discriminated)", () => {
  it("produces a callable function carrier", () => {
    const result = interpretBottom(sumSchema) as any
    expect(typeof result).toBe("function")
    // Bottom's product case ignores field thunks, so .item does not exist
    expect(result.item).toBeUndefined()
  })

  it("carrier has [CALL] symbol", () => {
    const result = interpretBottom(sumSchema) as any
    expect(CALL in result).toBe(true)
  })
})

describe("bottom: sum (nullable / positional)", () => {
  it("produces a callable function carrier", () => {
    // The struct schema wraps nullable — bottom's product ignores fields,
    // returns a carrier.
    const result = interpretBottom(nullableSchema) as any
    expect(typeof result).toBe("function")
  })
})

// ===========================================================================
// bottomInterpreter: first-class types
// ===========================================================================

describe("bottom: text", () => {
  it("text produces a callable carrier", () => {
    const result = interpretBottom(Schema.text()) as any
    expect(typeof result).toBe("function")
    expect(CALL in result).toBe(true)
  })
})

describe("bottom: counter", () => {
  it("counter produces a callable carrier", () => {
    const result = interpretBottom(Schema.counter()) as any
    expect(typeof result).toBe("function")
    expect(CALL in result).toBe(true)
  })
})

describe("bottom: movableList", () => {
  it("movableList delegates to inner (sequence carrier)", () => {
    const schema = Schema.struct({
      items: Schema.movableList(
        Schema.list(Schema.struct({ title: Schema.string() })),
      ),
    })
    // struct → product (bottom ignores fields), so we get a carrier
    const result = interpretBottom(schema) as any
    expect(typeof result).toBe("function")
  })
})

describe("bottom: tree", () => {
  it("tree produces a callable carrier", () => {
    const schema = Schema.tree(Schema.string())
    const result = interpretBottom(schema) as any
    expect(typeof result).toBe("function")
    expect(CALL in result).toBe(true)
  })
})

// ===========================================================================
// bottomInterpreter: full document tree
// ===========================================================================

describe("bottom: full document tree", () => {
  it("produces a carrier for a complex annotated doc schema", () => {
    const result = interpretBottom(annotatedDocSchema) as any
    expect(typeof result).toBe("function")
    expect(CALL in result).toBe(true)
    // Calling throws since no call behavior is configured
    expect(() => result()).toThrow("No call behavior configured")
  })

  it("every carrier in the tree is independently callable", () => {
    // Interpret individual parts to verify each kind gets a carrier
    const text = interpretBottom(Schema.text()) as any
    const counter = interpretBottom(Schema.counter()) as any
    const list = interpretBottom(Schema.list(Schema.string())) as any
    const record = interpretBottom(Schema.record(Schema.number())) as any
    const struct = interpretBottom(Schema.struct({ a: Schema.string() })) as any
    const scalar = interpretBottom(Schema.string()) as any

    for (const carrier of [text, counter, list, record, struct, scalar]) {
      expect(typeof carrier).toBe("function")
      expect(CALL in carrier).toBe(true)
      expect(() => carrier()).toThrow("No call behavior configured")
    }
  })
})

// ===========================================================================
// CALL symbol identity
// ===========================================================================

describe("CALL symbol", () => {
  it("is stable across references (Symbol.for identity)", () => {
    const other = Symbol.for("kyneta:call")
    expect(CALL).toBe(other)
  })

  it("different carriers share the same CALL symbol", () => {
    const a = makeCarrier()
    const b = makeCarrier()
    expect(CALL in a).toBe(true)
    expect(CALL in b).toBe(true)
    // Both use the same symbol key
    expect(Object.getOwnPropertySymbols(a)).toContainEqual(CALL)
    expect(Object.getOwnPropertySymbols(b)).toContainEqual(CALL)
  })
})

// ===========================================================================
// Type-level tests (compile-time assertions)
// ===========================================================================

describe("type-level: capability lattice", () => {
  it("bottomInterpreter is Interpreter<unknown, HasCall>", () => {
    // If this compiles, the type is correct
    const _check: Interpreter<unknown, HasCall> = bottomInterpreter
    void _check
  })

  it("bottomInterpreter result satisfies HasCall", () => {
    const result = interpretBottom(Schema.string())
    const _check: HasCall = result
    void _check
  })

  it("HasCall does NOT satisfy HasNavigation (negative test)", () => {
    // We can't directly test that a type does NOT extend another
    // in vitest without expectTypeOf. Instead, we verify that
    // HasNavigation requires NAVIGATION brand which HasCall lacks.
    //
    // The following would be a compile error if uncommented:
    // const result = interpretBottom(Schema.string())
    // const _bad: HasNavigation = result
    //               ^^^ Type 'HasCall' is not assignable to type 'HasNavigation'
    //
    // We use @ts-expect-error to assert this IS an error:
    // @ts-expect-error — HasCall is not assignable to HasNavigation
    const _negative: HasNavigation = interpretBottom(Schema.string())
    void _negative
  })

  it("HasNavigation extends HasCall", () => {
    // If this compiles, HasNavigation is assignable to HasCall
    const _check: (n: HasNavigation) => HasCall = n => n
    void _check
  })

  it("HasNavigation does NOT satisfy HasRead (negative test)", () => {
    // HasRead requires READ_BRAND which HasNavigation lacks.
    // @ts-expect-error — HasNavigation is not assignable to HasRead
    const _negative: HasRead = {} as HasNavigation
    void _negative
  })

  it("HasRead extends HasNavigation", () => {
    // If this compiles, HasRead is assignable to HasNavigation
    const _check: (r: HasRead) => HasNavigation = r => r
    void _check
  })

  it("HasRead extends HasCall", () => {
    // Transitivity: HasRead → HasNavigation → HasCall
    const _check: (r: HasRead) => HasCall = r => r
    void _check
  })
})
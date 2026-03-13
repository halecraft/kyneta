import { describe, expect, it } from "vitest"
import {
  Schema,
  LoroSchema,
  interpret,
} from "../index.js"
import {
  READ,
  makeCarrier,
  bottomInterpreter,
} from "../interpreters/bottom.js"
import type {
  HasRead,
  HasNavigation,
} from "../interpreters/bottom.js"
import type { Interpreter } from "../interpret.js"

// ===========================================================================
// Shared fixtures
// ===========================================================================

const structuralDocSchema = Schema.doc({
  settings: Schema.struct({
    darkMode: Schema.boolean(),
    fontSize: Schema.number(),
  }),
  metadata: Schema.record(Schema.any()),
})

const loroDocSchema = LoroSchema.doc({
  title: LoroSchema.text(),
  count: LoroSchema.counter(),
  messages: Schema.list(
    Schema.struct({
      author: Schema.string(),
      body: Schema.string(),
    }),
  ),
})

const sequenceSchema = Schema.list(Schema.string())

const mapSchema = Schema.record(Schema.number())

const sumSchema = Schema.doc({
  item: Schema.discriminatedUnion("type", {
    text: Schema.struct({ body: Schema.string() }),
    image: Schema.struct({ url: Schema.string() }),
  }),
})

const nullableSchema = Schema.doc({
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

  it("has a [READ] symbol property", () => {
    const carrier = makeCarrier()
    expect(READ in carrier).toBe(true)
    expect(typeof carrier[READ]).toBe("function")
  })

  it("calling the carrier delegates to [READ]", () => {
    const carrier = makeCarrier() as any
    // Replace the READ slot with a spy
    let called = false
    carrier[READ] = (...args: unknown[]) => {
      called = true
      return args
    }
    const result = carrier("a", "b")
    expect(called).toBe(true)
    expect(result).toEqual(["a", "b"])
  })

  it("calling the carrier with default READ throws", () => {
    const carrier = makeCarrier() as any
    expect(() => carrier()).toThrow("No reader configured")
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

  it("[READ] slot is writable", () => {
    const carrier = makeCarrier() as any
    carrier[READ] = () => "replaced"
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

  it("carrier has [READ] symbol", () => {
    const result = interpretBottom(Schema.number()) as any
    expect(READ in result).toBe(true)
  })

  it("calling the carrier throws (no reader configured)", () => {
    const result = interpretBottom(Schema.boolean()) as any
    expect(() => result()).toThrow("No reader configured")
  })
})

describe("bottom: product", () => {
  it("produces a callable function carrier", () => {
    const result = interpretBottom(
      Schema.struct({ name: Schema.string(), age: Schema.number() }),
    ) as any
    expect(typeof result).toBe("function")
  })

  it("carrier has [READ] symbol", () => {
    const result = interpretBottom(
      Schema.struct({ x: Schema.string() }),
    ) as any
    expect(READ in result).toBe(true)
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

  it("carrier has [READ] symbol", () => {
    const result = interpretBottom(sequenceSchema) as any
    expect(READ in result).toBe(true)
  })
})

describe("bottom: map", () => {
  it("produces a callable function carrier", () => {
    const result = interpretBottom(mapSchema) as any
    expect(typeof result).toBe("function")
  })

  it("carrier has [READ] symbol", () => {
    const result = interpretBottom(mapSchema) as any
    expect(READ in result).toBe(true)
  })
})

describe("bottom: sum (discriminated)", () => {
  it("produces a callable function carrier", () => {
    const result = interpretBottom(sumSchema) as any
    expect(typeof result).toBe("function")
    // Bottom's product case ignores field thunks, so .item does not exist
    expect(result.item).toBeUndefined()
  })

  it("carrier has [READ] symbol", () => {
    const result = interpretBottom(sumSchema) as any
    expect(READ in result).toBe(true)
  })
})

describe("bottom: sum (nullable / positional)", () => {
  it("produces a callable function carrier", () => {
    // The doc schema wraps nullable — bottom's annotated("doc") delegates
    // to inner product, product ignores fields, returns a carrier.
    const result = interpretBottom(nullableSchema) as any
    expect(typeof result).toBe("function")
  })
})

// ===========================================================================
// bottomInterpreter: annotated nodes
// ===========================================================================

describe("bottom: annotated", () => {
  it("text annotation produces a callable carrier", () => {
    const result = interpretBottom(LoroSchema.text()) as any
    expect(typeof result).toBe("function")
    expect(READ in result).toBe(true)
  })

  it("counter annotation produces a callable carrier", () => {
    const result = interpretBottom(LoroSchema.counter()) as any
    expect(typeof result).toBe("function")
    expect(READ in result).toBe(true)
  })

  it("doc annotation delegates to inner (product carrier)", () => {
    const result = interpretBottom(structuralDocSchema) as any
    // doc delegates to its inner product; bottom's product returns a carrier
    expect(typeof result).toBe("function")
    expect(READ in result).toBe(true)
  })

  it("movableList annotation delegates to inner (sequence carrier)", () => {
    const schema = LoroSchema.doc({
      items: LoroSchema.movableList(
        Schema.list(Schema.struct({ title: Schema.string() })),
      ),
    })
    // doc → product (bottom ignores fields), so we get a carrier
    const result = interpretBottom(schema) as any
    expect(typeof result).toBe("function")
  })

  it("tree annotation delegates to inner", () => {
    const schema = Schema.annotated("tree", Schema.string())
    const result = interpretBottom(schema) as any
    expect(typeof result).toBe("function")
    expect(READ in result).toBe(true)
  })

  it("unknown annotation with inner delegates to inner", () => {
    const schema = Schema.annotated("custom-thing", Schema.number())
    const result = interpretBottom(schema) as any
    expect(typeof result).toBe("function")
    expect(READ in result).toBe(true)
  })

  it("leaf annotation (no inner) produces its own carrier", () => {
    // annotated with no inner schema — treated as a leaf
    const schema = Schema.annotated("leaf-marker", undefined as any)
    const result = interpretBottom(schema) as any
    expect(typeof result).toBe("function")
    expect(READ in result).toBe(true)
  })
})

// ===========================================================================
// bottomInterpreter: full document tree
// ===========================================================================

describe("bottom: full document tree", () => {
  it("produces a carrier for a complex Loro doc schema", () => {
    const result = interpretBottom(loroDocSchema) as any
    expect(typeof result).toBe("function")
    expect(READ in result).toBe(true)
    // Calling throws since no reader is configured
    expect(() => result()).toThrow("No reader configured")
  })

  it("every carrier in the tree is independently callable", () => {
    // Interpret individual parts to verify each kind gets a carrier
    const text = interpretBottom(LoroSchema.text()) as any
    const counter = interpretBottom(LoroSchema.counter()) as any
    const list = interpretBottom(Schema.list(Schema.string())) as any
    const record = interpretBottom(Schema.record(Schema.number())) as any
    const struct = interpretBottom(
      Schema.struct({ a: Schema.string() }),
    ) as any
    const scalar = interpretBottom(Schema.string()) as any

    for (const carrier of [text, counter, list, record, struct, scalar]) {
      expect(typeof carrier).toBe("function")
      expect(READ in carrier).toBe(true)
      expect(() => carrier()).toThrow("No reader configured")
    }
  })
})

// ===========================================================================
// READ symbol identity
// ===========================================================================

describe("READ symbol", () => {
  it("is stable across references (Symbol.for identity)", () => {
    const other = Symbol.for("kyneta:read")
    expect(READ).toBe(other)
  })

  it("different carriers share the same READ symbol", () => {
    const a = makeCarrier()
    const b = makeCarrier()
    expect(READ in a).toBe(true)
    expect(READ in b).toBe(true)
    // Both use the same symbol key
    expect(Object.getOwnPropertySymbols(a)).toContainEqual(READ)
    expect(Object.getOwnPropertySymbols(b)).toContainEqual(READ)
  })
})

// ===========================================================================
// Type-level tests (compile-time assertions)
// ===========================================================================

describe("type-level: capability lattice", () => {
  it("bottomInterpreter is Interpreter<unknown, HasRead>", () => {
    // If this compiles, the type is correct
    const _check: Interpreter<unknown, HasRead> = bottomInterpreter
    void _check
  })

  it("bottomInterpreter result satisfies HasRead", () => {
    const result = interpretBottom(Schema.string())
    const _check: HasRead = result
    void _check
  })

  it("HasRead does NOT satisfy HasNavigation (negative test)", () => {
    // We can't directly test that a type does NOT extend another
    // in vitest without expectTypeOf. Instead, we verify that
    // HasNavigation requires NAVIGATION brand which HasRead lacks.
    //
    // The following would be a compile error if uncommented:
    // const result = interpretBottom(Schema.string())
    // const _bad: HasNavigation = result
    //               ^^^ Type 'HasRead' is not assignable to type 'HasNavigation'
    //
    // We use @ts-expect-error to assert this IS an error:
    // @ts-expect-error — HasRead is not assignable to HasNavigation
    const _negative: HasNavigation = interpretBottom(Schema.string())
    void _negative
  })

  it("HasNavigation extends HasRead", () => {
    // If this compiles, HasNavigation is assignable to HasRead
    const _check: (n: HasNavigation) => HasRead = (n) => n
    void _check
  })
})
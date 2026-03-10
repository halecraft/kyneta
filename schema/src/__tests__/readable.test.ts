import { describe, expect, it } from "vitest"
import {
  Schema,
  LoroSchema,
  interpret,
  readableInterpreter,
  INVALIDATE,
  SET_HANDLER,
  DELETE_HANDLER,
  enrich,
  withChangefeed,
  createChangefeedContext,
  createWritableContext,
  hasChangefeed,
} from "../index.js"
import type { RefContext, Readable } from "../index.js"

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

function createReadOnlyDoc(storeOverrides: Record<string, unknown> = {}) {
  const store = {
    settings: { darkMode: false, fontSize: 14 },
    metadata: { version: 1 },
    ...storeOverrides,
  }
  const ctx: RefContext = { store }
  const doc = interpret(structuralDocSchema, readableInterpreter, ctx) as any
  return { store, ctx, doc }
}

const loroDocSchema = LoroSchema.doc({
  title: LoroSchema.text(),
  count: LoroSchema.counter(),
  messages: Schema.list(
    Schema.struct({
      author: Schema.string(),
      body: LoroSchema.text(),
    }),
  ),
  settings: LoroSchema.plain.struct({
    darkMode: LoroSchema.plain.boolean(),
    fontSize: LoroSchema.plain.number(),
  }),
  metadata: Schema.record(LoroSchema.plain.any()),
})

function createReadOnlyLoroDoc(storeOverrides: Record<string, unknown> = {}) {
  const store = {
    title: "Hello",
    count: 42,
    messages: [{ author: "Alice", body: "Hi" }],
    settings: { darkMode: false, fontSize: 14 },
    metadata: { version: 1 },
    ...storeOverrides,
  }
  const ctx: RefContext = { store }
  const doc = interpret(loroDocSchema, readableInterpreter, ctx) as any
  return { store, ctx, doc }
}

// ===========================================================================
// Read-only document — basic callable behavior
// ===========================================================================

describe("readable: callable refs", () => {
  it("produces a navigable tree from a read-only context", () => {
    const { doc } = createReadOnlyDoc()
    expect(doc).toBeDefined()
    expect(typeof doc).toBe("function")
  })

  it("scalar ref returns current value when called", () => {
    const { doc } = createReadOnlyDoc()
    expect(doc.settings.darkMode()).toBe(false)
    expect(doc.settings.fontSize()).toBe(14)
  })

  it("scalar ref reflects direct store mutations (live read)", () => {
    const { store, doc } = createReadOnlyDoc()
    ;(store.settings as Record<string, unknown>).fontSize = 20
    expect(doc.settings.fontSize()).toBe(20)
  })

  it("text ref returns current string when called", () => {
    const { doc } = createReadOnlyLoroDoc()
    expect(doc.title()).toBe("Hello")
  })

  it("counter ref returns current number when called", () => {
    const { doc } = createReadOnlyLoroDoc()
    expect(doc.count()).toBe(42)
  })

  it("counter ref returns 0 when store value is not a number", () => {
    const { doc } = createReadOnlyLoroDoc({ count: "not a number" })
    expect(doc.count()).toBe(0)
  })

  it("text ref returns empty string when store value is null", () => {
    const { doc } = createReadOnlyLoroDoc({ title: null })
    expect(doc.title()).toBe("")
  })

  it("product ref returns deep plain snapshot when called", () => {
    const { doc } = createReadOnlyDoc()
    expect(doc.settings()).toEqual({ darkMode: false, fontSize: 14 })
  })

  it("doc ref returns full deep snapshot when called", () => {
    const { store, doc } = createReadOnlyDoc()
    expect(doc()).toEqual(store)
  })

  it("typeof every ref is 'function'", () => {
    const { doc } = createReadOnlyDoc()
    expect(typeof doc).toBe("function")
    expect(typeof doc.settings).toBe("function")
    expect(typeof doc.settings.darkMode).toBe("function")
    expect(typeof doc.metadata).toBe("function")
  })
})

// ===========================================================================
// [Symbol.toPrimitive] and coercion
// ===========================================================================

describe("readable: toPrimitive coercion", () => {
  it("counter ref in template literal produces string", () => {
    const { doc } = createReadOnlyLoroDoc()
    expect(`Stars: ${doc.count}`).toBe("Stars: 42")
  })

  it("text ref in template literal produces string", () => {
    const { doc } = createReadOnlyLoroDoc()
    expect(`Title: ${doc.title}`).toBe("Title: Hello")
  })

  it("counter toPrimitive with 'number' hint returns number", () => {
    const { doc } = createReadOnlyLoroDoc()
    expect(doc.count[Symbol.toPrimitive]("number")).toBe(42)
  })

  it("counter toPrimitive with 'string' hint returns string", () => {
    const { doc } = createReadOnlyLoroDoc()
    expect(doc.count[Symbol.toPrimitive]("string")).toBe("42")
  })

  it("counter toPrimitive with 'default' hint returns number", () => {
    const { doc } = createReadOnlyLoroDoc()
    expect(doc.count[Symbol.toPrimitive]("default")).toBe(42)
  })

  it("String(textRef) works via toPrimitive", () => {
    const { doc } = createReadOnlyLoroDoc()
    expect(String(doc.title)).toBe("Hello")
  })

  it("scalar toPrimitive with 'string' hint returns String(value)", () => {
    const { doc } = createReadOnlyDoc()
    expect(doc.settings.fontSize[Symbol.toPrimitive]("string")).toBe("14")
  })

  it("scalar toPrimitive with 'default' hint returns raw value", () => {
    const { doc } = createReadOnlyDoc()
    expect(doc.settings.fontSize[Symbol.toPrimitive]("default")).toBe(14)
  })
})

// ===========================================================================
// Product — lazy getters and structural navigation
// ===========================================================================

describe("readable: product lazy getters", () => {
  it("returns the same ref on repeated access (referential identity)", () => {
    const { doc } = createReadOnlyDoc()
    expect(doc.settings).toBe(doc.settings)
  })

  it("Object.keys returns only schema field names", () => {
    const { doc } = createReadOnlyDoc()
    expect(Object.keys(doc)).toEqual(["settings", "metadata"])
  })

  it("product field named 'name' shadows Function.prototype.name", () => {
    const schema = Schema.doc({
      name: Schema.string(),
    })
    const store = { name: "test-value" }
    const ctx: RefContext = { store }
    const doc = interpret(schema, readableInterpreter, ctx) as any
    // The lazy getter should return a child ref, not the function's name
    expect(typeof doc.name).toBe("function")
    expect(doc.name()).toBe("test-value")
  })

  it("product field named 'length' shadows Function.prototype.length", () => {
    const schema = Schema.doc({
      length: Schema.number(),
    })
    const store = { length: 99 }
    const ctx: RefContext = { store }
    const doc = interpret(schema, readableInterpreter, ctx) as any
    expect(typeof doc.length).toBe("function")
    expect(doc.length()).toBe(99)
  })
})

// ===========================================================================
// Sequence — .at(i), .length, iteration
// ===========================================================================

describe("readable: sequence ref", () => {
  it(".length reflects the store array length", () => {
    const { doc } = createReadOnlyLoroDoc()
    expect(doc.messages.length).toBe(1)
  })

  it(".at(i) returns a child ref that is itself callable", () => {
    const { doc } = createReadOnlyLoroDoc()
    const msg = doc.messages.at(0)!
    expect(typeof msg).toBe("function")
    expect(msg.author()).toBe("Alice")
  })

  it("sequence ref is callable and returns plain array", () => {
    const { doc } = createReadOnlyLoroDoc()
    const arr = doc.messages()
    expect(Array.isArray(arr)).toBe(true)
    expect(arr).toEqual([{ author: "Alice", body: "Hi" }])
  })

  it("iteration via for..of yields child refs", () => {
    const { doc } = createReadOnlyLoroDoc({
      messages: [
        { author: "Alice", body: "Hi" },
        { author: "Bob", body: "Hey" },
      ],
    })
    const authors: string[] = []
    for (const msg of doc.messages) {
      authors.push(msg.author())
    }
    expect(authors).toEqual(["Alice", "Bob"])
  })

  it(".at(i) caches child refs (referential identity)", () => {
    const { doc } = createReadOnlyLoroDoc()
    expect(doc.messages.at(0)).toBe(doc.messages.at(0))
  })

  it(".at(i) returns undefined for out-of-bounds index", () => {
    const { doc } = createReadOnlyLoroDoc()
    expect(doc.messages.at(100)).toBeUndefined()
  })

  it(".at(i) returns undefined for negative index", () => {
    const { doc } = createReadOnlyLoroDoc()
    expect(doc.messages.at(-1)).toBeUndefined()
  })
})

// ===========================================================================
// Map — Proxy with function target
// ===========================================================================

describe("readable: map via Proxy", () => {
  it("string key access returns a callable child ref", () => {
    const { doc } = createReadOnlyDoc()
    const versionRef = doc.metadata.version
    expect(typeof versionRef).toBe("function")
    expect(versionRef()).toBe(1)
  })

  it("map ref is callable and returns plain record", () => {
    const { doc } = createReadOnlyDoc()
    expect(doc.metadata()).toEqual({ version: 1 })
  })

  it("Object.keys returns the store's dynamic keys", () => {
    const { doc } = createReadOnlyDoc()
    expect(Object.keys(doc.metadata)).toEqual(["version"])
  })

  it("'in' operator checks store keys", () => {
    const { doc } = createReadOnlyDoc()
    expect("version" in doc.metadata).toBe(true)
    expect("nonexistent" in doc.metadata).toBe(false)
  })

  it("typeof map proxy is 'function'", () => {
    const { doc } = createReadOnlyDoc()
    expect(typeof doc.metadata).toBe("function")
  })

  it("map proxy rejects writes when no SET_HANDLER is installed", () => {
    const { doc } = createReadOnlyDoc()
    // In strict mode, Proxy set returning false throws TypeError
    expect(() => {
      "use strict"
      doc.metadata.newKey = "value"
    }).toThrow()
  })
})

// ===========================================================================
// Sum dispatch — discriminated and nullable
// ===========================================================================

describe("readable: discriminated sum", () => {
  const schema = Schema.doc({
    item: Schema.discriminatedUnion("type", {
      text: Schema.struct({ body: Schema.string() }),
      image: Schema.struct({ url: Schema.string() }),
    }),
  })

  it("dispatches to the correct variant based on store discriminant", () => {
    const store = { item: { type: "image", url: "pic.png" } }
    const ctx: RefContext = { store }
    const doc = interpret(schema, readableInterpreter, ctx) as any
    expect(doc.item.url()).toBe("pic.png")
  })

  it("falls back to first variant when discriminant is missing", () => {
    const store = { item: {} }
    const ctx: RefContext = { store }
    const doc = interpret(schema, readableInterpreter, ctx) as any
    expect(typeof doc.item.body).toBe("function")
  })
})

describe("readable: nullable (positional sum)", () => {
  const schema = Schema.doc({
    bio: Schema.nullable(Schema.string()),
  })

  it("null store value dispatches to the null variant", () => {
    const store = { bio: null }
    const ctx: RefContext = { store }
    const doc = interpret(schema, readableInterpreter, ctx) as any
    expect(doc.bio()).toBe(null)
  })

  it("non-null store value dispatches to the inner variant", () => {
    const store = { bio: "Hello world" }
    const ctx: RefContext = { store }
    const doc = interpret(schema, readableInterpreter, ctx) as any
    expect(doc.bio()).toBe("Hello world")
  })
})

// ===========================================================================
// Composability hooks
// ===========================================================================

describe("readable: composability hooks", () => {
  it("sequence ref has [INVALIDATE] symbol", () => {
    const { doc } = createReadOnlyLoroDoc()
    expect(typeof doc.messages[INVALIDATE]).toBe("function")
  })

  it("sequence [INVALIDATE]() clears full cache", () => {
    const { doc } = createReadOnlyLoroDoc({
      messages: [
        { author: "Alice", body: "Hi" },
        { author: "Bob", body: "Hey" },
      ],
    })
    const first = doc.messages.at(0)!
    expect(doc.messages.at(0)).toBe(first) // cached
    doc.messages[INVALIDATE]()
    // After invalidation, .at(0) creates a new ref (different identity)
    expect(doc.messages.at(0)).not.toBe(first)
  })

  it("sequence [INVALIDATE](key) clears single entry", () => {
    const { doc } = createReadOnlyLoroDoc({
      messages: [
        { author: "Alice", body: "Hi" },
        { author: "Bob", body: "Hey" },
      ],
    })
    const first = doc.messages.at(0)!
    const second = doc.messages.at(1)!
    doc.messages[INVALIDATE](0)
    // Index 0 is cleared, index 1 is preserved
    expect(doc.messages.at(0)).not.toBe(first)
    expect(doc.messages.at(1)).toBe(second)
  })

  it("map ref has [INVALIDATE] symbol", () => {
    const { doc } = createReadOnlyDoc()
    expect(typeof doc.metadata[INVALIDATE]).toBe("function")
  })

  it("map [INVALIDATE](key) clears single entry", () => {
    const { doc } = createReadOnlyDoc({
      metadata: { a: 1, b: 2 },
    })
    const aRef = doc.metadata.a
    const bRef = doc.metadata.b
    doc.metadata[INVALIDATE]("a")
    expect(doc.metadata.a).not.toBe(aRef)
    expect(doc.metadata.b).toBe(bRef)
  })

  it("map ref has [SET_HANDLER] and [DELETE_HANDLER] accessible via symbol", () => {
    const { doc } = createReadOnlyDoc()
    // Initially undefined (no mutation layer installed)
    expect(doc.metadata[SET_HANDLER]).toBeUndefined()
    expect(doc.metadata[DELETE_HANDLER]).toBeUndefined()
  })
})

// ===========================================================================
// Composition with withChangefeed
// ===========================================================================

describe("readable: composition with withChangefeed", () => {
  it("enrich(readableInterpreter, withChangefeed) attaches [CHANGEFEED] to callable refs", () => {
    const store = { title: "Hello", count: 42 }
    const schema = LoroSchema.doc({
      title: LoroSchema.text(),
      count: LoroSchema.counter(),
    })
    // withChangefeed needs WritableContext (extends RefContext)
    const wCtx = createWritableContext(store)
    const cfCtx = createChangefeedContext(wCtx)
    const enriched = enrich(readableInterpreter, withChangefeed)
    const doc = interpret(schema, enriched, cfCtx) as any

    expect(hasChangefeed(doc)).toBe(true)
    expect(hasChangefeed(doc.title)).toBe(true)
    expect(hasChangefeed(doc.count)).toBe(true)
    // Still callable
    expect(doc.title()).toBe("Hello")
    expect(doc.count()).toBe(42)
  })
})

// ===========================================================================
// Type-level tests (Readable<S>)
// ===========================================================================

describe("type-level: Readable<S>", () => {
  it("Readable<text()> has call signature returning string", () => {
    type Result = Readable<ReturnType<typeof LoroSchema.text>>
    // If this compiles, the type has a call signature
    const _check: (r: Result) => string = (r) => r()
  })

  it("Readable<counter()> has call signature returning number", () => {
    type Result = Readable<ReturnType<typeof LoroSchema.counter>>
    const _check: (r: Result) => number = (r) => r()
  })

  it("Readable<string()> has call signature returning string", () => {
    type Result = Readable<ReturnType<typeof Schema.string>>
    const _check: (r: Result) => string = (r) => r()
  })

  it("Readable<number()> has call signature returning number", () => {
    type Result = Readable<ReturnType<typeof Schema.number>>
    const _check: (r: Result) => number = (r) => r()
  })

  it("Readable<struct({...})> has typed child navigation", () => {
    const s = Schema.struct({
      name: Schema.string(),
      active: Schema.boolean(),
    })
    type Result = Readable<typeof s>
    // Children should be Readable
    const _checkName: (r: Result) => Readable<ReturnType<typeof Schema.string>> = (r) => r.name
    const _checkActive: (r: Result) => Readable<ReturnType<typeof Schema.boolean>> = (r) => r.active
  })

  it("Readable<doc({...})> has call signature and child navigation", () => {
    const s = Schema.doc({
      title: Schema.string(),
    })
    type Result = Readable<typeof s>
    // Callable
    const _checkCall: (r: Result) => { title: string } = (r) => r()
    // Navigation
    const _checkChild: (r: Result) => Readable<ReturnType<typeof Schema.string>> = (r) => r.title
  })
})
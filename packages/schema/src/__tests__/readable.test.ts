import { describe, expect, it } from "vitest"
import {
  Schema,
  LoroSchema,
  interpret,
  bottomInterpreter,
  withReadable,
  withCaching,
  INVALIDATE,
  enrich,
  withChangefeed,
  createWritableContext,
  hasChangefeed,
  replaceChange,
  sequenceChange,
  mapChange,
} from "../index.js"
import type { RefContext, Readable, ReadableMapRef } from "../index.js"

// Composed interpreter stack — functionally equivalent to the removed
// monolithic readableInterpreter.
const readableInterpreter = withCaching(withReadable(bottomInterpreter))

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

  it(".get(i) returns the plain value directly (not a function)", () => {
    const { doc } = createReadOnlyLoroDoc()
    const val = doc.messages.get(0)
    expect(typeof val).not.toBe("function")
    expect(val).toEqual({ author: "Alice", body: "Hi" })
  })

  it(".get(i) returns undefined for out-of-bounds index", () => {
    const { doc } = createReadOnlyLoroDoc()
    expect(doc.messages.get(100)).toBeUndefined()
    expect(doc.messages.get(-1)).toBeUndefined()
  })

  it(".get(i) returns a deep plain snapshot for structural items", () => {
    const { doc } = createReadOnlyLoroDoc({
      messages: [
        { author: "Alice", body: "Hi" },
        { author: "Bob", body: "Hey" },
      ],
    })
    const first = doc.messages.get(0)
    expect(first).toEqual({ author: "Alice", body: "Hi" })
    const second = doc.messages.get(1)
    expect(second).toEqual({ author: "Bob", body: "Hey" })
  })

  it(".get(i) reflects store mutations (live read)", () => {
    const store = {
      title: "Hello",
      count: 0,
      messages: [{ author: "Alice", body: "Hi" }],
      settings: { darkMode: false, fontSize: 14 },
      metadata: {},
    }
    const ctx: RefContext = { store }
    const doc = interpret(loroDocSchema, readableInterpreter, ctx) as any
    expect(doc.messages.get(0)).toEqual({ author: "Alice", body: "Hi" })
    // Mutate store directly
    ;(store.messages as unknown[]).push({ author: "Bob", body: "Hey" })
    doc.messages[INVALIDATE](replaceChange([]))
    expect(doc.messages.get(1)).toEqual({ author: "Bob", body: "Hey" })
  })
})

// ===========================================================================
// Map — Map-like API with function target
// ===========================================================================

describe("readable: map ref", () => {
  it(".at(key) returns a callable child ref", () => {
    const { doc } = createReadOnlyDoc()
    const versionRef = doc.metadata.at("version")
    expect(typeof versionRef).toBe("function")
    expect(versionRef!()).toBe(1)
  })

  it(".at(key) returns undefined for missing key", () => {
    const { doc } = createReadOnlyDoc()
    expect(doc.metadata.at("nonexistent")).toBeUndefined()
  })

  it("map ref is callable and returns plain record", () => {
    const { doc } = createReadOnlyDoc()
    expect(doc.metadata()).toEqual({ version: 1 })
  })

  it(".keys() returns the store's dynamic keys", () => {
    const { doc } = createReadOnlyDoc()
    expect(doc.metadata.keys()).toEqual(["version"])
  })

  it(".has(key) checks store keys", () => {
    const { doc } = createReadOnlyDoc()
    expect(doc.metadata.has("version")).toBe(true)
    expect(doc.metadata.has("nonexistent")).toBe(false)
  })

  it("typeof map ref is 'function'", () => {
    const { doc } = createReadOnlyDoc()
    expect(typeof doc.metadata).toBe("function")
  })

  it(".size reflects store entry count", () => {
    const { doc } = createReadOnlyDoc()
    expect(doc.metadata.size).toBe(1)
  })

  it(".size reflects store with multiple entries", () => {
    const { doc } = createReadOnlyDoc({ metadata: { a: 1, b: 2, c: 3 } })
    expect(doc.metadata.size).toBe(3)
  })

  it(".entries() yields [key, childRef] pairs", () => {
    const { doc } = createReadOnlyDoc({ metadata: { a: 1, b: 2 } })
    const entries = [...doc.metadata.entries()]
    expect(entries.length).toBe(2)
    expect(entries[0]![0]).toBe("a")
    expect(typeof entries[0]![1]).toBe("function")
    expect(entries[0]![1]()).toBe(1)
  })

  it(".values() yields child refs", () => {
    const { doc } = createReadOnlyDoc({ metadata: { a: 1, b: 2 } })
    const vals = [...doc.metadata.values()]
    expect(vals.length).toBe(2)
    expect(typeof vals[0]).toBe("function")
    expect(vals[0]()).toBe(1)
  })

  it("[Symbol.iterator] yields [key, childRef] pairs", () => {
    const { doc } = createReadOnlyDoc({ metadata: { x: 10, y: 20 } })
    const pairs: [string, unknown][] = []
    for (const entry of doc.metadata) {
      pairs.push(entry)
    }
    expect(pairs.length).toBe(2)
    expect(pairs[0]![0]).toBe("x")
    expect(typeof pairs[0]![1]).toBe("function")
  })

  it(".at(key) caches child refs (referential identity)", () => {
    const { doc } = createReadOnlyDoc()
    expect(doc.metadata.at("version")).toBe(doc.metadata.at("version"))
  })

  it(".get(key) returns the plain value directly (not a function)", () => {
    const { doc } = createReadOnlyDoc()
    const val = doc.metadata.get("version")
    expect(typeof val).not.toBe("function")
    expect(val).toBe(1)
  })

  it(".get(key) returns undefined for missing key", () => {
    const { doc } = createReadOnlyDoc()
    expect(doc.metadata.get("nonexistent")).toBeUndefined()
  })

  it(".get(key) returns a deep plain snapshot for structural items", () => {
    const schema = Schema.doc({
      records: Schema.record(
        Schema.struct({
          color: Schema.string(),
          priority: Schema.number(),
        }),
      ),
    })
    const store = {
      records: { bug: { color: "red", priority: 1 } },
    }
    const ctx: RefContext = { store }
    const doc = interpret(schema, readableInterpreter, ctx) as any
    expect(doc.records.get("bug")).toEqual({ color: "red", priority: 1 })
  })

  it("JSON.stringify(mapRef.get(key)) returns the JSON-serialized value", () => {
    const schema = Schema.doc({
      labels: Schema.record(Schema.string()),
    })
    const store = { labels: { bug: "red" } }
    const ctx: RefContext = { store }
    const doc = interpret(schema, readableInterpreter, ctx) as any
    expect(JSON.stringify(doc.labels.get("bug"))).toBe('"red"')
  })

  it(".get(key) reflects store mutations (live read)", () => {
    const { store, doc } = createReadOnlyDoc()
    expect(doc.metadata.get("version")).toBe(1)
    // Mutate store directly
    ;(store.metadata as Record<string, unknown>).version = 42
    doc.metadata[INVALIDATE](mapChange(undefined, ["version"]))
    expect(doc.metadata.get("version")).toBe(42)
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
    // replaceChange([]) triggers a full cache clear
    doc.messages[INVALIDATE](replaceChange([]))
    // After invalidation, .at(0) creates a new ref (different identity)
    expect(doc.messages.at(0)).not.toBe(first)
  })

  it("sequence [INVALIDATE](change) with delete shifts cached entries", () => {
    const { doc } = createReadOnlyLoroDoc({
      messages: [
        { author: "Alice", body: "Hi" },
        { author: "Bob", body: "Hey" },
      ],
    })
    const first = doc.messages.at(0)!
    const second = doc.messages.at(1)!
    // Delete index 0: [{ retain: 0 }, { delete: 1 }]
    // This removes index 0 and shifts index 1 → index 0
    doc.messages[INVALIDATE](sequenceChange([{ retain: 0 }, { delete: 1 }]))
    // Index 0 was deleted, so the old first ref is gone.
    // The old second ref (Bob) is now shifted to index 0.
    expect(doc.messages.at(0)).toBe(second)
  })

  it("map ref has [INVALIDATE] symbol", () => {
    const { doc } = createReadOnlyDoc()
    expect(typeof doc.metadata[INVALIDATE]).toBe("function")
  })

  it("map [INVALIDATE](change) clears single entry", () => {
    const { doc } = createReadOnlyDoc({
      metadata: { a: 1, b: 2 },
    })
    const aRef = doc.metadata.at("a")
    const bRef = doc.metadata.at("b")
    // Invalidate key "a" via mapChange with delete
    doc.metadata[INVALIDATE](mapChange(undefined, ["a"]))
    expect(doc.metadata.at("a")).not.toBe(aRef)
    expect(doc.metadata.at("b")).toBe(bRef)
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
    const ctx = createWritableContext(store)
    const enriched = enrich(readableInterpreter, withChangefeed)
    const doc = interpret(schema, enriched, ctx) as any

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

  it("Readable<record(string())>: .at() returns ref, .get() returns plain value", () => {
    const s = Schema.record(Schema.string())
    type Result = Readable<typeof s>
    // .at() returns Readable ref
    const _checkAt: (r: Result) => Readable<ReturnType<typeof Schema.string>> | undefined = (r) => r.at("x")
    // .get() returns plain string
    const _checkGet: (r: Result) => string | undefined = (r) => r.get("x")
    const _checkHas: (r: Result) => boolean = (r) => r.has("x")
    const _checkKeys: (r: Result) => string[] = (r) => r.keys()
    const _checkSize: (r: Result) => number = (r) => r.size
    const _checkCall: (r: Result) => Record<string, string> = (r) => r()
  })

  it("Readable<record(struct({...}))>: .get() returns plain struct", () => {
    const itemSchema = Schema.struct({
      color: Schema.string(),
      priority: Schema.number(),
    })
    const s = Schema.record(itemSchema)
    type Result = Readable<typeof s>
    // .get() returns the plain struct type
    const _checkGet: (r: Result) => { color: string; priority: number } | undefined = (r) => r.get("x")
    // .at() returns the readable ref (callable, with navigation)
    const _checkAt: (r: Result) => Readable<typeof itemSchema> | undefined = (r) => r.at("x")
  })

  it("Readable<list(struct({...}))>: .get() returns plain struct", () => {
    const itemSchema = Schema.struct({
      title: Schema.string(),
      done: Schema.boolean(),
    })
    const s = Schema.list(itemSchema)
    type Result = Readable<typeof s>
    // .get() returns the plain struct type
    const _checkGet: (r: Result) => { title: string; done: boolean } | undefined = (r) => r.get(0)
    // .at() returns the readable ref (callable, with navigation)
    const _checkAt: (r: Result) => Readable<typeof itemSchema> | undefined = (r) => r.at(0)
  })
})
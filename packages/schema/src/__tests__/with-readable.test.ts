import { describe, expect, it } from "vitest"
import {
  dispatchSum,
  interpret,
  plainInterpreter,
  plainStoreReader,
  Schema,
} from "../index.js"
import type { Interpreter } from "../interpret.js"
import type { RefContext } from "../interpreter-types.js"
import type { HasCall, HasNavigation, HasRead } from "../interpreters/bottom.js"
import { bottomInterpreter, CALL } from "../interpreters/bottom.js"
import { withNavigation } from "../interpreters/with-navigation.js"
import { withReadable } from "../interpreters/with-readable.js"

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

const annotatedDocSchema = Schema.doc({
  title: Schema.annotated("text"),
  count: Schema.annotated("counter"),
  messages: Schema.list(
    Schema.struct({
      author: Schema.string(),
      body: Schema.string(),
    }),
  ),
})

const readableInterp = withReadable(withNavigation(bottomInterpreter))

function createDoc(
  schema: Parameters<typeof interpret>[0],
  store: Record<string, unknown>,
) {
  const ctx: RefContext = { store: plainStoreReader(store) }
  const doc = interpret(schema, readableInterp, ctx) as any
  return { doc, store, ctx }
}

// ===========================================================================
// Scalar reading
// ===========================================================================

describe("withReadable: scalar", () => {
  it("ref() returns the current store value", () => {
    const { doc } = createDoc(Schema.doc({ name: Schema.string() }), {
      name: "Alice",
    })
    expect(doc.name()).toBe("Alice")
  })

  it("ref() reflects live store mutations", () => {
    const { doc, store } = createDoc(Schema.doc({ count: Schema.number() }), {
      count: 10,
    })
    expect(doc.count()).toBe(10)
    store.count = 42
    expect(doc.count()).toBe(42)
  })

  it("[CALL] slot is present and functional", () => {
    const schema = Schema.string()
    const ctx: RefContext = { store: plainStoreReader("hello" as any) }
    const result = interpret(schema, readableInterp, ctx) as any
    expect(CALL in result).toBe(true)
    expect(result[CALL]()).toBe("hello")
    expect(result()).toBe("hello")
  })

  it("toPrimitive with 'string' hint returns String(value)", () => {
    const { doc } = createDoc(Schema.doc({ n: Schema.number() }), { n: 14 })
    expect(doc.n[Symbol.toPrimitive]("string")).toBe("14")
  })

  it("toPrimitive with 'number' hint returns raw value", () => {
    const { doc } = createDoc(Schema.doc({ n: Schema.number() }), { n: 14 })
    expect(doc.n[Symbol.toPrimitive]("number")).toBe(14)
  })

  it("toPrimitive with 'default' hint returns raw value", () => {
    const { doc } = createDoc(Schema.doc({ n: Schema.number() }), { n: 14 })
    expect(doc.n[Symbol.toPrimitive]("default")).toBe(14)
  })

  it("scalar ref works in template literal", () => {
    const { doc } = createDoc(Schema.doc({ n: Schema.number() }), { n: 14 })
    expect(`value: ${doc.n}`).toBe("value: 14")
  })
})

// ===========================================================================
// Product navigation
// ===========================================================================

describe("withReadable: product", () => {
  it("product ref() returns deep plain snapshot", () => {
    const { doc } = createDoc(structuralDocSchema, {
      settings: { darkMode: false, fontSize: 14 },
      metadata: { version: 1 },
    })
    expect(doc()).toEqual({
      settings: { darkMode: false, fontSize: 14 },
      metadata: { version: 1 },
    })
  })

  it("field navigation returns child refs", () => {
    const { doc } = createDoc(structuralDocSchema, {
      settings: { darkMode: true, fontSize: 16 },
      metadata: {},
    })
    expect(typeof doc.settings).toBe("function")
    expect(doc.settings.darkMode()).toBe(true)
    expect(doc.settings.fontSize()).toBe(16)
  })

  it("Object.keys returns only schema field names", () => {
    const { doc } = createDoc(structuralDocSchema, {
      settings: { darkMode: false, fontSize: 14 },
      metadata: {},
    })
    expect(Object.keys(doc)).toEqual(["settings", "metadata"])
  })

  it("NO referential identity — each access forces the thunk", () => {
    const { doc } = createDoc(structuralDocSchema, {
      settings: { darkMode: false, fontSize: 14 },
      metadata: {},
    })
    // This is the key difference from readableInterpreter + withCaching:
    // without caching, every access produces a NEW child ref.
    expect(doc.settings).not.toBe(doc.settings)
  })

  it("product field named 'name' shadows Function.prototype.name", () => {
    const schema = Schema.struct({ name: Schema.string() })
    const ctx: RefContext = { store: plainStoreReader({ name: "test" }) }
    const ref = interpret(schema, readableInterp, ctx) as any
    expect(typeof ref.name).toBe("function")
    expect(ref.name()).toBe("test")
  })

  it("product field named 'length' shadows Function.prototype.length", () => {
    const schema = Schema.struct({ length: Schema.number() })
    const ctx: RefContext = { store: plainStoreReader({ length: 42 }) }
    const ref = interpret(schema, readableInterp, ctx) as any
    expect(typeof ref.length).toBe("function")
    expect(ref.length()).toBe(42)
  })
})

// ===========================================================================
// Sequence navigation
// ===========================================================================

describe("withReadable: sequence", () => {
  const schema = Schema.doc({
    messages: Schema.list(
      Schema.struct({
        author: Schema.string(),
        body: Schema.string(),
      }),
    ),
  })

  function createSeqDoc(
    messages: Array<{ author: string; body: string }> = [
      { author: "Alice", body: "Hi" },
    ],
  ) {
    return createDoc(schema, { messages })
  }

  it(".at(i) returns a callable child ref", () => {
    const { doc } = createSeqDoc()
    const msg = doc.messages.at(0)
    expect(typeof msg).toBe("function")
    expect(msg.author()).toBe("Alice")
  })

  it(".at(i) returns undefined for out-of-bounds index", () => {
    const { doc } = createSeqDoc()
    expect(doc.messages.at(100)).toBeUndefined()
  })

  it(".at(i) returns undefined for negative index", () => {
    const { doc } = createSeqDoc()
    expect(doc.messages.at(-1)).toBeUndefined()
  })

  it("NO referential identity — .at(i) returns fresh refs", () => {
    const { doc } = createSeqDoc()
    expect(doc.messages.at(0)).not.toBe(doc.messages.at(0))
  })

  it(".length reflects the store array length", () => {
    const { doc } = createSeqDoc([
      { author: "Alice", body: "Hi" },
      { author: "Bob", body: "Hey" },
    ])
    expect(doc.messages.length).toBe(2)
  })

  it(".length is 0 for empty array", () => {
    const { doc } = createSeqDoc([])
    expect(doc.messages.length).toBe(0)
  })

  it("ref() returns the plain array snapshot", () => {
    const { doc } = createSeqDoc([{ author: "Alice", body: "Hi" }])
    expect(doc.messages()).toEqual([{ author: "Alice", body: "Hi" }])
  })

  it(".get(i) returns the plain value (not a function)", () => {
    const { doc } = createSeqDoc([{ author: "Alice", body: "Hi" }])
    const val = doc.messages.get(0)
    expect(typeof val).not.toBe("function")
    expect(val).toEqual({ author: "Alice", body: "Hi" })
  })

  it(".get(i) returns undefined for out-of-bounds", () => {
    const { doc } = createSeqDoc()
    expect(doc.messages.get(100)).toBeUndefined()
    expect(doc.messages.get(-1)).toBeUndefined()
  })

  it("iteration via for..of yields child refs", () => {
    const { doc } = createSeqDoc([
      { author: "Alice", body: "Hi" },
      { author: "Bob", body: "Hey" },
    ])
    const refs: any[] = []
    for (const msg of doc.messages) {
      refs.push(msg)
    }
    expect(refs.length).toBe(2)
    expect(typeof refs[0]).toBe("function")
    expect(refs[0].author()).toBe("Alice")
    expect(refs[1].author()).toBe("Bob")
  })

  it(".length reflects live store mutations", () => {
    const { doc, store } = createSeqDoc([{ author: "Alice", body: "Hi" }])
    expect(doc.messages.length).toBe(1)
    ;(store.messages as any[]).push({ author: "Bob", body: "Hey" })
    expect(doc.messages.length).toBe(2)
  })
})

// ===========================================================================
// Map navigation
// ===========================================================================

describe("withReadable: map", () => {
  const schema = Schema.doc({
    metadata: Schema.record(Schema.number()),
  })

  function createMapDoc(metadata: Record<string, number> = { version: 1 }) {
    return createDoc(schema, { metadata })
  }

  it(".at(key) returns a callable child ref", () => {
    const { doc } = createMapDoc()
    const vRef = doc.metadata.at("version")
    expect(typeof vRef).toBe("function")
    expect(vRef()).toBe(1)
  })

  it(".at(key) returns undefined for missing key", () => {
    const { doc } = createMapDoc()
    expect(doc.metadata.at("nonexistent")).toBeUndefined()
  })

  it("NO referential identity — .at(key) returns fresh refs", () => {
    const { doc } = createMapDoc()
    expect(doc.metadata.at("version")).not.toBe(doc.metadata.at("version"))
  })

  it("ref() returns the plain record snapshot", () => {
    const { doc } = createMapDoc({ a: 1, b: 2 })
    expect(doc.metadata()).toEqual({ a: 1, b: 2 })
  })

  it(".get(key) returns the plain value", () => {
    const { doc } = createMapDoc({ version: 42 })
    const val = doc.metadata.get("version")
    expect(typeof val).not.toBe("function")
    expect(val).toBe(42)
  })

  it(".get(key) returns undefined for missing key", () => {
    const { doc } = createMapDoc()
    expect(doc.metadata.get("missing")).toBeUndefined()
  })

  it(".has(key) checks store keys", () => {
    const { doc } = createMapDoc({ version: 1 })
    expect(doc.metadata.has("version")).toBe(true)
    expect(doc.metadata.has("missing")).toBe(false)
  })

  it(".keys() returns the store's dynamic keys", () => {
    const { doc } = createMapDoc({ a: 1, b: 2, c: 3 })
    expect(doc.metadata.keys()).toEqual(["a", "b", "c"])
  })

  it(".size reflects store entry count", () => {
    const { doc } = createMapDoc({ a: 1, b: 2 })
    expect(doc.metadata.size).toBe(2)
  })

  it(".size is 0 for empty map", () => {
    const { doc } = createMapDoc({})
    expect(doc.metadata.size).toBe(0)
  })

  it(".entries() yields [key, childRef] pairs", () => {
    const { doc } = createMapDoc({ x: 10, y: 20 })
    const entries = [...doc.metadata.entries()]
    expect(entries.length).toBe(2)
    expect(entries[0][0]).toBe("x")
    expect(typeof entries[0][1]).toBe("function")
    expect(entries[0][1]()).toBe(10)
    expect(entries[1][0]).toBe("y")
    expect(entries[1][1]()).toBe(20)
  })

  it(".values() yields child refs", () => {
    const { doc } = createMapDoc({ x: 10, y: 20 })
    const values = [...doc.metadata.values()]
    expect(values.length).toBe(2)
    expect(typeof values[0]).toBe("function")
    expect(values[0]()).toBe(10)
    expect(values[1]()).toBe(20)
  })

  it("[Symbol.iterator] yields [key, childRef] pairs", () => {
    const { doc } = createMapDoc({ a: 1, b: 2 })
    const pairs: any[] = []
    for (const pair of doc.metadata) {
      pairs.push(pair)
    }
    expect(pairs.length).toBe(2)
    expect(pairs[0][0]).toBe("a")
    expect(typeof pairs[0][1]).toBe("function")
    expect(pairs[0][1]()).toBe(1)
  })

  it("typeof map ref is 'function'", () => {
    const { doc } = createMapDoc()
    expect(typeof doc.metadata).toBe("function")
  })

  it(".get(key) returns a deep plain snapshot for structural items", () => {
    const itemSchema = Schema.struct({
      color: Schema.string(),
      priority: Schema.number(),
    })
    const s = Schema.doc({ tags: Schema.record(itemSchema) })
    const { doc } = createDoc(s, {
      tags: { urgent: { color: "red", priority: 1 } },
    })
    const val = doc.tags.get("urgent")
    expect(val).toEqual({ color: "red", priority: 1 })
  })
})

// ===========================================================================
// Annotated nodes
// ===========================================================================

describe("withReadable: annotated", () => {
  it("text ref returns current string when called", () => {
    const { doc } = createDoc(Schema.doc({ title: Schema.annotated("text") }), {
      title: "Hello",
    })
    expect(doc.title()).toBe("Hello")
  })

  it("text ref returns empty string when store value is null", () => {
    const { doc } = createDoc(Schema.doc({ title: Schema.annotated("text") }), {
      title: null,
    })
    expect(doc.title()).toBe("")
  })

  it("text ref toPrimitive produces string", () => {
    const { doc } = createDoc(Schema.doc({ title: Schema.annotated("text") }), {
      title: "Hello",
    })
    expect(`Title: ${doc.title}`).toBe("Title: Hello")
    expect(String(doc.title)).toBe("Hello")
  })

  it("counter ref returns current number when called", () => {
    const { doc } = createDoc(Schema.doc({ count: Schema.annotated("counter") }), {
      count: 42,
    })
    expect(doc.count()).toBe(42)
  })

  it("counter ref returns 0 when store value is not a number", () => {
    const { doc } = createDoc(Schema.doc({ count: Schema.annotated("counter") }), {
      count: "oops",
    })
    expect(doc.count()).toBe(0)
  })

  it("counter ref toPrimitive is hint-aware", () => {
    const { doc } = createDoc(Schema.doc({ count: Schema.annotated("counter") }), {
      count: 42,
    })
    expect(doc.count[Symbol.toPrimitive]("string")).toBe("42")
    expect(doc.count[Symbol.toPrimitive]("number")).toBe(42)
    expect(doc.count[Symbol.toPrimitive]("default")).toBe(42)
  })

  it("counter ref works in template literal", () => {
    const { doc } = createDoc(Schema.doc({ count: Schema.annotated("counter") }), {
      count: 7,
    })
    expect(`Stars: ${doc.count}`).toBe("Stars: 7")
  })

  it("doc annotation delegates to inner (product)", () => {
    const { doc } = createDoc(structuralDocSchema, {
      settings: { darkMode: true, fontSize: 18 },
      metadata: {},
    })
    expect(typeof doc).toBe("function")
    expect(doc.settings.darkMode()).toBe(true)
  })

  it("tree annotation delegates to inner", () => {
    const schema = Schema.doc({
      data: Schema.annotated("tree", Schema.string()),
    })
    const { doc } = createDoc(schema, { data: "leaf" })
    expect(doc.data()).toBe("leaf")
  })

  it("unknown annotation with inner delegates to inner", () => {
    const schema = Schema.doc({
      custom: Schema.annotated("custom-thing", Schema.number()),
    })
    const { doc } = createDoc(schema, { custom: 99 })
    expect(doc.custom()).toBe(99)
  })
})

// ===========================================================================
// Sum dispatch
// ===========================================================================

describe("withReadable: discriminated sum", () => {
  const schema = Schema.doc({
    item: Schema.discriminatedUnion("type", [
      Schema.struct({ type: Schema.string("text"), body: Schema.string() }),
      Schema.struct({ type: Schema.string("image"), url: Schema.string() }),
    ]),
  })

  it("dispatches to the correct variant based on store discriminant", () => {
    const { doc } = createDoc(schema, {
      item: { type: "image", url: "pic.png" },
    })
    expect(doc.item.url()).toBe("pic.png")
  })

  it("falls back to first variant when discriminant is missing", () => {
    const { doc } = createDoc(schema, { item: {} })
    // First variant is "text" (first key in variantMap)
    expect(typeof doc.item.body).toBe("function")
  })

  it("falls back to first variant when store value is not an object", () => {
    const { doc } = createDoc(schema, { item: 42 })
    expect(typeof doc.item.body).toBe("function")
  })
})

describe("withReadable: hybrid discriminant", () => {
  const schema = Schema.doc({
    item: Schema.discriminatedUnion("type", [
      Schema.struct({ type: Schema.string("text"), body: Schema.string() }),
      Schema.struct({ type: Schema.string("image"), url: Schema.string() }),
    ]),
  })

  it("discriminant field returns a raw string, not a function ref", () => {
    const { doc } = createDoc(schema, {
      item: { type: "text", body: "hello" },
    })
    expect(doc.item.type).toBe("text")
    expect(typeof doc.item.type).toBe("string")
  })

  it("discriminant field has no .set() method", () => {
    const { doc } = createDoc(schema, {
      item: { type: "text", body: "hello" },
    })
    expect(doc.item.type.set).toBeUndefined()
  })

  it("discriminant is NOT callable", () => {
    const { doc } = createDoc(schema, {
      item: { type: "text", body: "hello" },
    })
    expect(typeof doc.item.type).not.toBe("function")
  })

  it("snapshot includes the discriminant as a plain string value", () => {
    const { doc } = createDoc(schema, {
      item: { type: "image", url: "pic.png" },
    })
    const snap = doc.item()
    expect(snap).toEqual({ type: "image", url: "pic.png" })
    expect(typeof snap.type).toBe("string")
  })

  it("non-discriminant fields are still full callable refs", () => {
    const { doc } = createDoc(schema, {
      item: { type: "text", body: "hello" },
    })
    expect(typeof doc.item.body).toBe("function")
    expect(doc.item.body()).toBe("hello")
  })

  it("discriminant reflects store changes after mutation", () => {
    const { doc, store } = createDoc(schema, {
      item: { type: "text", body: "hello" },
    })
    expect(doc.item.type).toBe("text")
    // Simulate store mutation (as would happen via product .set())
    ;(store as any).item = { type: "image", url: "pic.png" }
    expect(doc.item.type).toBe("image")
  })

  it("non-discriminated products are unaffected", () => {
    const plainSchema = Schema.doc({
      settings: Schema.struct({
        darkMode: Schema.boolean(),
        fontSize: Schema.number(),
      }),
    })
    const { doc } = createDoc(plainSchema, {
      settings: { darkMode: true, fontSize: 14 },
    })
    // All fields are still function refs
    expect(typeof doc.settings.darkMode).toBe("function")
    expect(typeof doc.settings.fontSize).toBe("function")
    expect(doc.settings.darkMode()).toBe(true)
  })
})

describe("withReadable: nullable (positional sum)", () => {
  const schema = Schema.doc({
    bio: Schema.nullable(Schema.string()),
  })

  it("null store value dispatches to the null variant", () => {
    const { doc } = createDoc(schema, { bio: null })
    expect(doc.bio()).toBe(null)
  })

  it("non-null store value dispatches to the inner variant", () => {
    const { doc } = createDoc(schema, { bio: "Hello world" })
    expect(doc.bio()).toBe("Hello world")
  })
})

// ===========================================================================
// Full document tree
// ===========================================================================

describe("withReadable: full doc tree", () => {
  it("produces a complete navigable tree from an annotated doc schema", () => {
    const { doc } = createDoc(annotatedDocSchema, {
      title: "Hello",
      count: 42,
      messages: [{ author: "Alice", body: "Hi" }],
    })

    expect(typeof doc).toBe("function")
    expect(doc.title()).toBe("Hello")
    expect(doc.count()).toBe(42)
    expect(doc.messages.length).toBe(1)
    expect(doc.messages.at(0).author()).toBe("Alice")
    expect(doc.messages()).toEqual([{ author: "Alice", body: "Hi" }])
  })

  it("doc ref() returns full deep snapshot when called", () => {
    const { doc } = createDoc(annotatedDocSchema, {
      title: "Hello",
      count: 42,
      messages: [],
    })
    expect(doc()).toEqual({ title: "Hello", count: 42, messages: [] })
  })

  it("typeof every ref is 'function'", () => {
    const { doc } = createDoc(annotatedDocSchema, {
      title: "Hello",
      count: 0,
      messages: [],
    })
    expect(typeof doc).toBe("function")
    expect(typeof doc.title).toBe("function")
    expect(typeof doc.count).toBe("function")
    expect(typeof doc.messages).toBe("function")
  })
})

// ===========================================================================
// dispatchSum (shared function)
// ===========================================================================

describe("dispatchSum", () => {
  it("discriminated: dispatches to correct variant for known discriminant", () => {
    const schema = Schema.discriminatedUnion("type", [
      Schema.struct({ type: Schema.string("text"), body: Schema.string() }),
      Schema.struct({ type: Schema.string("image"), url: Schema.string() }),
    ])
    let called: string | undefined
    const variants = {
      byKey: (key: string) => {
        called = key
        return key
      },
    }
    dispatchSum({ type: "image" }, schema, variants)
    expect(called).toBe("image")
  })

  it("discriminated: falls back to first variant for missing discriminant", () => {
    const schema = Schema.discriminatedUnion("type", [
      Schema.struct({ type: Schema.string("text"), body: Schema.string() }),
      Schema.struct({ type: Schema.string("image"), url: Schema.string() }),
    ])
    let called: string | undefined
    const variants = {
      byKey: (key: string) => {
        called = key
        return key
      },
    }
    dispatchSum({}, schema, variants)
    expect(called).toBe("text")
  })

  it("discriminated: falls back to first variant for non-object value", () => {
    const schema = Schema.discriminatedUnion("type", [
      Schema.struct({ type: Schema.string("text"), body: Schema.string() }),
    ])
    let called: string | undefined
    const variants = {
      byKey: (key: string) => {
        called = key
        return key
      },
    }
    dispatchSum(42, schema, variants)
    expect(called).toBe("text")
  })

  it("discriminated: falls back to first variant for unknown discriminant value", () => {
    const schema = Schema.discriminatedUnion("type", [
      Schema.struct({ type: Schema.string("text"), body: Schema.string() }),
      Schema.struct({ type: Schema.string("image"), url: Schema.string() }),
    ])
    let called: string | undefined
    const variants = {
      byKey: (key: string) => {
        called = key
        return key
      },
    }
    dispatchSum({ type: "video" }, schema, variants)
    expect(called).toBe("text")
  })

  it("nullable: null dispatches to variant 0", () => {
    const schema = Schema.nullable(Schema.string())
    let calledIndex: number | undefined
    const variants = {
      byIndex: (index: number) => {
        calledIndex = index
        return index
      },
    }
    dispatchSum(null, schema, variants)
    expect(calledIndex).toBe(0)
  })

  it("nullable: undefined dispatches to variant 0", () => {
    const schema = Schema.nullable(Schema.string())
    let calledIndex: number | undefined
    const variants = {
      byIndex: (index: number) => {
        calledIndex = index
        return index
      },
    }
    dispatchSum(undefined, schema, variants)
    expect(calledIndex).toBe(0)
  })

  it("nullable: non-null dispatches to variant 1", () => {
    const schema = Schema.nullable(Schema.string())
    let calledIndex: number | undefined
    const variants = {
      byIndex: (index: number) => {
        calledIndex = index
        return index
      },
    }
    dispatchSum("hello", schema, variants)
    expect(calledIndex).toBe(1)
  })

  it("general positional sum: dispatches to variant 0", () => {
    // A non-nullable positional sum (union of two non-null types)
    const schema: any = {
      _kind: "sum",
      variants: [
        { _kind: "scalar", scalarKind: "string" },
        { _kind: "scalar", scalarKind: "number" },
      ],
    }
    let calledIndex: number | undefined
    const variants = {
      byIndex: (index: number) => {
        calledIndex = index
        return index
      },
    }
    dispatchSum("anything", schema, variants)
    expect(calledIndex).toBe(0)
  })

  it("returns undefined when no variants match", () => {
    const schema: any = {
      _kind: "sum",
      variants: [],
      discriminant: "type",
      variantMap: {},
    }
    const result = dispatchSum({}, schema, { byKey: k => k })
    expect(result).toBeUndefined()
  })
})

// ===========================================================================
// Type-level tests
// ===========================================================================

describe("type-level: withReadable", () => {
  it("withReadable(withNavigation(bottomInterpreter)) produces HasRead", () => {
    const readable = withReadable(withNavigation(bottomInterpreter))
    const _check: Interpreter<RefContext, HasCall & HasNavigation & HasRead> =
      readable
    void _check
  })

  it("result satisfies HasRead", () => {
    const readable = withReadable(withNavigation(bottomInterpreter))
    const ctx: RefContext = { store: plainStoreReader("test" as any) }
    const result = interpret(Schema.string(), readable, ctx)
    const _check: HasRead = result
    void _check
  })

  it("result also satisfies HasNavigation and HasCall", () => {
    const readable = withReadable(withNavigation(bottomInterpreter))
    const ctx: RefContext = { store: plainStoreReader("test" as any) }
    const result = interpret(Schema.string(), readable, ctx)
    const _checkNav: HasNavigation = result
    const _checkCall: HasCall = result
    void _checkNav
    void _checkCall
  })

  it("withReadable(bottomInterpreter) is a compile error (requires HasNavigation)", () => {
    // @ts-expect-error — bottomInterpreter produces HasCall, withReadable requires HasNavigation
    const _bad = withReadable(bottomInterpreter)
    void _bad
  })

  it("withReadable(plainInterpreter) is a type error (plain has unknown, not HasCall)", () => {
    // @ts-expect-error — plainInterpreter is Interpreter<unknown, unknown>, not HasCall
    const _bad = withReadable(plainInterpreter)
    void _bad
  })
})

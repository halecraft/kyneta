import { describe, expect, it } from "vitest"
import {
  bottomInterpreter,
  hasChangefeed,
  interpret,
  plainContext,
  Schema,
  withCaching,
  withChangefeed,
  withReadable,
  withWritable,
} from "../index.js"
import type { Interpreter } from "../interpret.js"
import type { RefContext } from "../interpreter-types.js"
import type { HasCall, HasNavigation, HasRead } from "../interpreters/bottom.js"
import { withNavigation } from "../interpreters/with-navigation.js"
import { plainReader } from "../reader.js"

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

const _annotatedDocSchema = Schema.doc({
  title: Schema.annotated("text"),
  count: Schema.annotated("counter"),
  messages: Schema.list(
    Schema.struct({
      author: Schema.string(),
      body: Schema.string(),
    }),
  ),
})

const navInterp = withNavigation(bottomInterpreter)

function createNavDoc(storeOverrides: Record<string, unknown> = {}) {
  const store = {
    settings: { darkMode: false, fontSize: 14 },
    metadata: { version: 1 },
    ...storeOverrides,
  }
  const ctx: RefContext = { reader: plainReader(store) }
  const doc = interpret(structuralDocSchema, navInterp, ctx) as any
  return { store, ctx, doc }
}

// ===========================================================================
// Product: field getters
// ===========================================================================

describe("withNavigation: product field getters", () => {
  it("defines enumerable getters for each schema field", () => {
    const { doc } = createNavDoc()
    // Product field keys should be enumerable
    const keys = Object.keys(doc)
    expect(keys).toContain("settings")
    expect(keys).toContain("metadata")
  })

  it("field getters return child carriers (callable functions)", () => {
    const { doc } = createNavDoc()
    expect(typeof doc.settings).toBe("function")
    expect(typeof doc.metadata).toBe("function")
  })

  it("nested product field getters work", () => {
    const { doc } = createNavDoc()
    const settings = doc.settings
    expect(typeof settings.darkMode).toBe("function")
    expect(typeof settings.fontSize).toBe("function")
  })

  it("calling a carrier throws (no reader configured)", () => {
    const { doc } = createNavDoc()
    expect(() => doc()).toThrow("No call behavior configured")
    expect(() => doc.settings()).toThrow("No call behavior configured")
    expect(() => doc.settings.darkMode()).toThrow("No call behavior configured")
  })

  it("field getters are not cached (each access forces thunk)", () => {
    const { doc } = createNavDoc()
    // Without caching, each access returns a different ref
    expect(doc.settings).not.toBe(doc.settings)
  })
})

// ===========================================================================
// Sequence: .at(), .length, [Symbol.iterator]
// ===========================================================================

describe("withNavigation: sequence navigation", () => {
  const seqSchema = Schema.list(Schema.string())

  function createSeqDoc(items: string[]) {
    const store = items as any
    const ctx: RefContext = { reader: plainReader(store) }
    const result = interpret(seqSchema, navInterp, ctx) as any
    return { store, ctx, result }
  }

  it(".at(i) returns a child carrier", () => {
    const { result } = createSeqDoc(["a", "b", "c"])
    const child = result.at(0)
    expect(typeof child).toBe("function")
  })

  it(".at(i) calling the child throws (no reader)", () => {
    const { result } = createSeqDoc(["a", "b", "c"])
    const child = result.at(0)
    expect(() => child()).toThrow("No call behavior configured")
  })

  it(".at(-1) returns undefined", () => {
    const { result } = createSeqDoc(["a", "b", "c"])
    expect(result.at(-1)).toBeUndefined()
  })

  it(".at(out-of-bounds) returns undefined", () => {
    const { result } = createSeqDoc(["a", "b"])
    expect(result.at(2)).toBeUndefined()
    expect(result.at(99)).toBeUndefined()
  })

  it(".length reflects store array length", () => {
    const { result } = createSeqDoc(["a", "b", "c"])
    expect(result.length).toBe(3)
  })

  it(".length is 0 for empty array", () => {
    const { result } = createSeqDoc([])
    expect(result.length).toBe(0)
  })

  it("[Symbol.iterator] yields child carriers", () => {
    const { result } = createSeqDoc(["a", "b"])
    const items = [...result]
    expect(items).toHaveLength(2)
    expect(typeof items[0]).toBe("function")
    expect(typeof items[1]).toBe("function")
  })

  it("[Symbol.iterator] yields nothing for empty array", () => {
    const { result } = createSeqDoc([])
    const items = [...result]
    expect(items).toHaveLength(0)
  })
})

// ===========================================================================
// Map: .at(), .has(), .keys(), .size, .entries(), .values(), iterator
// ===========================================================================

describe("withNavigation: map navigation", () => {
  const mapSchema = Schema.record(Schema.number())

  function createMapDoc(data: Record<string, number>) {
    const store = data as any
    const ctx: RefContext = { reader: plainReader(store) }
    const result = interpret(mapSchema, navInterp, ctx) as any
    return { store, ctx, result }
  }

  it(".at(key) returns a child carrier for existing key", () => {
    const { result } = createMapDoc({ x: 1, y: 2 })
    const child = result.at("x")
    expect(typeof child).toBe("function")
  })

  it(".at(missingKey) returns undefined", () => {
    const { result } = createMapDoc({ x: 1 })
    expect(result.at("missing")).toBeUndefined()
  })

  it(".has(key) returns true for existing key", () => {
    const { result } = createMapDoc({ x: 1 })
    expect(result.has("x")).toBe(true)
  })

  it(".has(key) returns false for missing key", () => {
    const { result } = createMapDoc({ x: 1 })
    expect(result.has("y")).toBe(false)
  })

  it(".keys() returns store keys", () => {
    const { result } = createMapDoc({ a: 1, b: 2, c: 3 })
    expect(result.keys()).toEqual(["a", "b", "c"])
  })

  it(".keys() returns empty array for empty map", () => {
    const { result } = createMapDoc({})
    expect(result.keys()).toEqual([])
  })

  it(".size reflects store key count", () => {
    const { result } = createMapDoc({ a: 1, b: 2 })
    expect(result.size).toBe(2)
  })

  it(".entries() yields [key, carrier] pairs", () => {
    const { result } = createMapDoc({ x: 1, y: 2 })
    const entries = [...result.entries()]
    expect(entries).toHaveLength(2)
    expect(entries[0]?.[0]).toBe("x")
    expect(typeof entries[0]?.[1]).toBe("function")
    expect(entries[1]?.[0]).toBe("y")
    expect(typeof entries[1]?.[1]).toBe("function")
  })

  it(".values() yields carriers", () => {
    const { result } = createMapDoc({ x: 1, y: 2 })
    const values = [...result.values()]
    expect(values).toHaveLength(2)
    expect(typeof values[0]).toBe("function")
  })

  it("[Symbol.iterator] yields [key, carrier] pairs", () => {
    const { result } = createMapDoc({ x: 1 })
    const entries = [...result]
    expect(entries).toHaveLength(1)
    expect(entries[0]?.[0]).toBe("x")
    expect(typeof entries[0]?.[1]).toBe("function")
  })
})

// ===========================================================================
// Sum dispatch
// ===========================================================================

describe("withNavigation: sum dispatch", () => {
  it("discriminated union dispatches to correct variant", () => {
    const schema = Schema.doc({
      item: Schema.discriminatedUnion("type", [
        Schema.struct({ type: Schema.string("text"), body: Schema.string() }),
        Schema.struct({ type: Schema.string("image"), url: Schema.string() }),
      ]),
    })
    const store = { item: { type: "image", url: "pic.png" } }
    const ctx: RefContext = { reader: plainReader(store) }
    const doc = interpret(schema, navInterp, ctx) as any

    // item should be a carrier (the resolved variant)
    expect(typeof doc.item).toBe("function")
    // The variant is a product with 'type' and 'url' fields
    expect(Object.keys(doc.item)).toContain("type")
    expect(Object.keys(doc.item)).toContain("url")
  })

  it("nullable sum dispatches based on null/non-null", () => {
    const schema = Schema.doc({
      bio: Schema.nullable(Schema.string()),
    })

    // Non-null case
    const store1 = { bio: "hello" }
    const ctx1: RefContext = { reader: plainReader(store1) }
    const doc1 = interpret(schema, navInterp, ctx1) as any
    // bio resolves to the string variant (a carrier)
    expect(typeof doc1.bio).toBe("function")

    // Null case
    const store2 = { bio: null }
    const ctx2: RefContext = { reader: plainReader(store2) }
    const doc2 = interpret(schema, navInterp, ctx2) as any
    // bio resolves to the null variant (a carrier)
    expect(typeof doc2.bio).toBe("function")
  })
})

// ===========================================================================
// Annotated: delegation
// ===========================================================================

describe("withNavigation: annotated delegation", () => {
  it("doc annotation delegates to inner (product gets getters)", () => {
    const schema = Schema.doc({
      title: Schema.annotated("text"),
      count: Schema.annotated("counter"),
    })
    const store = { title: "Hello", count: 0 }
    const ctx: RefContext = { reader: plainReader(store) }
    const doc = interpret(schema, navInterp, ctx) as any

    // doc delegates to product — field getters should work
    expect(Object.keys(doc)).toContain("title")
    expect(Object.keys(doc)).toContain("count")
    expect(typeof doc.title).toBe("function")
    expect(typeof doc.count).toBe("function")
  })

  it("text annotation produces a carrier (no toPrimitive — that's withReadable)", () => {
    const schema = Schema.annotated("text")
    const store = "Hello" as any
    const ctx: RefContext = { reader: plainReader(store) }
    const result = interpret(schema, navInterp, ctx) as any

    expect(typeof result).toBe("function")
    // CALL slot should NOT be filled (still throws)
    expect(() => result()).toThrow("No call behavior configured")
  })

  it("counter annotation produces a carrier (no toPrimitive)", () => {
    const schema = Schema.annotated("counter")
    const store = 42 as any
    const ctx: RefContext = { reader: plainReader(store) }
    const result = interpret(schema, navInterp, ctx) as any

    expect(typeof result).toBe("function")
    expect(() => result()).toThrow("No call behavior configured")
  })

  it("movable list annotation delegates to inner sequence", () => {
    const schema = Schema.annotated(
      "movable",
      Schema.list(Schema.struct({ title: Schema.string() })),
    )
    const store = [{ title: "A" }, { title: "B" }] as any
    const ctx: RefContext = { reader: plainReader(store) }
    const result = interpret(schema, navInterp, ctx) as any

    // Sequence navigation should be present
    expect(result.length).toBe(2)
    expect(typeof result.at).toBe("function")
    const child = result.at(0)
    expect(typeof child).toBe("function")
  })

  it("tree annotation delegates to inner", () => {
    const schema = Schema.annotated("tree", Schema.string())
    const store = "leaf" as any
    const ctx: RefContext = { reader: plainReader(store) }
    const result = interpret(schema, navInterp, ctx) as any

    expect(typeof result).toBe("function")
  })
})

// ===========================================================================
// Integration: navigate + write (no reading layer)
// ===========================================================================

describe("withNavigation: navigate + write stack", () => {
  const navWriteInterp = withWritable(withNavigation(bottomInterpreter))

  it("product field navigation works", () => {
    const schema = Schema.doc({
      title: Schema.string(),
      count: Schema.number(),
    })
    const store = { title: "hello", count: 0 }
    const ctx = plainContext(store)
    const doc = interpret(schema, navWriteInterp, ctx) as any

    expect(Object.keys(doc)).toContain("title")
    expect(typeof doc.title).toBe("function")
  })

  it("ref() throws (no reader configured)", () => {
    const schema = Schema.doc({
      title: Schema.string(),
    })
    const store = { title: "hello" }
    const ctx = plainContext(store)
    const doc = interpret(schema, navWriteInterp, ctx) as any

    expect(() => doc.title()).toThrow("No call behavior configured")
  })

  it(".set() works on navigated scalar child", () => {
    const schema = Schema.doc({
      title: Schema.string(),
    })
    const store: Record<string, unknown> = { title: "hello" }
    const ctx = plainContext(store)
    const doc = interpret(schema, navWriteInterp, ctx) as any

    doc.title.set("world")
    expect(store.title).toBe("world")
  })

  it("sequence .at(i) returns a navigable+writable ref", () => {
    const schema = Schema.doc({
      items: Schema.list(Schema.struct({ name: Schema.string() })),
    })
    const store = { items: [{ name: "a" }, { name: "b" }] }
    const ctx = plainContext(store)
    const doc = interpret(schema, navWriteInterp, ctx) as any

    expect(doc.items.length).toBe(2)
    const item = doc.items.at(0)
    expect(typeof item).toBe("function")

    // Can navigate to the child's field
    expect(typeof item.name).toBe("function")

    // Can mutate through navigation
    item.name.set("updated")
    expect(store.items[0].name).toBe("updated")
  })

  it(".push() works on sequence", () => {
    const schema = Schema.doc({
      items: Schema.list(Schema.string()),
    })
    const store = { items: ["a", "b"] }
    const ctx = plainContext(store)
    const doc = interpret(schema, navWriteInterp, ctx) as any

    doc.items.push("c")
    expect(store.items).toEqual(["a", "b", "c"])
  })

  it("text .update() works without reading layer", () => {
    const schema = Schema.doc({
      title: Schema.annotated("text"),
    })
    const store = { title: "hello" }
    const ctx = plainContext(store)
    const doc = interpret(schema, navWriteInterp, ctx) as any

    doc.title.update("world")
    expect(store.title).toBe("world")
  })

  it("map .set() and .delete() work", () => {
    const schema = Schema.doc({
      labels: Schema.record(Schema.string()),
    })
    const store = { labels: { color: "red" } }
    const ctx = plainContext(store)
    const doc = interpret(schema, navWriteInterp, ctx) as any

    doc.labels.set("size", "large")
    expect((store.labels as any).size).toBe("large")

    doc.labels.delete("color")
    expect((store.labels as any).color).toBeUndefined()
  })
})

// ===========================================================================
// Integration: read-only changefeed stack (Moore machine)
// ===========================================================================

describe("withNavigation: read-only changefeed stack", () => {
  const readOnlyInterp = withChangefeed(
    withCaching(withReadable(withNavigation(bottomInterpreter))),
  )

  it("produces refs with [CHANGEFEED]", () => {
    const schema = Schema.doc({
      title: Schema.string(),
      count: Schema.number(),
    })
    const store = { title: "Hello", count: 42 }
    const ctx: RefContext = { reader: plainReader(store) }
    const doc = interpret(schema, readOnlyInterp, ctx) as any

    expect(hasChangefeed(doc)).toBe(true)
    expect(hasChangefeed(doc.title)).toBe(true)
  })

  it(".current returns a value (valid Moore machine)", () => {
    const schema = Schema.doc({
      title: Schema.string(),
    })
    const store = { title: "Hello" }
    const ctx: RefContext = { reader: plainReader(store) }
    const doc = interpret(schema, readOnlyInterp, ctx) as any

    const CF_SYM = Symbol.for("kyneta:changefeed")
    const cf = doc.title[CF_SYM]
    expect(cf.current).toBe("Hello")
  })

  it(".subscribe returns an unsubscribe function (never fires)", () => {
    const schema = Schema.doc({
      title: Schema.string(),
    })
    const store = { title: "Hello" }
    const ctx: RefContext = { reader: plainReader(store) }
    const doc = interpret(schema, readOnlyInterp, ctx) as any

    const CF_SYM = Symbol.for("kyneta:changefeed")
    const cf = doc.title[CF_SYM]
    const unsub = cf.subscribe(() => {
      throw new Error("should never fire on read-only stack")
    })
    expect(typeof unsub).toBe("function")
    // No mutation possible — subscriber should never fire
    unsub()
  })

  it("composite .current returns a fresh snapshot", () => {
    const schema = Schema.doc({
      settings: Schema.struct({
        darkMode: Schema.boolean(),
        fontSize: Schema.number(),
      }),
    })
    const store = { settings: { darkMode: false, fontSize: 14 } }
    const ctx: RefContext = { reader: plainReader(store) }
    const doc = interpret(schema, readOnlyInterp, ctx) as any

    const CF_SYM = Symbol.for("kyneta:changefeed")
    const cf = doc.settings[CF_SYM]
    expect(cf.current).toEqual({ darkMode: false, fontSize: 14 })
    // Fresh snapshot each time
    expect(cf.current).not.toBe(cf.current)
  })
})

// ===========================================================================
// Type-level tests
// ===========================================================================

describe("type-level: withNavigation", () => {
  it("withNavigation(bottomInterpreter) compiles", () => {
    const nav = withNavigation(bottomInterpreter)
    void nav
  })

  it("withNavigation(bottomInterpreter) produces Interpreter<RefContext, HasCall & HasNavigation>", () => {
    const nav = withNavigation(bottomInterpreter)
    const _check: Interpreter<RefContext, HasCall & HasNavigation> = nav
    void _check
  })

  it("result satisfies HasNavigation", () => {
    const nav = withNavigation(bottomInterpreter)
    const ctx: RefContext = { reader: plainReader("test" as any) }
    const result = interpret(Schema.string(), nav, ctx)
    const _check: HasNavigation = result
    void _check
  })

  it("result also satisfies HasCall", () => {
    const nav = withNavigation(bottomInterpreter)
    const ctx: RefContext = { reader: plainReader("test" as any) }
    const result = interpret(Schema.string(), nav, ctx)
    const _check: HasCall = result
    void _check
  })

  it("result does NOT satisfy HasRead (negative test)", () => {
    const nav = withNavigation(bottomInterpreter)
    const ctx: RefContext = { reader: plainReader("test" as any) }
    const result = interpret(Schema.string(), nav, ctx)
    // @ts-expect-error — withNavigation does not produce HasRead
    const _bad: HasRead = result
    void _bad
  })

  it("withWritable(withNavigation(bottomInterpreter)) compiles", () => {
    // Navigate + write without reading — valid composition
    const navWrite = withWritable(withNavigation(bottomInterpreter))
    void navWrite
  })

  it("withReadable(withNavigation(bottomInterpreter)) compiles", () => {
    const navRead = withReadable(withNavigation(bottomInterpreter))
    void navRead
  })

  it("withCaching(withNavigation(bottomInterpreter)) compiles", () => {
    // Caching without reading — valid composition
    const navCache = withCaching(withNavigation(bottomInterpreter))
    void navCache
  })
})

import { describe, expect, it } from "vitest"
import {
  interpret,
  own,
  plainContext,
  plainInterpreter,
  plainReader,
  replaceChange,
  Schema,
  sequenceChange,
  withWritable,
} from "../index.js"
import type { Interpreter } from "../interpret.js"
import type { RefContext } from "../interpreter-types.js"
import type {
  HasCaching,
  HasCall,
  HasNavigation,
} from "../interpreters/bottom.js"
import { bottomInterpreter } from "../interpreters/bottom.js"
import { withAddressing } from "../interpreters/with-addressing.js"
import { withCaching } from "../interpreters/with-caching.js"
import { withNavigation } from "../interpreters/with-navigation.js"
import { withReadable } from "../interpreters/with-readable.js"
import { RawPath } from "../path.js"

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

// Default interpreter: includes withAddressing for identity-preserving
// sequence/map caching via the address table.
const cachedInterp = withCaching(
  withAddressing(withReadable(withNavigation(bottomInterpreter))),
)

function createDoc(
  schema: Parameters<typeof interpret>[0],
  store: Record<string, unknown>,
) {
  const ctx: RefContext = { reader: plainReader({ current: store }) }
  const doc = interpret(schema, cachedInterp, ctx) as any
  return { doc, store, ctx }
}

function createWritableDoc(
  schema: Parameters<typeof interpret>[0],
  store: Record<string, unknown>,
) {
  const ctx = plainContext(schema, store)
  const doc = interpret(schema, withWritable(cachedInterp), ctx) as any
  return { doc, store, ctx }
}

// ===========================================================================
// Product: referential identity
// ===========================================================================

describe("withCaching: product referential identity", () => {
  it("returns the same ref on repeated access", () => {
    const { doc } = createDoc(structuralDocSchema, {
      settings: { darkMode: false, fontSize: 14 },
      metadata: {},
    })
    expect(doc.settings).toBe(doc.settings)
  })

  it("nested field access is also stable", () => {
    const { doc } = createDoc(structuralDocSchema, {
      settings: { darkMode: true, fontSize: 16 },
      metadata: {},
    })
    const settings1 = doc.settings
    const settings2 = doc.settings
    expect(settings1).toBe(settings2)
    expect(settings1.darkMode).toBe(settings2.darkMode)
  })

  it("Object.keys returns only schema field names", () => {
    const { doc } = createDoc(structuralDocSchema, {
      settings: { darkMode: false, fontSize: 14 },
      metadata: {},
    })
    expect(Object.keys(doc)).toEqual(["settings", "metadata"])
  })

  it("reading through cached product ref still works", () => {
    const { doc } = createDoc(structuralDocSchema, {
      settings: { darkMode: false, fontSize: 14 },
      metadata: {},
    })
    expect(doc.settings.darkMode()).toBe(false)
    expect(doc.settings.fontSize()).toBe(14)
  })

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
})

// ===========================================================================
// Sequence: referential identity
// ===========================================================================

describe("withCaching: sequence referential identity", () => {
  const schema = Schema.struct({
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

  it(".at(i) returns the same ref on repeated access", () => {
    const { doc } = createSeqDoc()
    expect(doc.messages.at(0)).toBe(doc.messages.at(0))
  })

  it("different indices return different refs", () => {
    const { doc } = createSeqDoc([
      { author: "Alice", body: "Hi" },
      { author: "Bob", body: "Hey" },
    ])
    expect(doc.messages.at(0)).not.toBe(doc.messages.at(1))
  })

  it(".at(i) returns a callable child ref", () => {
    const { doc } = createSeqDoc()
    const msg = doc.messages.at(0)
    expect(typeof msg).toBe("function")
    expect(msg.author()).toBe("Alice")
  })

  it(".at(i) returns undefined for out-of-bounds", () => {
    const { doc } = createSeqDoc()
    expect(doc.messages.at(100)).toBeUndefined()
    expect(doc.messages.at(-1)).toBeUndefined()
  })

  it(".length reflects the store array length", () => {
    const { doc } = createSeqDoc([
      { author: "Alice", body: "Hi" },
      { author: "Bob", body: "Hey" },
    ])
    expect(doc.messages.length).toBe(2)
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

  it("iteration via for..of yields cached refs", () => {
    const { doc } = createSeqDoc([
      { author: "Alice", body: "Hi" },
      { author: "Bob", body: "Hey" },
    ])
    const refs: any[] = []
    for (const msg of doc.messages) {
      refs.push(msg)
    }
    expect(refs.length).toBe(2)
    // Iteration should populate the cache, so subsequent .at() returns same ref
    expect(refs[0]).toBe(doc.messages.at(0))
    expect(refs[1]).toBe(doc.messages.at(1))
  })
})

// ===========================================================================
// Map: referential identity
// ===========================================================================

describe("withCaching: map referential identity", () => {
  const schema = Schema.struct({
    metadata: Schema.record(Schema.number()),
  })

  function createMapDoc(metadata: Record<string, number> = { version: 1 }) {
    return createDoc(schema, { metadata })
  }

  it(".at(key) returns the same ref on repeated access", () => {
    const { doc } = createMapDoc()
    expect(doc.metadata.at("version")).toBe(doc.metadata.at("version"))
  })

  it("different keys return different refs", () => {
    const { doc } = createMapDoc({ a: 1, b: 2 })
    expect(doc.metadata.at("a")).not.toBe(doc.metadata.at("b"))
  })

  it(".at(key) returns a callable child ref", () => {
    const { doc } = createMapDoc({ version: 42 })
    const vRef = doc.metadata.at("version")
    expect(typeof vRef).toBe("function")
    expect(vRef()).toBe(42)
  })

  it(".at(key) returns undefined for missing key", () => {
    const { doc } = createMapDoc()
    expect(doc.metadata.at("nonexistent")).toBeUndefined()
  })

  it(".has(key) checks store keys", () => {
    const { doc } = createMapDoc({ version: 1 })
    expect(doc.metadata.has("version")).toBe(true)
    expect(doc.metadata.has("missing")).toBe(false)
  })

  it(".keys() returns the store's dynamic keys", () => {
    const { doc } = createMapDoc({ a: 1, b: 2 })
    expect(doc.metadata.keys()).toEqual(["a", "b"])
  })

  it(".size reflects store entry count", () => {
    const { doc } = createMapDoc({ a: 1, b: 2 })
    expect(doc.metadata.size).toBe(2)
  })

  it("ref() returns the plain record snapshot", () => {
    const { doc } = createMapDoc({ x: 10, y: 20 })
    expect(doc.metadata()).toEqual({ x: 10, y: 20 })
  })

  it(".get(key) returns the plain value", () => {
    const { doc } = createMapDoc({ version: 42 })
    expect(doc.metadata.get("version")).toBe(42)
  })

  it(".entries() yields [key, cachedRef] pairs", () => {
    const { doc } = createMapDoc({ a: 1, b: 2 })
    const entries = [...doc.metadata.entries()]
    expect(entries.length).toBe(2)
    // After iteration, cache is populated
    expect(entries[0][1]).toBe(doc.metadata.at("a"))
    expect(entries[1][1]).toBe(doc.metadata.at("b"))
  })
})

// ===========================================================================
// Hybrid discriminant: caching behavior
// ===========================================================================

describe("withCaching: hybrid discriminant", () => {
  const schema = Schema.struct({
    item: Schema.discriminatedUnion("type", [
      Schema.struct({ type: Schema.string("text"), body: Schema.string() }),
      Schema.struct({ type: Schema.string("image"), url: Schema.string() }),
    ]),
  })

  it("discriminant field returns a raw string, not a cached ref", () => {
    const { doc } = createDoc(schema, {
      item: { type: "text", body: "hello" },
    })
    expect(doc.item.type).toBe("text")
    expect(typeof doc.item.type).toBe("string")
  })

  it("discriminant identity is stable (same string from store)", () => {
    const { doc } = createDoc(schema, {
      item: { type: "text", body: "hello" },
    })
    // String identity: same primitive value on repeated access
    expect(doc.item.type).toBe(doc.item.type)
  })

  it("non-discriminant fields are still cached refs", () => {
    const { doc } = createDoc(schema, {
      item: { type: "text", body: "hello" },
    })
    // body is a cached ref — same identity on repeated access
    expect(doc.item.body).toBe(doc.item.body)
    expect(typeof doc.item.body).toBe("function")
    expect(doc.item.body()).toBe("hello")
  })

  it("a variant switch keeps the sum's identity, and the discriminant reads from the store", () => {
    const { doc } = createWritableDoc(schema, {
      item: { type: "text", body: "hello" },
    })
    const item = doc.item
    item.set({ type: "image", url: "pic.png" })

    expect(doc.item).toBe(item)
    expect(doc.item.type).toBe("image")
    expect(doc.item.url()).toBe("pic.png")
  })
})

// ===========================================================================
// Field refs live as long as their product ref
// ===========================================================================

describe("withCaching: field refs across a replace of their product", () => {
  it("a replace of the product keeps every field ref's identity", () => {
    const { doc } = createWritableDoc(structuralDocSchema, {
      settings: { darkMode: false, fontSize: 14 },
      metadata: {},
    })
    const darkMode = doc.settings.darkMode
    const fontSize = doc.settings.fontSize

    doc.settings.set({ darkMode: true, fontSize: 20 })

    expect(doc.settings.darkMode).toBe(darkMode)
    expect(doc.settings.fontSize).toBe(fontSize)
    expect(darkMode()).toBe(true)
    expect(fontSize()).toBe(20)
  })

  it("a replace of the product keeps a sum field's and a list field's identity", () => {
    const schema = Schema.struct({
      outer: Schema.struct({
        mode: Schema.discriminatedUnion("type", [
          Schema.struct({ type: Schema.string("a"), a: Schema.number() }),
          Schema.struct({ type: Schema.string("b"), b: Schema.string() }),
        ]),
        opt: Schema.struct({ x: Schema.number() }).nullable(),
        items: Schema.list(Schema.number()),
      }),
    })
    const { doc } = createWritableDoc(schema, {
      outer: { mode: { type: "a", a: 1 }, opt: null, items: [1] },
    })
    const mode = doc.outer.mode
    const opt = doc.outer.opt
    const items = doc.outer.items

    doc.outer.set({
      mode: { type: "b", b: "x" },
      opt: { x: 2 },
      items: [1, 2, 3],
    })

    expect(doc.outer.mode).toBe(mode)
    expect(doc.outer.opt).toBe(opt)
    expect(doc.outer.items).toBe(items)
    expect(doc.outer()).toEqual({
      mode: { type: "b", b: "x" },
      opt: { x: 2 },
      items: [1, 2, 3],
    })
  })
})

// ===========================================================================
// Sum dispatch still works through caching layer
// ===========================================================================

describe("withCaching: sum dispatch", () => {
  it("discriminated sum dispatches correctly", () => {
    const schema = Schema.struct({
      item: Schema.discriminatedUnion("type", [
        Schema.struct({ type: Schema.string("text"), body: Schema.string() }),
        Schema.struct({ type: Schema.string("image"), url: Schema.string() }),
      ]),
    })
    const { doc } = createDoc(schema, {
      item: { type: "image", url: "pic.png" },
    })
    expect(doc.item.url()).toBe("pic.png")
  })

  it("nullable sum dispatches correctly", () => {
    const schema = Schema.struct({
      bio: Schema.string().nullable(),
    })
    const { doc: doc1 } = createDoc(schema, { bio: null })
    expect(doc1.bio()).toBe(null)

    const { doc: doc2 } = createDoc(schema, { bio: "Hello" })
    expect(doc2.bio()).toBe("Hello")
  })
})

// ===========================================================================
// Full doc tree with caching
// ===========================================================================

describe("withCaching: full doc tree", () => {
  it("produces a complete navigable, cached tree with identity", () => {
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

    // Referential identity throughout
    expect(doc.messages).toBe(doc.messages)
    expect(doc.messages.at(0)).toBe(doc.messages.at(0))
  })
})

// ===========================================================================
// Writes through the prepare pipeline
//
// Every change reaches `ctx.prepare`, whether or not a mutation method sent
// it, and memoized refs read through their paths, so none goes stale.
// ===========================================================================

describe("withCaching: writes through ctx.prepare", () => {
  const fullInterpreter = withWritable(
    withCaching(
      withAddressing(withReadable(withNavigation(bottomInterpreter))),
    ),
  )

  const docSchema = Schema.struct({
    settings: Schema.struct({
      darkMode: Schema.boolean(),
      fontSize: Schema.number(),
    }),
    messages: Schema.list(
      Schema.struct({
        author: Schema.string(),
        body: Schema.string(),
      }),
    ),
  })

  function createFullDoc() {
    const store = {
      settings: { darkMode: false, fontSize: 14 },
      messages: [
        { author: "Alice", body: "Hello" },
        { author: "Bob", body: "World" },
      ],
    }
    const ctx = plainContext(docSchema, store)
    const doc = interpret(docSchema, fullInterpreter, ctx) as any
    return { doc, store, ctx }
  }

  it("a write through ctx.prepare is read back (bypassing mutation methods)", () => {
    const { doc, ctx } = createFullDoc()
    const darkMode = doc.settings.darkMode
    expect(darkMode()).toBe(false)

    const path = RawPath.empty.field("settings").field("darkMode")
    ctx.runBatch(() => {
      ctx.prepare(path, replaceChange(true), { ingress: "author" })
    }, {})

    expect(doc.settings.darkMode).toBe(darkMode)
    expect(darkMode()).toBe(true)
  })

  it("mutating one path preserves unrelated cached refs", () => {
    const { doc } = createFullDoc()

    // Populate caches at two unrelated paths
    const msgRef0 = doc.messages.at(0)
    expect(msgRef0.author()).toBe("Alice")
    const settingsRef = doc.settings
    expect(settingsRef.darkMode()).toBe(false)

    // Mutate settings.darkMode — this should NOT affect messages cache
    doc.settings.darkMode.set(true)

    expect(doc.settings.darkMode()).toBe(true)

    // messages cache is untouched — same ref identity
    expect(doc.messages.at(0)).toBe(msgRef0)
    expect(doc.messages.at(0).author()).toBe("Alice")
  })

  it("an insert through ctx.prepare moves the held items' addresses", () => {
    const { doc, ctx } = createFullDoc()

    // Populate sequence cache
    const _refAlice = doc.messages.at(0)
    const _refBob = doc.messages.at(1)
    expect(_refAlice.author()).toBe("Alice")
    expect(_refBob.author()).toBe("Bob")

    // Insert at index 0 via prepare (bypassing mutation methods)
    const path = RawPath.empty.field("messages")
    ctx.runBatch(() => {
      ctx.prepare(
        path,
        sequenceChange([{ insert: [own({ author: "Eve", body: "Hi" })] }]),
        { ingress: "author" },
      )
    }, {})

    expect(doc.messages.at(0).author()).toBe("Eve")
    expect(doc.messages.at(1)).toBe(_refAlice)
    expect(doc.messages.at(2)).toBe(_refBob)
    expect(_refAlice.author()).toBe("Alice")
    expect(_refBob.author()).toBe("Bob")
  })
})

describe("withCaching: read-only stack backward compatibility", () => {
  it("withCaching(withAddressing(withReadable(bottom))) with plain RefContext still works", () => {
    const readOnlyInterp = withCaching(
      withAddressing(withReadable(withNavigation(bottomInterpreter))),
    )
    const store = {
      settings: { darkMode: false, fontSize: 14 },
    }
    const ctx: RefContext = { reader: plainReader({ current: store }) }
    const schema = Schema.struct({
      settings: Schema.struct({
        darkMode: Schema.boolean(),
        fontSize: Schema.number(),
      }),
    })
    const doc = interpret(schema, readOnlyInterp, ctx) as any

    // Reading works
    expect(doc.settings.darkMode()).toBe(false)
    // Caching works (identity preserved)
    expect(doc.settings).toBe(doc.settings)
  })
})

// ===========================================================================
// Type-level tests
// ===========================================================================

describe("type-level: withCaching", () => {
  it("withCaching(withAddressing(withReadable(bottomInterpreter))) is Interpreter<RefContext, HasCall & HasNavigation & HasCaching>", () => {
    const cached = withCaching(
      withAddressing(withReadable(withNavigation(bottomInterpreter))),
    )
    const _check: Interpreter<
      RefContext,
      HasCall & HasNavigation & HasCaching
    > = cached
    void _check
  })

  it("result of cached interpreter satisfies HasCaching", () => {
    const cached = withCaching(
      withAddressing(withReadable(withNavigation(bottomInterpreter))),
    )
    const ctx: RefContext = { reader: plainReader({ current: { n: 1 } }) }
    const result = interpret(Schema.struct({ n: Schema.number() }), cached, ctx)
    const _check: HasCaching = result
    void _check
  })

  it("result of cached interpreter also satisfies HasNavigation and HasCall", () => {
    const cached = withCaching(
      withAddressing(withReadable(withNavigation(bottomInterpreter))),
    )
    const ctx: RefContext = { reader: plainReader({ current: "test" as any }) }
    const result = interpret(Schema.string(), cached, ctx)
    const _checkNav: HasNavigation = result
    const _checkRead: HasCall = result
    void _checkNav
    void _checkRead
  })

  it("withCaching(bottomInterpreter) is a type error (bottom has HasCall, not HasNavigation)", () => {
    // @ts-expect-error — bottomInterpreter produces HasCall, withCaching requires HasNavigation
    const _bad = withCaching(bottomInterpreter)
    void _bad
  })

  it("withCaching(plainInterpreter) is a type error", () => {
    const unknownInterpreter = plainInterpreter as any as Interpreter<
      RefContext,
      unknown
    >
    // @ts-expect-error — unknown is not assignable to HasNavigation
    const _bad = withCaching(unknownInterpreter)
    void _bad
  })
})

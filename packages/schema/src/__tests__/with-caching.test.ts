import { describe, expect, it } from "vitest"
import {
  interpret,
  mapChange,
  plainContext,
  plainInterpreter,
  plainStoreReader,
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
import { INVALIDATE, withCaching } from "../interpreters/with-caching.js"
import { withAddressing } from "../interpreters/with-addressing.js"
import { withNavigation } from "../interpreters/with-navigation.js"
import { withReadable } from "../interpreters/with-readable.js"
import { RawPath } from "../path.js"

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

// Default interpreter: includes withAddressing for identity-preserving
// sequence/map caching via the address table.
const cachedInterp = withCaching(
  withAddressing(withReadable(withNavigation(bottomInterpreter))),
)

// Interpreter WITHOUT withAddressing — for testing graceful degradation.
const cachedInterpNoAddressing = withCaching(
  withReadable(withNavigation(bottomInterpreter)),
)

function createDoc(
  schema: Parameters<typeof interpret>[0],
  store: Record<string, unknown>,
) {
  const ctx: RefContext = { store: plainStoreReader(store) }
  const doc = interpret(schema, cachedInterp, ctx) as any
  return { doc, store, ctx }
}

function createDocNoAddressing(
  schema: Parameters<typeof interpret>[0],
  store: Record<string, unknown>,
) {
  const ctx: RefContext = { store: plainStoreReader(store) }
  const doc = interpret(schema, cachedInterpNoAddressing, ctx) as any
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
  const schema = Schema.doc({
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
  const schema = Schema.doc({
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

  it("INVALIDATE clears non-discriminant caches but discriminant still reads from store", () => {
    const { doc, store } = createDoc(schema, {
      item: { type: "text", body: "hello" },
    })
    const bodyBefore = doc.item.body
    expect(bodyBefore).toBe(doc.item.body) // cached

    // Mutate store and invalidate
    ;(store as any).item = { type: "image", url: "pic.png" }
    doc.item[INVALIDATE](replaceChange({ type: "image", url: "pic.png" }))

    // Discriminant reads live from store
    expect(doc.item.type).toBe("image")
    // Non-discriminant cache was cleared — fresh ref
    expect(doc.item.url).not.toBe(bodyBefore)
  })
})

// ===========================================================================
// INVALIDATE: product
// ===========================================================================

describe("withCaching: INVALIDATE product", () => {
  it("has [INVALIDATE] symbol on product refs", () => {
    const { doc } = createDoc(structuralDocSchema, {
      settings: { darkMode: false, fontSize: 14 },
      metadata: {},
    })
    expect(typeof doc[INVALIDATE]).toBe("function")
  })

  it("INVALIDATE with replaceChange clears all field caches", () => {
    const { doc } = createDoc(structuralDocSchema, {
      settings: { darkMode: false, fontSize: 14 },
      metadata: {},
    })
    const settingsBefore = doc.settings
    expect(settingsBefore).toBe(doc.settings) // cached

    doc[INVALIDATE](
      replaceChange({
        settings: { darkMode: true, fontSize: 20 },
        metadata: {},
      }),
    )

    const settingsAfter = doc.settings
    expect(settingsAfter).not.toBe(settingsBefore) // cache cleared
  })

  it("INVALIDATE with unrecognized change type clears all caches", () => {
    const { doc } = createDoc(structuralDocSchema, {
      settings: { darkMode: false, fontSize: 14 },
      metadata: {},
    })
    const settingsBefore = doc.settings
    expect(settingsBefore).toBe(doc.settings)

    doc[INVALIDATE]({ type: "unknown" })

    expect(doc.settings).not.toBe(settingsBefore)
  })

  it("after INVALIDATE, re-accessing returns fresh refs that still work", () => {
    const { doc, store } = createDoc(structuralDocSchema, {
      settings: { darkMode: false, fontSize: 14 },
      metadata: {},
    })
    // Force cache
    expect(doc.settings.darkMode()).toBe(false)

    // Mutate store directly and invalidate
    ;(store as any).settings = { darkMode: true, fontSize: 20 }
    doc[INVALIDATE](
      replaceChange({
        settings: { darkMode: true, fontSize: 20 },
        metadata: {},
      }),
    )

    // Fresh refs read new data
    expect(doc.settings.darkMode()).toBe(true)
    expect(doc.settings.fontSize()).toBe(20)
  })
})

// ===========================================================================
// INVALIDATE: sequence
// ===========================================================================

describe("withCaching: INVALIDATE sequence", () => {
  const schema = Schema.doc({
    items: Schema.list(Schema.struct({ name: Schema.string() })),
  })

  function createListDoc(items: Array<{ name: string }>) {
    return createDoc(schema, { items })
  }

  it("has [INVALIDATE] symbol on sequence refs", () => {
    const { doc } = createListDoc([{ name: "a" }])
    expect(typeof doc.items[INVALIDATE]).toBe("function")
  })

  it("sequence INVALIDATE is a no-op (addressing layer handles advancement)", () => {
    const { doc } = createListDoc([{ name: "a" }, { name: "b" }])
    const refA = doc.items.at(0)
    const refB = doc.items.at(1)

    // Calling INVALIDATE with a sequence change should be a no-op —
    // the addressing layer handles all advancement in prepare.
    doc.items[INVALIDATE](sequenceChange([{ retain: 1 }, { delete: 1 }]))

    // Refs are still the same objects (INVALIDATE didn't clear anything)
    expect(doc.items.at(0)).toBe(refA)
    // Note: refB's address may have been advanced by the addressing
    // layer during prepare, but direct INVALIDATE doesn't change it.
  })

  it("address-table-backed .at(i) returns same ref on repeated access", () => {
    const { doc } = createListDoc([{ name: "a" }, { name: "b" }])

    const ref0a = doc.items.at(0)
    const ref0b = doc.items.at(0)
    expect(ref0a).toBe(ref0b) // identity via address table
  })
})

// ===========================================================================
// INVALIDATE: map
// ===========================================================================

describe("withCaching: INVALIDATE map", () => {
  const schema = Schema.doc({
    metadata: Schema.record(Schema.number()),
  })

  function createMapDoc(metadata: Record<string, number>) {
    return createDoc(schema, { metadata })
  }

  it("has [INVALIDATE] symbol on map refs", () => {
    const { doc } = createMapDoc({ a: 1 })
    expect(typeof doc.metadata[INVALIDATE]).toBe("function")
  })

  it("map INVALIDATE is a no-op (addressing layer handles tombstoning)", () => {
    const { doc } = createMapDoc({ a: 1, b: 2 })
    const refA = doc.metadata.at("a")

    // Calling INVALIDATE with a map change should be a no-op
    doc.metadata[INVALIDATE](mapChange(undefined, ["b"]))

    // Ref A is still the same object
    expect(doc.metadata.at("a")).toBe(refA)
  })

  it("address-table-backed .at(key) returns same ref on repeated access", () => {
    const { doc } = createMapDoc({ a: 1, b: 2 })

    const refA1 = doc.metadata.at("a")
    const refA2 = doc.metadata.at("a")
    expect(refA1).toBe(refA2) // identity via address table
  })
})

// ===========================================================================
// Scalars/annotations: no INVALIDATE (pass-through)
// ===========================================================================

describe("withCaching: leaf pass-through", () => {
  it("scalar refs do not have [INVALIDATE]", () => {
    const schema = Schema.doc({ n: Schema.number() })
    const { doc } = createDoc(schema, { n: 42 })
    expect(INVALIDATE in doc.n).toBe(false)
  })

  it("text annotation refs do not have [INVALIDATE]", () => {
    const schema = Schema.doc({ title: Schema.annotated("text") })
    const { doc } = createDoc(schema, { title: "Hello" })
    expect(INVALIDATE in doc.title).toBe(false)
  })

  it("counter annotation refs do not have [INVALIDATE]", () => {
    const schema = Schema.doc({ count: Schema.annotated("counter") })
    const { doc } = createDoc(schema, { count: 0 })
    expect(INVALIDATE in doc.count).toBe(false)
  })
})

// ===========================================================================
// Sum dispatch still works through caching layer
// ===========================================================================

describe("withCaching: sum dispatch", () => {
  it("discriminated sum dispatches correctly", () => {
    const schema = Schema.doc({
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
    const schema = Schema.doc({
      bio: Schema.nullable(Schema.string()),
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
// INVALIDATE symbol identity
// ===========================================================================

describe("INVALIDATE symbol", () => {
  it("is stable across references (Symbol.for identity)", () => {
    const other = Symbol.for("kyneta:invalidate")
    expect(INVALIDATE).toBe(other)
  })
})

// ===========================================================================
// Prepare-pipeline invalidation (Phase 4 verification)
//
// These tests verify that cache invalidation fires via the prepare
// pipeline — i.e. calling ctx.prepare(path, change) directly (without
// going through mutation methods) invalidates caches. This is the key
// behavioral contract introduced in Phase 4.
// ===========================================================================

describe("withCaching: prepare-pipeline invalidation", () => {
  const fullInterpreter = withWritable(
    withCaching(withAddressing(withReadable(withNavigation(bottomInterpreter)))),
  )

  const docSchema = Schema.doc({
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
    const ctx = plainContext(store)
    const doc = interpret(docSchema, fullInterpreter, ctx) as any
    return { doc, store, ctx }
  }

  it("ctx.prepare + ctx.flush invalidates cache at target path (bypassing mutation methods)", () => {
    // This is the RED test for the old code: before Phase 4, prepare was
    // just applyChangeToStore — no invalidation. The cache would be stale.
    const { doc, ctx } = createFullDoc()

    // Populate the cache by reading
    expect(doc.settings.darkMode()).toBe(false)

    // Bypass mutation methods — call prepare + flush directly.
    // This simulates what applyChanges will do in Phase 5.
    const path = RawPath.empty.field("settings").field("darkMode")
    ctx.prepare(path, replaceChange(true))
    ctx.flush()

    // The cache must be invalidated — reading should return the new value.
    // Pre-Phase 4 this would return `false` (stale cache).
    expect(doc.settings.darkMode()).toBe(true)
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

    // settings cache was invalidated (darkMode returns new value)
    expect(doc.settings.darkMode()).toBe(true)

    // messages cache is untouched — same ref identity
    expect(doc.messages.at(0)).toBe(msgRef0)
    expect(doc.messages.at(0).author()).toBe("Alice")
  })

  it("ctx.prepare invalidates sequence cache (evict on insert)", () => {
    const { doc, ctx } = createFullDoc()

    // Populate sequence cache
    const _refAlice = doc.messages.at(0)
    const _refBob = doc.messages.at(1)
    expect(_refAlice.author()).toBe("Alice")
    expect(_refBob.author()).toBe("Bob")

    // Insert at index 0 via prepare (bypassing mutation methods)
    const path = RawPath.empty.field("messages")
    ctx.prepare(
      path,
      sequenceChange([{ insert: [{ author: "Eve", body: "Hi" }] }]),
    )
    ctx.flush()

    // All indices are evicted and re-created with correct paths
    expect(doc.messages.at(0).author()).toBe("Eve") // new item
    expect(doc.messages.at(1).author()).toBe("Alice") // semantic correctness
    expect(doc.messages.at(2).author()).toBe("Bob") // semantic correctness
  })
})

describe("withCaching: degradation without withAddressing", () => {
  it("product field caching still works without withAddressing", () => {
    const { doc } = createDocNoAddressing(structuralDocSchema, {
      settings: { darkMode: false, fontSize: 14 },
      metadata: {},
    })
    // Product field identity is preserved (thunk memoization is self-contained)
    expect(doc.settings).toBe(doc.settings)
    expect(doc.settings.darkMode).toBe(doc.settings.darkMode)
  })

  it("sequence .at(i) returns fresh ref each time without withAddressing", () => {
    const schema = Schema.doc({
      items: Schema.list(Schema.string()),
    })
    const { doc } = createDocNoAddressing(schema, { items: ["a", "b"] })

    const ref1 = doc.items.at(0)
    const ref2 = doc.items.at(0)
    // No memoization — fresh ref each time
    expect(ref1).not.toBe(ref2)
    // But both read the correct value
    expect(ref1()).toBe("a")
    expect(ref2()).toBe("a")
  })

  it("map .at(key) returns fresh ref each time without withAddressing", () => {
    const schema = Schema.doc({
      metadata: Schema.record(Schema.number()),
    })
    const { doc } = createDocNoAddressing(schema, { metadata: { a: 1 } })

    const ref1 = doc.metadata.at("a")
    const ref2 = doc.metadata.at("a")
    // No memoization — fresh ref each time
    expect(ref1).not.toBe(ref2)
    // But both read the correct value
    expect(ref1()).toBe(1)
    expect(ref2()).toBe(1)
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
    const ctx: RefContext = { store: plainStoreReader(store) }
    const schema = Schema.doc({
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
    // [INVALIDATE] is still on refs (for direct use)
    expect(INVALIDATE in doc.settings).toBe(true)
    // Direct [INVALIDATE] clears memoized children — after store update
    // and invalidation, re-reading returns the new value.
    store.settings = { darkMode: true, fontSize: 24 }
    doc.settings[INVALIDATE](replaceChange({ darkMode: true, fontSize: 24 }))
    expect(doc.settings.darkMode()).toBe(true)
    expect(doc.settings.fontSize()).toBe(24)
  })
})

// ===========================================================================
// Type-level tests
// ===========================================================================

describe("type-level: withCaching", () => {
  it("withCaching(withReadable(bottomInterpreter)) is Interpreter<RefContext, HasCall & HasNavigation & HasCaching>", () => {
    const cached = withCaching(withReadable(withNavigation(bottomInterpreter)))
    const _check: Interpreter<
      RefContext,
      HasCall & HasNavigation & HasCaching
    > = cached
    void _check
  })

  it("result of cached interpreter satisfies HasCaching", () => {
    const cached = withCaching(withReadable(withNavigation(bottomInterpreter)))
    const ctx: RefContext = { store: plainStoreReader({ n: 1 }) }
    const result = interpret(Schema.struct({ n: Schema.number() }), cached, ctx)
    const _check: HasCaching = result
    void _check
  })

  it("result of cached interpreter also satisfies HasNavigation and HasCall", () => {
    const cached = withCaching(withReadable(withNavigation(bottomInterpreter)))
    const ctx: RefContext = { store: plainStoreReader("test" as any) }
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

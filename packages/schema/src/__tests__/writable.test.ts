import { describe, expect, it, vi } from "vitest"
import {
  Schema,
  LoroSchema,
  interpret,
  bottomInterpreter,
  withReadable,
  withCaching,
  withWritable,
  createWritableContext,
  TRANSACT,
  hasTransact,
} from "../index.js"
import { INVALIDATE } from "../interpreters/with-caching.js"
import type {
  WritableContext,
  TextRef,
  CounterRef,
  ScalarRef,
  SequenceRef,
  Writable,
} from "../index.js"
import type { RefContext } from "../interpreter-types.js"

// ===========================================================================
// Composed stacks
// ===========================================================================

// Full stack: readable + caching + writable (the standard composition)
const fullInterpreter = withWritable(withCaching(withReadable(bottomInterpreter)))

// Cacheless stack: readable + writable (no caching layer)
const cachelessInterpreter = withWritable(withReadable(bottomInterpreter))

// Write-only stack: writable on bare carriers (ref() throws)
const writeOnlyInterpreter = withWritable(bottomInterpreter)

// Backward compat alias used by most tests
const writableInterpreter = fullInterpreter

// ===========================================================================
// Base grammar tests — Schema only, no Loro annotations
// ===========================================================================

// ---------------------------------------------------------------------------
// Shared fixture: pure structural schema (no Loro annotations)
// ---------------------------------------------------------------------------

const structuralDocSchema = Schema.doc({
  settings: Schema.struct({
    darkMode: Schema.boolean(),
    fontSize: Schema.number(),
  }),
  metadata: Schema.record(Schema.any()),
})

function createStructuralDoc(storeOverrides: Record<string, unknown> = {}) {
  const store = {
    settings: { darkMode: false, fontSize: 14 },
    metadata: { version: 1 },
    ...storeOverrides,
  }
  const ctx = createWritableContext(store)
  const doc = interpret(structuralDocSchema, fullInterpreter, ctx) as any
  return { store, ctx, doc }
}

// ---------------------------------------------------------------------------
// Product lazy getters
// ---------------------------------------------------------------------------

describe("writable: product lazy getters", () => {
  it("returns the same ref on repeated access (referential identity)", () => {
    const { doc } = createStructuralDoc()
    const a = doc.settings
    const b = doc.settings
    expect(a).toBe(b)
  })

  it("accessing one field does NOT force siblings", () => {
    const store = {
      settings: { darkMode: true, fontSize: 16 },
      metadata: { version: 1 },
    }
    const ctx = createWritableContext(store)
    const doc = interpret(structuralDocSchema, writableInterpreter, ctx) as any

    // Access settings — metadata should not be forced
    const settings = doc.settings
    expect(settings.darkMode()).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Namespace isolation
// ---------------------------------------------------------------------------

describe("writable: namespace isolation", () => {
  it("Object.keys returns only schema property names for products", () => {
    const { doc } = createStructuralDoc()
    const keys = Object.keys(doc)
    expect(keys).toEqual(["settings", "metadata"])
  })

  it("schema property names are accessible via 'in' operator", () => {
    const { doc } = createStructuralDoc()
    expect("settings" in doc).toBe(true)
    expect("metadata" in doc).toBe(true)
  })

  it("non-schema string keys are not own properties", () => {
    const { doc } = createStructuralDoc()
    expect(Object.hasOwn(doc, "toString")).toBe(false)
    expect(Object.hasOwn(doc, "constructor")).toBe(false)
    expect(Object.hasOwn(doc, "nonexistent")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Scalar dispatch (self-path ReplaceChange)
// ---------------------------------------------------------------------------

describe("writable: scalar dispatch", () => {
  it(".set() writes to the backing store at the correct path", () => {
    const { store, doc } = createStructuralDoc()
    doc.settings.darkMode.set(true)
    expect(store.settings.darkMode).toBe(true)
  })

  it("ref() reads live from the backing store", () => {
    const { store, doc } = createStructuralDoc()
    ;(store.settings as Record<string, unknown>).fontSize = 20
    expect(doc.settings.fontSize()).toBe(20)
  })
})

// ---------------------------------------------------------------------------
// Product .set() — atomic subtree replacement
// ---------------------------------------------------------------------------

describe("writable: product .set()", () => {
  it(".set(plainObject) writes entire object to store", () => {
    const { store, doc } = createStructuralDoc()
    doc.settings.set({ darkMode: true, fontSize: 24 })
    expect(store.settings).toEqual({ darkMode: true, fontSize: 24 })
  })

  it(".set() is non-enumerable (doesn't appear in Object.keys)", () => {
    const { doc } = createStructuralDoc()
    const keys = Object.keys(doc.settings)
    expect(keys).toEqual(["darkMode", "fontSize"])
    expect(keys).not.toContain("set")
  })

  it("individual field refs still work after product .set()", () => {
    const { doc } = createStructuralDoc()
    doc.settings.set({ darkMode: true, fontSize: 24 })
    expect(doc.settings.darkMode()).toBe(true)
    expect(doc.settings.fontSize()).toBe(24)
    // Leaf .set() still works after product .set()
    doc.settings.darkMode.set(false)
    expect(doc.settings.darkMode()).toBe(false)
  })

  it(".set() inside transaction accumulates until commit", () => {
    const store = {
      settings: { darkMode: false, fontSize: 14 },
      metadata: { version: 1 },
    }
    const ctx = createWritableContext(store)
    const doc = interpret(structuralDocSchema, writableInterpreter, ctx) as any

    ctx.beginTransaction()
    doc.settings.set({ darkMode: true, fontSize: 20 })

    // Not yet applied
    expect(store.settings).toEqual({ darkMode: false, fontSize: 14 })

    // Commit applies it
    const flushed = ctx.commit()
    expect(store.settings).toEqual({ darkMode: true, fontSize: 20 })
    expect(flushed.length).toBe(1)
    expect(flushed[0].change.type).toBe("replace")
  })
})

// ---------------------------------------------------------------------------
// Portable refs
// ---------------------------------------------------------------------------

describe("writable: portable refs", () => {
  it("extracted scalar ref works outside the tree", () => {
    const { doc } = createStructuralDoc()
    const ref = doc.settings.fontSize
    // ref works independently
    ref.set(24)
    expect(ref()).toBe(24)
  })
})

// ---------------------------------------------------------------------------
// Map via Proxy
// ---------------------------------------------------------------------------

describe("writable: map ref", () => {
  it(".at(key) returns a callable child ref", () => {
    const { doc } = createStructuralDoc()
    const versionRef = doc.metadata.at("version")
    expect(versionRef!()).toBe(1)
  })

  it(".keys() returns the store's dynamic keys", () => {
    const { doc } = createStructuralDoc()
    expect(doc.metadata.keys()).toEqual(["version"])
  })

  it(".has(key) checks store keys", () => {
    const { doc } = createStructuralDoc()
    expect(doc.metadata.has("version")).toBe(true)
    expect(doc.metadata.has("nonexistent")).toBe(false)
  })

  it(".set(key, value) dispatches change and updates store", () => {
    const { store, doc } = createStructuralDoc()
    doc.metadata.set("newKey", "newValue")
    expect((store.metadata as Record<string, unknown>).newKey).toBe("newValue")
  })

  it(".delete(key) dispatches change and removes from store", () => {
    const { store, doc } = createStructuralDoc()
    doc.metadata.delete("version")
    expect("version" in (store.metadata as Record<string, unknown>)).toBe(false)
  })

  it(".clear() removes all keys from the store", () => {
    const { store, doc } = createStructuralDoc()
    doc.metadata.set("a", 1)
    doc.metadata.set("b", 2)
    doc.metadata.clear()
    expect(Object.keys(store.metadata as Record<string, unknown>)).toEqual([])
    expect(doc.metadata.size).toBe(0)
    expect(doc.metadata.keys()).toEqual([])
  })

  it("after .set(), .at() returns the new value", () => {
    const { doc } = createStructuralDoc()
    doc.metadata.set("color", "red")
    expect(doc.metadata.at("color")!()).toBe("red")
  })

  it(".get() and .set() are symmetric: .set(k, v) then .get(k) returns v", () => {
    const { doc } = createStructuralDoc()
    doc.metadata.set("color", "red")
    expect(doc.metadata.get("color")).toBe("red")
  })

  it(".get(key) returns plain value after mutation (not a function)", () => {
    const { doc } = createStructuralDoc()
    doc.metadata.set("color", "red")
    const val = doc.metadata.get("color")
    expect(typeof val).not.toBe("function")
    expect(val).toBe("red")
  })

  it("after .delete(), .has() returns false", () => {
    const { doc } = createStructuralDoc()
    expect(doc.metadata.has("version")).toBe(true)
    doc.metadata.delete("version")
    expect(doc.metadata.has("version")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Batched mode
// ---------------------------------------------------------------------------

describe("writable: transactions", () => {
  it("actions accumulate in transaction and do not apply until commit", () => {
    const store = { x: 0, y: 0 }
    const schema = Schema.doc({
      x: Schema.number(),
      y: Schema.number(),
    })
    const ctx = createWritableContext(store)
    const doc = interpret(schema, writableInterpreter, ctx) as any

    ctx.beginTransaction()
    doc.x.set(10)
    doc.y.set(20)

    // Not yet applied
    expect(store.x).toBe(0)
    expect(store.y).toBe(0)

    // Commit
    const flushed = ctx.commit()
    expect(store.x).toBe(10)
    expect(store.y).toBe(20)
    expect(flushed.length).toBe(2)
  })

  it("dispatch applies immediately outside a transaction", () => {
    const store = { x: 0 }
    const schema = Schema.doc({ x: Schema.number() })
    const ctx = createWritableContext(store)
    const doc = interpret(schema, writableInterpreter, ctx) as any

    doc.x.set(42)
    expect(store.x).toBe(42)
  })
})

// ---------------------------------------------------------------------------
// Discriminated sum dispatch
// ---------------------------------------------------------------------------

describe("writable: discriminated sum", () => {
  const schema = Schema.doc({
    item: Schema.discriminatedUnion("type", [
      Schema.struct({ type: Schema.string("text"), body: Schema.string() }),
      Schema.struct({ type: Schema.string("image"), url: Schema.string() }),
    ]),
  })

  it("dispatches to the correct variant based on store discriminant", () => {
    const store = { item: { type: "image", url: "pic.png" } }
    const ctx = createWritableContext(store)
    const doc = interpret(schema, writableInterpreter, ctx) as any

    // Should produce the "image" variant ref with a .url field
    expect(doc.item.url()).toBe("pic.png")
  })

  it("falls back to first variant when discriminant is missing", () => {
    const store = { item: {} }
    const ctx = createWritableContext(store)
    const doc = interpret(schema, writableInterpreter, ctx) as any

    // First variant is "text" which has a .body field
    expect(typeof doc.item.body).toBe("function")
  })

  it("falls back to first variant when store value is not an object", () => {
    const store = { item: 42 }
    const ctx = createWritableContext(store)
    const doc = interpret(schema, writableInterpreter, ctx) as any

    expect(typeof doc.item.body).toBe("function")
  })
})

// ---------------------------------------------------------------------------
// Nullable (positional sum) dispatch
// ---------------------------------------------------------------------------

describe("writable: nullable (positional sum)", () => {
  const schema = Schema.doc({
    bio: Schema.nullable(Schema.string()),
  })

  it("null store value dispatches to the null variant", () => {
    const store = { bio: null }
    const ctx = createWritableContext(store)
    const doc = interpret(schema, writableInterpreter, ctx) as any

    // The null variant is a scalar ref whose () returns null
    expect(doc.bio()).toBe(null)
  })

  it("non-null store value dispatches to the inner variant", () => {
    const store = { bio: "Hello world" }
    const ctx = createWritableContext(store)
    const doc = interpret(schema, writableInterpreter, ctx) as any

    expect(doc.bio()).toBe("Hello world")
  })

  it("mutation on the inner ref works", () => {
    const store = { bio: "old" }
    const ctx = createWritableContext(store)
    const doc = interpret(schema, writableInterpreter, ctx) as any

    doc.bio.set("new")
    expect(store.bio).toBe("new")
  })
})

// ===========================================================================
// LoroSchema tests — Loro-specific annotation-driven behavior
// ===========================================================================

// ---------------------------------------------------------------------------
// Shared fixture: Loro document schema (with annotations)
// ---------------------------------------------------------------------------

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

function createLoroDoc(storeOverrides: Record<string, unknown> = {}) {
  const store = {
    title: "Hello",
    count: 0,
    messages: [{ author: "Alice", body: "Hi" }],
    settings: { darkMode: false, fontSize: 14 },
    metadata: { version: 1 },
    ...storeOverrides,
  }
  const ctx = createWritableContext(store)
  const doc = interpret(loroDocSchema, fullInterpreter, ctx) as any
  return { store, ctx, doc }
}

// ---------------------------------------------------------------------------
// Text ref (Loro-specific)
// ---------------------------------------------------------------------------

describe("writable: text ref", () => {
  it("ref() returns the current string", () => {
    const { doc } = createLoroDoc()
    expect(doc.title()).toBe("Hello")
  })

  it(".insert() applies a text action to the store", () => {
    const { store, doc } = createLoroDoc()
    doc.title.insert(5, " World")
    expect(store.title).toBe("Hello World")
  })

  it(".delete() removes characters from the store", () => {
    const { store, doc } = createLoroDoc()
    doc.title.delete(0, 2)
    expect(store.title).toBe("llo")
  })

  it(".update() replaces the entire string", () => {
    const { store, doc } = createLoroDoc()
    doc.title.update("New Title")
    expect(store.title).toBe("New Title")
  })
})

// ---------------------------------------------------------------------------
// Counter ref (Loro-specific)
// ---------------------------------------------------------------------------

describe("writable: counter ref", () => {
  it("ref() returns the current value", () => {
    const { doc } = createLoroDoc()
    expect(doc.count()).toBe(0)
  })

  it(".increment() adds to the value", () => {
    const { store, doc } = createLoroDoc()
    doc.count.increment(5)
    expect(store.count).toBe(5)
  })

  it(".decrement() subtracts from the value", () => {
    const { store, doc } = createLoroDoc()
    doc.count.decrement(3)
    expect(store.count).toBe(-3)
  })

  it(".increment() with no arg defaults to 1", () => {
    const { store, doc } = createLoroDoc()
    doc.count.increment()
    expect(store.count).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Sequence ref (using Loro fixture for list-of-structs)
// ---------------------------------------------------------------------------

describe("writable: sequence ref", () => {
  it(".length reflects the store array length", () => {
    const { doc } = createLoroDoc()
    expect(doc.messages.length).toBe(1)
  })

  it(".at(i) returns a child ref for the item at index i", () => {
    const { doc } = createLoroDoc()
    const msg = doc.messages.at(0)!
    expect(msg.author()).toBe("Alice")
  })

  it(".push() appends items and updates the store", () => {
    const { store, doc } = createLoroDoc()
    doc.messages.push({ author: "Bob", body: "Hey" })
    expect((store.messages as unknown[]).length).toBe(2)
  })

  it(".delete() removes items from the store", () => {
    const { store, doc } = createLoroDoc()
    doc.messages.delete(0)
    expect((store.messages as unknown[]).length).toBe(0)
  })

  it(".get(i) returns the plain value directly after .push()", () => {
    const { doc } = createLoroDoc()
    doc.messages.push({ author: "Bob", body: "Hey" })
    const val = doc.messages.get(1)
    expect(typeof val).not.toBe("function")
    expect(val).toEqual({ author: "Bob", body: "Hey" })
  })
})

// ---------------------------------------------------------------------------
// Annotation-driven behavior — API shape depends on annotation tag
// ---------------------------------------------------------------------------

describe("writable: annotation-driven behavior", () => {
  it("LoroSchema.text() writable has .insert() and .delete()", () => {
    const { doc } = createLoroDoc()
    expect(typeof doc.title.insert).toBe("function")
    expect(typeof doc.title.delete).toBe("function")
    expect(typeof doc.title.update).toBe("function")
    // Callable — no .get()
    expect(typeof doc.title).toBe("function")
  })

  it("LoroSchema.plain.string() writable has .set() and is callable", () => {
    const { doc } = createLoroDoc()
    const msg = doc.messages.at(0)!
    expect(typeof msg.author).toBe("function")
    expect(typeof msg.author.set).toBe("function")
    // Should NOT have text-specific methods
    expect(
      (msg.author as unknown as Record<string, unknown>).insert,
    ).toBeUndefined()
  })

  it("LoroSchema.counter() writable has .increment() and .decrement()", () => {
    const { doc } = createLoroDoc()
    expect(typeof doc.count.increment).toBe("function")
    expect(typeof doc.count.decrement).toBe("function")
    // Callable — no .get()
    expect(typeof doc.count).toBe("function")
  })
})

// ---------------------------------------------------------------------------
// Portable refs (Loro-specific: TextRef works outside the tree)
// ---------------------------------------------------------------------------

describe("writable: portable refs (Loro)", () => {
  it("extracted text ref works outside the tree", () => {
    const { doc } = createLoroDoc()
    const ref = doc.title
    ref.insert(ref().length, " World")
    expect(ref()).toBe("Hello World")
  })
})

// ---------------------------------------------------------------------------
// Mutation + read integration
// ---------------------------------------------------------------------------

// ===========================================================================
// Invalidate-before-dispatch (the core timing fix)
// ===========================================================================

describe("writable: invalidate-before-dispatch", () => {
  const listSchema = LoroSchema.doc({
    items: Schema.list(Schema.struct({ name: Schema.string() })),
  })

  function createCachedListDoc(items: Array<{ name: string }>) {
    const store = { items }
    const ctx = createWritableContext(store)
    const doc = interpret(listSchema, fullInterpreter, ctx) as any
    return { doc, store, ctx }
  }

  it("after push(), .at(newIndex) returns correct child immediately", () => {
    const { doc } = createCachedListDoc([{ name: "a" }])
    // Populate cache
    expect(doc.items.at(0).name()).toBe("a")
    // Push a new item
    doc.items.push({ name: "b" })
    // New index should be immediately accessible
    expect(doc.items.at(1).name()).toBe("b")
    // Existing ref is preserved
    expect(doc.items.at(0).name()).toBe("a")
  })

  it("after insert(1, item) on 3-item list, shifted indices are fresh", () => {
    const { doc } = createCachedListDoc([
      { name: "a" },
      { name: "b" },
      { name: "c" },
    ])
    // Populate cache for all items
    const refA = doc.items.at(0)
    const refB = doc.items.at(1)
    const refC = doc.items.at(2)

    // Insert at index 1
    doc.items.insert(1, { name: "x" })

    // index 0: unchanged
    expect(doc.items.at(0)).toBe(refA)
    expect(doc.items.at(0).name()).toBe("a")
    // index 1: new item (not the old refB)
    expect(doc.items.at(1)).not.toBe(refB)
    expect(doc.items.at(1).name()).toBe("x")
    // index 2: shifted from old index 1 (refB)
    expect(doc.items.at(2)).toBe(refB)
    // index 3: shifted from old index 2 (refC)
    expect(doc.items.at(3)).toBe(refC)
  })

  it("after delete(0, 1), cache shifts preserve ref identity", () => {
    const { doc } = createCachedListDoc([
      { name: "a" },
      { name: "b" },
      { name: "c" },
    ])
    // Populate cache
    const refA = doc.items.at(0)
    const refB = doc.items.at(1)
    const refC = doc.items.at(2)

    // Delete first item
    doc.items.delete(0, 1)

    // Cache identity is preserved: refB shifted from index 1 → 0,
    // refC shifted from index 2 → 1. refA was deleted from cache.
    expect(doc.items.at(0)).toBe(refB)
    expect(doc.items.at(1)).toBe(refC)

    // Store is correctly updated
    expect(doc.items.length).toBe(2)
    expect(doc.items()).toEqual([{ name: "b" }, { name: "c" }])
  })
})

// ===========================================================================
// Cacheless stack (no caching, no crash)
// ===========================================================================

describe("writable: cacheless stack", () => {
  it("push() works without caching, store updated, no crash", () => {
    const schema = LoroSchema.doc({
      items: Schema.list(Schema.struct({ name: Schema.string() })),
    })
    const store = { items: [{ name: "a" }] }
    const ctx = createWritableContext(store)
    const doc = interpret(schema, cachelessInterpreter, ctx) as any

    doc.items.push({ name: "b" })
    expect((store.items as any[]).length).toBe(2)
    expect((store.items as any[])[1]).toEqual({ name: "b" })
  })

  it("map .set() works without caching", () => {
    const schema = Schema.doc({ meta: Schema.record(Schema.number()) })
    const store = { meta: { a: 1 } }
    const ctx = createWritableContext(store)
    const doc = interpret(schema, cachelessInterpreter, ctx) as any

    doc.meta.set("b", 2)
    expect((store.meta as any).b).toBe(2)
  })

  it("scalar .set() works without caching", () => {
    const schema = Schema.doc({ n: Schema.number() })
    const store = { n: 0 }
    const ctx = createWritableContext(store)
    const doc = interpret(schema, cachelessInterpreter, ctx) as any

    doc.n.set(42)
    expect(store.n).toBe(42)
  })
})

// ===========================================================================
// Write-only stack (ref() throws, mutation works)
// ===========================================================================

describe("writable: write-only stack", () => {
  it(".set() dispatches changes", () => {
    // Write-only uses bottomInterpreter which ignores product fields,
    // so we test with a bare scalar schema (not wrapped in doc).
    const schema = Schema.number()
    const store = {} as any
    const dispatched: Array<{ path: any; change: any }> = []
    const ctx: WritableContext = {
      store,
      prepare: (path, change) => dispatched.push({ path, change }),
      flush: () => {},
      dispatch: (path, change) => dispatched.push({ path, change }),
      beginTransaction: () => {},
      commit: () => [],
      abort: () => {},
      inTransaction: false,
    }
    const ref = interpret(schema, writeOnlyInterpreter, ctx) as any

    ref.set(42)
    expect(dispatched.length).toBe(1)
    expect(dispatched[0].change.type).toBe("replace")
    expect(dispatched[0].change.value).toBe(42)
  })

  it("ref() throws (no call behavior configured)", () => {
    const schema = Schema.number()
    const store = {} as any
    const ctx = createWritableContext(store)
    const ref = interpret(schema, writeOnlyInterpreter, ctx) as any

    expect(() => ref()).toThrow("No call behavior configured")
  })
})

// ===========================================================================
// Mutation + read integration
// ===========================================================================

describe("writable: mutation + read integration", () => {
  it("ref() reflects value after .set()", () => {
    const { doc } = createStructuralDoc()
    doc.settings.darkMode.set(true)
    expect(doc.settings.darkMode()).toBe(true)
  })

  it("ref() reflects value after .insert()", () => {
    const { doc } = createLoroDoc()
    doc.title.insert(5, " World")
    expect(doc.title()).toBe("Hello World")
  })

  it("ref() reflects value after .increment()", () => {
    const { doc } = createLoroDoc()
    doc.count.increment(10)
    expect(doc.count()).toBe(10)
  })

  it("sequence ref() reflects new items after .push()", () => {
    const { doc } = createLoroDoc()
    doc.messages.push({ author: "Bob", body: "Hey" })
    const arr = doc.messages()
    expect(Array.isArray(arr)).toBe(true)
    expect((arr as unknown[]).length).toBe(2)
  })

  it("sequence cache invalidation: after .push(), .at(newIndex) returns correct child", () => {
    const { doc } = createLoroDoc()
    doc.messages.push({ author: "Bob", body: "Hey" })
    const msg = doc.messages.at(1)!
    expect(msg.author()).toBe("Bob")
  })

  it("product ref() returns updated fresh snapshot after .set()", () => {
    const { doc, store } = createStructuralDoc()
    // Mutate via the writable API
    doc.settings.set({ darkMode: true, fontSize: 20 })

    // ref() returns the updated snapshot
    const snap = doc.settings()
    expect(snap).toEqual({ darkMode: true, fontSize: 20 })

    // Snapshot is still isolated — mutating it does not corrupt the store
    snap.darkMode = false
    expect((store.settings as any).darkMode).toBe(true)
    expect(doc.settings()).toEqual({ darkMode: true, fontSize: 20 })
  })

  it("map mutation: .set(key, value) dispatches change", () => {
    const { store, doc } = createStructuralDoc()
    doc.metadata.set("newKey", "newValue")
    expect((store.metadata as Record<string, unknown>).newKey).toBe("newValue")
  })

  it("map mutation: .delete(key) dispatches change", () => {
    const { store, doc } = createStructuralDoc()
    doc.metadata.delete("version")
    expect("version" in (store.metadata as Record<string, unknown>)).toBe(false)
  })
})

// ===========================================================================
// TRANSACT attachment — withWritable attaches [TRANSACT] to all refs
// ===========================================================================

describe("writable: TRANSACT attachment", () => {
  it("scalar ref has [TRANSACT] pointing to ctx", () => {
    const { ctx, doc } = createStructuralDoc()
    expect(doc.settings.darkMode[TRANSACT]).toBe(ctx)
  })

  it("product ref has [TRANSACT] pointing to ctx", () => {
    const { ctx, doc } = createStructuralDoc()
    expect(doc.settings[TRANSACT]).toBe(ctx)
  })

  it("sequence ref has [TRANSACT] pointing to ctx", () => {
    const { ctx, doc } = createLoroDoc()
    expect(doc.messages[TRANSACT]).toBe(ctx)
  })

  it("map ref has [TRANSACT] pointing to ctx", () => {
    const { ctx, doc } = createStructuralDoc()
    expect(doc.metadata[TRANSACT]).toBe(ctx)
  })

  it("text annotated ref has [TRANSACT] pointing to ctx", () => {
    const { ctx, doc } = createLoroDoc()
    expect(doc.title[TRANSACT]).toBe(ctx)
  })

  it("counter annotated ref has [TRANSACT] pointing to ctx", () => {
    const { ctx, doc } = createLoroDoc()
    expect(doc.count[TRANSACT]).toBe(ctx)
  })

  it("doc (delegating annotation) ref has [TRANSACT] pointing to ctx", () => {
    const { ctx, doc } = createLoroDoc()
    expect(doc[TRANSACT]).toBe(ctx)
  })

  it("[TRANSACT] does not appear in Object.keys()", () => {
    const { doc } = createStructuralDoc()
    expect(Object.keys(doc.settings)).not.toContain(TRANSACT)
    expect(Object.keys(doc.settings)).not.toContain(String(TRANSACT))
  })

  it("hasTransact() returns true for refs with [TRANSACT]", () => {
    const { doc } = createStructuralDoc()
    expect(hasTransact(doc)).toBe(true)
    expect(hasTransact(doc.settings)).toBe(true)
    expect(hasTransact(doc.settings.darkMode)).toBe(true)
    expect(hasTransact(doc.metadata)).toBe(true)
  })

  it("[TRANSACT] works on Proxy-backed map refs", () => {
    const { ctx, doc } = createStructuralDoc()
    // Map refs use Proxy — Object.defineProperty must bypass set trap
    expect(doc.metadata[TRANSACT]).toBe(ctx)
    // Verify the map still works normally after TRANSACT attachment
    doc.metadata.set("newKey", "newValue")
    expect(doc.metadata.at("newKey")()).toBe("newValue")
  })

  it("[TRANSACT] is present on cacheless stack refs", () => {
    const schema = Schema.doc({
      n: Schema.number(),
    })
    const store = { n: 0 }
    const ctx = createWritableContext(store)
    const doc = interpret(schema, cachelessInterpreter, ctx) as any
    expect(doc.n[TRANSACT]).toBe(ctx)
    expect(doc[TRANSACT]).toBe(ctx)
  })

  it("[TRANSACT] is present on write-only stack refs", () => {
    const schema = Schema.struct({ n: Schema.number() })
    const store = { n: 0 }
    const dispatched: unknown[] = []
    const ctx: WritableContext = {
      store,
      prepare: (path, change) => dispatched.push({ path, change }),
      flush: () => {},
      dispatch: (path, change) => dispatched.push({ path, change }),
      beginTransaction: () => { throw new Error("not implemented") },
      commit: () => { throw new Error("not implemented") },
      abort: () => { throw new Error("not implemented") },
      inTransaction: false,
    }
    const ref = interpret(schema, writeOnlyInterpreter, ctx) as any
    // Write-only product ref has [TRANSACT] (child .n is not navigable
    // without withReadable, so we test the product itself)
    expect(ref[TRANSACT]).toBe(ctx)
  })
})
import { describe, expect, it, vi } from "vitest"
import {
  Schema,
  LoroSchema,
  interpret,
  readableInterpreter,
  withMutation,
  createWritableContext,
  flush,
} from "../index.js"
import type {
  WritableContext,
  TextRef,
  CounterRef,
  ScalarRef,
  SequenceRef,
  Writable,
} from "../index.js"

// ===========================================================================
// Shared interpreter: withMutation(readableInterpreter)
// ===========================================================================

const writableInterpreter = withMutation(readableInterpreter)

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
  const doc = interpret(structuralDocSchema, writableInterpreter, ctx) as any
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
// Scalar upward reference
// ---------------------------------------------------------------------------

describe("writable: scalar upward reference", () => {
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
  it(".get(key) returns a callable child ref", () => {
    const { doc } = createStructuralDoc()
    const versionRef = doc.metadata.get("version")
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

  it("after .set(), .get() returns the new value", () => {
    const { doc } = createStructuralDoc()
    doc.metadata.set("color", "red")
    expect(doc.metadata.get("color")!()).toBe("red")
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

describe("writable: batched mode", () => {
  it("actions accumulate in pending and do not apply until flush", () => {
    const store = { x: 0, y: 0 }
    const schema = Schema.doc({
      x: Schema.number(),
      y: Schema.number(),
    })
    const ctx = createWritableContext(store, { autoCommit: false })
    const doc = interpret(schema, writableInterpreter, ctx) as any

    doc.x.set(10)
    doc.y.set(20)

    // Not yet applied
    expect(store.x).toBe(0)
    expect(store.y).toBe(0)
    expect(ctx.pending.length).toBe(2)

    // Flush
    const flushed = flush(ctx)
    expect(store.x).toBe(10)
    expect(store.y).toBe(20)
    expect(flushed.length).toBe(2)
    expect(ctx.pending.length).toBe(0)
  })

  it("auto-commit mode applies immediately", () => {
    const store = { x: 0 }
    const schema = Schema.doc({ x: Schema.number() })
    const ctx = createWritableContext(store, { autoCommit: true })
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
    item: Schema.discriminatedUnion("type", {
      text: Schema.struct({ body: Schema.string() }),
      image: Schema.struct({ url: Schema.string() }),
    }),
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
  const doc = interpret(loroDocSchema, writableInterpreter, ctx) as any
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
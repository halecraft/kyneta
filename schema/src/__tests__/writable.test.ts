import { describe, expect, it, vi } from "vitest"
import {
  Schema,
  LoroSchema,
  interpret,
  writableInterpreter,
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
  const doc = interpret(structuralDocSchema, writableInterpreter, ctx) as Writable<
    typeof structuralDocSchema
  >
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
    const doc = interpret(structuralDocSchema, writableInterpreter, ctx) as Writable<
      typeof structuralDocSchema
    >

    // Access settings — metadata should not be forced
    const settings = doc.settings
    expect(settings.darkMode.get()).toBe(true)
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

  it(".get() reads live from the backing store", () => {
    const { store, doc } = createStructuralDoc()
    ;(store.settings as Record<string, unknown>).fontSize = 20
    expect(doc.settings.fontSize.get()).toBe(20)
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
    expect(ref.get()).toBe(24)
  })
})

// ---------------------------------------------------------------------------
// Map via Proxy
// ---------------------------------------------------------------------------

describe("writable: map via Proxy", () => {
  it("dynamic string key access returns a child ref", () => {
    const { doc } = createStructuralDoc()
    const versionRef = doc.metadata.version
    expect(versionRef.get()).toBe(1)
  })

  it("Object.keys returns the store's dynamic keys", () => {
    const { doc } = createStructuralDoc()
    expect(Object.keys(doc.metadata)).toEqual(["version"])
  })

  it("'in' operator checks store keys", () => {
    const { doc } = createStructuralDoc()
    expect("version" in doc.metadata).toBe(true)
    expect("nonexistent" in doc.metadata).toBe(false)
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
    const doc = interpret(schema, writableInterpreter, ctx) as Writable<
      typeof schema
    >

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
    const doc = interpret(schema, writableInterpreter, ctx) as Writable<
      typeof schema
    >

    doc.x.set(42)
    expect(store.x).toBe(42)
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
    LoroSchema.plain.struct({
      author: LoroSchema.plain.string(),
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
  const doc = interpret(loroDocSchema, writableInterpreter, ctx) as Writable<
    typeof loroDocSchema
  >
  return { store, ctx, doc }
}

// ---------------------------------------------------------------------------
// Text ref (Loro-specific)
// ---------------------------------------------------------------------------

describe("writable: text ref", () => {
  it(".get() returns the current string", () => {
    const { doc } = createLoroDoc()
    expect(doc.title.get()).toBe("Hello")
  })

  it(".toString() returns the current string", () => {
    const { doc } = createLoroDoc()
    expect(doc.title.toString()).toBe("Hello")
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
  it(".get() returns the current value", () => {
    const { doc } = createLoroDoc()
    expect(doc.count.get()).toBe(0)
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

  it(".get(i) returns a child ref for the item at index i", () => {
    const { doc } = createLoroDoc()
    const msg = doc.messages.get(0)
    expect(msg.author.get()).toBe("Alice")
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
    expect(typeof doc.title.get).toBe("function")
  })

  it("LoroSchema.plain.string() writable has .get() and .set() only", () => {
    const { doc } = createLoroDoc()
    const msg = doc.messages.get(0)
    expect(typeof msg.author.get).toBe("function")
    expect(typeof msg.author.set).toBe("function")
    // Should NOT have text-specific methods
    expect(
      (msg.author as unknown as Record<string, unknown>).insert,
    ).toBeUndefined()
    expect(
      (msg.author as unknown as Record<string, unknown>).delete,
    ).toBeUndefined()
  })

  it("LoroSchema.counter() writable has .increment() and .decrement()", () => {
    const { doc } = createLoroDoc()
    expect(typeof doc.count.increment).toBe("function")
    expect(typeof doc.count.decrement).toBe("function")
    expect(typeof doc.count.get).toBe("function")
  })
})

// ---------------------------------------------------------------------------
// Portable refs (Loro-specific: TextRef works outside the tree)
// ---------------------------------------------------------------------------

describe("writable: portable refs (Loro)", () => {
  it("extracted text ref works outside the tree", () => {
    const { doc } = createLoroDoc()
    const ref = doc.title
    ref.insert(ref.get().length, " World")
    expect(ref.get()).toBe("Hello World")
  })
})
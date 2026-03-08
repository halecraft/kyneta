import { describe, expect, it, vi } from "vitest"
import {
  Schema,
  interpret,
  writableInterpreter,
  createWritableContext,
  flush,
  FEED,
  isFeedable,
} from "../index.js"
import type {
  WritableContext,
  TextRef,
  CounterRef,
  ScalarRef,
  SequenceRef,
  Writable,
} from "../index.js"

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const chatDocSchema = Schema.doc({
  title: Schema.text(),
  count: Schema.counter(),
  messages: Schema.list(
    Schema.struct({
      author: Schema.plain.string(),
      body: Schema.text(),
    }),
  ),
  settings: Schema.struct({
    darkMode: Schema.plain.boolean(),
    fontSize: Schema.plain.number(),
  }),
  metadata: Schema.record(Schema.plain.any()),
})

function createChatDoc(storeOverrides: Record<string, unknown> = {}) {
  const store = {
    title: "Hello",
    count: 0,
    messages: [{ author: "Alice", body: "Hi" }],
    settings: { darkMode: false, fontSize: 14 },
    metadata: { version: 1 },
    ...storeOverrides,
  }
  const ctx = createWritableContext(store)
  const doc = interpret(chatDocSchema, writableInterpreter, ctx) as Writable<
    typeof chatDocSchema
  >
  return { store, ctx, doc }
}

// ---------------------------------------------------------------------------
// Product lazy getters
// ---------------------------------------------------------------------------

describe("writable: product lazy getters", () => {
  it("returns the same ref on repeated access (referential identity)", () => {
    const { doc } = createChatDoc()
    const first = doc.title
    const second = doc.title
    expect(first).toBe(second)
  })

  it("accessing one field does NOT force siblings", () => {
    // We can't directly observe non-forcing, but we can verify that
    // the settings ref and title ref are independent objects created
    // at different times — accessing title doesn't create settings.
    const { doc } = createChatDoc()
    const title = doc.title
    expect(title).toBeDefined()
    // Access settings now — it should be independently created
    const settings = doc.settings
    expect(settings).toBeDefined()
    expect(settings).not.toBe(title)
  })
})

// ---------------------------------------------------------------------------
// Namespace isolation
// ---------------------------------------------------------------------------

describe("writable: namespace isolation", () => {
  it("Object.keys returns only schema property names for products", () => {
    const { doc } = createChatDoc()
    const keys = Object.keys(doc)
    expect(keys).toEqual(["title", "count", "messages", "settings", "metadata"])
  })

  it("[FEED] is present on products but not enumerable", () => {
    const { doc } = createChatDoc()
    const FEED_SYM = Symbol.for("kinetic:feed")
    expect(FEED_SYM in doc).toBe(true)
    const descriptor = Object.getOwnPropertyDescriptor(doc, FEED_SYM)
    expect(descriptor?.enumerable).toBe(false)
  })

  it("schema property names are accessible via 'in' operator", () => {
    const { doc } = createChatDoc()
    expect("title" in doc).toBe(true)
    expect("settings" in doc).toBe(true)
  })

  it("non-schema string keys are not own properties", () => {
    const { doc } = createChatDoc()
    expect(Object.hasOwn(doc, "toJSON")).toBe(false)
    expect(Object.hasOwn(doc, "constructor")).toBe(false)
    expect(Object.hasOwn(doc, "nonexistent")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Scalar ref upward write
// ---------------------------------------------------------------------------

describe("writable: scalar upward reference", () => {
  it(".set() writes to the backing store at the correct path", () => {
    const { doc, store } = createChatDoc()
    const darkModeRef = doc.settings.darkMode

    expect(darkModeRef.get()).toBe(false)
    darkModeRef.set(true)
    expect(store.settings.darkMode).toBe(true)
  })

  it(".get() reads live from the backing store", () => {
    const { doc, store } = createChatDoc()
    const fontSizeRef = doc.settings.fontSize

    expect(fontSizeRef.get()).toBe(14)
    // Mutate store directly
    ;(store.settings as any).fontSize = 20
    expect(fontSizeRef.get()).toBe(20)
  })
})

// ---------------------------------------------------------------------------
// Portable refs
// ---------------------------------------------------------------------------

describe("writable: portable refs", () => {
  it("extracted scalar ref works outside the tree", () => {
    const { doc, store } = createChatDoc()
    const fontRef = doc.settings.fontSize

    // Pass to a standalone function
    function bump(ref: { get(): number; set(value: number): void }) {
      ref.set(ref.get() + 2)
    }

    expect(fontRef.get()).toBe(14)
    bump(fontRef)
    expect(fontRef.get()).toBe(16)
    expect((store.settings as any).fontSize).toBe(16)
  })

  it("extracted text ref works outside the tree", () => {
    const { doc, store } = createChatDoc()
    const titleRef = doc.title

    function appendBang(ref: TextRef) {
      const len = ref.get().length
      ref.insert(len, "!")
    }

    appendBang(titleRef)
    expect(store.title).toBe("Hello!")
  })
})

// ---------------------------------------------------------------------------
// Text ref
// ---------------------------------------------------------------------------

describe("writable: text ref", () => {
  it(".get() returns the current string", () => {
    const { doc } = createChatDoc()
    expect(doc.title.get()).toBe("Hello")
  })

  it(".toString() returns the current string", () => {
    const { doc } = createChatDoc()
    expect(doc.title.toString()).toBe("Hello")
  })

  it(".insert() applies a text action to the store", () => {
    const { doc, store } = createChatDoc()
    doc.title.insert(5, " World")
    expect(store.title).toBe("Hello World")
  })

  it(".delete() removes characters from the store", () => {
    const { doc, store } = createChatDoc()
    doc.title.delete(0, 3)
    expect(store.title).toBe("lo")
  })

  it(".update() replaces the entire string", () => {
    const { doc, store } = createChatDoc()
    doc.title.update("New Title")
    expect(store.title).toBe("New Title")
  })
})

// ---------------------------------------------------------------------------
// Counter ref
// ---------------------------------------------------------------------------

describe("writable: counter ref", () => {
  it(".get() returns the current value", () => {
    const { doc } = createChatDoc()
    expect(doc.count.get()).toBe(0)
  })

  it(".increment() adds to the value", () => {
    const { doc, store } = createChatDoc()
    doc.count.increment(5)
    expect(store.count).toBe(5)
  })

  it(".decrement() subtracts from the value", () => {
    const { doc, store } = createChatDoc({ count: 10 })
    doc.count.decrement(3)
    expect(store.count).toBe(7)
  })

  it(".increment() with no arg defaults to 1", () => {
    const { doc, store } = createChatDoc()
    doc.count.increment()
    expect(store.count).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Sequence ref
// ---------------------------------------------------------------------------

describe("writable: sequence ref", () => {
  it(".length reflects the store array length", () => {
    const { doc } = createChatDoc()
    expect(doc.messages.length).toBe(1)
  })

  it(".get(i) returns a child ref for the item at index i", () => {
    const { doc } = createChatDoc()
    const msg0 = doc.messages.get(0)
    expect(msg0.author.get()).toBe("Alice")
    expect(msg0.body.get()).toBe("Hi")
  })

  it(".push() appends items and updates the store", () => {
    const { doc, store } = createChatDoc()
    doc.messages.push({ author: "Bob", body: "Hey" })
    expect((store.messages as any[]).length).toBe(2)
    expect((store.messages as any[])[1]).toEqual({ author: "Bob", body: "Hey" })
  })

  it(".delete() removes items from the store", () => {
    const { doc, store } = createChatDoc({
      messages: [
        { author: "Alice", body: "Hi" },
        { author: "Bob", body: "Hey" },
      ],
    })
    doc.messages.delete(0)
    expect((store.messages as any[]).length).toBe(1)
    expect((store.messages as any[])[0].author).toBe("Bob")
  })
})

// ---------------------------------------------------------------------------
// Map (Proxy)
// ---------------------------------------------------------------------------

describe("writable: map via Proxy", () => {
  it("dynamic string key access returns a child ref", () => {
    const { doc } = createChatDoc()
    const versionRef = doc.metadata.version
    expect(versionRef.get()).toBe(1)
  })

  it("Object.keys returns the store's dynamic keys", () => {
    const { doc } = createChatDoc()
    expect(Object.keys(doc.metadata)).toEqual(["version"])
  })

  it("'in' operator checks store keys", () => {
    const { doc } = createChatDoc()
    expect("version" in doc.metadata).toBe(true)
    expect("nonexistent" in doc.metadata).toBe(false)
  })

  it("[FEED] is accessible via symbol on map proxy", () => {
    const { doc } = createChatDoc()
    const FEED_SYM = Symbol.for("kinetic:feed")
    expect(FEED_SYM in doc.metadata).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Batched mode
// ---------------------------------------------------------------------------

describe("writable: batched mode", () => {
  it("actions accumulate in pending and do not apply until flush", () => {
    const store = { x: 0, y: 0 }
    const schema = Schema.doc({
      x: Schema.plain.number(),
      y: Schema.plain.number(),
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
    const schema = Schema.doc({ x: Schema.plain.number() })
    const ctx = createWritableContext(store, { autoCommit: true })
    const doc = interpret(schema, writableInterpreter, ctx) as Writable<
      typeof schema
    >

    doc.x.set(42)
    expect(store.x).toBe(42)
  })
})

// ---------------------------------------------------------------------------
// Feed subscription
// ---------------------------------------------------------------------------

describe("writable: feed subscription", () => {
  it("text ref [FEED].head returns the current value", () => {
    const { doc } = createChatDoc()
    const FEED_SYM = Symbol.for("kinetic:feed")
    const feed = (
      doc.title as unknown as Record<
        symbol,
        { head: string; subscribe: (cb: (a: unknown) => void) => () => void }
      >
    )[FEED_SYM]
    expect(feed.head).toBe("Hello")
  })

  it("text ref [FEED].head reflects mutations", () => {
    const { doc } = createChatDoc()
    const FEED_SYM = Symbol.for("kinetic:feed")
    const feed = (doc.title as unknown as Record<symbol, { head: string }>)[
      FEED_SYM
    ]

    doc.title.update("Changed")
    expect(feed.head).toBe("Changed")
  })

  it("subscribe receives actions, unsubscribe stops delivery", () => {
    const { doc } = createChatDoc()
    const FEED_SYM = Symbol.for("kinetic:feed")
    const feed = (
      doc.title as unknown as Record<
        symbol,
        { subscribe: (cb: (a: unknown) => void) => () => void }
      >
    )[FEED_SYM]

    const received: unknown[] = []
    const unsub = feed.subscribe((action: unknown) => received.push(action))

    doc.title.insert(0, "X")
    expect(received.length).toBe(1)

    unsub()
    doc.title.insert(0, "Y")
    expect(received.length).toBe(1) // no new action after unsub
  })

  it("isFeedable returns true for products", () => {
    const { doc } = createChatDoc()
    expect(isFeedable(doc)).toBe(true)
  })

  it("isFeedable returns true for text refs", () => {
    const { doc } = createChatDoc()
    expect(isFeedable(doc.title)).toBe(true)
  })

  it("isFeedable returns true for counter refs", () => {
    const { doc } = createChatDoc()
    expect(isFeedable(doc.count)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Annotation-driven behavior
// ---------------------------------------------------------------------------

describe("writable: annotation-driven behavior", () => {
  it("Schema.text() writable has .insert() and .delete()", () => {
    const { doc } = createChatDoc()
    expect(typeof doc.title.insert).toBe("function")
    expect(typeof doc.title.delete).toBe("function")
    expect(typeof doc.title.update).toBe("function")
    expect(typeof doc.title.get).toBe("function")
  })

  it("Schema.plain.string() writable has .get() and .set() only", () => {
    const { doc } = createChatDoc()
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

  it("Schema.counter() writable has .increment() and .decrement()", () => {
    const { doc } = createChatDoc()
    expect(typeof doc.count.increment).toBe("function")
    expect(typeof doc.count.decrement).toBe("function")
    expect(typeof doc.count.get).toBe("function")
  })
})

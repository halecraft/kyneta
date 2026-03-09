import { describe, expect, it } from "vitest"
import {
  Schema,
  LoroSchema,
  interpret,
  enrich,
  writableInterpreter,
  createWritableContext,
  withChangefeed,
  createChangefeedContext,
  changefeedFlush,
  hasChangefeed,
  CHANGEFEED,
} from "../index.js"
import type { Writable, TextRef, CounterRef } from "../index.js"

// ---------------------------------------------------------------------------
// Shared fixture
// ---------------------------------------------------------------------------

const chatDocSchema = LoroSchema.doc({
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

function createChangefeedChatDoc(storeOverrides: Record<string, unknown> = {}) {
  const store = {
    title: "Hello",
    count: 0,
    messages: [{ author: "Alice", body: "Hi" }],
    settings: { darkMode: false, fontSize: 14 },
    metadata: { version: 1 },
    ...storeOverrides,
  }
  const wCtx = createWritableContext(store)
  const cfCtx = createChangefeedContext(wCtx)
  const enriched = enrich(writableInterpreter, withChangefeed)
  const doc = interpret(chatDocSchema, enriched, cfCtx) as Writable<
    typeof chatDocSchema
  >
  return { store, cfCtx, doc }
}

const CF_SYM = Symbol.for("kinetic:changefeed")

function getChangefeed(obj: unknown): { current: unknown; subscribe: (cb: (c: unknown) => void) => () => void } {
  return (obj as Record<symbol, { current: unknown; subscribe: (cb: (c: unknown) => void) => () => void }>)[CF_SYM]
}

// ---------------------------------------------------------------------------
// hasChangefeed
// ---------------------------------------------------------------------------

describe("withChangefeed: hasChangefeed", () => {
  it("products have changefeed", () => {
    const { doc } = createChangefeedChatDoc()
    expect(hasChangefeed(doc)).toBe(true)
  })

  it("text refs have changefeed", () => {
    const { doc } = createChangefeedChatDoc()
    expect(hasChangefeed(doc.title)).toBe(true)
  })

  it("counter refs have changefeed", () => {
    const { doc } = createChangefeedChatDoc()
    expect(hasChangefeed(doc.count)).toBe(true)
  })

  it("sequence refs have changefeed", () => {
    const { doc } = createChangefeedChatDoc()
    expect(hasChangefeed(doc.messages)).toBe(true)
  })

  it("map refs have changefeed (via Proxy defineProperty trap)", () => {
    const { doc } = createChangefeedChatDoc()
    expect(hasChangefeed(doc.metadata)).toBe(true)
  })

  it("nested product refs have changefeed", () => {
    const { doc } = createChangefeedChatDoc()
    expect(hasChangefeed(doc.settings)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Namespace isolation
// ---------------------------------------------------------------------------

describe("withChangefeed: namespace isolation", () => {
  it("[CHANGEFEED] is present on products but not enumerable", () => {
    const { doc } = createChangefeedChatDoc()
    expect(CF_SYM in (doc as object)).toBe(true)
    const descriptor = Object.getOwnPropertyDescriptor(doc, CF_SYM)
    expect(descriptor?.enumerable).toBe(false)
  })

  it("Object.keys still returns only schema property names", () => {
    const { doc } = createChangefeedChatDoc()
    const keys = Object.keys(doc)
    expect(keys).toEqual(["title", "count", "messages", "settings", "metadata"])
  })

  it("[CHANGEFEED] is accessible on map proxy via symbol", () => {
    const { doc } = createChangefeedChatDoc()
    expect(CF_SYM in (doc.metadata as object)).toBe(true)
  })

  it("Object.keys on map proxy returns only store keys", () => {
    const { doc } = createChangefeedChatDoc()
    expect(Object.keys(doc.metadata)).toEqual(["version"])
  })
})

// ---------------------------------------------------------------------------
// Changefeed current
// ---------------------------------------------------------------------------

describe("withChangefeed: current value", () => {
  it("product [CHANGEFEED].current returns the store object at that path", () => {
    const { doc, store } = createChangefeedChatDoc()
    const cf = getChangefeed(doc)
    expect(cf.current).toEqual(store)
  })

  it("text ref [CHANGEFEED].current returns the current string", () => {
    const { doc } = createChangefeedChatDoc()
    const cf = getChangefeed(doc.title)
    expect(cf.current).toBe("Hello")
  })

  it("text ref [CHANGEFEED].current reflects mutations", () => {
    const { doc } = createChangefeedChatDoc()
    const cf = getChangefeed(doc.title)
    doc.title.update("Changed")
    expect(cf.current).toBe("Changed")
  })

  it("counter ref [CHANGEFEED].current reflects mutations", () => {
    const { doc } = createChangefeedChatDoc()
    const cf = getChangefeed(doc.count)
    expect(cf.current).toBe(0)
    doc.count.increment(5)
    expect(cf.current).toBe(5)
  })
})

// ---------------------------------------------------------------------------
// Changefeed subscription lifecycle
// ---------------------------------------------------------------------------

describe("withChangefeed: subscription lifecycle", () => {
  it("subscribe receives changes on mutation", () => {
    const { doc } = createChangefeedChatDoc()
    const cf = getChangefeed(doc.title)

    const received: unknown[] = []
    cf.subscribe((change) => received.push(change))

    doc.title.insert(0, "X")
    expect(received.length).toBe(1)
    expect((received[0] as { type: string }).type).toBe("text")
  })

  it("unsubscribe stops delivery", () => {
    const { doc } = createChangefeedChatDoc()
    const cf = getChangefeed(doc.title)

    const received: unknown[] = []
    const unsub = cf.subscribe((change) => received.push(change))

    doc.title.insert(0, "A")
    expect(received.length).toBe(1)

    unsub()
    doc.title.insert(0, "B")
    expect(received.length).toBe(1) // no new change after unsub
  })

  it("multiple subscribers all receive changes", () => {
    const { doc } = createChangefeedChatDoc()
    const cf = getChangefeed(doc.title)

    const a: unknown[] = []
    const b: unknown[] = []
    cf.subscribe((change) => a.push(change))
    cf.subscribe((change) => b.push(change))

    doc.title.insert(0, "X")
    expect(a.length).toBe(1)
    expect(b.length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Writable surface preserved through enrichment
// ---------------------------------------------------------------------------

describe("withChangefeed: writable surface preserved", () => {
  it("text ref .insert() still works", () => {
    const { doc, store } = createChangefeedChatDoc()
    doc.title.insert(5, " World")
    expect(store.title).toBe("Hello World")
  })

  it("counter ref .increment() still works", () => {
    const { doc, store } = createChangefeedChatDoc()
    doc.count.increment(3)
    expect(store.count).toBe(3)
  })

  it("scalar ref .set() still works", () => {
    const { doc, store } = createChangefeedChatDoc()
    doc.settings.darkMode.set(true)
    expect((store.settings as Record<string, unknown>).darkMode).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Batched mode: changefeedFlush notifies subscribers
// ---------------------------------------------------------------------------

describe("withChangefeed: batched mode", () => {
  it("changefeedFlush applies pending changes AND notifies subscribers", () => {
    const store = { x: 0, y: 0 }
    const schema = LoroSchema.doc({
      x: LoroSchema.plain.number(),
      y: LoroSchema.plain.number(),
    })
    const wCtx = createWritableContext(store, { autoCommit: false })
    const cfCtx = createChangefeedContext(wCtx)
    const enriched = enrich(writableInterpreter, withChangefeed)
    const doc = interpret(schema, enriched, cfCtx) as Writable<typeof schema>

    // Subscribe to the root to see notifications
    const cf = getChangefeed(doc)
    const received: unknown[] = []
    cf.subscribe((change) => received.push(change))

    doc.x.set(10)
    doc.y.set(20)

    // Not yet applied or notified
    expect(store.x).toBe(0)
    expect(store.y).toBe(0)
    expect(received.length).toBe(0)

    // Flush
    const flushed = changefeedFlush(cfCtx)
    expect(store.x).toBe(10)
    expect(store.y).toBe(20)
    expect(flushed.length).toBe(2)
    // Subscribers on root were notified (MapChange dispatches to root path [])
    expect(received.length).toBe(2)
  })
})
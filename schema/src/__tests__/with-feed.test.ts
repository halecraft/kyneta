import { describe, expect, it } from "vitest"
import {
  Schema,
  interpret,
  enrich,
  writableInterpreter,
  createWritableContext,
  withFeed,
  createFeedableContext,
  feedableFlush,
  isFeedable,
  FEED,
} from "../index.js"
import type { Writable, TextRef, CounterRef } from "../index.js"

// ---------------------------------------------------------------------------
// Shared fixture
// ---------------------------------------------------------------------------

const chatDocSchema = Schema.doc({
  title: Schema.text(),
  count: Schema.counter(),
  messages: Schema.list(
    Schema.struct({
      author: Schema.string(),
      body: Schema.text(),
    }),
  ),
  settings: Schema.struct({
    darkMode: Schema.boolean(),
    fontSize: Schema.number(),
  }),
  metadata: Schema.record(Schema.any()),
})

function createFeedableChatDoc(storeOverrides: Record<string, unknown> = {}) {
  const store = {
    title: "Hello",
    count: 0,
    messages: [{ author: "Alice", body: "Hi" }],
    settings: { darkMode: false, fontSize: 14 },
    metadata: { version: 1 },
    ...storeOverrides,
  }
  const wCtx = createWritableContext(store)
  const fCtx = createFeedableContext(wCtx)
  const enriched = enrich(writableInterpreter, withFeed)
  const doc = interpret(chatDocSchema, enriched, fCtx) as Writable<
    typeof chatDocSchema
  >
  return { store, fCtx, doc }
}

const FEED_SYM = Symbol.for("kinetic:feed")

function getFeed(obj: unknown): { head: unknown; subscribe: (cb: (a: unknown) => void) => () => void } {
  return (obj as Record<symbol, { head: unknown; subscribe: (cb: (a: unknown) => void) => () => void }>)[FEED_SYM]
}

// ---------------------------------------------------------------------------
// isFeedable
// ---------------------------------------------------------------------------

describe("withFeed: isFeedable", () => {
  it("products are feedable", () => {
    const { doc } = createFeedableChatDoc()
    expect(isFeedable(doc)).toBe(true)
  })

  it("text refs are feedable", () => {
    const { doc } = createFeedableChatDoc()
    expect(isFeedable(doc.title)).toBe(true)
  })

  it("counter refs are feedable", () => {
    const { doc } = createFeedableChatDoc()
    expect(isFeedable(doc.count)).toBe(true)
  })

  it("sequence refs are feedable", () => {
    const { doc } = createFeedableChatDoc()
    expect(isFeedable(doc.messages)).toBe(true)
  })

  it("map refs are feedable (via Proxy defineProperty trap)", () => {
    const { doc } = createFeedableChatDoc()
    expect(isFeedable(doc.metadata)).toBe(true)
  })

  it("nested product refs are feedable", () => {
    const { doc } = createFeedableChatDoc()
    expect(isFeedable(doc.settings)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Namespace isolation
// ---------------------------------------------------------------------------

describe("withFeed: namespace isolation", () => {
  it("[FEED] is present on products but not enumerable", () => {
    const { doc } = createFeedableChatDoc()
    expect(FEED_SYM in (doc as object)).toBe(true)
    const descriptor = Object.getOwnPropertyDescriptor(doc, FEED_SYM)
    expect(descriptor?.enumerable).toBe(false)
  })

  it("Object.keys still returns only schema property names", () => {
    const { doc } = createFeedableChatDoc()
    const keys = Object.keys(doc)
    expect(keys).toEqual(["title", "count", "messages", "settings", "metadata"])
  })

  it("[FEED] is accessible on map proxy via symbol", () => {
    const { doc } = createFeedableChatDoc()
    expect(FEED_SYM in (doc.metadata as object)).toBe(true)
  })

  it("Object.keys on map proxy returns only store keys", () => {
    const { doc } = createFeedableChatDoc()
    expect(Object.keys(doc.metadata)).toEqual(["version"])
  })
})

// ---------------------------------------------------------------------------
// Feed head
// ---------------------------------------------------------------------------

describe("withFeed: feed head", () => {
  it("product [FEED].head returns the store object at that path", () => {
    const { doc, store } = createFeedableChatDoc()
    const feed = getFeed(doc)
    expect(feed.head).toEqual(store)
  })

  it("text ref [FEED].head returns the current string", () => {
    const { doc } = createFeedableChatDoc()
    const feed = getFeed(doc.title)
    expect(feed.head).toBe("Hello")
  })

  it("text ref [FEED].head reflects mutations", () => {
    const { doc } = createFeedableChatDoc()
    const feed = getFeed(doc.title)
    doc.title.update("Changed")
    expect(feed.head).toBe("Changed")
  })

  it("counter ref [FEED].head reflects mutations", () => {
    const { doc } = createFeedableChatDoc()
    const feed = getFeed(doc.count)
    expect(feed.head).toBe(0)
    doc.count.increment(5)
    expect(feed.head).toBe(5)
  })
})

// ---------------------------------------------------------------------------
// Feed subscription lifecycle
// ---------------------------------------------------------------------------

describe("withFeed: subscription lifecycle", () => {
  it("subscribe receives actions on mutation", () => {
    const { doc } = createFeedableChatDoc()
    const feed = getFeed(doc.title)

    const received: unknown[] = []
    feed.subscribe((action) => received.push(action))

    doc.title.insert(0, "X")
    expect(received.length).toBe(1)
    expect((received[0] as { type: string }).type).toBe("text")
  })

  it("unsubscribe stops delivery", () => {
    const { doc } = createFeedableChatDoc()
    const feed = getFeed(doc.title)

    const received: unknown[] = []
    const unsub = feed.subscribe((action) => received.push(action))

    doc.title.insert(0, "A")
    expect(received.length).toBe(1)

    unsub()
    doc.title.insert(0, "B")
    expect(received.length).toBe(1) // no new action after unsub
  })

  it("multiple subscribers all receive actions", () => {
    const { doc } = createFeedableChatDoc()
    const feed = getFeed(doc.title)

    const a: unknown[] = []
    const b: unknown[] = []
    feed.subscribe((action) => a.push(action))
    feed.subscribe((action) => b.push(action))

    doc.title.insert(0, "X")
    expect(a.length).toBe(1)
    expect(b.length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Writable surface preserved through enrichment
// ---------------------------------------------------------------------------

describe("withFeed: writable surface preserved", () => {
  it("text ref .insert() still works", () => {
    const { doc, store } = createFeedableChatDoc()
    doc.title.insert(5, " World")
    expect(store.title).toBe("Hello World")
  })

  it("counter ref .increment() still works", () => {
    const { doc, store } = createFeedableChatDoc()
    doc.count.increment(3)
    expect(store.count).toBe(3)
  })

  it("scalar ref .set() still works", () => {
    const { doc, store } = createFeedableChatDoc()
    doc.settings.darkMode.set(true)
    expect((store.settings as Record<string, unknown>).darkMode).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Batched mode: feedableFlush notifies subscribers
// ---------------------------------------------------------------------------

describe("withFeed: batched mode", () => {
  it("feedableFlush applies pending actions AND notifies subscribers", () => {
    const store = { x: 0, y: 0 }
    const schema = Schema.doc({
      x: Schema.number(),
      y: Schema.number(),
    })
    const wCtx = createWritableContext(store, { autoCommit: false })
    const fCtx = createFeedableContext(wCtx)
    const enriched = enrich(writableInterpreter, withFeed)
    const doc = interpret(schema, enriched, fCtx) as Writable<typeof schema>

    // Subscribe to the root to see notifications
    const feed = getFeed(doc)
    const received: unknown[] = []
    feed.subscribe((action) => received.push(action))

    doc.x.set(10)
    doc.y.set(20)

    // Not yet applied or notified
    expect(store.x).toBe(0)
    expect(store.y).toBe(0)
    expect(received.length).toBe(0)

    // Flush
    const flushed = feedableFlush(fCtx)
    expect(store.x).toBe(10)
    expect(store.y).toBe(20)
    expect(flushed.length).toBe(2)
    // Subscribers on root were notified (MapAction dispatches to root path [])
    expect(received.length).toBe(2)
  })
})
import { describe, expect, it } from "vitest"
import {
  Schema,
  LoroSchema,
  interpret,
  enrich,
  readableInterpreter,
  withMutation,
  createWritableContext,
  withChangefeed,
  createChangefeedContext,
  changefeedFlush,
  subscribeDeep,
  hasChangefeed,
  CHANGEFEED,
} from "../index.js"
import type { Readable, Writable, TextRef, CounterRef, DeepEvent } from "../index.js"

const writableInterpreter = withMutation(readableInterpreter)

// ---------------------------------------------------------------------------
// Shared fixture
// ---------------------------------------------------------------------------

const chatDocSchema = LoroSchema.doc({
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
  const doc = interpret(chatDocSchema, enriched, cfCtx) as Readable<
    typeof chatDocSchema
  > &
    Writable<typeof chatDocSchema>
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

  it("map refs have changefeed", () => {
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

  it("[CHANGEFEED] is accessible on map ref via symbol", () => {
    const { doc } = createChangefeedChatDoc()
    expect(CF_SYM in (doc.metadata as object)).toBe(true)
  })

  it("map ref .keys() returns store keys", () => {
    const { doc } = createChangefeedChatDoc()
    expect(doc.metadata.keys()).toEqual(["version"])
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
    const doc = interpret(schema, enriched, cfCtx) as Readable<typeof schema> &
      Writable<typeof schema>

    // Deep subscriber on root — scalar .set() dispatches ReplaceChange at
    // the scalar's own path, so an exact subscriber at root won't see it.
    const received: DeepEvent[] = []
    subscribeDeep(cfCtx, [], (e) => received.push(e))

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
    // Deep subscriber at root sees both scalar ReplaceChanges
    expect(received.length).toBe(2)
    expect(received[0]!.change.type).toBe("replace")
    expect(received[1]!.change.type).toBe("replace")
  })
})

// ---------------------------------------------------------------------------
// Deep subscriptions (subscribeDeep)
// ---------------------------------------------------------------------------

describe("subscribeDeep: basic dispatch", () => {
  it("deep subscriber on root receives text change from doc.title.insert()", () => {
    const { cfCtx, doc } = createChangefeedChatDoc()
    const events: DeepEvent[] = []
    subscribeDeep(cfCtx, [], (e) => events.push(e))

    doc.title.insert(0, "X")

    expect(events).toHaveLength(1)
    expect(events[0]!.origin).toEqual([{ type: "key", key: "title" }])
    expect(events[0]!.change.type).toBe("text")
  })

  it("deep subscriber on root receives counter change from doc.count.increment()", () => {
    const { cfCtx, doc } = createChangefeedChatDoc()
    const events: DeepEvent[] = []
    subscribeDeep(cfCtx, [], (e) => events.push(e))

    doc.count.increment(5)

    expect(events).toHaveLength(1)
    expect(events[0]!.origin).toEqual([{ type: "key", key: "count" }])
    expect(events[0]!.change.type).toBe("increment")
  })

  it("deep subscriber on root receives sequence change from doc.messages.push()", () => {
    const { cfCtx, doc } = createChangefeedChatDoc()
    const events: DeepEvent[] = []
    subscribeDeep(cfCtx, [], (e) => events.push(e))

    doc.messages.push({ author: "Bob", body: "Hey" })

    expect(events).toHaveLength(1)
    expect(events[0]!.origin).toEqual([{ type: "key", key: "messages" }])
    expect(events[0]!.change.type).toBe("sequence")
  })
})

describe("subscribeDeep: scalar self-path dispatch", () => {
  it("deep subscriber on settings receives scalar set with origin [darkMode]", () => {
    const { cfCtx, doc } = createChangefeedChatDoc()
    const events: DeepEvent[] = []
    // Subscribe deep at ["settings"]
    subscribeDeep(cfCtx, [{ type: "key", key: "settings" }], (e) => events.push(e))

    // darkMode.set() dispatches ReplaceChange at ["settings","darkMode"]
    doc.settings.darkMode.set(true)

    expect(events).toHaveLength(1)
    expect(events[0]!.origin).toEqual([{ type: "key", key: "darkMode" }])
    expect(events[0]!.change.type).toBe("replace")
  })

  it("deep subscriber on root receives scalar set with full origin path", () => {
    const { cfCtx, doc } = createChangefeedChatDoc()
    const events: DeepEvent[] = []
    subscribeDeep(cfCtx, [], (e) => events.push(e))

    doc.settings.darkMode.set(true)

    expect(events).toHaveLength(1)
    // ReplaceChange dispatches at ["settings","darkMode"], so relative to root:
    expect(events[0]!.origin).toEqual([
      { type: "key", key: "settings" },
      { type: "key", key: "darkMode" },
    ])
    expect(events[0]!.change.type).toBe("replace")
  })

  it("exact-path subscriber on scalar fires on .set()", () => {
    const { doc } = createChangefeedChatDoc()
    const cf = getChangefeed(doc.settings.darkMode)
    const received: unknown[] = []
    cf.subscribe((change: unknown) => received.push(change))

    doc.settings.darkMode.set(true)

    expect(received).toHaveLength(1)
    expect((received[0] as { type: string }).type).toBe("replace")
    expect((received[0] as { type: string; value: unknown }).value).toBe(true)
  })
})

describe("subscribeDeep: unsubscribe", () => {
  it("unsubscribe stops delivery", () => {
    const { cfCtx, doc } = createChangefeedChatDoc()
    const events: DeepEvent[] = []
    const unsub = subscribeDeep(cfCtx, [], (e) => events.push(e))

    doc.title.insert(0, "A")
    expect(events).toHaveLength(1)

    unsub()
    doc.title.insert(0, "B")
    expect(events).toHaveLength(1) // no new event after unsub
  })
})

describe("subscribeDeep: multi-level", () => {
  it("multiple deep subscribers at different levels both fire", () => {
    const { cfCtx, doc } = createChangefeedChatDoc()
    const rootEvents: DeepEvent[] = []
    const settingsEvents: DeepEvent[] = []

    subscribeDeep(cfCtx, [], (e) => rootEvents.push(e))
    subscribeDeep(cfCtx, [{ type: "key", key: "settings" }], (e) => settingsEvents.push(e))

    // darkMode.set() dispatches ReplaceChange at ["settings","darkMode"]
    doc.settings.darkMode.set(true)

    // Root sees origin: [{key:"settings"},{key:"darkMode"}]
    expect(rootEvents).toHaveLength(1)
    expect(rootEvents[0]!.origin).toEqual([
      { type: "key", key: "settings" },
      { type: "key", key: "darkMode" },
    ])

    // Settings sees origin: [{key:"darkMode"}]
    expect(settingsEvents).toHaveLength(1)
    expect(settingsEvents[0]!.origin).toEqual([{ type: "key", key: "darkMode" }])
  })
})

describe("subscribeDeep: coexistence with exact", () => {
  it("deep subscriber and exact subscriber both fire for same dispatch", () => {
    const { cfCtx, doc } = createChangefeedChatDoc()

    // Exact subscribe on title
    const exactChanges: unknown[] = []
    const cf = getChangefeed(doc.title)
    cf.subscribe((change) => exactChanges.push(change))

    // Deep subscribe on root
    const deepEvents: DeepEvent[] = []
    subscribeDeep(cfCtx, [], (e) => deepEvents.push(e))

    doc.title.insert(0, "X")

    expect(exactChanges).toHaveLength(1)
    expect(deepEvents).toHaveLength(1)
    expect((exactChanges[0] as { type: string }).type).toBe("text")
    expect(deepEvents[0]!.change.type).toBe("text")
  })
})

describe("subscribeDeep: batched mode", () => {
  it("deep subscribers fire during changefeedFlush, not during dispatch", () => {
    const store = { x: 0, y: 0 }
    const schema = LoroSchema.doc({
      x: LoroSchema.plain.number(),
      y: LoroSchema.plain.number(),
    })
    const wCtx = createWritableContext(store, { autoCommit: false })
    const cfCtx = createChangefeedContext(wCtx)
    const enriched = enrich(writableInterpreter, withChangefeed)
    const doc = interpret(schema, enriched, cfCtx) as Readable<typeof schema> &
      Writable<typeof schema>

    const events: DeepEvent[] = []
    subscribeDeep(cfCtx, [], (e) => events.push(e))

    doc.x.set(10)
    doc.y.set(20)

    // Not yet notified
    expect(events).toHaveLength(0)

    changefeedFlush(cfCtx)

    // Now notified — scalar .set() dispatches ReplaceChange at own path
    expect(events).toHaveLength(2)
    expect(events[0]!.change.type).toBe("replace")
    expect(events[1]!.change.type).toBe("replace")
  })
})

describe("subscribeDeep: sibling exclusion", () => {
  it("deep subscriber does NOT fire for sibling paths", () => {
    const { cfCtx, doc } = createChangefeedChatDoc()
    const events: DeepEvent[] = []

    // Subscribe deep at ["settings"] only
    subscribeDeep(cfCtx, [{ type: "key", key: "settings" }], (e) => events.push(e))

    // Mutate a sibling (title)
    doc.title.insert(0, "X")

    expect(events).toHaveLength(0) // settings subscriber should not fire
  })
})

describe("subscribeDeep: sequence dispatch", () => {
  it("deep subscriber on messages receives push as SequenceChange at origin []", () => {
    const { cfCtx, doc } = createChangefeedChatDoc()
    const events: DeepEvent[] = []

    subscribeDeep(cfCtx, [{ type: "key", key: "messages" }], (e) => events.push(e))

    doc.messages.push({ author: "Carol", body: "Hi" })

    expect(events).toHaveLength(1)
    // push() dispatches at ["messages"] itself, so origin is []
    expect(events[0]!.origin).toEqual([])
    expect(events[0]!.change.type).toBe("sequence")
  })
})
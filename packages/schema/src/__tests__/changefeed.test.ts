import { describe, expect, it } from "vitest"
import {
  Schema,
  LoroSchema,
  interpret,
  bottomInterpreter,
  withReadable,
  withCaching,
  withWritable,
  withChangefeed,
  createWritableContext,
  hasChangefeed,
  hasComposedChangefeed,
  CHANGEFEED,
  TRANSACT,
} from "../index.js"
import type {
  Readable,
  Writable,
  TreeEvent,
  ChangeBase,
} from "../index.js"

// ===========================================================================
// Composed interpreter stack
// ===========================================================================

const fullInterpreter = withChangefeed(
  withWritable(withCaching(withReadable(bottomInterpreter))),
)

// ===========================================================================
// Shared fixtures
// ===========================================================================

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
  const doc = interpret(chatDocSchema, fullInterpreter, ctx) as unknown as Readable<
    typeof chatDocSchema
  > &
    Writable<typeof chatDocSchema>
  return { store, ctx, doc }
}

const CF_SYM = Symbol.for("kyneta:changefeed")

function getChangefeed(obj: unknown): {
  current: unknown
  subscribe: (cb: (c: unknown) => void) => () => void
  subscribeTree?: (cb: (event: TreeEvent) => void) => () => void
} {
  return (obj as any)[CF_SYM]
}

// ===========================================================================
// Baseline tests (migrated from old with-changefeed.test.ts)
// ===========================================================================

// ---------------------------------------------------------------------------
// hasChangefeed — one leaf, one composite
// ---------------------------------------------------------------------------

describe("changefeed: hasChangefeed", () => {
  it("leaf refs have changefeed", () => {
    const { doc } = createChatDoc()
    expect(hasChangefeed(doc.title)).toBe(true)
    expect(hasChangefeed(doc.count)).toBe(true)
  })

  it("composite refs have changefeed", () => {
    const { doc } = createChatDoc()
    expect(hasChangefeed(doc)).toBe(true)
    expect(hasChangefeed(doc.settings)).toBe(true)
    expect(hasChangefeed(doc.messages)).toBe(true)
    expect(hasChangefeed(doc.metadata)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// [CHANGEFEED].current — live getter
// ---------------------------------------------------------------------------

describe("changefeed: current value", () => {
  it("current reflects live store state through mutations", () => {
    const { doc } = createChatDoc()

    const titleCf = getChangefeed(doc.title)
    expect(titleCf.current).toBe("Hello")
    doc.title.update("Changed")
    expect(titleCf.current).toBe("Changed")

    const countCf = getChangefeed(doc.count)
    expect(countCf.current).toBe(0)
    doc.count.increment(5)
    expect(countCf.current).toBe(5)
  })
})

// ---------------------------------------------------------------------------
// Subscription lifecycle — subscribe, unsubscribe, multiple
// ---------------------------------------------------------------------------

describe("changefeed: subscription lifecycle", () => {
  it("subscribe receives changes, unsubscribe stops delivery", () => {
    const { doc } = createChatDoc()
    const cf = getChangefeed(doc.title)

    const received: unknown[] = []
    const unsub = cf.subscribe((change) => received.push(change))

    doc.title.insert(0, "X")
    expect(received).toHaveLength(1)
    expect((received[0] as { type: string }).type).toBe("text")

    unsub()
    doc.title.insert(0, "Y")
    expect(received).toHaveLength(1) // unchanged after unsub
  })

  it("multiple subscribers all receive changes", () => {
    const { doc } = createChatDoc()
    const cf = getChangefeed(doc.title)

    const a: unknown[] = []
    const b: unknown[] = []
    cf.subscribe((change) => a.push(change))
    cf.subscribe((change) => b.push(change))

    doc.title.insert(0, "X")
    expect(a).toHaveLength(1)
    expect(b).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Exact-path subscription — one representative test per change type
// ---------------------------------------------------------------------------

describe("changefeed: exact-path subscription", () => {
  it("fires with the correct change type for each node kind", () => {
    const { doc } = createChatDoc()

    // Scalar (replace)
    const scalarChanges: unknown[] = []
    getChangefeed(doc.settings.darkMode).subscribe((c) => scalarChanges.push(c))
    doc.settings.darkMode.set(true)
    expect(scalarChanges).toHaveLength(1)
    expect((scalarChanges[0] as { type: string }).type).toBe("replace")

    // Text
    const textChanges: unknown[] = []
    getChangefeed(doc.title).subscribe((c) => textChanges.push(c))
    doc.title.insert(0, "X")
    expect(textChanges).toHaveLength(1)
    expect((textChanges[0] as { type: string }).type).toBe("text")

    // Counter
    const counterChanges: unknown[] = []
    getChangefeed(doc.count).subscribe((c) => counterChanges.push(c))
    doc.count.increment(5)
    expect(counterChanges).toHaveLength(1)
    expect((counterChanges[0] as { type: string }).type).toBe("increment")

    // Sequence
    const seqChanges: unknown[] = []
    getChangefeed(doc.messages).subscribe((c) => seqChanges.push(c))
    doc.messages.push({ author: "Bob", body: "Hey" })
    expect(seqChanges).toHaveLength(1)
    expect((seqChanges[0] as { type: string }).type).toBe("sequence")

    // Product (whole-struct replace)
    const prodChanges: unknown[] = []
    getChangefeed(doc.settings).subscribe((c) => prodChanges.push(c))
    doc.settings.set({ darkMode: false, fontSize: 20 })
    expect(prodChanges).toHaveLength(1)
    expect((prodChanges[0] as { type: string }).type).toBe("replace")
  })
})

// ===========================================================================
// Compositional tests — hasComposedChangefeed, subscribeTree
// ===========================================================================

describe("changefeed: composed changefeed type guards", () => {
  it("leaf refs produce Changefeed, not ComposedChangefeed", () => {
    const { doc } = createChatDoc()
    expect(hasChangefeed(doc.title)).toBe(true)
    expect(hasComposedChangefeed(doc.title)).toBe(false)

    expect(hasChangefeed(doc.count)).toBe(true)
    expect(hasComposedChangefeed(doc.count)).toBe(false)

    expect(hasChangefeed(doc.settings.darkMode)).toBe(true)
    expect(hasComposedChangefeed(doc.settings.darkMode)).toBe(false)
  })

  it("product refs produce ComposedChangefeed", () => {
    const { doc } = createChatDoc()
    expect(hasComposedChangefeed(doc.settings)).toBe(true)
    expect(hasComposedChangefeed(doc)).toBe(true)
  })

  it("sequence refs produce ComposedChangefeed", () => {
    const { doc } = createChatDoc()
    expect(hasComposedChangefeed(doc.messages)).toBe(true)
  })

  it("map refs produce ComposedChangefeed", () => {
    const { doc } = createChatDoc()
    expect(hasComposedChangefeed(doc.metadata)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Product subscribe is node-level
// ---------------------------------------------------------------------------

describe("changefeed: product subscribe is node-level", () => {
  it("subscribe does NOT fire for child mutations", () => {
    const { doc } = createChatDoc()
    const cf = getChangefeed(doc.settings)
    const received: unknown[] = []
    cf.subscribe((c) => received.push(c))

    // Mutate a child — should NOT fire on the product's subscribe
    doc.settings.darkMode.set(true)
    expect(received).toHaveLength(0)

    // Mutate the product itself — should fire
    doc.settings.set({ darkMode: false, fontSize: 20 })
    expect(received).toHaveLength(1)
    expect((received[0] as { type: string }).type).toBe("replace")
  })
})

// ---------------------------------------------------------------------------
// Product subscribeTree is tree-level
// ---------------------------------------------------------------------------

describe("changefeed: product subscribeTree", () => {
  it("fires for child mutations with correct origin path", () => {
    const { doc } = createChatDoc()
    const cf = getChangefeed(doc.settings)
    const events: TreeEvent[] = []
    cf.subscribeTree!((event) => events.push(event))

    doc.settings.darkMode.set(true)
    expect(events).toHaveLength(1)
    expect(events[0]!.origin).toEqual([{ type: "key", key: "darkMode" }])
    expect(events[0]!.change.type).toBe("replace")
  })

  it("fires for own-path changes with origin []", () => {
    const { doc } = createChatDoc()
    const cf = getChangefeed(doc.settings)
    const events: TreeEvent[] = []
    cf.subscribeTree!((event) => events.push(event))

    doc.settings.set({ darkMode: true, fontSize: 18 })
    expect(events).toHaveLength(1)
    expect(events[0]!.origin).toEqual([])
    expect(events[0]!.change.type).toBe("replace")
  })

  it("nested tree composition — deep origin path", () => {
    const { doc } = createChatDoc()
    const cf = getChangefeed(doc)
    const events: TreeEvent[] = []
    cf.subscribeTree!((event) => events.push(event))

    doc.settings.darkMode.set(true)
    expect(events.length).toBeGreaterThanOrEqual(1)
    // Find the event for the darkMode change
    const darkModeEvent = events.find(
      (e) =>
        e.origin.length === 2 &&
        e.origin[0]!.type === "key" &&
        (e.origin[0] as { key: string }).key === "settings" &&
        e.origin[1]!.type === "key" &&
        (e.origin[1] as { key: string }).key === "darkMode",
    )
    expect(darkModeEvent).toBeDefined()
    expect(darkModeEvent!.change.type).toBe("replace")
  })
})

// ---------------------------------------------------------------------------
// Sequence subscribe is structural only
// ---------------------------------------------------------------------------

describe("changefeed: sequence subscribe is structural only", () => {
  it("subscribe fires on push (structural) but NOT on item mutation", () => {
    const { doc } = createChatDoc()
    const cf = getChangefeed(doc.messages)
    const received: unknown[] = []
    cf.subscribe((c) => received.push(c))

    // Push — structural, should fire
    doc.messages.push({ author: "Bob", body: "Hey" })
    expect(received).toHaveLength(1)
    expect((received[0] as { type: string }).type).toBe("sequence")

    // Mutate item content — should NOT fire
    const msg = doc.messages.at(0)!
    msg.author.set("Charlie")
    expect(received).toHaveLength(1) // still 1
  })
})

// ---------------------------------------------------------------------------
// Sequence subscribeTree includes item content
// ---------------------------------------------------------------------------

describe("changefeed: sequence subscribeTree", () => {
  it("fires for item content changes", () => {
    const { doc } = createChatDoc()
    const cf = getChangefeed(doc.messages)
    const events: TreeEvent[] = []
    cf.subscribeTree!((event) => events.push(event))

    const msg = doc.messages.at(0)!
    msg.author.set("Charlie")

    expect(events.length).toBeGreaterThanOrEqual(1)
    // Find the item content event
    const itemEvent = events.find(
      (e) =>
        e.origin.length >= 2 &&
        e.origin[0]!.type === "index" &&
        (e.origin[0] as { index: number }).index === 0,
    )
    expect(itemEvent).toBeDefined()
    expect(itemEvent!.change.type).toBe("replace")
  })

  it("fires for structural changes with origin []", () => {
    const { doc } = createChatDoc()
    const cf = getChangefeed(doc.messages)
    const events: TreeEvent[] = []
    cf.subscribeTree!((event) => events.push(event))

    doc.messages.push({ author: "Bob", body: "Hey" })

    const ownPathEvent = events.find((e) => e.origin.length === 0)
    expect(ownPathEvent).toBeDefined()
    expect(ownPathEvent!.change.type).toBe("sequence")
  })

  it("dynamic subscription: push then mutate new item fires tree event", () => {
    const { doc } = createChatDoc()
    const cf = getChangefeed(doc.messages)
    const events: TreeEvent[] = []
    cf.subscribeTree!((event) => events.push(event))

    // Push a new item
    doc.messages.push({ author: "New", body: "Item" })
    const eventsAfterPush = events.length

    // Mutate the new item
    const newMsg = doc.messages.at(1)!
    newMsg.author.set("Updated")

    expect(events.length).toBeGreaterThan(eventsAfterPush)
    const newItemEvent = events.find(
      (e) =>
        e.origin.length >= 2 &&
        e.origin[0]!.type === "index" &&
        (e.origin[0] as { index: number }).index === 1,
    )
    expect(newItemEvent).toBeDefined()
  })

  it("delete cleans up subscriptions — mutating deleted item does not fire", () => {
    const { doc } = createChatDoc({
      messages: [
        { author: "Alice", body: "Hi" },
        { author: "Bob", body: "Hey" },
      ],
    })
    const cf = getChangefeed(doc.messages)
    const events: TreeEvent[] = []
    cf.subscribeTree!((event) => events.push(event))

    // Get a reference to the first item before deleting
    const firstMsg = doc.messages.at(0)!

    // Delete the first item
    doc.messages.delete(0, 1)
    const eventsAfterDelete = events.length

    // Mutate the deleted item's old ref — should NOT fire
    firstMsg.author.set("Ghost")
    expect(events.length).toBe(eventsAfterDelete)
  })
})

// ---------------------------------------------------------------------------
// Map subscribeTree
// ---------------------------------------------------------------------------

describe("changefeed: map subscribeTree", () => {
  it("fires for entry value changes", () => {
    const { doc } = createChatDoc({ metadata: { color: "red", priority: 1 } })
    const cf = getChangefeed(doc.metadata)
    const events: TreeEvent[] = []
    cf.subscribeTree!((event) => events.push(event))

    // Access a child ref and mutate it
    const colorRef = doc.metadata.at("color")!
    colorRef.set("blue")

    expect(events.length).toBeGreaterThanOrEqual(1)
    const entryEvent = events.find(
      (e) =>
        e.origin.length >= 1 &&
        e.origin[0]!.type === "key" &&
        (e.origin[0] as { key: string }).key === "color",
    )
    expect(entryEvent).toBeDefined()
  })

  it("fires for structural changes with origin []", () => {
    const { doc } = createChatDoc()
    const cf = getChangefeed(doc.metadata)
    const events: TreeEvent[] = []
    cf.subscribeTree!((event) => events.push(event))

    doc.metadata.set("newKey", "newValue")

    const ownPathEvent = events.find((e) => e.origin.length === 0)
    expect(ownPathEvent).toBeDefined()
    expect(ownPathEvent!.change.type).toBe("map")
  })

  it("dynamic subscription: set then mutate new entry fires tree event", () => {
    const { doc } = createChatDoc()
    const cf = getChangefeed(doc.metadata)
    const events: TreeEvent[] = []
    cf.subscribeTree!((event) => events.push(event))

    // Set a new key
    doc.metadata.set("color", "red")
    const eventsAfterSet = events.length

    // Mutate the new entry
    const colorRef = doc.metadata.at("color")!
    colorRef.set("blue")

    expect(events.length).toBeGreaterThan(eventsAfterSet)
  })
})

// ---------------------------------------------------------------------------
// Unsubscribe cleans up
// ---------------------------------------------------------------------------

describe("changefeed: unsubscribe cleanup", () => {
  it("unsubscribe from subscribeTree stops delivery", () => {
    const { doc } = createChatDoc()
    const cf = getChangefeed(doc.settings)
    const events: TreeEvent[] = []
    const unsub = cf.subscribeTree!((event) => events.push(event))

    doc.settings.darkMode.set(true)
    expect(events).toHaveLength(1)

    unsub()
    doc.settings.darkMode.set(false)
    expect(events).toHaveLength(1) // unchanged
  })
})

// ---------------------------------------------------------------------------
// Coexistence: subscribe + subscribeTree on same ref
// ---------------------------------------------------------------------------

describe("changefeed: coexistence of subscribe and subscribeTree", () => {
  it("both fire for a change at the node's own path", () => {
    const { doc } = createChatDoc()
    const cf = getChangefeed(doc.settings)
    const shallowChanges: unknown[] = []
    const treeEvents: TreeEvent[] = []

    cf.subscribe((c) => shallowChanges.push(c))
    cf.subscribeTree!((e) => treeEvents.push(e))

    doc.settings.set({ darkMode: true, fontSize: 18 })

    expect(shallowChanges).toHaveLength(1)
    expect(treeEvents).toHaveLength(1)
    expect(treeEvents[0]!.origin).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// TRANSACT is present on changefeed-enriched refs
// ---------------------------------------------------------------------------

describe("changefeed: TRANSACT preserved", () => {
  it("refs still have [TRANSACT] after withChangefeed layer", () => {
    const { ctx, doc } = createChatDoc()
    expect(doc[TRANSACT]).toBe(ctx)
    expect(doc.title[TRANSACT]).toBe(ctx)
    expect(doc.settings[TRANSACT]).toBe(ctx)
    expect(doc.messages[TRANSACT]).toBe(ctx)
    expect(doc.metadata[TRANSACT]).toBe(ctx)
  })
})

// ===========================================================================
// Transaction integration
// ===========================================================================

describe("changefeed: transaction integration", () => {
  it("store buffers changes during transaction until commit", () => {
    const store = { x: 0, y: 0 }
    const schema = LoroSchema.doc({
      x: LoroSchema.plain.number(),
      y: LoroSchema.plain.number(),
    })
    const ctx = createWritableContext(store)
    const doc = interpret(schema, fullInterpreter, ctx) as unknown as Readable<typeof schema> &
      Writable<typeof schema>

    ctx.beginTransaction()
    doc.x.set(10)
    doc.y.set(20)

    expect(store.x).toBe(0)
    expect(store.y).toBe(0)

    const flushed = ctx.commit()
    expect(store.x).toBe(10)
    expect(store.y).toBe(20)
    expect(flushed).toHaveLength(2)
  })

  it("commit replays through ctx.dispatch so changefeed subscribers fire", () => {
    const store = { x: 0, y: 0 }
    const schema = LoroSchema.doc({
      x: LoroSchema.plain.number(),
      y: LoroSchema.plain.number(),
    })
    const ctx = createWritableContext(store)
    const doc = interpret(schema, fullInterpreter, ctx) as unknown as Readable<typeof schema> &
      Writable<typeof schema>

    const xChanges: unknown[] = []
    getChangefeed(doc.x).subscribe((c) => xChanges.push(c))

    ctx.beginTransaction()
    doc.x.set(10)
    // During transaction, dispatch is buffered — the transitional
    // notification wiring won't fire until commit replays
    const countDuringBuffer = xChanges.length

    ctx.commit()
    // After commit, replay fires through the wrapped dispatch
    expect(xChanges.length).toBeGreaterThan(countDuringBuffer)
    expect(store.x).toBe(10)
    expect((xChanges[xChanges.length - 1] as { type: string }).type).toBe("replace")
  })

  it("transaction + subscribeTree: tree subscribers fire at commit time", () => {
    const { ctx, doc } = createChatDoc()
    const events: TreeEvent[] = []
    getChangefeed(doc.settings).subscribeTree!((e) => events.push(e))

    ctx.beginTransaction()
    doc.settings.darkMode.set(true)
    doc.settings.fontSize.set(18)
    const countDuringBuffer = events.length

    ctx.commit()
    // Both child changes should propagate up after commit
    expect(events.length).toBeGreaterThan(countDuringBuffer)

    const darkModeEvents = events.filter(
      (e) =>
        e.origin.length === 1 &&
        e.origin[0]!.type === "key" &&
        (e.origin[0] as { key: string }).key === "darkMode",
    )
    const fontSizeEvents = events.filter(
      (e) =>
        e.origin.length === 1 &&
        e.origin[0]!.type === "key" &&
        (e.origin[0] as { key: string }).key === "fontSize",
    )
    expect(darkModeEvents.length).toBeGreaterThanOrEqual(1)
    expect(fontSizeEvents.length).toBeGreaterThanOrEqual(1)
  })
})

// ===========================================================================
// CHANGEFEED is non-enumerable
// ===========================================================================

describe("changefeed: non-enumerable", () => {
  it("[CHANGEFEED] does not appear in Object.keys()", () => {
    const { doc } = createChatDoc()
    expect(Object.keys(doc)).not.toContain(CHANGEFEED)
    expect(Object.keys(doc)).not.toContain(String(CHANGEFEED))
    expect(Object.keys(doc.settings)).not.toContain(CHANGEFEED)
  })
})

// ===========================================================================
// Sequence child ref changefeed after structural ops
// ===========================================================================

describe("changefeed: sequence child refs have changefeed", () => {
  it("child refs from .at() have [CHANGEFEED]", () => {
    const { doc } = createChatDoc()
    const msg = doc.messages.at(0)!
    expect(hasChangefeed(msg)).toBe(true)
    expect(hasChangefeed(msg.author)).toBe(true)
    expect(hasChangefeed(msg.body)).toBe(true)
  })

  it("newly pushed item refs have [CHANGEFEED]", () => {
    const { doc } = createChatDoc()
    doc.messages.push({ author: "Bob", body: "Hey" })
    const newMsg = doc.messages.at(1)!
    expect(hasChangefeed(newMsg)).toBe(true)
    expect(hasChangefeed(newMsg.author)).toBe(true)
  })
})

// ===========================================================================
// Map child ref changefeed
// ===========================================================================

describe("changefeed: map child refs have changefeed", () => {
  it("child refs from .at() have [CHANGEFEED]", () => {
    const { doc } = createChatDoc()
    const versionRef = doc.metadata.at("version")
    expect(versionRef).toBeDefined()
    expect(hasChangefeed(versionRef)).toBe(true)
  })
})

// ===========================================================================
// Edge cases
// ===========================================================================

describe("changefeed: edge cases", () => {
  it("subscribe on leaf ref at scalar path fires on set", () => {
    const schema = Schema.doc({ n: Schema.number() })
    const store = { n: 42 }
    const ctx = createWritableContext(store)
    const doc = interpret(schema, fullInterpreter, ctx) as any

    const changes: unknown[] = []
    getChangefeed(doc.n).subscribe((c: unknown) => changes.push(c))

    doc.n.set(99)
    expect(changes).toHaveLength(1)
    expect((changes[0] as { type: string }).type).toBe("replace")
  })

  it("empty sequence has ComposedChangefeed", () => {
    const schema = Schema.doc({
      items: Schema.list(Schema.string()),
    })
    const store = { items: [] as string[] }
    const ctx = createWritableContext(store)
    const doc = interpret(schema, fullInterpreter, ctx) as any

    expect(hasComposedChangefeed(doc.items)).toBe(true)
  })

  it("empty map has ComposedChangefeed", () => {
    const schema = Schema.doc({
      labels: Schema.record(Schema.string()),
    })
    const store = { labels: {} }
    const ctx = createWritableContext(store)
    const doc = interpret(schema, fullInterpreter, ctx) as any

    expect(hasComposedChangefeed(doc.labels)).toBe(true)
  })
})
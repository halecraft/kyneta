import { describe, expect, it } from "vitest"
import {
  Schema,
  LoroSchema,
  interpret,
  bottomInterpreter,
  withReadable,
  withNavigation,
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
  Ref,
  TreeEvent,
  Changeset,
  ChangeBase,
} from "../index.js"

// ===========================================================================
// Composed interpreter stack
// ===========================================================================

const fullInterpreter = withChangefeed(
  withWritable(withCaching(withReadable(withNavigation(bottomInterpreter)))),
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
  const doc = interpret(chatDocSchema, fullInterpreter, ctx) as unknown as Ref<typeof chatDocSchema>
  return { store, ctx, doc }
}

const CF_SYM = Symbol.for("kyneta:changefeed")

function getChangefeed(obj: unknown): {
  current: unknown
  subscribe: (cb: (changeset: Changeset) => void) => () => void
  subscribeTree?: (cb: (changeset: Changeset<TreeEvent>) => void) => () => void
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
// CHANGEFEED.current snapshot isolation — composite nodes
// ---------------------------------------------------------------------------

describe("changefeed: composite current snapshot isolation", () => {
  it("product CHANGEFEED.current returns a fresh snapshot — mutating it does not corrupt the store", () => {
    const { doc, store } = createChatDoc()
    const cf = getChangefeed(doc.settings)

    const snap1 = cf.current as Record<string, unknown>
    snap1.darkMode = true
    snap1.fontSize = 99

    // Store must be unaffected
    expect((store.settings as any).darkMode).toBe(false)
    expect((store.settings as any).fontSize).toBe(14)

    // Second access returns a clean snapshot
    const snap2 = cf.current as Record<string, unknown>
    expect(snap2).toEqual({ darkMode: false, fontSize: 14 })

    // Distinct references each access
    expect(cf.current).not.toBe(cf.current)
  })
})

// ---------------------------------------------------------------------------
// Subscription lifecycle — subscribe, unsubscribe, multiple
// ---------------------------------------------------------------------------

describe("changefeed: subscription lifecycle", () => {
  it("subscribe receives changesets, unsubscribe stops delivery", () => {
    const { doc } = createChatDoc()
    const cf = getChangefeed(doc.title)

    const received: Changeset[] = []
    const unsub = cf.subscribe((changeset) => received.push(changeset))

    doc.title.insert(0, "X")
    expect(received).toHaveLength(1)
    expect(received[0]!.changes).toHaveLength(1)
    expect(received[0]!.changes[0]!.type).toBe("text")

    unsub()
    doc.title.insert(0, "Y")
    expect(received).toHaveLength(1) // unchanged after unsub
  })

  it("multiple subscribers all receive changesets", () => {
    const { doc } = createChatDoc()
    const cf = getChangefeed(doc.title)

    const a: Changeset[] = []
    const b: Changeset[] = []
    cf.subscribe((cs) => a.push(cs))
    cf.subscribe((cs) => b.push(cs))

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
    const scalarChangesets: Changeset[] = []
    getChangefeed(doc.settings.darkMode).subscribe((cs) => scalarChangesets.push(cs))
    doc.settings.darkMode.set(true)
    expect(scalarChangesets).toHaveLength(1)
    expect(scalarChangesets[0]!.changes[0]!.type).toBe("replace")

    // Text
    const textChangesets: Changeset[] = []
    getChangefeed(doc.title).subscribe((cs) => textChangesets.push(cs))
    doc.title.insert(0, "X")
    expect(textChangesets).toHaveLength(1)
    expect(textChangesets[0]!.changes[0]!.type).toBe("text")

    // Counter
    const counterChangesets: Changeset[] = []
    getChangefeed(doc.count).subscribe((cs) => counterChangesets.push(cs))
    doc.count.increment(5)
    expect(counterChangesets).toHaveLength(1)
    expect(counterChangesets[0]!.changes[0]!.type).toBe("increment")

    // Sequence
    const seqChangesets: Changeset[] = []
    getChangefeed(doc.messages).subscribe((cs) => seqChangesets.push(cs))
    doc.messages.push({ author: "Bob", body: "Hey" })
    expect(seqChangesets).toHaveLength(1)
    expect(seqChangesets[0]!.changes[0]!.type).toBe("sequence")

    // Product (whole-struct replace)
    const prodChangesets: Changeset[] = []
    getChangefeed(doc.settings).subscribe((cs) => prodChangesets.push(cs))
    doc.settings.set({ darkMode: false, fontSize: 20 })
    expect(prodChangesets).toHaveLength(1)
    expect(prodChangesets[0]!.changes[0]!.type).toBe("replace")
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
    const received: Changeset[] = []
    cf.subscribe((cs) => received.push(cs))

    // Mutate a child — should NOT fire on the product's subscribe
    doc.settings.darkMode.set(true)
    expect(received).toHaveLength(0)

    // Mutate the product itself — should fire
    doc.settings.set({ darkMode: false, fontSize: 20 })
    expect(received).toHaveLength(1)
    expect(received[0]!.changes[0]!.type).toBe("replace")
  })
})

// ---------------------------------------------------------------------------
// Product subscribeTree is tree-level
// ---------------------------------------------------------------------------

describe("changefeed: product subscribeTree", () => {
  it("fires for child mutations with correct path", () => {
    const { doc } = createChatDoc()
    const cf = getChangefeed(doc.settings)
    const events: TreeEvent[] = []
    cf.subscribeTree!((changeset) => {
      for (const event of changeset.changes) events.push(event)
    })

    doc.settings.darkMode.set(true)
    expect(events).toHaveLength(1)
    expect(events[0]!.path).toEqual([{ type: "key", key: "darkMode" }])
    expect(events[0]!.change.type).toBe("replace")
  })

  it("fires for own-path changes with path []", () => {
    const { doc } = createChatDoc()
    const cf = getChangefeed(doc.settings)
    const events: TreeEvent[] = []
    cf.subscribeTree!((changeset) => {
      for (const event of changeset.changes) events.push(event)
    })

    doc.settings.set({ darkMode: true, fontSize: 18 })
    expect(events).toHaveLength(1)
    expect(events[0]!.path).toEqual([])
    expect(events[0]!.change.type).toBe("replace")
  })

  it("nested tree composition — deep path", () => {
    const { doc } = createChatDoc()
    const cf = getChangefeed(doc)
    const events: TreeEvent[] = []
    cf.subscribeTree!((changeset) => {
      for (const event of changeset.changes) events.push(event)
    })

    doc.settings.darkMode.set(true)
    expect(events.length).toBeGreaterThanOrEqual(1)
    // Find the event for the darkMode change
    const darkModeEvent = events.find(
      (e) =>
        e.path.length === 2 &&
        e.path[0]!.type === "key" &&
        (e.path[0] as { key: string }).key === "settings" &&
        e.path[1]!.type === "key" &&
        (e.path[1] as { key: string }).key === "darkMode",
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
    const received: Changeset[] = []
    cf.subscribe((cs) => received.push(cs))

    // Push — structural, should fire
    doc.messages.push({ author: "Bob", body: "Hey" })
    expect(received).toHaveLength(1)
    expect(received[0]!.changes[0]!.type).toBe("sequence")

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
    cf.subscribeTree!((changeset) => {
      for (const event of changeset.changes) events.push(event)
    })

    const msg = doc.messages.at(0)!
    msg.author.set("Charlie")

    expect(events.length).toBeGreaterThanOrEqual(1)
    // Find the item content event
    const itemEvent = events.find(
      (e) =>
        e.path.length >= 2 &&
        e.path[0]!.type === "index" &&
        (e.path[0] as { index: number }).index === 0,
    )
    expect(itemEvent).toBeDefined()
    expect(itemEvent!.change.type).toBe("replace")
  })

  it("fires for structural changes with path []", () => {
    const { doc } = createChatDoc()
    const cf = getChangefeed(doc.messages)
    const events: TreeEvent[] = []
    cf.subscribeTree!((changeset) => {
      for (const event of changeset.changes) events.push(event)
    })

    doc.messages.push({ author: "Bob", body: "Hey" })

    const ownPathEvent = events.find((e) => e.path.length === 0)
    expect(ownPathEvent).toBeDefined()
    expect(ownPathEvent!.change.type).toBe("sequence")
  })

  it("dynamic subscription: push then mutate new item fires tree event", () => {
    const { doc } = createChatDoc()
    const cf = getChangefeed(doc.messages)
    const events: TreeEvent[] = []
    cf.subscribeTree!((changeset) => {
      for (const event of changeset.changes) events.push(event)
    })

    // Push a new item
    doc.messages.push({ author: "New", body: "Item" })
    const eventsAfterPush = events.length

    // Mutate the new item
    const newMsg = doc.messages.at(1)!
    newMsg.author.set("Updated")

    expect(events.length).toBeGreaterThan(eventsAfterPush)
    const newItemEvent = events.find(
      (e) =>
        e.path.length >= 2 &&
        e.path[0]!.type === "index" &&
        (e.path[0] as { index: number }).index === 1,
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
    cf.subscribeTree!((changeset) => {
      for (const event of changeset.changes) events.push(event)
    })

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
    cf.subscribeTree!((changeset) => {
      for (const event of changeset.changes) events.push(event)
    })

    // Access a child ref and mutate it
    const colorRef = doc.metadata.at("color")!
    colorRef.set("blue")

    expect(events.length).toBeGreaterThanOrEqual(1)
    const entryEvent = events.find(
      (e) =>
        e.path.length >= 1 &&
        e.path[0]!.type === "key" &&
        (e.path[0] as { key: string }).key === "color",
    )
    expect(entryEvent).toBeDefined()
  })

  it("fires for structural changes with path []", () => {
    const { doc } = createChatDoc()
    const cf = getChangefeed(doc.metadata)
    const events: TreeEvent[] = []
    cf.subscribeTree!((changeset) => {
      for (const event of changeset.changes) events.push(event)
    })

    doc.metadata.set("newKey", "newValue")

    const ownPathEvent = events.find((e) => e.path.length === 0)
    expect(ownPathEvent).toBeDefined()
    expect(ownPathEvent!.change.type).toBe("map")
  })

  it("dynamic subscription: set then mutate new entry fires tree event", () => {
    const { doc } = createChatDoc()
    const cf = getChangefeed(doc.metadata)
    const events: TreeEvent[] = []
    cf.subscribeTree!((changeset) => {
      for (const event of changeset.changes) events.push(event)
    })

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
    const unsub = cf.subscribeTree!((changeset) => {
      for (const event of changeset.changes) events.push(event)
    })

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
    const shallowChangesets: Changeset[] = []
    const treeEvents: TreeEvent[] = []

    cf.subscribe((cs) => shallowChangesets.push(cs))
    cf.subscribeTree!((changeset) => {
      for (const event of changeset.changes) treeEvents.push(event)
    })

    doc.settings.set({ darkMode: true, fontSize: 18 })

    expect(shallowChangesets).toHaveLength(1)
    expect(treeEvents).toHaveLength(1)
    expect(treeEvents[0]!.path).toEqual([])
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
  it("no subscriber notifications during transaction buffering", () => {
    const store = { x: 0, y: 0 }
    const schema = LoroSchema.doc({
      x: LoroSchema.plain.number(),
      y: LoroSchema.plain.number(),
    })
    const ctx = createWritableContext(store)
    const doc = interpret(schema, fullInterpreter, ctx) as unknown as Ref<typeof schema>

    const xChangesets: Changeset[] = []
    getChangefeed(doc.x).subscribe((cs) => xChangesets.push(cs))

    ctx.beginTransaction()
    doc.x.set(10)
    doc.x.set(20)

    // The key invariant: ZERO notifications while buffering.
    // Store is unchanged, so subscribers must not fire.
    expect(store.x).toBe(0)
    expect(xChangesets).toHaveLength(0)

    ctx.commit()
    // After commit, exactly ONE changeset with both changes (batched)
    expect(store.x).toBe(20)
    expect(xChangesets).toHaveLength(1)
    expect(xChangesets[0]!.changes).toHaveLength(2)
    expect(xChangesets[0]!.changes[0]!.type).toBe("replace")
    expect(xChangesets[0]!.changes[1]!.type).toBe("replace")
  })

  it("no tree subscriber notifications during transaction buffering", () => {
    const { ctx, doc } = createChatDoc()
    const treeChangesets: Changeset<TreeEvent>[] = []
    getChangefeed(doc.settings).subscribeTree!((changeset) => {
      treeChangesets.push(changeset)
    })

    ctx.beginTransaction()
    doc.settings.darkMode.set(true)
    doc.settings.fontSize.set(18)

    // ZERO tree changesets while buffering
    expect(treeChangesets).toHaveLength(0)

    ctx.commit()
    // After commit: each child path gets its own Changeset (1 change each)
    // propagated via subscription composition from child → parent.
    // darkMode and fontSize are at different paths, so 2 tree changesets.
    expect(treeChangesets).toHaveLength(2)
    const allEvents = treeChangesets.flatMap(cs => cs.changes)
    expect(allEvents).toHaveLength(2)

    const darkModeEvents = allEvents.filter(
      (e) =>
        e.path.length === 1 &&
        e.path[0]!.type === "key" &&
        (e.path[0] as { key: string }).key === "darkMode",
    )
    const fontSizeEvents = allEvents.filter(
      (e) =>
        e.path.length === 1 &&
        e.path[0]!.type === "key" &&
        (e.path[0] as { key: string }).key === "fontSize",
    )
    expect(darkModeEvents).toHaveLength(1)
    expect(fontSizeEvents).toHaveLength(1)
  })

  it("store buffers changes during transaction until commit", () => {
    const store = { x: 0, y: 0 }
    const schema = LoroSchema.doc({
      x: LoroSchema.plain.number(),
      y: LoroSchema.plain.number(),
    })
    const ctx = createWritableContext(store)
    const doc = interpret(schema, fullInterpreter, ctx) as unknown as Ref<typeof schema>

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

  it("commit delivers exactly one Changeset per affected path", () => {
    const store = { x: 0, y: 0 }
    const schema = LoroSchema.doc({
      x: LoroSchema.plain.number(),
      y: LoroSchema.plain.number(),
    })
    const ctx = createWritableContext(store)
    const doc = interpret(schema, fullInterpreter, ctx) as unknown as Ref<typeof schema>

    const xChangesets: Changeset[] = []
    getChangefeed(doc.x).subscribe((cs) => xChangesets.push(cs))

    ctx.beginTransaction()
    doc.x.set(10)
    // No notifications during buffering
    expect(xChangesets).toHaveLength(0)

    ctx.commit()
    // Exactly 1 changeset with 1 change (batched delivery)
    expect(xChangesets).toHaveLength(1)
    expect(store.x).toBe(10)
    expect(xChangesets[0]!.changes).toHaveLength(1)
    expect(xChangesets[0]!.changes[0]!.type).toBe("replace")
  })

  it("transaction + subscribeTree: tree subscribers fire at commit time", () => {
    const { ctx, doc } = createChatDoc()
    const treeChangesets: Changeset<TreeEvent>[] = []
    getChangefeed(doc.settings).subscribeTree!((changeset) => {
      treeChangesets.push(changeset)
    })

    ctx.beginTransaction()
    doc.settings.darkMode.set(true)
    doc.settings.fontSize.set(18)
    // No tree events during buffering
    expect(treeChangesets).toHaveLength(0)

    ctx.commit()
    // Tree changesets propagated from children — one per child path
    expect(treeChangesets).toHaveLength(2)
    const allEvents = treeChangesets.flatMap(cs => cs.changes)
    expect(allEvents).toHaveLength(2)

    const darkModeEvents = allEvents.filter(
      (e) =>
        e.path.length === 1 &&
        e.path[0]!.type === "key" &&
        (e.path[0] as { key: string }).key === "darkMode",
    )
    const fontSizeEvents = allEvents.filter(
      (e) =>
        e.path.length === 1 &&
        e.path[0]!.type === "key" &&
        (e.path[0] as { key: string }).key === "fontSize",
    )
    expect(darkModeEvents).toHaveLength(1)
    expect(fontSizeEvents).toHaveLength(1)
  })
})

// ===========================================================================
// Batched notification — the key correctness tests for the Changeset protocol
// ===========================================================================

describe("changefeed: batched notification", () => {
  it("transaction commit delivers one Changeset with N changes to same-path subscriber", () => {
    const store = { x: 0, y: 0 }
    const schema = LoroSchema.doc({
      x: LoroSchema.plain.number(),
      y: LoroSchema.plain.number(),
    })
    const ctx = createWritableContext(store)
    const doc = interpret(schema, fullInterpreter, ctx) as unknown as Ref<typeof schema>

    const xChangesets: Changeset[] = []
    getChangefeed(doc.x).subscribe((cs) => xChangesets.push(cs))

    ctx.beginTransaction()
    doc.x.set(1)
    doc.x.set(2)
    doc.x.set(3)

    expect(xChangesets).toHaveLength(0)

    ctx.commit()
    // 3 mutations to the same path → 1 Changeset with 3 changes
    expect(xChangesets).toHaveLength(1)
    expect(xChangesets[0]!.changes).toHaveLength(3)
    expect(store.x).toBe(3)
  })

  it("subscriber sees fully-applied state when Changeset arrives", () => {
    const store = { x: 0, y: 0 }
    const schema = LoroSchema.doc({
      x: LoroSchema.plain.number(),
      y: LoroSchema.plain.number(),
    })
    const ctx = createWritableContext(store)
    const doc = interpret(schema, fullInterpreter, ctx) as unknown as Ref<typeof schema>

    let observedX: unknown = undefined
    let observedY: unknown = undefined
    getChangefeed(doc.x).subscribe(() => {
      // When x's subscriber fires, BOTH x and y should be fully applied
      observedX = store.x
      observedY = store.y
    })

    ctx.beginTransaction()
    doc.x.set(10)
    doc.y.set(20)
    ctx.commit()

    // The subscriber saw the fully-applied state (both x=10 and y=20),
    // not the partially-applied state (x=10, y=0)
    expect(observedX).toBe(10)
    expect(observedY).toBe(20)
  })

  it("auto-commit (single mutation) delivers Changeset with exactly 1 change", () => {
    const { doc } = createChatDoc()
    const changesets: Changeset[] = []
    getChangefeed(doc.title).subscribe((cs) => changesets.push(cs))

    doc.title.insert(0, "X")
    expect(changesets).toHaveLength(1)
    expect(changesets[0]!.changes).toHaveLength(1)
    expect(changesets[0]!.origin).toBeUndefined()
  })

  it("origin tagging: commit(origin) attaches origin to emitted Changeset", () => {
    const store = { x: 0, y: 0 }
    const schema = LoroSchema.doc({
      x: LoroSchema.plain.number(),
      y: LoroSchema.plain.number(),
    })
    const ctx = createWritableContext(store)
    const doc = interpret(schema, fullInterpreter, ctx) as unknown as Ref<typeof schema>

    const xChangesets: Changeset[] = []
    getChangefeed(doc.x).subscribe((cs) => xChangesets.push(cs))

    ctx.beginTransaction()
    doc.x.set(42)
    ctx.commit("sync")

    expect(xChangesets).toHaveLength(1)
    expect(xChangesets[0]!.origin).toBe("sync")
    expect(xChangesets[0]!.changes).toHaveLength(1)
  })

  it("origin tagging: auto-commit has no origin", () => {
    const { doc } = createChatDoc()
    const changesets: Changeset[] = []
    getChangefeed(doc.count).subscribe((cs) => changesets.push(cs))

    doc.count.increment(5)
    expect(changesets).toHaveLength(1)
    expect(changesets[0]!.origin).toBeUndefined()
  })

  it("origin tagging: tree subscribers receive origin from commit", () => {
    const { ctx, doc } = createChatDoc()
    const treeChangesets: Changeset<TreeEvent>[] = []
    getChangefeed(doc.settings).subscribeTree!((cs) => treeChangesets.push(cs))

    ctx.beginTransaction()
    doc.settings.darkMode.set(true)
    ctx.commit("undo")

    // Tree changeset propagated from child — should carry the origin
    expect(treeChangesets).toHaveLength(1)
    expect(treeChangesets[0]!.origin).toBe("undo")
    expect(treeChangesets[0]!.changes).toHaveLength(1)
    expect(treeChangesets[0]!.changes[0]!.path).toEqual([{ type: "key", key: "darkMode" }])
  })

  it("multiple paths in one transaction: each path gets its own Changeset", () => {
    const store = { x: 0, y: 0 }
    const schema = LoroSchema.doc({
      x: LoroSchema.plain.number(),
      y: LoroSchema.plain.number(),
    })
    const ctx = createWritableContext(store)
    const doc = interpret(schema, fullInterpreter, ctx) as unknown as Ref<typeof schema>

    const xChangesets: Changeset[] = []
    const yChangesets: Changeset[] = []
    getChangefeed(doc.x).subscribe((cs) => xChangesets.push(cs))
    getChangefeed(doc.y).subscribe((cs) => yChangesets.push(cs))

    ctx.beginTransaction()
    doc.x.set(10)
    doc.y.set(20)
    doc.x.set(30)
    ctx.commit()

    // x had 2 mutations → 1 changeset with 2 changes
    expect(xChangesets).toHaveLength(1)
    expect(xChangesets[0]!.changes).toHaveLength(2)

    // y had 1 mutation → 1 changeset with 1 change
    expect(yChangesets).toHaveLength(1)
    expect(yChangesets[0]!.changes).toHaveLength(1)
  })

  it("no notification for paths without subscribers", () => {
    const store = { x: 0, y: 0 }
    const schema = LoroSchema.doc({
      x: LoroSchema.plain.number(),
      y: LoroSchema.plain.number(),
    })
    const ctx = createWritableContext(store)
    const doc = interpret(schema, fullInterpreter, ctx) as unknown as Ref<typeof schema>

    // Only subscribe to x, not y
    const xChangesets: Changeset[] = []
    getChangefeed(doc.x).subscribe((cs) => xChangesets.push(cs))

    ctx.beginTransaction()
    doc.x.set(10)
    doc.y.set(20)
    ctx.commit()

    // x subscriber fires, y has no subscriber so no changeset created for it
    expect(xChangesets).toHaveLength(1)
    expect(store.x).toBe(10)
    expect(store.y).toBe(20)
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

    const changesets: Changeset[] = []
    getChangefeed(doc.n).subscribe((cs: Changeset) => changesets.push(cs))

    doc.n.set(99)
    expect(changesets).toHaveLength(1)
    expect(changesets[0]!.changes[0]!.type).toBe("replace")
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

  it("changeset wraps a single change (degenerate changeset)", () => {
    const { doc } = createChatDoc()
    const changesets: Changeset[] = []
    getChangefeed(doc.title).subscribe((cs) => changesets.push(cs))

    doc.title.insert(0, "X")
    expect(changesets).toHaveLength(1)
    expect(changesets[0]!.changes).toHaveLength(1)
    // No origin on auto-commit changesets
    expect(changesets[0]!.origin).toBeUndefined()
  })

  it("tree changeset wraps a single tree event (degenerate)", () => {
    const { doc } = createChatDoc()
    const changesets: Changeset<TreeEvent>[] = []
    getChangefeed(doc.settings).subscribeTree!((cs) => changesets.push(cs))

    doc.settings.darkMode.set(true)
    expect(changesets).toHaveLength(1)
    expect(changesets[0]!.changes).toHaveLength(1)
    expect(changesets[0]!.changes[0]!.path).toEqual([{ type: "key", key: "darkMode" }])
  })
})
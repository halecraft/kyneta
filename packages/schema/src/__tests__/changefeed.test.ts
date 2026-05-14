import type { Changeset } from "@kyneta/changefeed"
import { CHANGEFEED, hasChangefeed } from "@kyneta/changefeed"
import { describe, expect, it } from "vitest"
import type {
  IncrementChange,
  MapChange,
  SequenceChange,
  TextChange,
} from "../change.js"
import type { Op } from "../index.js"
import {
  change,
  expandMapOpsToLeaves,
  hasTreeChangefeed,
  interpret,
  observation,
  plainContext,
  readable,
  Schema,
  TRANSACT,
  writable,
} from "../index.js"
import { RawPath } from "../path.js"

/** Narrowed helper: return the key variant of RawSegment. */
function keySeg(
  path: { readonly segments: readonly unknown[] },
  i: number,
): { role: "key"; resolve(): string; type?: string; key?: string } {
  const seg = path.segments[i] as any
  return {
    role: "key" as const,
    resolve: () => seg.resolve() as string,
    // Backwards compat for tests that check .type and .key
    type: "key",
    key: seg.resolve() as string,
  }
}

/** Narrowed helper: return the index variant of RawSegment. */
function idxSeg(
  path: { readonly segments: readonly unknown[] },
  i: number,
): { role: "index"; resolve(): number; type?: string; index?: number } {
  const seg = path.segments[i] as any
  return {
    role: "index" as const,
    resolve: () => seg.resolve() as number,
    // Backwards compat for tests that check .type and .index
    type: "index",
    index: seg.resolve() as number,
  }
}

// ===========================================================================
// Shared fixtures
// ===========================================================================

const chatDocSchema = Schema.struct({
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

function createChatDoc(storeOverrides: Record<string, unknown> = {}) {
  const store = {
    title: "Hello",
    count: 0,
    messages: [{ author: "Alice", body: "Hi" }],
    settings: { darkMode: false, fontSize: 14 },
    metadata: { version: 1 },
    ...storeOverrides,
  }
  const ctx = plainContext(store)
  const doc = interpret(chatDocSchema, ctx)
    .with(readable)
    .with(writable)
    .with(observation)
    .done()
  return { store, ctx, doc }
}

const CF_SYM = Symbol.for("kyneta:changefeed")

function getChangefeed(obj: unknown): {
  current: unknown
  subscribe: (cb: (changeset: Changeset) => void) => () => void
  subscribeTree?: (cb: (changeset: Changeset<Op>) => void) => () => void
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
    const unsub = cf.subscribe(changeset => received.push(changeset))

    doc.title.insert(0, "X")
    expect(received).toHaveLength(1)
    expect(received[0]?.changes).toHaveLength(1)
    expect(received[0]?.changes[0]?.type).toBe("text")

    unsub()
    doc.title.insert(0, "Y")
    expect(received).toHaveLength(1) // unchanged after unsub
  })

  it("multiple subscribers all receive changesets", () => {
    const { doc } = createChatDoc()
    const cf = getChangefeed(doc.title)

    const a: Changeset[] = []
    const b: Changeset[] = []
    cf.subscribe(cs => a.push(cs))
    cf.subscribe(cs => b.push(cs))

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
    getChangefeed(doc.settings.darkMode).subscribe(cs =>
      scalarChangesets.push(cs),
    )
    doc.settings.darkMode.set(true)
    expect(scalarChangesets).toHaveLength(1)
    expect(scalarChangesets[0]?.changes[0]?.type).toBe("replace")

    // Text
    const textChangesets: Changeset[] = []
    getChangefeed(doc.title).subscribe(cs => textChangesets.push(cs))
    doc.title.insert(0, "X")
    expect(textChangesets).toHaveLength(1)
    expect(textChangesets[0]?.changes[0]?.type).toBe("text")

    // Counter
    const counterChangesets: Changeset[] = []
    getChangefeed(doc.count).subscribe(cs => counterChangesets.push(cs))
    doc.count.increment(5)
    expect(counterChangesets).toHaveLength(1)
    expect(counterChangesets[0]?.changes[0]?.type).toBe("increment")

    // Sequence
    const seqChangesets: Changeset[] = []
    getChangefeed(doc.messages).subscribe(cs => seqChangesets.push(cs))
    doc.messages.push({ author: "Bob", body: "Hey" })
    expect(seqChangesets).toHaveLength(1)
    expect(seqChangesets[0]?.changes[0]?.type).toBe("sequence")

    // Product (whole-struct replace)
    const prodChangesets: Changeset[] = []
    getChangefeed(doc.settings).subscribe(cs => prodChangesets.push(cs))
    doc.settings.set({ darkMode: false, fontSize: 20 })
    expect(prodChangesets).toHaveLength(1)
    expect(prodChangesets[0]?.changes[0]?.type).toBe("replace")
  })
})

// ===========================================================================
// Compositional tests — hasTreeChangefeed, subscribeTree
// ===========================================================================

describe("changefeed: tree-changefeed type guards", () => {
  it("every schema-issued ref carries TreeChangefeed (subscribeTree)", () => {
    const { doc } = createChatDoc()
    // Leaves now also satisfy the composed-changefeed guard — their
    // `subscribeTree` is the trivial own-path lift with `path.root()`
    // as the relative path (a leaf is a tree of size 1).
    expect(hasChangefeed(doc.title)).toBe(true)
    expect(hasTreeChangefeed(doc.title)).toBe(true)

    expect(hasChangefeed(doc.count)).toBe(true)
    expect(hasTreeChangefeed(doc.count)).toBe(true)

    expect(hasChangefeed(doc.settings.darkMode)).toBe(true)
    expect(hasTreeChangefeed(doc.settings.darkMode)).toBe(true)
  })

  it("product refs produce TreeChangefeed", () => {
    const { doc } = createChatDoc()
    expect(hasTreeChangefeed(doc.settings)).toBe(true)
    expect(hasTreeChangefeed(doc)).toBe(true)
  })

  it("sequence refs produce TreeChangefeed", () => {
    const { doc } = createChatDoc()
    expect(hasTreeChangefeed(doc.messages)).toBe(true)
  })

  it("map refs produce TreeChangefeed", () => {
    const { doc } = createChatDoc()
    expect(hasTreeChangefeed(doc.metadata)).toBe(true)
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
    cf.subscribe(cs => received.push(cs))

    // Mutate a child — should NOT fire on the product's subscribe
    doc.settings.darkMode.set(true)
    expect(received).toHaveLength(0)

    // Mutate the product itself — should fire
    doc.settings.set({ darkMode: false, fontSize: 20 })
    expect(received).toHaveLength(1)
    expect(received[0]?.changes[0]?.type).toBe("replace")
  })
})

// ---------------------------------------------------------------------------
// Product subscribeTree is tree-level
// ---------------------------------------------------------------------------

describe("changefeed: product subscribeTree", () => {
  it("fires for child mutations with correct path", () => {
    const { doc } = createChatDoc()
    const cf = getChangefeed(doc.settings)
    const events: Op[] = []
    cf.subscribeTree?.(changeset => {
      for (const event of changeset.changes) events.push(event)
    })

    doc.settings.darkMode.set(true)
    expect(events).toHaveLength(1)
    expect(events[0]?.path.key).toBe(RawPath.empty.field("darkMode").key)
    expect(events[0]?.change.type).toBe("replace")
  })

  it("fires for own-path changes with path []", () => {
    const { doc } = createChatDoc()
    const cf = getChangefeed(doc.settings)
    const events: Op[] = []
    cf.subscribeTree?.(changeset => {
      for (const event of changeset.changes) events.push(event)
    })

    doc.settings.set({ darkMode: true, fontSize: 18 })
    expect(events).toHaveLength(1)
    expect(events[0]?.path.length).toBe(0)
    expect(events[0]?.change.type).toBe("replace")
  })

  it("nested tree composition — deep path", () => {
    const { doc } = createChatDoc()
    const cf = getChangefeed(doc)
    const events: Op[] = []
    cf.subscribeTree?.(changeset => {
      for (const event of changeset.changes) events.push(event)
    })

    doc.settings.darkMode.set(true)
    expect(events.length).toBeGreaterThanOrEqual(1)
    // Find the event for the darkMode change
    const darkModeEvent = events.find(
      e =>
        e.path.length === 2 &&
        keySeg(e.path, 0).type === "key" &&
        keySeg(e.path, 0).key === "settings" &&
        keySeg(e.path, 1).type === "key" &&
        keySeg(e.path, 1).key === "darkMode",
    )
    expect(darkModeEvent).toBeDefined()
    expect(darkModeEvent?.change.type).toBe("replace")
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
    cf.subscribe(cs => received.push(cs))

    // Push — structural, should fire
    doc.messages.push({ author: "Bob", body: "Hey" })
    expect(received).toHaveLength(1)
    expect(received[0]?.changes[0]?.type).toBe("sequence")

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
    const events: Op[] = []
    cf.subscribeTree?.(changeset => {
      for (const event of changeset.changes) events.push(event)
    })

    const msg = doc.messages.at(0)!
    msg.author.set("Charlie")

    expect(events.length).toBeGreaterThanOrEqual(1)
    // Find the item content event
    const itemEvent = events.find(
      e =>
        e.path.length >= 2 &&
        idxSeg(e.path, 0).type === "index" &&
        idxSeg(e.path, 0).index === 0,
    )
    expect(itemEvent).toBeDefined()
    expect(itemEvent?.change.type).toBe("replace")
  })

  it("fires for structural changes with path []", () => {
    const { doc } = createChatDoc()
    const cf = getChangefeed(doc.messages)
    const events: Op[] = []
    cf.subscribeTree?.(changeset => {
      for (const event of changeset.changes) events.push(event)
    })

    doc.messages.push({ author: "Bob", body: "Hey" })

    const ownPathEvent = events.find(e => e.path.length === 0)
    expect(ownPathEvent).toBeDefined()
    expect(ownPathEvent?.change.type).toBe("sequence")
  })

  it("dynamic subscription: push then mutate new item fires tree event", () => {
    const { doc } = createChatDoc()
    const cf = getChangefeed(doc.messages)
    const events: Op[] = []
    cf.subscribeTree?.(changeset => {
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
      e =>
        e.path.length >= 2 &&
        idxSeg(e.path, 0).type === "index" &&
        idxSeg(e.path, 0).index === 1,
    )
    expect(newItemEvent).toBeDefined()
  })

  it("delete rebuilds subscriptions — new item at evicted index fires correctly", () => {
    const { doc } = createChatDoc({
      messages: [
        { author: "Alice", body: "Hi" },
        { author: "Bob", body: "Hey" },
      ],
    })
    const cf = getChangefeed(doc.messages)
    const events: Op[] = []
    cf.subscribeTree?.(changeset => {
      for (const event of changeset.changes) events.push(event)
    })

    // Delete the first item — Bob shifts to index 0
    doc.messages.delete(0, 1)
    const eventsAfterDelete = events.length

    // Get a fresh ref to the new item at index 0 (Bob)
    const newFirst = doc.messages.at(0)!
    expect(newFirst.author()).toBe("Bob")

    // Mutate the new first item — tree subscription should fire
    newFirst.author.set("Robert")
    expect(events.length).toBeGreaterThan(eventsAfterDelete)
  })
})

// ---------------------------------------------------------------------------
// Map subscribeTree
// ---------------------------------------------------------------------------

describe("changefeed: map subscribeTree", () => {
  it("fires for entry value changes", () => {
    const { doc } = createChatDoc({ metadata: { color: "red", priority: 1 } })
    const cf = getChangefeed(doc.metadata)
    const events: Op[] = []
    cf.subscribeTree?.(changeset => {
      for (const event of changeset.changes) events.push(event)
    })

    // Access a child ref and mutate it
    const colorRef = doc.metadata.at("color")!
    colorRef.set("blue")

    expect(events.length).toBeGreaterThanOrEqual(1)
    const entryEvent = events.find(
      e =>
        e.path.length >= 1 &&
        keySeg(e.path, 0).type === "key" &&
        keySeg(e.path, 0).key === "color",
    )
    expect(entryEvent).toBeDefined()
  })

  it("fires for structural changes with path []", () => {
    const { doc } = createChatDoc()
    const cf = getChangefeed(doc.metadata)
    const events: Op[] = []
    cf.subscribeTree?.(changeset => {
      for (const event of changeset.changes) events.push(event)
    })

    doc.metadata.set("newKey", "newValue")

    const ownPathEvent = events.find(e => e.path.length === 0)
    expect(ownPathEvent).toBeDefined()
    expect(ownPathEvent?.change.type).toBe("map")
  })

  it("dynamic subscription: set then mutate new entry fires tree event", () => {
    const { doc } = createChatDoc()
    const cf = getChangefeed(doc.metadata)
    const events: Op[] = []
    cf.subscribeTree?.(changeset => {
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
    const events: Op[] = []
    // biome-ignore lint/style/noNonNullAssertion: subscribeTree is guaranteed present on composed changefeeds
    const unsub = cf.subscribeTree!(changeset => {
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
    const treeEvents: Op[] = []

    cf.subscribe(cs => shallowChangesets.push(cs))
    cf.subscribeTree?.(changeset => {
      for (const event of changeset.changes) treeEvents.push(event)
    })

    doc.settings.set({ darkMode: true, fontSize: 18 })

    expect(shallowChangesets).toHaveLength(1)
    expect(treeEvents).toHaveLength(1)
    expect(treeEvents[0]?.path.length).toBe(0)
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
    const schema = Schema.struct({
      x: Schema.number(),
      y: Schema.number(),
    })
    const ctx = plainContext(store)
    const doc = interpret(schema, ctx)
      .with(readable)
      .with(writable)
      .with(observation)
      .done()

    const xChangesets: Changeset[] = []
    getChangefeed(doc.x).subscribe(cs => xChangesets.push(cs))

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
    expect(xChangesets[0]?.changes).toHaveLength(2)
    expect(xChangesets[0]?.changes[0]?.type).toBe("replace")
    expect(xChangesets[0]?.changes[1]?.type).toBe("replace")
  })

  it("no tree subscriber notifications during transaction buffering", () => {
    const { ctx, doc } = createChatDoc()
    const treeChangesets: Changeset<Op>[] = []
    getChangefeed(doc.settings).subscribeTree?.(changeset => {
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
      e =>
        e.path.length === 1 &&
        keySeg(e.path, 0).type === "key" &&
        keySeg(e.path, 0).key === "darkMode",
    )
    const fontSizeEvents = allEvents.filter(
      e =>
        e.path.length === 1 &&
        keySeg(e.path, 0).type === "key" &&
        keySeg(e.path, 0).key === "fontSize",
    )
    expect(darkModeEvents).toHaveLength(1)
    expect(fontSizeEvents).toHaveLength(1)
  })

  it("store buffers changes during transaction until commit", () => {
    const store = { x: 0, y: 0 }
    const schema = Schema.struct({
      x: Schema.number(),
      y: Schema.number(),
    })
    const ctx = plainContext(store)
    const doc = interpret(schema, ctx)
      .with(readable)
      .with(writable)
      .with(observation)
      .done()

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
    const schema = Schema.struct({
      x: Schema.number(),
      y: Schema.number(),
    })
    const ctx = plainContext(store)
    const doc = interpret(schema, ctx)
      .with(readable)
      .with(writable)
      .with(observation)
      .done()

    const xChangesets: Changeset[] = []
    getChangefeed(doc.x).subscribe(cs => xChangesets.push(cs))

    ctx.beginTransaction()
    doc.x.set(10)
    // No notifications during buffering
    expect(xChangesets).toHaveLength(0)

    ctx.commit()
    // Exactly 1 changeset with 1 change (batched delivery)
    expect(xChangesets).toHaveLength(1)
    expect(store.x).toBe(10)
    expect(xChangesets[0]?.changes).toHaveLength(1)
    expect(xChangesets[0]?.changes[0]?.type).toBe("replace")
  })

  it("transaction + subscribeTree: tree subscribers fire at commit time", () => {
    const { ctx, doc } = createChatDoc()
    const treeChangesets: Changeset<Op>[] = []
    getChangefeed(doc.settings).subscribeTree?.(changeset => {
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
      e =>
        e.path.length === 1 &&
        keySeg(e.path, 0).type === "key" &&
        keySeg(e.path, 0).key === "darkMode",
    )
    const fontSizeEvents = allEvents.filter(
      e =>
        e.path.length === 1 &&
        keySeg(e.path, 0).type === "key" &&
        keySeg(e.path, 0).key === "fontSize",
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
    const schema = Schema.struct({
      x: Schema.number(),
      y: Schema.number(),
    })
    const ctx = plainContext(store)
    const doc = interpret(schema, ctx)
      .with(readable)
      .with(writable)
      .with(observation)
      .done()

    const xChangesets: Changeset[] = []
    getChangefeed(doc.x).subscribe(cs => xChangesets.push(cs))

    ctx.beginTransaction()
    doc.x.set(1)
    doc.x.set(2)
    doc.x.set(3)

    expect(xChangesets).toHaveLength(0)

    ctx.commit()
    // 3 mutations to the same path → 1 Changeset with 3 changes
    expect(xChangesets).toHaveLength(1)
    expect(xChangesets[0]?.changes).toHaveLength(3)
    expect(store.x).toBe(3)
  })

  it("subscriber sees fully-applied state when Changeset arrives", () => {
    const store = { x: 0, y: 0 }
    const schema = Schema.struct({
      x: Schema.number(),
      y: Schema.number(),
    })
    const ctx = plainContext(store)
    const doc = interpret(schema, ctx)
      .with(readable)
      .with(writable)
      .with(observation)
      .done()

    let observedX: unknown
    let observedY: unknown
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
    getChangefeed(doc.title).subscribe(cs => changesets.push(cs))

    doc.title.insert(0, "X")
    expect(changesets).toHaveLength(1)
    expect(changesets[0]?.changes).toHaveLength(1)
    expect(changesets[0]?.origin).toBeUndefined()
  })

  it("origin tagging: commit(origin) attaches origin to emitted Changeset", () => {
    const store = { x: 0, y: 0 }
    const schema = Schema.struct({
      x: Schema.number(),
      y: Schema.number(),
    })
    const ctx = plainContext(store)
    const doc = interpret(schema, ctx)
      .with(readable)
      .with(writable)
      .with(observation)
      .done()

    const xChangesets: Changeset[] = []
    getChangefeed(doc.x).subscribe(cs => xChangesets.push(cs))

    ctx.beginTransaction()
    doc.x.set(42)
    ctx.commit("sync")

    expect(xChangesets).toHaveLength(1)
    expect(xChangesets[0]?.origin).toBe("sync")
    expect(xChangesets[0]?.changes).toHaveLength(1)
  })

  it("origin tagging: auto-commit has no origin", () => {
    const { doc } = createChatDoc()
    const changesets: Changeset[] = []
    getChangefeed(doc.count).subscribe(cs => changesets.push(cs))

    doc.count.increment(5)
    expect(changesets).toHaveLength(1)
    expect(changesets[0]?.origin).toBeUndefined()
  })

  it("origin tagging: tree subscribers receive origin from commit", () => {
    const { ctx, doc } = createChatDoc()
    const treeChangesets: Changeset<Op>[] = []
    getChangefeed(doc.settings).subscribeTree?.(cs => treeChangesets.push(cs))

    ctx.beginTransaction()
    doc.settings.darkMode.set(true)
    ctx.commit("undo")

    // Tree changeset propagated from child — should carry the origin
    expect(treeChangesets).toHaveLength(1)
    expect(treeChangesets[0]?.origin).toBe("undo")
    expect(treeChangesets[0]?.changes).toHaveLength(1)
    expect(treeChangesets[0]?.changes[0]?.path.key).toBe(
      RawPath.empty.field("darkMode").key,
    )
  })

  it("multiple paths in one transaction: each path gets its own Changeset", () => {
    const store = { x: 0, y: 0 }
    const schema = Schema.struct({
      x: Schema.number(),
      y: Schema.number(),
    })
    const ctx = plainContext(store)
    const doc = interpret(schema, ctx)
      .with(readable)
      .with(writable)
      .with(observation)
      .done()

    const xChangesets: Changeset[] = []
    const yChangesets: Changeset[] = []
    getChangefeed(doc.x).subscribe(cs => xChangesets.push(cs))
    getChangefeed(doc.y).subscribe(cs => yChangesets.push(cs))

    ctx.beginTransaction()
    doc.x.set(10)
    doc.y.set(20)
    doc.x.set(30)
    ctx.commit()

    // x had 2 mutations → 1 changeset with 2 changes
    expect(xChangesets).toHaveLength(1)
    expect(xChangesets[0]?.changes).toHaveLength(2)

    // y had 1 mutation → 1 changeset with 1 change
    expect(yChangesets).toHaveLength(1)
    expect(yChangesets[0]?.changes).toHaveLength(1)
  })

  it("no notification for paths without subscribers", () => {
    const store = { x: 0, y: 0 }
    const schema = Schema.struct({
      x: Schema.number(),
      y: Schema.number(),
    })
    const ctx = plainContext(store)
    const doc = interpret(schema, ctx)
      .with(readable)
      .with(writable)
      .with(observation)
      .done()

    // Only subscribe to x, not y
    const xChangesets: Changeset[] = []
    getChangefeed(doc.x).subscribe(cs => xChangesets.push(cs))

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
    const schema = Schema.struct({ n: Schema.number() })
    const store = { n: 42 }
    const ctx = plainContext(store)
    const doc = interpret(schema, ctx)
      .with(readable)
      .with(writable)
      .with(observation)
      .done()

    const changesets: Changeset[] = []
    getChangefeed(doc.n).subscribe((cs: Changeset) => changesets.push(cs))

    doc.n.set(99)
    expect(changesets).toHaveLength(1)
    expect(changesets[0]?.changes[0]?.type).toBe("replace")
  })

  it("empty sequence has TreeChangefeed", () => {
    const schema = Schema.struct({
      items: Schema.list(Schema.string()),
    })
    const store = { items: [] as string[] }
    const ctx = plainContext(store)
    const doc = interpret(schema, ctx)
      .with(readable)
      .with(writable)
      .with(observation)
      .done()

    expect(hasTreeChangefeed(doc.items)).toBe(true)
  })

  it("empty map has TreeChangefeed", () => {
    const schema = Schema.struct({
      labels: Schema.record(Schema.string()),
    })
    const store = { labels: {} }
    const ctx = plainContext(store)
    const doc = interpret(schema, ctx)
      .with(readable)
      .with(writable)
      .with(observation)
      .done()

    expect(hasTreeChangefeed(doc.labels)).toBe(true)
  })

  it("changeset wraps a single change (degenerate changeset)", () => {
    const { doc } = createChatDoc()
    const changesets: Changeset[] = []
    getChangefeed(doc.title).subscribe(cs => changesets.push(cs))

    doc.title.insert(0, "X")
    expect(changesets).toHaveLength(1)
    expect(changesets[0]?.changes).toHaveLength(1)
    // No origin on auto-commit changesets
    expect(changesets[0]?.origin).toBeUndefined()
  })

  it("tree changeset wraps a single tree event (degenerate)", () => {
    const { doc } = createChatDoc()
    const changesets: Changeset<Op>[] = []
    getChangefeed(doc.settings).subscribeTree?.(cs => changesets.push(cs))

    doc.settings.darkMode.set(true)
    expect(changesets).toHaveLength(1)
    expect(changesets[0]?.changes).toHaveLength(1)
    expect(changesets[0]?.changes[0]?.path.key).toBe(
      RawPath.empty.field("darkMode").key,
    )
  })
})

// ===========================================================================
// expandMapOpsToLeaves — container→leaf op expansion
// ===========================================================================

describe("expandMapOpsToLeaves", () => {
  // Schema for tests: settings is a product (expand), peers is a map (preserve)
  const testSchema = Schema.struct({
    title: Schema.text(),
    settings: Schema.struct({
      a: Schema.boolean(),
      b: Schema.number(),
      c: Schema.string(),
      dark: Schema.boolean(),
      x: Schema.string(),
      y: Schema.string(),
    }),
    items: Schema.list(Schema.string()),
    entries: Schema.list(Schema.record(Schema.boolean())),
    count: Schema.counter(),
    peers: Schema.record(Schema.boolean()),
  })

  it("map op at product path → expanded to leaf replace ops", () => {
    const ops: Op<MapChange>[] = [
      {
        path: RawPath.empty.field("settings"),
        change: { type: "map", set: { a: true } },
      },
    ]
    const result = expandMapOpsToLeaves(ops, testSchema)
    expect(result).toHaveLength(1)
    expect(result[0].path.key).toBe(
      RawPath.empty.field("settings").field("a").key,
    )
    expect(result[0].change).toEqual({ type: "replace", value: true })
  })

  it("map op with multiple keys at product path → N leaf replace ops", () => {
    const ops: Op<MapChange>[] = [
      {
        path: RawPath.empty.field("settings"),
        change: { type: "map", set: { a: true, b: 0, c: "hi" } },
      },
    ]
    const result = expandMapOpsToLeaves(ops, testSchema)
    expect(result).toHaveLength(3)
    const keys = result.map(r => keySeg(r.path, 1).key).sort()
    expect(keys).toEqual(["a", "b", "c"])
    for (const r of result) {
      expect(r.change.type).toBe("replace")
    }
  })

  it("map op with delete keys at product path → leaf replace ops with undefined", () => {
    const ops: Op<MapChange>[] = [
      {
        path: RawPath.empty.field("settings"),
        change: { type: "map", delete: ["x", "y"] },
      },
    ]
    const result = expandMapOpsToLeaves(ops, testSchema)
    expect(result).toHaveLength(2)
    expect(result[0].change).toEqual({ type: "replace", value: undefined })
    expect(result[1].change).toEqual({ type: "replace", value: undefined })
  })

  it("non-map op → pass through unchanged", () => {
    const ops: Op<TextChange | SequenceChange>[] = [
      {
        path: RawPath.empty.field("title"),
        change: { type: "text", instructions: [{ insert: "hello" }] },
      },
      {
        path: RawPath.empty.field("items"),
        change: { type: "sequence", instructions: [{ insert: ["a"] }] },
      },
    ]
    const result = expandMapOpsToLeaves(ops, testSchema)
    expect(result).toHaveLength(2)
    expect(result).toEqual(ops)
  })

  it("mixed ops → only product map ops expanded", () => {
    const ops: Op<TextChange | MapChange | IncrementChange>[] = [
      {
        path: RawPath.empty.field("title"),
        change: { type: "text", instructions: [{ insert: "hi" }] },
      },
      {
        path: RawPath.empty.field("settings"),
        change: { type: "map", set: { dark: true } },
      },
      {
        path: RawPath.empty.field("count"),
        change: { type: "increment", amount: 1 },
      },
    ]
    const result = expandMapOpsToLeaves(ops, testSchema)
    expect(result).toHaveLength(3)
    // text passes through
    expect(result[0].change.type).toBe("text")
    // map expanded to leaf replace (settings is a product)
    expect(result[1].path.key).toBe(
      RawPath.empty.field("settings").field("dark").key,
    )
    expect(result[1].change).toEqual({ type: "replace", value: true })
    // counter passes through
    expect(result[2].change.type).toBe("increment")
  })

  it("map op at map (record) path → preserved as MapChange", () => {
    const ops: Op<MapChange>[] = [
      {
        path: RawPath.empty.field("peers"),
        change: { type: "map", set: { alice: true } },
      },
    ]
    const result = expandMapOpsToLeaves(ops, testSchema)
    expect(result).toHaveLength(1)
    expect(result[0].path.key).toBe(RawPath.empty.field("peers").key)
    expect(result[0].change.type).toBe("map")
  })

  it("map op at root path (length 0) → always expanded (_props)", () => {
    const ops: Op<MapChange>[] = [
      {
        path: RawPath.empty,
        change: { type: "map", set: { darkMode: true, theme: "dark" } },
      },
    ]
    const result = expandMapOpsToLeaves(ops, testSchema)
    expect(result).toHaveLength(2)
    for (const r of result) {
      expect(r.change.type).toBe("replace")
    }
  })

  it("mixed product + record map ops → only product expanded", () => {
    const ops: Op<MapChange>[] = [
      {
        path: RawPath.empty.field("settings"),
        change: { type: "map", set: { dark: true } },
      },
      {
        path: RawPath.empty.field("peers"),
        change: { type: "map", set: { bob: true } },
      },
    ]
    const result = expandMapOpsToLeaves(ops, testSchema)
    expect(result).toHaveLength(2)
    // settings (product) → expanded
    expect(result[0].change.type).toBe("replace")
    expect(result[0].path.key).toBe(
      RawPath.empty.field("settings").field("dark").key,
    )
    // peers (map) → preserved
    expect(result[1].change.type).toBe("map")
    expect(result[1].path.key).toBe(RawPath.empty.field("peers").key)
  })

  it("map op at nested record path (record inside list) → preserved", () => {
    const ops: Op<MapChange>[] = [
      {
        path: RawPath.empty.field("entries").item(0),
        change: { type: "map", set: { alice: true } },
      },
    ]
    const result = expandMapOpsToLeaves(ops, testSchema)
    expect(result).toHaveLength(1)
    expect(result[0].change.type).toBe("map")
  })
})

// ===========================================================================
// Phase-separation enforcement (flush boundary)
// ===========================================================================

describe("changefeed: flush boundary enforcement", () => {
  it("change() propagates subscriber error, not secondary abort error", () => {
    const store = { x: 0 }
    const schema = Schema.struct({ x: Schema.number() })
    const ctx = plainContext(store)
    const doc = interpret(schema, ctx)
      .with(readable)
      .with(writable)
      .with(observation)
      .done()

    // Subscribe with a callback that throws
    getChangefeed(doc.x).subscribe(() => {
      throw new Error("subscriber boom")
    })

    // The change() call should propagate the SUBSCRIBER error,
    // not a secondary "No active transaction to abort" error.
    expect(() => {
      change(doc, (d: any) => {
        d.x.set(42)
      })
    }).toThrow("subscriber boom")
  })

  it("re-entrant change() during notification delivery succeeds and drains in a fresh sub-tick", () => {
    const store = { x: 0, y: 0 }
    const schema = Schema.struct({
      x: Schema.number(),
      y: Schema.number(),
    })
    const ctx = plainContext(store)
    const doc = interpret(schema, ctx)
      .with(readable)
      .with(writable)
      .with(observation)
      .done()

    // Subscribe to x; when x changes, mutate y via change().
    // Pre-1.6.0 this threw "Mutation during notification delivery is not
    // supported." Post-1.6.0 the per-context dispatcher drains the
    // re-entrant change in a fresh sub-tick: both writes land, both
    // subscribers fire, and subsequent reads see the new state.
    let xFired = 0
    let yFired = 0
    getChangefeed(doc.x).subscribe(() => {
      xFired++
      change(doc, (d: any) => {
        d.y.set(99)
      })
    })
    getChangefeed(doc.y).subscribe(() => {
      yFired++
    })

    expect(() => {
      change(doc, (d: any) => {
        d.x.set(42)
      })
    }).not.toThrow()

    expect(doc.x()).toBe(42)
    expect(doc.y()).toBe(99)
    expect(xFired).toBe(1)
    expect(yFired).toBe(1)
  })
})

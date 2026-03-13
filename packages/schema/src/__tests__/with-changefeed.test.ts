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
  hasChangefeed,
  CHANGEFEED,
} from "../index.js"
import type { Readable, Writable } from "../index.js"

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
  const ctx = createWritableContext(store)
  const enriched = enrich(writableInterpreter, withChangefeed)
  const doc = interpret(chatDocSchema, enriched, ctx) as Readable<
    typeof chatDocSchema
  > &
    Writable<typeof chatDocSchema>
  return { store, ctx, doc }
}

const CF_SYM = Symbol.for("kyneta:changefeed")

function getChangefeed(obj: unknown): { current: unknown; subscribe: (cb: (c: unknown) => void) => () => void } {
  return (obj as Record<symbol, { current: unknown; subscribe: (cb: (c: unknown) => void) => () => void }>)[CF_SYM]
}

// ---------------------------------------------------------------------------
// hasChangefeed — one leaf, one composite
// ---------------------------------------------------------------------------

describe("withChangefeed: hasChangefeed", () => {
  it("leaf refs have changefeed", () => {
    const { doc } = createChangefeedChatDoc()
    expect(hasChangefeed(doc.title)).toBe(true)
    expect(hasChangefeed(doc.count)).toBe(true)
  })

  it("composite refs have changefeed", () => {
    const { doc } = createChangefeedChatDoc()
    expect(hasChangefeed(doc)).toBe(true)
    expect(hasChangefeed(doc.settings)).toBe(true)
    expect(hasChangefeed(doc.messages)).toBe(true)
    expect(hasChangefeed(doc.metadata)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// [CHANGEFEED].current — live getter
// ---------------------------------------------------------------------------

describe("withChangefeed: current value", () => {
  it("current reflects live store state through mutations", () => {
    const { doc } = createChangefeedChatDoc()

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

describe("withChangefeed: subscription lifecycle", () => {
  it("subscribe receives changes, unsubscribe stops delivery", () => {
    const { doc } = createChangefeedChatDoc()
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
    const { doc } = createChangefeedChatDoc()
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

describe("withChangefeed: exact-path subscription", () => {
  it("fires with the correct change type for each node kind", () => {
    const { doc } = createChangefeedChatDoc()

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

// ---------------------------------------------------------------------------
// Transaction integration — store buffering only
// ---------------------------------------------------------------------------
//
// The "commit replays through ctx.dispatch" invariant is tested in
// transaction.test.ts. Here we verify the store-level contract:
// changes don't apply until commit.

describe("withChangefeed: transaction integration", () => {
  it("store buffers changes during transaction until commit", () => {
    const store = { x: 0, y: 0 }
    const schema = LoroSchema.doc({
      x: LoroSchema.plain.number(),
      y: LoroSchema.plain.number(),
    })
    const ctx = createWritableContext(store)
    const enriched = enrich(writableInterpreter, withChangefeed)
    const doc = interpret(schema, enriched, ctx) as Readable<typeof schema> &
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
})
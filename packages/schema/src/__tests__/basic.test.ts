import { describe, expect, it } from "vitest"
import {
  applyChanges,
  change,
  createDoc,
  createDocFromSnapshot,
  delta,
  exportSnapshot,
  Schema,
  subscribe,
  subscribeNode,
  version,
} from "../basic/index.js"
import type { Changeset, Op, SubstratePayload } from "../index.js"
import { CHANGEFEED, hasChangefeed, hasTransact, TRANSACT } from "../index.js"

// ===========================================================================
// Shared fixtures
// ===========================================================================

const TestSchema = Schema.doc({
  title: Schema.annotated("text"),
  count: Schema.annotated("counter"),
  items: Schema.list(
    Schema.struct({
      name: Schema.string(),
      done: Schema.boolean(),
    }),
  ),
  theme: Schema.string(),
})

/** Create a doc and apply seed values via change(). */
function createSeededDoc() {
  const doc = createDoc(TestSchema)
  change(doc, d => {
    d.title.insert(0, "Hello")
    d.count.increment(5)
    d.items.push({ name: "Task A", done: false })
    d.theme.set("dark")
  })
  return doc
}

// ===========================================================================
// createDoc
// ===========================================================================

describe("createDoc", () => {
  it("returns callable refs — typeof doc is function, doc() returns plain object", () => {
    const doc = createDoc(TestSchema)

    expect(typeof doc).toBe("function")
    expect(typeof doc()).toBe("object")
    expect(doc()).not.toBeNull()
  })

  it("with seed values applied via change() populates initial state", () => {
    const doc = createSeededDoc()

    expect(doc.title()).toBe("Hello")
    expect(doc.count()).toBe(5)
    expect(doc.theme()).toBe("dark")
    expect(doc.items.length).toBe(1)
    expect(doc.items.at(0)?.name()).toBe("Task A")
    expect(doc.items.at(0)?.done()).toBe(false)
  })

  it("without seed uses Zero defaults", () => {
    const doc = createDoc(TestSchema)

    expect(doc.title()).toBe("")
    expect(doc.count()).toBe(0)
    expect(doc.theme()).toBe("")
    expect(doc.items.length).toBe(0)
  })

  it("refs have CHANGEFEED and TRANSACT symbols", () => {
    const doc = createDoc(TestSchema)

    expect(hasChangefeed(doc)).toBe(true)
    expect(hasTransact(doc)).toBe(true)
    expect(CHANGEFEED in doc).toBe(true)
    expect(TRANSACT in doc).toBe(true)
  })
})

// ===========================================================================
// createDocFromSnapshot
// ===========================================================================

describe("createDocFromSnapshot", () => {
  it("round-trips with exportSnapshot", () => {
    const docA = createSeededDoc()

    // Mutate docA
    change(docA, d => {
      d.title.insert(5, " World")
      d.count.increment(3)
      d.items.push({ name: "Task B", done: true })
      d.theme.set("light")
    })

    const payload = exportSnapshot(docA)
    const docB = createDocFromSnapshot(TestSchema, payload)

    expect(docB()).toEqual(docA())
  })
})

// ===========================================================================
// Sync primitives
// ===========================================================================

describe("sync primitives", () => {
  it("version returns 0 initially", () => {
    const doc = createDoc(TestSchema)

    expect(version(doc)).toBe(0)
  })

  it("version increments after mutations", () => {
    const doc = createSeededDoc()

    const v0 = version(doc)
    change(doc, d => {
      d.theme.set("light")
    })
    const v1 = version(doc)

    expect(v1).toBeGreaterThan(v0)

    change(doc, d => {
      d.count.increment(1)
    })
    const v2 = version(doc)

    expect(v2).toBeGreaterThan(v1)
  })

  it("delta returns ops after mutations", () => {
    const doc = createSeededDoc()

    change(doc, d => {
      d.theme.set("light")
      d.count.increment(2)
    })

    const ops = delta(doc, 0)
    expect(ops.length).toBeGreaterThan(0)
  })

  it("delta returns [] when already up to date", () => {
    const doc = createSeededDoc()

    change(doc, d => {
      d.theme.set("light")
    })

    const currentVersion = version(doc)
    const ops = delta(doc, currentVersion)
    expect(ops).toEqual([])
  })

  it("exportSnapshot produces a payload with encoding json and string data", () => {
    const doc = createSeededDoc()

    const payload: SubstratePayload = exportSnapshot(doc)

    expect(payload.encoding).toBe("json")
    expect(typeof payload.data).toBe("string")
  })
})

// ===========================================================================
// change / applyChanges round-trip
// ===========================================================================

describe("change / applyChanges round-trip", () => {
  it("text insert round-trips correctly", () => {
    const docA = createSeededDoc()
    const docB = createDocFromSnapshot(TestSchema, exportSnapshot(docA))

    const ops = change(docA, d => {
      d.title.insert(5, " World")
    })

    applyChanges(docB, ops)
    expect(docB()).toEqual(docA())
    expect(docB.title()).toBe("Hello World")
  })

  it("counter increment round-trips correctly", () => {
    const docA = createSeededDoc()
    const docB = createDocFromSnapshot(TestSchema, exportSnapshot(docA))

    const ops = change(docA, d => {
      d.count.increment(10)
    })

    applyChanges(docB, ops)
    expect(docB()).toEqual(docA())
    expect(docB.count()).toBe(15)
  })

  it("sequence push round-trips correctly", () => {
    const docA = createSeededDoc()
    const docB = createDocFromSnapshot(TestSchema, exportSnapshot(docA))

    const ops = change(docA, d => {
      d.items.push({ name: "Task B", done: true })
    })

    applyChanges(docB, ops)
    expect(docB()).toEqual(docA())
    expect(docB.items.length).toBe(2)
    expect(docB.items.at(1)?.name()).toBe("Task B")
    expect(docB.items.at(1)?.done()).toBe(true)
  })

  it("mixed mutations round-trip correctly", () => {
    const docA = createSeededDoc()
    const docB = createDocFromSnapshot(TestSchema, exportSnapshot(docA))

    const ops = change(docA, d => {
      d.title.insert(5, "!")
      d.count.increment(7)
      d.items.push({ name: "Task C", done: false })
      d.theme.set("solarized")
    })

    applyChanges(docB, ops)
    expect(docB()).toEqual(docA())
  })

  it("applyChanges with origin delivers origin to subscriber", () => {
    const doc = createSeededDoc()

    const changesets: Changeset<Op>[] = []
    subscribe(doc, cs => changesets.push(cs))

    const otherDoc = createDocFromSnapshot(TestSchema, exportSnapshot(doc))
    const ops = change(otherDoc, d => {
      d.theme.set("light")
    })

    applyChanges(doc, ops, { origin: "sync" })

    expect(changesets).toHaveLength(1)
    expect(changesets[0]?.origin).toBe("sync")
  })
})

// ===========================================================================
// subscribe
// ===========================================================================

describe("subscribe", () => {
  it("fires on mutations with correct paths", () => {
    const doc = createSeededDoc()

    const changesets: Changeset<Op>[] = []
    subscribe(doc, cs => changesets.push(cs))

    change(doc, d => {
      d.theme.set("light")
    })

    expect(changesets).toHaveLength(1)
    expect(changesets[0]?.changes).toHaveLength(1)
    expect(changesets[0]?.changes[0]?.path.format()).toBe("theme")
  })

  it("fires on multiple mutations with all paths", () => {
    const doc = createSeededDoc()

    const changesets: Changeset<Op>[] = []
    subscribe(doc, cs => changesets.push(cs))

    change(doc, d => {
      d.theme.set("light")
      d.count.increment(1)
    })

    const allChanges = changesets.flatMap(cs => cs.changes)
    expect(allChanges.length).toBeGreaterThanOrEqual(2)
  })
})

// ===========================================================================
// subscribeNode
// ===========================================================================

describe("subscribeNode", () => {
  it("fires on count mutation", () => {
    const doc = createSeededDoc()

    const changesets: Changeset[] = []
    subscribeNode(doc.count, cs => changesets.push(cs))

    change(doc, d => {
      d.count.increment(1)
    })

    expect(changesets).toHaveLength(1)
    expect(changesets[0]?.changes).toHaveLength(1)
    expect(changesets[0]?.changes[0]?.type).toBe("increment")
  })

  it("does not fire on unrelated mutations", () => {
    const doc = createSeededDoc()

    const changesets: Changeset[] = []
    subscribeNode(doc.count, cs => changesets.push(cs))

    change(doc, d => {
      d.theme.set("light")
    })

    expect(changesets).toHaveLength(0)
  })
})

// ===========================================================================
// WeakMap isolation
// ===========================================================================

describe("WeakMap isolation", () => {
  it("two docs from same schema have independent substrates", () => {
    const docA = createSeededDoc()
    const docB = createSeededDoc()

    change(docA, d => {
      d.title.insert(5, " World")
      d.count.increment(10)
      d.theme.set("light")
    })

    // docB should be unaffected
    expect(docB.title()).toBe("Hello")
    expect(docB.count()).toBe(5)
    expect(docB.theme()).toBe("dark")

    // docA should reflect mutations
    expect(docA.title()).toBe("Hello World")
    expect(docA.count()).toBe(15)
    expect(docA.theme()).toBe("light")
  })

  it("version tracks independently per doc", () => {
    const docA = createDoc(TestSchema)
    const docB = createDoc(TestSchema)

    expect(version(docA)).toBe(0)
    expect(version(docB)).toBe(0)

    change(docA, d => {
      d.theme.set("light")
    })

    expect(version(docA)).toBeGreaterThan(0)
    expect(version(docB)).toBe(0)

    change(docB, d => {
      d.count.increment(1)
    })

    expect(version(docB)).toBeGreaterThan(0)
  })
})

// ===========================================================================
// isPopulated
// ===========================================================================

describe("isPopulated", () => {
  it("starts false on a fresh doc", () => {
    const doc = createDoc(TestSchema)
    expect(doc.isPopulated()).toBe(false)
    expect(doc.title.isPopulated()).toBe(false)
    expect(doc.count.isPopulated()).toBe(false)
    expect(doc.items.isPopulated()).toBe(false)
    expect(doc.theme.isPopulated()).toBe(false)
  })

  it("flips true on leaf scalar mutation", () => {
    const doc = createDoc(TestSchema)
    expect(doc.theme.isPopulated()).toBe(false)

    change(doc, d => d.theme.set("dark"))

    expect(doc.theme.isPopulated()).toBe(true)
    // Other fields remain unpopulated
    expect(doc.title.isPopulated()).toBe(false)
    expect(doc.count.isPopulated()).toBe(false)
  })

  it("flips true on text annotation mutation", () => {
    const doc = createDoc(TestSchema)
    expect(doc.title.isPopulated()).toBe(false)

    change(doc, d => d.title.insert(0, "Hello"))

    expect(doc.title.isPopulated()).toBe(true)
  })

  it("flips true on counter annotation mutation", () => {
    const doc = createDoc(TestSchema)
    expect(doc.count.isPopulated()).toBe(false)

    change(doc, d => d.count.increment(1))

    expect(doc.count.isPopulated()).toBe(true)
  })

  it("flips true on sequence push", () => {
    const doc = createDoc(TestSchema)
    expect(doc.items.isPopulated()).toBe(false)

    change(doc, d => d.items.push({ name: "Task", done: false }))

    expect(doc.items.isPopulated()).toBe(true)
  })

  it("parent (doc) flips true when any child is mutated", () => {
    const doc = createDoc(TestSchema)
    expect(doc.isPopulated()).toBe(false)

    change(doc, d => d.theme.set("light"))

    // Doc itself is populated because a descendant was mutated
    expect(doc.isPopulated()).toBe(true)
    // The mutated child is populated
    expect(doc.theme.isPopulated()).toBe(true)
    // Other children remain unpopulated
    expect(doc.title.isPopulated()).toBe(false)
  })

  it("never reverts to false after becoming true", () => {
    const doc = createDoc(TestSchema)
    change(doc, d => d.theme.set("dark"))
    expect(doc.theme.isPopulated()).toBe(true)

    // Another mutation doesn't change the boolean
    change(doc, d => d.theme.set("light"))
    expect(doc.theme.isPopulated()).toBe(true)
  })

  it("has [CHANGEFEED] for reactive detection", () => {
    const doc = createDoc(TestSchema)
    expect(hasChangefeed(doc.isPopulated)).toBe(true)
    expect(hasChangefeed(doc.title.isPopulated)).toBe(true)
  })

  it("changefeed fires on false → true transition", () => {
    const doc = createDoc(TestSchema)
    const events: boolean[] = []

    doc.theme.isPopulated[CHANGEFEED].subscribe(() => {
      events.push(doc.theme.isPopulated())
    })

    change(doc, d => d.theme.set("dark"))

    // Subscriber should have fired exactly once
    expect(events).toEqual([true])

    // Second mutation does NOT fire again (monotonic)
    change(doc, d => d.theme.set("light"))
    expect(events).toEqual([true])
  })

  it("works after importDelta (remote sync)", () => {
    const docA = createDoc(TestSchema)
    const docB = createDoc(TestSchema)

    expect(docB.theme.isPopulated()).toBe(false)

    // Mutate docA
    change(docA, d => d.theme.set("synced"))

    // Sync A → B
    const ops = delta(docA, 0)
    applyChanges(docB, ops, { origin: "sync" })

    expect(docB.theme.isPopulated()).toBe(true)
    expect(docB.theme()).toBe("synced")
  })
})
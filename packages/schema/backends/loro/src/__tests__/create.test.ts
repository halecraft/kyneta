import { LoroDoc } from "loro-crdt"
import { describe, expect, it } from "vitest"
import {
  change,
  createDoc,
  createLoroSubstrate,
  createRef,
  exportEntirety,
  exportSince,
  LoroVersion,
  loro,
  merge,
  Schema,
  subscribe,
  version,
} from "../index.js"

// ===========================================================================
// Shared test schema
// ===========================================================================

const TestSchema = Schema.struct({
  title: Schema.text(),
  count: Schema.counter(),
  items: Schema.list(
    Schema.struct.json({
      name: Schema.string(),
      done: Schema.boolean(),
    }),
  ),
  theme: Schema.string(),
})

const bound = loro.bind(TestSchema)

// ===========================================================================
// createDoc — fresh doc with seed
// ===========================================================================

describe("createDoc (fresh doc)", () => {
  it("creates a doc with default values", () => {
    const doc = createDoc(bound)
    expect(doc.title()).toBe("")
    expect(doc.count()).toBe(0)
    expect(doc.items.length).toBe(0)
  })

  it("creates a doc with seed values", () => {
    const doc = createDoc(bound)
    change(doc, (d: any) => {
      d.title.insert(0, "Hello")
      d.theme.set("dark")
    })
    expect(doc.title()).toBe("Hello")
    expect(doc.theme()).toBe("dark")
  })

  it("supports change() and subscribe()", () => {
    const doc = createDoc(bound)
    let fired = false
    subscribe(doc, () => {
      fired = true
    })

    change(doc, (d: any) => d.title.insert(0, "Hi"))
    expect(doc.title()).toBe("Hi")
    expect(fired).toBe(true)
  })

  it("supports counter increment", () => {
    const doc = createDoc(bound)
    change(doc, (d: any) => d.count.increment(5))
    expect(doc.count()).toBe(5)

    change(doc, (d: any) => d.count.increment(3))
    expect(doc.count()).toBe(8)
  })

  it("supports scalar set", () => {
    const doc = createDoc(bound)
    change(doc, (d: any) => d.theme.set("light"))
    expect(doc.theme()).toBe("light")

    change(doc, (d: any) => d.theme.set("dark"))
    expect(doc.theme()).toBe("dark")
  })

  it("supports list push with structured items", () => {
    const doc = createDoc(bound)

    change(doc, (d: any) => {
      d.items.push({ name: "Task 1", done: false })
    })

    expect(doc.items.length).toBe(1)
    expect((doc.items.at(0) as any).name()).toBe("Task 1")
    expect((doc.items.at(0) as any).done()).toBe(false)
  })

  it("supports seed with list items", () => {
    const doc = createDoc(bound)
    change(doc, (d: any) => d.items.push({ name: "A", done: false }))
    change(doc, (d: any) => d.items.push({ name: "B", done: true }))
    expect(doc.items.length).toBe(2)
    expect((doc.items.at(0) as any).name()).toBe("A")
    expect((doc.items.at(1) as any).done()).toBe(true)
  })
})

// ===========================================================================
// createRef — bring your own doc
// ===========================================================================

describe("createRef (bring your own doc)", () => {
  it("wraps an existing LoroDoc", () => {
    const loroDoc = new LoroDoc()
    loroDoc.getText("title").insert(0, "Existing")
    loroDoc.getCounter("count").increment(42)
    loroDoc.commit()

    const doc = createRef(TestSchema, createLoroSubstrate(loroDoc, TestSchema))
    expect(doc.title()).toBe("Existing")
    expect(doc.count()).toBe(42)
  })

  it("mutations on the wrapped doc are visible", () => {
    const loroDoc = new LoroDoc()
    loroDoc.getText("title")
    loroDoc.getCounter("count")
    loroDoc.getList("items")
    loroDoc.commit()

    const doc = createRef(TestSchema, createLoroSubstrate(loroDoc, TestSchema))
    change(doc, (d: any) => d.title.insert(0, "New"))
    expect(doc.title()).toBe("New")
  })

  it("external mutations fire kyneta subscribers", () => {
    const loroDoc = new LoroDoc()
    loroDoc.getText("title")
    loroDoc.getCounter("count")
    loroDoc.getList("items")
    loroDoc.commit()

    const doc = createRef(TestSchema, createLoroSubstrate(loroDoc, TestSchema))

    let fired = false
    subscribe(doc, () => {
      fired = true
    })

    // External mutation — bypasses kyneta change()
    loroDoc.getText("title").insert(0, "External")
    loroDoc.commit()

    expect(fired).toBe(true)
    expect(doc.title()).toBe("External")
  })

  it("external imports fire kyneta subscribers", () => {
    const loroDoc = new LoroDoc()
    loroDoc.getText("title")
    loroDoc.getCounter("count")
    loroDoc.getList("items")
    loroDoc.commit()

    const doc = createRef(TestSchema, createLoroSubstrate(loroDoc, TestSchema))

    let fired = false
    subscribe(doc, () => {
      fired = true
    })

    // Create a remote doc with changes
    const remoteDoc = new LoroDoc()
    remoteDoc.getText("title").insert(0, "Remote")
    remoteDoc.commit()
    const update = remoteDoc.export({ mode: "update" })

    // External import on the raw LoroDoc
    loroDoc.import(update)

    expect(fired).toBe(true)
    expect(doc.title()).toBe("Remote")
  })
})

// ===========================================================================
// createDoc with payload (replaces createLoroDocFromEntirety)
// ===========================================================================

describe("createDoc with payload (from entirety)", () => {
  it("reconstructs from a snapshot", () => {
    const docA = createDoc(bound)
    change(docA, (d: any) => {
      d.title.insert(0, "Original")
      d.theme.set("dark")
      d.count.increment(10)
    })

    const snapshot = exportEntirety(docA)
    const docB = createDoc(bound, snapshot)

    expect(docB.title()).toBe("Original")
    expect(docB.count()).toBe(10)
    expect(docB.theme()).toBe("dark")
  })

  it("reconstructed doc is fully functional", () => {
    const docA = createDoc(bound)
    change(docA, (d: any) => d.title.insert(0, "Source"))

    const snapshot = exportEntirety(docA)
    const docB = createDoc(bound, snapshot)

    change(docB, (d: any) => d.title.insert(6, "!"))
    expect(docB.title()).toBe("Source!")
  })
})

// ===========================================================================
// Sync primitives: version, exportEntirety, exportSince, merge
// ===========================================================================

describe("sync primitives", () => {
  it("version() returns a LoroVersion", () => {
    const doc = createDoc(bound)
    const v = version(doc)
    expect(v).toBeInstanceOf(LoroVersion)
  })

  it("version() advances after mutations", () => {
    const doc = createDoc(bound)
    const v0 = version(doc)

    change(doc, (d: any) => d.title.insert(0, "A"))
    const v1 = version(doc)

    expect(v0.compare(v1)).toBe("behind")
  })

  it("exportEntirety() returns a binary payload", () => {
    const doc = createDoc(bound)
    change(doc, (d: any) => d.title.insert(0, "Test"))
    const snap = exportEntirety(doc)
    expect(snap.encoding).toBe("binary")
    expect(snap.data).toBeInstanceOf(Uint8Array)
  })

  it("exportSince() + merge() syncs two docs", () => {
    const docA = createDoc(bound)
    const docB = createDoc(bound)

    const v0 = version(docB)

    change(docA, (d: any) => {
      d.title.insert(0, "Hello")
      d.count.increment(5)
    })

    const delta = exportSince(docA, v0)
    expect(delta).not.toBeNull()

    merge(docB, delta!, { origin: "sync" })

    expect(docB.title()).toBe("Hello")
    expect(docB.count()).toBe(5)
  })

  it("merge fires subscribers", () => {
    const docA = createDoc(bound)
    const docB = createDoc(bound)

    const v0 = version(docB)

    const received: unknown[] = []
    subscribe(docB, (cs: any) => received.push(cs))

    change(docA, (d: any) => d.title.insert(0, "Remote"))
    const delta = exportSince(docA, v0)!
    merge(docB, delta, { origin: "sync" })

    expect(received.length).toBeGreaterThanOrEqual(1)
  })

  it("version() throws on non-createDoc ref", () => {
    expect(() => version({} as any)).toThrow()
  })
})

// ===========================================================================
// Full workflow: the README example in test form
// ===========================================================================

describe("full workflow", () => {
  it("create → mutate → sync → observe (the README example)", () => {
    // Peer A creates a doc
    const docA = createDoc(bound)
    change(docA, (d: any) => d.title.insert(0, "Draft"))

    // Peer A mutates
    change(docA, (d: any) => {
      d.title.insert(5, " v1")
      d.count.increment(1)
      d.items.push({ name: "Task", done: false })
    })

    expect(docA.title()).toBe("Draft v1")
    expect(docA.count()).toBe(1)
    expect(docA.items.length).toBe(1)

    // Peer B starts fresh and syncs from A's snapshot
    const snapshot = exportEntirety(docA)
    const docB = createDoc(bound, snapshot)

    expect(docB.title()).toBe("Draft v1")
    expect(docB.count()).toBe(1)

    // Peer B subscribes
    const bChanges: number[] = []
    subscribe(docB, () => bChanges.push(1))

    // Peer A makes more changes
    change(docA, (d: any) => d.count.increment(9))

    // Sync A → B via delta
    const delta = exportSince(docA, version(docB))
    expect(delta).not.toBeNull()
    merge(docB, delta!, { origin: "sync" })

    // B observed the change
    expect(bChanges.length).toBeGreaterThanOrEqual(1)
    expect(docB.count()).toBe(10)

    // Both docs converge
    expect(docB.title()).toBe("Draft v1")
    expect(docB.count()).toBe(10)
  })
})

import { describe, expect, it, vi } from "vitest"
import * as Y from "yjs"
import { Schema, change, subscribe } from "@kyneta/schema"
import { createYjsDoc, createYjsDocFromSnapshot } from "../create.js"
import { version, exportSnapshot, exportSince, importDelta } from "../sync.js"
import { YjsVersion } from "../version.js"
import { populateRoot } from "../populate.js"
import { yjs } from "../yjs-escape.js"

// ===========================================================================
// Schemas used across tests
// ===========================================================================

const SimpleSchema = Schema.doc({
  title: Schema.annotated("text"),
  count: Schema.number(),
  items: Schema.list(Schema.string()),
})

const StructListSchema = Schema.doc({
  tasks: Schema.list(
    Schema.struct({
      name: Schema.string(),
      done: Schema.boolean(),
    }),
  ),
})

const NestedSchema = Schema.doc({
  title: Schema.annotated("text"),
  meta: Schema.struct({
    author: Schema.string(),
    tags: Schema.list(Schema.string()),
  }),
  labels: Schema.record(Schema.string()),
})

// ===========================================================================
// Tests
// ===========================================================================

describe("createYjsDoc", () => {
  // -------------------------------------------------------------------------
  // Default values
  // -------------------------------------------------------------------------

  describe("with defaults", () => {
    it("creates a doc with zero-value defaults", () => {
      const doc = createYjsDoc(SimpleSchema)
      expect(doc.title()).toBe("")
      expect(doc.count()).toBe(0)
      expect(doc.items()).toEqual([])
    })

    it("creates a doc with nested struct defaults", () => {
      const doc = createYjsDoc(NestedSchema)
      expect(doc.title()).toBe("")
      expect(doc.meta.author()).toBe("")
      expect(doc.meta.tags()).toEqual([])
      expect(doc.labels()).toEqual({})
    })

    it("creates a doc with struct list defaults", () => {
      const doc = createYjsDoc(StructListSchema)
      expect(doc.tasks()).toEqual([])
      expect(doc.tasks.length).toBe(0)
    })
  })

  // -------------------------------------------------------------------------
  // With seed values
  // -------------------------------------------------------------------------

  describe("with seeds", () => {
    it("creates a doc with scalar seed values", () => {
      const doc = createYjsDoc(SimpleSchema, {
        title: "Hello",
        count: 42,
        items: ["a", "b", "c"],
      })
      expect(doc.title()).toBe("Hello")
      expect(doc.count()).toBe(42)
      expect(doc.items()).toEqual(["a", "b", "c"])
    })

    it("creates a doc with partial seed (defaults fill gaps)", () => {
      const doc = createYjsDoc(SimpleSchema, { title: "Partial" })
      expect(doc.title()).toBe("Partial")
      expect(doc.count()).toBe(0)
      expect(doc.items()).toEqual([])
    })

    it("creates a doc with nested struct seed", () => {
      const doc = createYjsDoc(NestedSchema, {
        title: "Doc",
        meta: { author: "Alice", tags: ["draft"] },
        labels: { priority: "high" },
      })
      expect(doc.title()).toBe("Doc")
      expect(doc.meta.author()).toBe("Alice")
      expect(doc.meta.tags()).toEqual(["draft"])
      const labels = doc.labels() as Record<string, unknown>
      expect(labels.priority).toBe("high")
    })

    it("creates a doc with struct list seed items", () => {
      const doc = createYjsDoc(StructListSchema, {
        tasks: [
          { name: "Task 1", done: false },
          { name: "Task 2", done: true },
        ],
      })
      expect(doc.tasks.length).toBe(2)
      expect(doc.tasks.at(0)?.name()).toBe("Task 1")
      expect(doc.tasks.at(0)?.done()).toBe(false)
      expect(doc.tasks.at(1)?.name()).toBe("Task 2")
      expect(doc.tasks.at(1)?.done()).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // Bring your own Y.Doc
  // -------------------------------------------------------------------------

  describe("with existing Y.Doc", () => {
    it("wraps an existing Y.Doc", () => {
      const yjsDoc = new Y.Doc()
      populateRoot(yjsDoc, SimpleSchema, {
        title: "External",
        count: 99,
        items: ["x"],
      })

      const doc = createYjsDoc(SimpleSchema, yjsDoc)
      expect(doc.title()).toBe("External")
      expect(doc.count()).toBe(99)
      expect(doc.items()).toEqual(["x"])
    })

    it("mutations through kyneta change are visible on the Y.Doc", () => {
      const yjsDoc = new Y.Doc()
      populateRoot(yjsDoc, SimpleSchema)

      const doc = createYjsDoc(SimpleSchema, yjsDoc)
      change(doc, (d: any) => {
        d.title.insert(0, "Hello")
        d.count.set(42)
      })

      const rootMap = yjsDoc.getMap("root")
      expect((rootMap.get("title") as Y.Text).toJSON()).toBe("Hello")
      expect(rootMap.get("count")).toBe(42)
    })

    it("mutations through raw Yjs API are visible on the kyneta ref", () => {
      const yjsDoc = new Y.Doc()
      populateRoot(yjsDoc, SimpleSchema)

      const doc = createYjsDoc(SimpleSchema, yjsDoc)

      const rootMap = yjsDoc.getMap("root")
      rootMap.set("count", 77)

      expect(doc.count()).toBe(77)
    })

    it("yjs() escape hatch returns the same Y.Doc", () => {
      const yjsDoc = new Y.Doc()
      populateRoot(yjsDoc, SimpleSchema)

      const doc = createYjsDoc(SimpleSchema, yjsDoc)
      const escaped = yjs(doc)

      expect(escaped).toBe(yjsDoc)
    })
  })
})

// ===========================================================================
// createYjsDocFromSnapshot
// ===========================================================================

describe("createYjsDocFromSnapshot", () => {
  it("reconstructs state from a snapshot", () => {
    const doc1 = createYjsDoc(SimpleSchema, {
      title: "Snapshot",
      count: 42,
      items: ["a", "b"],
    })

    const payload = exportSnapshot(doc1)
    const doc2 = createYjsDocFromSnapshot(SimpleSchema, payload)

    expect(doc2.title()).toBe("Snapshot")
    expect(doc2.count()).toBe(42)
    expect(doc2.items()).toEqual(["a", "b"])
  })

  it("reconstructs state after mutations", () => {
    const doc1 = createYjsDoc(SimpleSchema, { title: "Start" })

    change(doc1, (d: any) => {
      d.title.insert(5, " End")
      d.count.set(99)
      d.items.push("x")
    })

    const payload = exportSnapshot(doc1)
    const doc2 = createYjsDocFromSnapshot(SimpleSchema, payload)

    expect(doc2.title()).toBe("Start End")
    expect(doc2.count()).toBe(99)
    expect(doc2.items()).toEqual(["x"])
  })

  it("reconstructs nested struct state from snapshot", () => {
    const doc1 = createYjsDoc(NestedSchema, {
      title: "Nested",
      meta: { author: "Alice", tags: ["v1", "v2"] },
      labels: { bug: "red" },
    })

    const payload = exportSnapshot(doc1)
    const doc2 = createYjsDocFromSnapshot(NestedSchema, payload)

    expect(doc2.title()).toBe("Nested")
    expect(doc2.meta.author()).toBe("Alice")
    expect(doc2.meta.tags()).toEqual(["v1", "v2"])
    const labels = doc2.labels() as Record<string, unknown>
    expect(labels.bug).toBe("red")
  })

  it("reconstructs struct list state from snapshot", () => {
    const doc1 = createYjsDoc(StructListSchema, {
      tasks: [
        { name: "Task A", done: false },
        { name: "Task B", done: true },
      ],
    })

    const payload = exportSnapshot(doc1)
    const doc2 = createYjsDocFromSnapshot(StructListSchema, payload)

    expect(doc2.tasks.length).toBe(2)
    expect((doc2.tasks.at(0) as any).name()).toBe("Task A")
    expect((doc2.tasks.at(1) as any).done()).toBe(true)
  })

  it("is writable after reconstruction", () => {
    const doc1 = createYjsDoc(SimpleSchema, { title: "Original" })
    const payload = exportSnapshot(doc1)
    const doc2 = createYjsDocFromSnapshot(SimpleSchema, payload)

    change(doc2, (d: any) => {
      d.title.insert(8, " Copy")
      d.count.set(7)
    })

    expect(doc2.title()).toBe("Original Copy")
    expect(doc2.count()).toBe(7)
  })

  it("is observable after reconstruction", () => {
    const doc1 = createYjsDoc(SimpleSchema, { title: "Original" })
    const payload = exportSnapshot(doc1)
    const doc2 = createYjsDocFromSnapshot(SimpleSchema, payload)

    const received: any[] = []
    subscribe(doc2, (changeset: any) => {
      received.push(changeset)
    })

    change(doc2, (d: any) => {
      d.count.set(42)
    })

    expect(received.length).toBeGreaterThanOrEqual(1)
  })
})

// ===========================================================================
// Sync primitives
// ===========================================================================

describe("sync primitives", () => {
  describe("version", () => {
    it("returns a YjsVersion", () => {
      const doc = createYjsDoc(SimpleSchema)
      const v = version(doc)
      expect(v).toBeInstanceOf(YjsVersion)
    })

    it("advances after mutations", () => {
      const doc = createYjsDoc(SimpleSchema)
      const v1 = version(doc)

      change(doc, (d: any) => {
        d.count.set(1)
      })
      const v2 = version(doc)

      expect(v1.compare(v2)).toBe("behind")
    })

    it("serialize/parse round-trips", () => {
      const doc = createYjsDoc(SimpleSchema, { title: "Test" })
      const v = version(doc)
      const serialized = v.serialize()
      const parsed = YjsVersion.parse(serialized)
      expect(parsed.compare(v)).toBe("equal")
    })
  })

  describe("exportSnapshot", () => {
    it("returns a binary payload", () => {
      const doc = createYjsDoc(SimpleSchema, { title: "Snap" })
      const payload = exportSnapshot(doc)
      expect(payload.encoding).toBe("binary")
      expect(payload.data).toBeInstanceOf(Uint8Array)
      expect((payload.data as Uint8Array).byteLength).toBeGreaterThan(0)
    })
  })

  describe("exportSince + importDelta", () => {
    it("syncs incremental changes between two docs", () => {
      const doc1 = createYjsDoc(SimpleSchema, { title: "Start" })
      const doc2 = createYjsDocFromSnapshot(SimpleSchema, exportSnapshot(doc1))

      const v2Before = version(doc2)

      // Mutate doc1
      change(doc1, (d: any) => {
        d.title.insert(5, " Edited")
        d.count.set(42)
        d.items.push("new-item")
      })

      // Export delta and apply to doc2
      const delta = exportSince(doc1, v2Before)
      expect(delta).not.toBeNull()
      expect(delta!.encoding).toBe("binary")

      importDelta(doc2, delta!)

      expect(doc2.title()).toBe("Start Edited")
      expect(doc2.count()).toBe(42)
      expect(doc2.items()).toEqual(["new-item"])
    })

    it("syncs multiple incremental deltas", () => {
      const doc1 = createYjsDoc(SimpleSchema)
      const doc2 = createYjsDocFromSnapshot(SimpleSchema, exportSnapshot(doc1))

      // First round
      let vBefore = version(doc2)
      change(doc1, (d: any) => {
        d.title.insert(0, "A")
      })
      importDelta(doc2, exportSince(doc1, vBefore)!)

      // Second round
      vBefore = version(doc2)
      change(doc1, (d: any) => {
        d.title.insert(1, "B")
      })
      importDelta(doc2, exportSince(doc1, vBefore)!)

      // Third round
      vBefore = version(doc2)
      change(doc1, (d: any) => {
        d.count.set(3)
      })
      importDelta(doc2, exportSince(doc1, vBefore)!)

      expect(doc2.title()).toBe("AB")
      expect(doc2.count()).toBe(3)
    })

    it("changefeed fires on importDelta", () => {
      const doc1 = createYjsDoc(SimpleSchema, { title: "Source" })
      const doc2 = createYjsDocFromSnapshot(SimpleSchema, exportSnapshot(doc1))

      const v2Before = version(doc2)

      change(doc1, (d: any) => {
        d.count.set(77)
      })

      const delta = exportSince(doc1, v2Before)

      const received: any[] = []
      subscribe(doc2, (changeset: any) => {
        received.push(changeset)
      })

      importDelta(doc2, delta!)

      expect(received.length).toBeGreaterThanOrEqual(1)
      expect(doc2.count()).toBe(77)
    })

    it("importDelta passes origin to changefeed", () => {
      const doc1 = createYjsDoc(SimpleSchema)
      const doc2 = createYjsDocFromSnapshot(SimpleSchema, exportSnapshot(doc1))

      const v2Before = version(doc2)
      change(doc1, (d: any) => {
        d.count.set(1)
      })

      const receivedOrigins: (string | undefined)[] = []
      subscribe(doc2, (changeset: any) => {
        receivedOrigins.push(changeset.origin)
      })

      importDelta(doc2, exportSince(doc1, v2Before)!, "my-sync-origin")

      expect(receivedOrigins).toContain("my-sync-origin")
    })
  })

  describe("versions equal after sync", () => {
    it("versions equal after full snapshot sync", () => {
      const doc1 = createYjsDoc(SimpleSchema, { title: "Same" })
      change(doc1, (d: any) => {
        d.count.set(42)
      })

      const doc2 = createYjsDocFromSnapshot(SimpleSchema, exportSnapshot(doc1))

      expect(version(doc1).compare(version(doc2))).toBe("equal")
    })

    it("versions equal after bidirectional delta sync", () => {
      const doc1 = createYjsDoc(SimpleSchema, { title: "" })
      const doc2 = createYjsDocFromSnapshot(SimpleSchema, exportSnapshot(doc1))

      const v1Before = version(doc1)
      const v2Before = version(doc2)

      // Independent mutations
      change(doc1, (d: any) => {
        d.title.insert(0, "A")
      })
      change(doc2, (d: any) => {
        d.count.set(7)
      })

      // Bidirectional sync
      const d1to2 = exportSince(doc1, v2Before)
      const d2to1 = exportSince(doc2, v1Before)
      importDelta(doc2, d1to2!)
      importDelta(doc1, d2to1!)

      expect(version(doc1).compare(version(doc2))).toBe("equal")
    })
  })
})

// ===========================================================================
// Full workflow
// ===========================================================================

describe("full workflow", () => {
  it("create → mutate → sync → observe", () => {
    // 1. Create two docs
    const doc1 = createYjsDoc(StructListSchema)
    const doc2 = createYjsDocFromSnapshot(
      StructListSchema,
      exportSnapshot(doc1),
    )

    // 2. Set up observer on doc2
    const changes: any[] = []
    subscribe(doc2, (changeset: any) => {
      changes.push(changeset)
    })

    // 3. Mutate doc1
    const vBefore = version(doc2)

    change(doc1, (d: any) => {
      d.tasks.push({ name: "Buy milk", done: false })
    })

    change(doc1, (d: any) => {
      d.tasks.push({ name: "Walk dog", done: false })
    })

    // 4. Sync doc1 → doc2
    const delta = exportSince(doc1, vBefore)
    importDelta(doc2, delta!)

    // 5. Verify state converged
    expect(doc2.tasks.length).toBe(2)
    expect((doc2.tasks.at(0) as any).name()).toBe("Buy milk")
    expect((doc2.tasks.at(1) as any).name()).toBe("Walk dog")

    // 6. Verify observer was called
    expect(changes.length).toBeGreaterThan(0)

    // 7. Verify versions match
    expect(version(doc1).compare(version(doc2))).toBe("equal")

    // 8. Mutate doc2 and sync back
    const v1Before = version(doc1)

    change(doc2, (d: any) => {
      d.tasks.push({ name: "Read book", done: false })
    })

    const delta2 = exportSince(doc2, v1Before)
    importDelta(doc1, delta2!)

    expect(doc1.tasks.length).toBe(3)
    expect((doc1.tasks.at(2) as any).name()).toBe("Read book")
    expect(version(doc1).compare(version(doc2))).toBe("equal")
  })

  it("create → mutate → snapshot → reconstruct → continue", () => {
    // 1. Create and mutate
    const doc1 = createYjsDoc(SimpleSchema, { title: "Start" })
    change(doc1, (d: any) => {
      d.title.insert(5, " Middle")
      d.count.set(10)
      d.items.push("first")
    })

    // 2. Snapshot
    const snapshot = exportSnapshot(doc1)

    // 3. Reconstruct
    const doc2 = createYjsDocFromSnapshot(SimpleSchema, snapshot)
    expect(doc2.title()).toBe("Start Middle")
    expect(doc2.count()).toBe(10)
    expect(doc2.items()).toEqual(["first"])

    // 4. Continue mutating the reconstructed doc
    change(doc2, (d: any) => {
      d.title.insert(12, " End")
      d.count.set(20)
      d.items.push("second")
    })

    expect(doc2.title()).toBe("Start Middle End")
    expect(doc2.count()).toBe(20)
    expect(doc2.items()).toEqual(["first", "second"])

    // 5. Version should be ahead of the snapshot version
    const snapshotVersion = version(doc1)
    const currentVersion = version(doc2)
    // doc2 has additional mutations beyond doc1
    expect(snapshotVersion.compare(currentVersion)).toBe("behind")
  })

  it("concurrent edits converge correctly", () => {
    // 1. Create two peers from the same initial state
    const doc1 = createYjsDoc(SimpleSchema, { title: "", count: 0 })
    const doc2 = createYjsDocFromSnapshot(SimpleSchema, exportSnapshot(doc1))

    const v1Before = version(doc1)
    const v2Before = version(doc2)

    // 2. Both peers edit concurrently
    change(doc1, (d: any) => {
      d.title.insert(0, "Peer1")
      d.items.push("from-1")
    })
    change(doc2, (d: any) => {
      d.count.set(42)
      d.items.push("from-2")
    })

    // 3. Versions are concurrent
    expect(version(doc1).compare(version(doc2))).toBe("concurrent")

    // 4. Bidirectional sync
    const d1to2 = exportSince(doc1, v2Before)
    const d2to1 = exportSince(doc2, v1Before)
    importDelta(doc2, d1to2!)
    importDelta(doc1, d2to1!)

    // 5. Versions converge
    expect(version(doc1).compare(version(doc2))).toBe("equal")

    // 6. Both docs have all the data
    expect(doc1.title()).toContain("Peer1")
    expect(doc2.title()).toContain("Peer1")
    expect(doc1.count()).toBe(42)
    expect(doc2.count()).toBe(42)

    // Both items should be present (order determined by Yjs conflict resolution)
    const items1 = doc1.items() as string[]
    const items2 = doc2.items() as string[]
    expect(items1.sort()).toEqual(["from-1", "from-2"])
    expect(items2.sort()).toEqual(["from-1", "from-2"])
  })
})

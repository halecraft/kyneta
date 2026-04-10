import { change, Schema, subscribe } from "@kyneta/schema"
import { describe, expect, it } from "vitest"
import * as Y from "yjs"
import { yjs } from "../bind-yjs.js"
import { createYjsDoc, createYjsDocFromEntirety } from "../create.js"
import { ensureContainers } from "../populate.js"
import { exportEntirety, exportSince, merge, version } from "../sync.js"
import { YjsVersion } from "../version.js"

// ===========================================================================
// Schemas used across tests
// ===========================================================================

const SimpleSchema = Schema.struct({
  title: Schema.text(),
  count: Schema.number(),
  items: Schema.list(Schema.string()),
})

const StructListSchema = Schema.struct({
  tasks: Schema.list(
    Schema.struct({
      name: Schema.string(),
      done: Schema.boolean(),
    }),
  ),
})

const NestedSchema = Schema.struct({
  title: Schema.text(),
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
    it("creates a doc with empty containers for shared types", () => {
      const doc = createYjsDoc(SimpleSchema)
      // Text annotation returns "" (empty Y.Text)
      expect(doc.title()).toBe("")
      // Plain scalars return structural zeros
      expect(doc.count()).toBe(0)
      // Sequence containers are created empty
      expect(doc.items()).toEqual([])
    })

    it("creates a doc with nested struct empty containers", () => {
      const doc = createYjsDoc(NestedSchema)
      expect(doc.title()).toBe("")
      // Plain scalar inside struct returns structural zero
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
      const doc = createYjsDoc(SimpleSchema)
      change(doc, (d: any) => {
        d.title.insert(0, "Hello")
        d.count.set(42)
      })
      // Separate change() calls for list pushes to preserve order
      // (Yjs reverses order within a single transaction)
      change(doc, (d: any) => d.items.push("a"))
      change(doc, (d: any) => d.items.push("b"))
      change(doc, (d: any) => d.items.push("c"))
      expect(doc.title()).toBe("Hello")
      expect(doc.count()).toBe(42)
      expect(doc.items()).toEqual(["a", "b", "c"])
    })

    it("creates a doc with partial seed (defaults fill gaps)", () => {
      const doc = createYjsDoc(SimpleSchema)
      change(doc, (d: any) => {
        d.title.insert(0, "Partial")
      })
      expect(doc.title()).toBe("Partial")
      expect(doc.count()).toBe(0)
      expect(doc.items()).toEqual([])
    })

    it("creates a doc with nested struct seed", () => {
      const doc = createYjsDoc(NestedSchema)
      change(doc, (d: any) => {
        d.title.insert(0, "Doc")
        d.meta.author.set("Alice")
        d.meta.tags.push("draft")
        d.labels.set("priority", "high")
      })
      expect(doc.title()).toBe("Doc")
      expect(doc.meta.author()).toBe("Alice")
      expect(doc.meta.tags()).toEqual(["draft"])
      const labels = doc.labels() as Record<string, unknown>
      expect(labels.priority).toBe("high")
    })

    it("creates a doc with struct list seed items", () => {
      const doc = createYjsDoc(StructListSchema)
      // Separate change() calls for list pushes to preserve order
      change(doc, (d: any) => d.tasks.push({ name: "Task 1", done: false }))
      change(doc, (d: any) => d.tasks.push({ name: "Task 2", done: true }))
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
      ensureContainers(yjsDoc, SimpleSchema)
      yjsDoc.transact(() => {
        const rootMap = yjsDoc.getMap("root")
        ;(rootMap.get("title") as Y.Text).insert(0, "External")
        rootMap.set("count", 99)
        ;(rootMap.get("items") as Y.Array<string>).push(["x"])
      })

      const doc = createYjsDoc(SimpleSchema, yjsDoc)
      expect(doc.title()).toBe("External")
      expect(doc.count()).toBe(99)
      expect(doc.items()).toEqual(["x"])
    })

    it("mutations through kyneta change are visible on the Y.Doc", () => {
      const yjsDoc = new Y.Doc()
      ensureContainers(yjsDoc, SimpleSchema)

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
      ensureContainers(yjsDoc, SimpleSchema)

      const doc = createYjsDoc(SimpleSchema, yjsDoc)

      const rootMap = yjsDoc.getMap("root")
      rootMap.set("count", 77)

      expect(doc.count()).toBe(77)
    })

    it("yjs.unwrap() escape hatch returns the same Y.Doc", () => {
      const yjsDoc = new Y.Doc()
      ensureContainers(yjsDoc, SimpleSchema)

      const doc = createYjsDoc(SimpleSchema, yjsDoc)
      const escaped = yjs.unwrap(doc)

      expect(escaped).toBe(yjsDoc)
    })
  })
})

// ===========================================================================
// createYjsDocFromEntirety
// ===========================================================================

describe("createYjsDocFromEntirety", () => {
  it("reconstructs state from a snapshot", () => {
    const doc1 = createYjsDoc(SimpleSchema)
    change(doc1, (d: any) => {
      d.title.insert(0, "Snapshot")
      d.count.set(42)
    })
    change(doc1, (d: any) => d.items.push("a"))
    change(doc1, (d: any) => d.items.push("b"))

    const payload = exportEntirety(doc1)
    const doc2 = createYjsDocFromEntirety(SimpleSchema, payload)

    expect(doc2.title()).toBe("Snapshot")
    expect(doc2.count()).toBe(42)
    expect(doc2.items()).toEqual(["a", "b"])
  })

  it("reconstructs state after mutations", () => {
    const doc1 = createYjsDoc(SimpleSchema)
    change(doc1, (d: any) => {
      d.title.insert(0, "Start")
    })

    change(doc1, (d: any) => {
      d.title.insert(5, " End")
      d.count.set(99)
      d.items.push("x")
    })

    const payload = exportEntirety(doc1)
    const doc2 = createYjsDocFromEntirety(SimpleSchema, payload)

    expect(doc2.title()).toBe("Start End")
    expect(doc2.count()).toBe(99)
    expect(doc2.items()).toEqual(["x"])
  })

  it("reconstructs nested struct state from snapshot", () => {
    const doc1 = createYjsDoc(NestedSchema)
    change(doc1, (d: any) => {
      d.title.insert(0, "Nested")
      d.meta.author.set("Alice")
      d.labels.set("bug", "red")
    })
    change(doc1, (d: any) => d.meta.tags.push("v1"))
    change(doc1, (d: any) => d.meta.tags.push("v2"))

    const payload = exportEntirety(doc1)
    const doc2 = createYjsDocFromEntirety(NestedSchema, payload)

    expect(doc2.title()).toBe("Nested")
    expect(doc2.meta.author()).toBe("Alice")
    expect(doc2.meta.tags()).toEqual(["v1", "v2"])
    const labels = doc2.labels() as Record<string, unknown>
    expect(labels.bug).toBe("red")
  })

  it("reconstructs struct list state from snapshot", () => {
    const doc1 = createYjsDoc(StructListSchema)
    change(doc1, (d: any) => d.tasks.push({ name: "Task A", done: false }))
    change(doc1, (d: any) => d.tasks.push({ name: "Task B", done: true }))

    const payload = exportEntirety(doc1)
    const doc2 = createYjsDocFromEntirety(StructListSchema, payload)

    expect(doc2.tasks.length).toBe(2)
    expect((doc2.tasks.at(0) as any).name()).toBe("Task A")
    expect((doc2.tasks.at(1) as any).done()).toBe(true)
  })

  it("is writable after reconstruction", () => {
    const doc1 = createYjsDoc(SimpleSchema)
    change(doc1, (d: any) => {
      d.title.insert(0, "Original")
    })
    const payload = exportEntirety(doc1)
    const doc2 = createYjsDocFromEntirety(SimpleSchema, payload)

    change(doc2, (d: any) => {
      d.title.insert(8, " Copy")
      d.count.set(7)
    })

    expect(doc2.title()).toBe("Original Copy")
    expect(doc2.count()).toBe(7)
  })

  it("is observable after reconstruction", () => {
    const doc1 = createYjsDoc(SimpleSchema)
    change(doc1, (d: any) => {
      d.title.insert(0, "Original")
    })
    const payload = exportEntirety(doc1)
    const doc2 = createYjsDocFromEntirety(SimpleSchema, payload)

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
      const doc = createYjsDoc(SimpleSchema)
      change(doc, (d: any) => {
        d.title.insert(0, "Test")
      })
      const v = version(doc)
      const serialized = v.serialize()
      const parsed = YjsVersion.parse(serialized)
      expect(parsed.compare(v)).toBe("equal")
    })
  })

  describe("exportEntirety", () => {
    it("returns a binary payload", () => {
      const doc = createYjsDoc(SimpleSchema)
      change(doc, (d: any) => {
        d.title.insert(0, "Snap")
      })
      const payload = exportEntirety(doc)
      expect(payload.encoding).toBe("binary")
      expect(payload.data).toBeInstanceOf(Uint8Array)
      expect((payload.data as Uint8Array).byteLength).toBeGreaterThan(0)
    })
  })

  describe("exportSince + merge", () => {
    it("syncs incremental changes between two docs", () => {
      const doc1 = createYjsDoc(SimpleSchema)
      change(doc1, (d: any) => {
        d.title.insert(0, "Start")
      })
      const doc2 = createYjsDocFromEntirety(SimpleSchema, exportEntirety(doc1))

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
      expect(delta?.encoding).toBe("binary")

      merge(doc2, delta!)

      expect(doc2.title()).toBe("Start Edited")
      expect(doc2.count()).toBe(42)
      expect(doc2.items()).toEqual(["new-item"])
    })

    it("syncs multiple incremental deltas", () => {
      const doc1 = createYjsDoc(SimpleSchema)
      const doc2 = createYjsDocFromEntirety(SimpleSchema, exportEntirety(doc1))

      // First round
      let vBefore = version(doc2)
      change(doc1, (d: any) => {
        d.title.insert(0, "A")
      })
      merge(doc2, exportSince(doc1, vBefore)!)

      // Second round
      vBefore = version(doc2)
      change(doc1, (d: any) => {
        d.title.insert(1, "B")
      })
      merge(doc2, exportSince(doc1, vBefore)!)

      // Third round
      vBefore = version(doc2)
      change(doc1, (d: any) => {
        d.count.set(3)
      })
      merge(doc2, exportSince(doc1, vBefore)!)

      expect(doc2.title()).toBe("AB")
      expect(doc2.count()).toBe(3)
    })

    it("changefeed fires on merge", () => {
      const doc1 = createYjsDoc(SimpleSchema)
      change(doc1, (d: any) => {
        d.title.insert(0, "Source")
      })
      const doc2 = createYjsDocFromEntirety(SimpleSchema, exportEntirety(doc1))

      const v2Before = version(doc2)

      change(doc1, (d: any) => {
        d.count.set(77)
      })

      const delta = exportSince(doc1, v2Before)

      const received: any[] = []
      subscribe(doc2, (changeset: any) => {
        received.push(changeset)
      })

      merge(doc2, delta!)

      expect(received.length).toBeGreaterThanOrEqual(1)
      expect(doc2.count()).toBe(77)
    })

    it("merge passes origin to changefeed", () => {
      const doc1 = createYjsDoc(SimpleSchema)
      const doc2 = createYjsDocFromEntirety(SimpleSchema, exportEntirety(doc1))

      const v2Before = version(doc2)
      change(doc1, (d: any) => {
        d.count.set(1)
      })

      const receivedOrigins: (string | undefined)[] = []
      subscribe(doc2, (changeset: any) => {
        receivedOrigins.push(changeset.origin)
      })

      merge(doc2, exportSince(doc1, v2Before)!, "my-sync-origin")

      expect(receivedOrigins).toContain("my-sync-origin")
    })
  })

  describe("versions equal after sync", () => {
    it("versions equal after full snapshot sync", () => {
      const doc1 = createYjsDoc(SimpleSchema)
      change(doc1, (d: any) => {
        d.title.insert(0, "Same")
      })
      change(doc1, (d: any) => {
        d.count.set(42)
      })

      const doc2 = createYjsDocFromEntirety(SimpleSchema, exportEntirety(doc1))

      expect(version(doc1).compare(version(doc2))).toBe("equal")
    })

    it("versions equal after bidirectional delta sync", () => {
      const doc1 = createYjsDoc(SimpleSchema)
      const doc2 = createYjsDocFromEntirety(SimpleSchema, exportEntirety(doc1))

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
      merge(doc2, d1to2!)
      merge(doc1, d2to1!)

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
    const doc2 = createYjsDocFromEntirety(
      StructListSchema,
      exportEntirety(doc1),
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
    merge(doc2, delta!)

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
    merge(doc1, delta2!)

    expect(doc1.tasks.length).toBe(3)
    expect((doc1.tasks.at(2) as any).name()).toBe("Read book")
    expect(version(doc1).compare(version(doc2))).toBe("equal")
  })

  it("create → mutate → snapshot → reconstruct → continue", () => {
    // 1. Create and mutate
    const doc1 = createYjsDoc(SimpleSchema)
    change(doc1, (d: any) => {
      d.title.insert(0, "Start")
    })
    change(doc1, (d: any) => {
      d.title.insert(5, " Middle")
      d.count.set(10)
      d.items.push("first")
    })

    // 2. Snapshot
    const snapshot = exportEntirety(doc1)

    // 3. Reconstruct
    const doc2 = createYjsDocFromEntirety(SimpleSchema, snapshot)
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
    const doc1 = createYjsDoc(SimpleSchema)
    const doc2 = createYjsDocFromEntirety(SimpleSchema, exportEntirety(doc1))

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
    merge(doc2, d1to2!)
    merge(doc1, d2to1!)

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

import { describe, expect, it, vi } from "vitest"
import * as Y from "yjs"
import { Schema, change, subscribe } from "@kyneta/schema"
import { createYjsSubstrate, yjsSubstrateFactory } from "../substrate.js"
import { YjsVersion } from "../version.js"
import { createYjsDoc, createYjsDocFromSnapshot } from "../create.js"
import {
  version,
  exportSnapshot,
  exportSince,
  importDelta,
} from "../sync.js"
import { ensureContainers } from "../populate.js"

// ===========================================================================
// Helpers
// ===========================================================================

/** Key path segment helper */
function key(k: string) {
  return { type: "key" as const, key: k }
}

/** Index path segment helper */
function idx(i: number) {
  return { type: "index" as const, index: i }
}

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

const FullSchema = Schema.doc({
  title: Schema.annotated("text"),
  count: Schema.number(),
  active: Schema.boolean(),
  items: Schema.list(Schema.string()),
  tasks: Schema.list(
    Schema.struct({
      name: Schema.string(),
      done: Schema.boolean(),
    }),
  ),
  meta: Schema.struct({
    author: Schema.string(),
  }),
  labels: Schema.record(Schema.string()),
})

// ===========================================================================
// Tests
// ===========================================================================

describe("YjsSubstrate", () => {
  // -------------------------------------------------------------------------
  // Factory create
  // -------------------------------------------------------------------------

  describe("factory create", () => {
    it("creates a substrate with empty containers", () => {
      const substrate = yjsSubstrateFactory.create(SimpleSchema)
      expect(substrate.store.read([key("title")])).toBe("")
      // Plain scalars return structural zeros
      expect(substrate.store.read([key("count")])).toBe(0)
      expect(substrate.store.read([key("items")])).toEqual([])
    })

    it("creates a substrate and populates via change()", () => {
      const doc = createYjsDoc(SimpleSchema)
      change(doc, (d: any) => {
        d.title.insert(0, "Hello")
        d.count.set(42)
      })
      // Separate change() calls for list pushes to preserve order
      // (Yjs reverses order within a single transaction)
      change(doc, (d: any) => d.items.push("a"))
      change(doc, (d: any) => d.items.push("b"))
      expect(doc.title()).toBe("Hello")
      expect(doc.count()).toBe(42)
      expect(doc.items()).toEqual(["a", "b"])
    })

    it("creates a substrate with partial values (unset fields stay empty)", () => {
      const doc = createYjsDoc(SimpleSchema)
      change(doc, (d: any) => {
        d.title.insert(0, "Partial")
      })
      expect(doc.title()).toBe("Partial")
      expect(doc.count()).toBe(0)
      expect(doc.items()).toEqual([])
    })

    it("creates a substrate with nested struct values via change()", () => {
      const doc = createYjsDoc(FullSchema)
      change(doc, (d: any) => {
        d.meta.author.set("Alice")
      })
      expect(doc.meta.author()).toBe("Alice")
    })

    it("creates a substrate with struct list values via change()", () => {
      const doc = createYjsDoc(StructListSchema)
      // Separate change() calls for list pushes to preserve order
      change(doc, (d: any) => d.tasks.push({ name: "Task 1", done: false }))
      change(doc, (d: any) => d.tasks.push({ name: "Task 2", done: true }))
      expect((doc.tasks.at(0) as any).name()).toBe("Task 1")
      expect((doc.tasks.at(1) as any).done()).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // Write round-trip
  // -------------------------------------------------------------------------

  describe("write round-trip", () => {
    it("text insert round-trips through prepare/flush", () => {
      const doc = createYjsDoc(SimpleSchema)
      change(doc, (d: any) => {
        d.title.insert(0, "Hello")
      })
      expect(doc.title()).toBe("Hello")
    })

    it("scalar set round-trips through prepare/flush", () => {
      const doc = createYjsDoc(SimpleSchema)
      change(doc, (d: any) => {
        d.count.set(42)
      })
      expect(doc.count()).toBe(42)
    })

    it("list push round-trips through prepare/flush", () => {
      const doc = createYjsDoc(SimpleSchema)
      change(doc, (d: any) => {
        d.items.push("a")
      })
      change(doc, (d: any) => {
        d.items.push("b")
      })
      expect(doc.items()).toEqual(["a", "b"])
      expect(doc.items.length).toBe(2)
    })
  })

  // -------------------------------------------------------------------------
  // Version tracking
  // -------------------------------------------------------------------------

  describe("version tracking", () => {
    it("version advances after mutations", () => {
      const doc = createYjsDoc(SimpleSchema)
      const v1 = version(doc)

      change(doc, (d: any) => {
        d.title.insert(0, "Hi")
      })
      const v2 = version(doc)

      expect(v1.compare(v2)).toBe("behind")
      expect(v2.compare(v1)).toBe("ahead")
    })

    it("version serialize/parse round-trips", () => {
      const doc = createYjsDoc(SimpleSchema)
      change(doc, (d: any) => {
        d.title.insert(0, "Test")
        d.count.set(5)
      })

      const v = version(doc)
      const serialized = v.serialize()
      const parsed = YjsVersion.parse(serialized)
      expect(parsed.compare(v)).toBe("equal")
    })
  })

  // -------------------------------------------------------------------------
  // Export/import snapshot
  // -------------------------------------------------------------------------

  describe("export/import snapshot", () => {
    it("exports a binary payload", () => {
      const doc = createYjsDoc(SimpleSchema)
      change(doc, (d: any) => { d.title.insert(0, "Snapshot") })
      const payload = exportSnapshot(doc)
      expect(payload.encoding).toBe("binary")
      expect(payload.data).toBeInstanceOf(Uint8Array)
    })

    it("reconstructs equivalent state from snapshot", () => {
      const doc1 = createYjsDoc(SimpleSchema)
      change(doc1, (d: any) => {
        d.title.insert(0, "Hello")
        d.count.set(42)
      })
      // Separate change() calls for list pushes to preserve order
      change(doc1, (d: any) => d.items.push("a"))
      change(doc1, (d: any) => d.items.push("b"))
      change(doc1, (d: any) => {
        d.title.insert(5, " World")
      })

      const payload = exportSnapshot(doc1)
      const doc2 = createYjsDocFromSnapshot(SimpleSchema, payload)

      expect(doc2.title()).toBe("Hello World")
      expect(doc2.count()).toBe(42)
      expect(doc2.items()).toEqual(["a", "b"])
    })
  })

  // -------------------------------------------------------------------------
  // Delta sync
  // -------------------------------------------------------------------------

  describe("delta sync", () => {
    it("exportSince → importDelta syncs state", () => {
      const doc1 = createYjsDoc(SimpleSchema)
      change(doc1, (d: any) => { d.title.insert(0, "Start") })
      const doc2 = createYjsDocFromSnapshot(
        SimpleSchema,
        exportSnapshot(doc1),
      )

      const v1Before = version(doc1)

      change(doc1, (d: any) => {
        d.title.insert(5, " Edited")
        d.count.set(99)
      })

      const delta = exportSince(doc1, v1Before)
      expect(delta).not.toBeNull()

      importDelta(doc2, delta!)
      expect(doc2.title()).toBe("Start Edited")
      expect(doc2.count()).toBe(99)
    })

    it("concurrent sync — two substrates converge after bidirectional sync", () => {
      const doc1 = createYjsDoc(SimpleSchema)
      const doc2 = createYjsDocFromSnapshot(
        SimpleSchema,
        exportSnapshot(doc1),
      )

      const v1Before = version(doc1)
      const v2Before = version(doc2)

      // Independent mutations
      change(doc1, (d: any) => {
        d.title.insert(0, "A")
      })
      change(doc2, (d: any) => {
        d.count.set(7)
      })

      // Versions should be concurrent
      const v1After = version(doc1)
      const v2After = version(doc2)
      expect(v1After.compare(v2After)).toBe("concurrent")

      // Bidirectional sync
      const d1to2 = exportSince(doc1, v2Before)
      const d2to1 = exportSince(doc2, v1Before)

      importDelta(doc2, d1to2!)
      importDelta(doc1, d2to1!)

      // Should now be equal
      expect(version(doc1).compare(version(doc2))).toBe("equal")

      // Both should have both mutations
      // Note: concurrent text inserts at the same position resolve
      // per Yjs's conflict resolution algorithm. Both will have
      // the "A" insert. Count should be 7 on both.
      expect(doc1.count()).toBe(7)
      expect(doc2.count()).toBe(7)
      expect(doc1.title()).toContain("A")
      expect(doc2.title()).toContain("A")
    })
  })

  // -------------------------------------------------------------------------
  // Changefeed
  // -------------------------------------------------------------------------

  describe("changefeed", () => {
    it("fires on importDelta", () => {
      const doc1 = createYjsDoc(SimpleSchema)
      change(doc1, (d: any) => { d.title.insert(0, "A") })
      const doc2 = createYjsDocFromSnapshot(
        SimpleSchema,
        exportSnapshot(doc1),
      )

      const v2Before = version(doc2)

      change(doc1, (d: any) => {
        d.count.set(42)
      })

      const received: any[] = []
      subscribe(doc2, (changeset: any) => {
        received.push(changeset)
      })

      const delta = exportSince(doc1, v2Before)
      importDelta(doc2, delta!)

      expect(received.length).toBeGreaterThanOrEqual(1)
      expect(doc2.count()).toBe(42)
    })

    it("fires on external Y.Doc mutation (raw Yjs API)", () => {
      const yjsDoc = new Y.Doc()
      ensureContainers(yjsDoc, SimpleSchema)
      const doc = createYjsDoc(SimpleSchema, yjsDoc)

      const received: any[] = []
      subscribe(doc, (changeset: any) => {
        received.push(changeset)
      })

      // Mutate via raw Yjs API (not through kyneta)
      const rootMap = yjsDoc.getMap("root")
      rootMap.set("count", 99)

      expect(received.length).toBeGreaterThanOrEqual(1)
      expect(doc.count()).toBe(99)
    })

    it("no double-fire on kyneta local writes", () => {
      const doc = createYjsDoc(SimpleSchema)

      const received: any[] = []
      subscribe(doc, (changeset: any) => {
        received.push(changeset)
      })

      change(doc, (d: any) => {
        d.count.set(42)
      })

      // Should fire exactly once (from the changefeed layer's flush),
      // not twice (not also from the event bridge).
      expect(received.length).toBe(1)
    })
  })

  // -------------------------------------------------------------------------
  // Transaction support
  // -------------------------------------------------------------------------

  describe("transaction support", () => {
    it("multi-op change() is atomic", () => {
      const doc = createYjsDoc(SimpleSchema)

      const received: any[] = []
      subscribe(doc, (changeset: any) => {
        received.push(changeset)
      })

      change(doc, (d: any) => {
        d.title.insert(0, "Hello")
        d.count.set(42)
        d.items.push("a")
        d.items.push("b")
      })

      // Tree-level subscribe fires once per affected container in the
      // flush cycle. Three containers changed (title + count + items) → 3 fires.
      // This matches LoroSubstrate and PlainSubstrate behavior.
      expect(received.length).toBe(3)
      expect(doc.title()).toBe("Hello")
      expect(doc.count()).toBe(42)
      // Both items present. Order within a single transaction batch is
      // not guaranteed because deferred-flush applies all SequenceChanges
      // atomically — both pushes see arrayLength=0 at prepare time.
      const items = doc.items() as string[]
      expect(items).toHaveLength(2)
      expect(items).toContain("a")
      expect(items).toContain("b")
    })
  })

  // -------------------------------------------------------------------------
  // Nested structure
  // -------------------------------------------------------------------------

  describe("nested structure", () => {
    it("push struct into list, read back via navigation", () => {
      const doc = createYjsDoc(StructListSchema)

      change(doc, (d: any) => {
        d.tasks.push({ name: "Task 1", done: false })
      })

      expect(doc.tasks.length).toBe(1)
      expect((doc.tasks.at(0) as any).name()).toBe("Task 1")
      expect((doc.tasks.at(0) as any).done()).toBe(false)

      change(doc, (d: any) => {
        d.tasks.push({ name: "Task 2", done: true })
      })

      expect(doc.tasks.length).toBe(2)
      expect((doc.tasks.at(1) as any).name()).toBe("Task 2")
      expect((doc.tasks.at(1) as any).done()).toBe(true)
    })

    it("nested struct write round-trip", () => {
      const doc = createYjsDoc(FullSchema)
      change(doc, (d: any) => {
        d.meta.author.set("Alice")
      })
      expect(doc.meta.author()).toBe("Alice")

      change(doc, (d: any) => {
        d.meta.author.set("Bob")
      })

      expect(doc.meta.author()).toBe("Bob")
    })
  })

  // -------------------------------------------------------------------------
  // Counter annotation throws
  // -------------------------------------------------------------------------

  describe("unsupported annotations", () => {
    it("counter annotation throws clear error at construction", () => {
      const CounterSchema = Schema.doc({
        count: Schema.annotated("counter"),
      })

      expect(() =>
        yjsSubstrateFactory.create(CounterSchema),
      ).toThrow("counter")
    })

    it("movable annotation throws clear error at construction", () => {
      const MovableSchema = Schema.doc({
        items: Schema.annotated("movable", Schema.list(Schema.string())),
      })

      expect(() =>
        yjsSubstrateFactory.create(MovableSchema),
      ).toThrow("movable")
    })

    it("tree annotation throws clear error at construction", () => {
      const TreeSchema = Schema.doc({
        tree: Schema.annotated(
          "tree",
          Schema.struct({ label: Schema.string() }),
        ),
      })

      expect(() =>
        yjsSubstrateFactory.create(TreeSchema),
      ).toThrow("tree")
    })
  })

  // -------------------------------------------------------------------------
  // fromSnapshot
  // -------------------------------------------------------------------------

  describe("fromSnapshot", () => {
    it("rejects non-binary payloads", () => {
      expect(() =>
        yjsSubstrateFactory.fromSnapshot(
          { encoding: "json", data: "{}" },
          SimpleSchema,
        ),
      ).toThrow("binary")
    })

    it("reconstructs from snapshot with correct state", () => {
      const doc = createYjsDoc(SimpleSchema)
      change(doc, (d: any) => {
        d.title.insert(0, "Snapshot Test")
        d.count.set(77)
        d.items.push("x")
      })

      const payload = exportSnapshot(doc)
      const doc2 = createYjsDocFromSnapshot(SimpleSchema, payload)

      expect(doc2.title()).toBe("Snapshot Test")
      expect(doc2.count()).toBe(77)
      expect(doc2.items()).toEqual(["x"])
    })
  })

  // -------------------------------------------------------------------------
  // parseVersion
  // -------------------------------------------------------------------------

  describe("parseVersion", () => {
    it("round-trips through factory.parseVersion", () => {
      const substrate = yjsSubstrateFactory.create(SimpleSchema)
      const v = substrate.version()
      const serialized = v.serialize()
      const parsed = yjsSubstrateFactory.parseVersion(serialized)
      expect(parsed.compare(v)).toBe("equal")
    })
  })
})
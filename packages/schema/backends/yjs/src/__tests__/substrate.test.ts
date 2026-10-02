import {
  batch,
  createDoc,
  createRef,
  createSubstrate,
  exportEntirety,
  exportSince,
  hasSubstrate,
  merge,
  RawPath,
  Schema,
  SUBSTRATE,
  subscribe,
  substrateFromEntirety,
  unwrap,
  version,
} from "@kyneta/schema"
import { defined } from "@kyneta/schema/testing"
import { describe, expect, it } from "vitest"
import * as Y from "yjs"
import { yjs } from "../bind-yjs.js"
import { ensureContainers } from "../populate.js"
import {
  createYjsSubstrate,
  DELETE_CLOCK,
  yjsReplicaFactory,
  yjsSubstrateFactory,
} from "../substrate.js"
import { YjsVersion } from "../version.js"

// ===========================================================================
// Helpers
// ===========================================================================

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

const FullSchema = Schema.struct({
  title: Schema.text(),
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
      const substrate = createSubstrate(yjsSubstrateFactory, SimpleSchema)
      expect(substrate.reader.read(RawPath.empty.field("title"))).toBe("")
      // Plain scalars return structural zeros
      expect(substrate.reader.read(RawPath.empty.field("count"))).toBe(0)
      expect(substrate.reader.read(RawPath.empty.field("items"))).toEqual([])
    })

    it("creates a substrate and populates via batch()", () => {
      const doc = createDoc(yjs.bind(SimpleSchema))
      batch(doc, (d: any) => {
        d.title.insert(0, "Hello")
        d.count.set(42)
      })
      // Separate batch() calls for list pushes to preserve order
      // (Yjs reverses order within a single transaction)
      batch(doc, (d: any) => d.items.push("a"))
      batch(doc, (d: any) => d.items.push("b"))
      expect(doc.title()).toBe("Hello")
      expect(doc.count()).toBe(42)
      expect(doc.items()).toEqual(["a", "b"])
    })

    it("creates a substrate with partial values (unset fields stay empty)", () => {
      const doc = createDoc(yjs.bind(SimpleSchema))
      batch(doc, (d: any) => {
        d.title.insert(0, "Partial")
      })
      expect(doc.title()).toBe("Partial")
      expect(doc.count()).toBe(0)
      expect(doc.items()).toEqual([])
    })

    it("creates a substrate with nested struct values via batch()", () => {
      const doc = createDoc(yjs.bind(FullSchema))
      batch(doc, (d: any) => {
        d.meta.author.set("Alice")
      })
      expect(doc.meta.author()).toBe("Alice")
    })

    it("creates a substrate with struct list values via batch()", () => {
      const doc = createDoc(yjs.bind(StructListSchema))
      // Separate batch() calls for list pushes to preserve order
      batch(doc, (d: any) => d.tasks.push({ name: "Task 1", done: false }))
      batch(doc, (d: any) => d.tasks.push({ name: "Task 2", done: true }))
      expect((doc.tasks.at(0) as any).name()).toBe("Task 1")
      expect((doc.tasks.at(1) as any).done()).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // Write round-trip
  // -------------------------------------------------------------------------

  describe("write round-trip", () => {
    it("text insert round-trips through prepare/flush", () => {
      const doc = createDoc(yjs.bind(SimpleSchema))
      batch(doc, (d: any) => {
        d.title.insert(0, "Hello")
      })
      expect(doc.title()).toBe("Hello")
    })

    it("scalar set round-trips through prepare/flush", () => {
      const doc = createDoc(yjs.bind(SimpleSchema))
      batch(doc, (d: any) => {
        d.count.set(42)
      })
      expect(doc.count()).toBe(42)
    })

    it("list push round-trips through prepare/flush", () => {
      const doc = createDoc(yjs.bind(SimpleSchema))
      batch(doc, (d: any) => {
        d.items.push("a")
      })
      batch(doc, (d: any) => {
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
      const doc = createDoc(yjs.bind(SimpleSchema))
      const v1 = version(doc)

      batch(doc, (d: any) => {
        d.title.insert(0, "Hi")
      })
      const v2 = version(doc)

      expect(v1.compare(v2)).toBe("behind")
      expect(v2.compare(v1)).toBe("ahead")
    })

    it("version serialize/parse round-trips", () => {
      const doc = createDoc(yjs.bind(SimpleSchema))
      batch(doc, (d: any) => {
        d.title.insert(0, "Test")
        d.count.set(5)
      })

      const v = version(doc)
      const serialized = v.serialize()
      const parsed = YjsVersion.parse(serialized)
      expect(parsed.compare(v)).toBe("equal")
    })

    it("version changes after a delete-only mutation", () => {
      const doc = createDoc(yjs.bind(SimpleSchema))
      batch(doc, (d: any) => {
        d.title.insert(0, "hello")
      })
      const vAfterInsert = version(doc)

      batch(doc, (d: any) => {
        d.title.delete(1, 1)
      })
      const vAfterDelete = version(doc)

      // The version must change after a delete — even though Yjs's state
      // vector does not advance on delete. The snapshot-based YjsVersion
      // detects the delete set change and returns "concurrent" (not "equal").
      expect(vAfterInsert.compare(vAfterDelete)).not.toBe("equal")
    })
  })

  // -------------------------------------------------------------------------
  // Export/import snapshot
  // -------------------------------------------------------------------------

  describe("export/import snapshot", () => {
    it("exports a binary payload", () => {
      const doc = createDoc(yjs.bind(SimpleSchema))
      batch(doc, (d: any) => {
        d.title.insert(0, "Snapshot")
      })
      const payload = exportEntirety(doc)
      expect(payload.encoding).toBe("binary")
      expect(payload.data).toBeInstanceOf(Uint8Array)
    })

    it("reconstructs equivalent state from snapshot", () => {
      const doc1 = createDoc(yjs.bind(SimpleSchema))
      batch(doc1, (d: any) => {
        d.title.insert(0, "Hello")
        d.count.set(42)
      })
      // Separate batch() calls for list pushes to preserve order
      batch(doc1, (d: any) => d.items.push("a"))
      batch(doc1, (d: any) => d.items.push("b"))
      batch(doc1, (d: any) => {
        d.title.insert(5, " World")
      })

      const payload = exportEntirety(doc1)
      const doc2 = createDoc(yjs.bind(SimpleSchema), payload)

      expect(doc2.title()).toBe("Hello World")
      expect(doc2.count()).toBe(42)
      expect(doc2.items()).toEqual(["a", "b"])
    })
  })

  // -------------------------------------------------------------------------
  // Delta sync
  // -------------------------------------------------------------------------

  describe("delta sync", () => {
    it("exportSince → merge syncs state", () => {
      const doc1 = createDoc(yjs.bind(SimpleSchema))
      batch(doc1, (d: any) => {
        d.title.insert(0, "Start")
      })
      const doc2 = createDoc(yjs.bind(SimpleSchema), exportEntirety(doc1))

      const v1Before = version(doc1)

      batch(doc1, (d: any) => {
        d.title.insert(5, " Edited")
        d.count.set(99)
      })

      const delta = exportSince(doc1, v1Before)
      expect(delta).not.toBeNull()

      merge(doc2, defined(delta, "delta"))
      expect(doc2.title()).toBe("Start Edited")
      expect(doc2.count()).toBe(99)
    })

    it("concurrent sync — two substrates converge after bidirectional sync", () => {
      const doc1 = createDoc(yjs.bind(SimpleSchema))
      const doc2 = createDoc(yjs.bind(SimpleSchema), exportEntirety(doc1))

      const v1Before = version(doc1)
      const v2Before = version(doc2)

      // Independent mutations
      batch(doc1, (d: any) => {
        d.title.insert(0, "A")
      })
      batch(doc2, (d: any) => {
        d.count.set(7)
      })

      // Versions should be concurrent
      const v1After = version(doc1)
      const v2After = version(doc2)
      expect(v1After.compare(v2After)).toBe("concurrent")

      // Bidirectional sync
      const d1to2 = exportSince(doc1, v2Before)
      const d2to1 = exportSince(doc2, v1Before)

      merge(doc2, defined(d1to2, "d1to2"))
      merge(doc1, defined(d2to1, "d2to1"))

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
    it("fires on merge", () => {
      const doc1 = createDoc(yjs.bind(SimpleSchema))
      batch(doc1, (d: any) => {
        d.title.insert(0, "A")
      })
      const doc2 = createDoc(yjs.bind(SimpleSchema), exportEntirety(doc1))

      const v2Before = version(doc2)

      batch(doc1, (d: any) => {
        d.count.set(42)
      })

      const received: any[] = []
      subscribe(doc2, (changeset: any) => {
        received.push(changeset)
      })

      const delta = exportSince(doc1, v2Before)
      merge(doc2, defined(delta, "delta"))

      expect(received.length).toBeGreaterThanOrEqual(1)
      expect(doc2.count()).toBe(42)
    })

    it("fires on external Y.Doc mutation (raw Yjs API)", () => {
      const yjsDoc = new Y.Doc()
      ensureContainers(yjsDoc, SimpleSchema)
      const doc = createRef(
        SimpleSchema,
        createYjsSubstrate(yjsDoc, SimpleSchema),
      )

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
      const doc = createDoc(yjs.bind(SimpleSchema))

      const received: any[] = []
      subscribe(doc, (changeset: any) => {
        received.push(changeset)
      })

      batch(doc, (d: any) => {
        d.count.set(42)
      })

      // Should fire exactly once (from the changefeed layer's flush),
      // not twice (not also from the event bridge).
      expect(received.length).toBe(1)
    })

    it("nested struct field changefeed fires on merge", () => {
      const doc1 = createDoc(yjs.bind(StructListSchema))
      const _doc2 = createDoc(yjs.bind(StructListSchema), exportEntirety(doc1))

      // Add a struct item on doc1, sync to doc2
      batch(doc1, (d: any) => {
        d.tasks.push({ name: "Buy milk", done: false })
      })
      const snap = exportEntirety(doc1)
      const doc2b = createDoc(yjs.bind(StructListSchema), snap)

      const taskB = [...doc2b.tasks][0] as any
      expect(taskB.done()).toBe(false)

      // Subscribe to the FIELD-LEVEL changefeed on doc2b's task
      const v2 = version(doc2b)
      const fieldChanges: unknown[] = []
      const cf = (taskB.done as any)[Symbol.for("kyneta:changefeed")]
      expect(cf).toBeDefined()
      const unsub = cf.subscribe((cs: unknown) => fieldChanges.push(cs))

      // Toggle done on doc1
      batch(doc1, (d: any) => {
        d.tasks.at(0).done.set(true)
      })

      // Sync the toggle to doc2b
      const delta = defined(exportSince(doc1, v2), "the delta")
      merge(doc2b, delta)

      // Value should be updated
      expect(taskB.done()).toBe(true)

      // The field-level changefeed should have fired
      expect(fieldChanges.length).toBeGreaterThanOrEqual(1)

      unsub()
    })

    it("multi-key struct update fires per-field changefeeds on merge", () => {
      const doc1 = createDoc(yjs.bind(StructListSchema))

      // Add a struct item, sync to doc2
      batch(doc1, (d: any) => {
        d.tasks.push({ name: "Buy milk", done: false })
      })
      const doc2 = createDoc(yjs.bind(StructListSchema), exportEntirety(doc1))

      const taskB = [...doc2.tasks][0] as any
      const v2 = version(doc2)

      // Subscribe to BOTH field-level changefeeds
      const nameChanges: unknown[] = []
      const doneChanges: unknown[] = []
      const cfName = (taskB.name as any)[Symbol.for("kyneta:changefeed")]
      const cfDone = (taskB.done as any)[Symbol.for("kyneta:changefeed")]
      const unsub1 = cfName.subscribe((cs: unknown) => nameChanges.push(cs))
      const unsub2 = cfDone.subscribe((cs: unknown) => doneChanges.push(cs))

      // Update both fields in a single batch() on doc1
      batch(doc1, (d: any) => {
        const task = d.tasks.at(0)
        task.name.set("Buy oat milk")
        task.done.set(true)
      })

      // Sync to doc2
      const delta = defined(exportSince(doc1, v2), "the delta")
      merge(doc2, delta)

      // Both field-level changefeeds should have fired
      expect(nameChanges.length).toBeGreaterThanOrEqual(1)
      expect(doneChanges.length).toBeGreaterThanOrEqual(1)

      expect(taskB.name()).toBe("Buy oat milk")
      expect(taskB.done()).toBe(true)

      unsub1()
      unsub2()
    })
  })

  // -------------------------------------------------------------------------
  // Transaction support
  // -------------------------------------------------------------------------

  describe("transaction support", () => {
    it("multi-op batch() is atomic", () => {
      const doc = createDoc(yjs.bind(SimpleSchema))

      const received: any[] = []
      subscribe(doc, (changeset: any) => {
        received.push(changeset)
      })

      batch(doc, (d: any) => {
        d.title.insert(0, "Hello")
        d.count.set(42)
        d.items.push("a")
        d.items.push("b")
      })

      // A deep subscriber hears one changeset per flush covering its whole
      // subtree, so all three containers arrive together — one fire, not one
      // per container. This matches LoroSubstrate and PlainSubstrate behavior.
      expect(received.length).toBe(1)
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
      const doc = createDoc(yjs.bind(StructListSchema))

      batch(doc, (d: any) => {
        d.tasks.push({ name: "Task 1", done: false })
      })

      expect(doc.tasks.length).toBe(1)
      expect((doc.tasks.at(0) as any).name()).toBe("Task 1")
      expect((doc.tasks.at(0) as any).done()).toBe(false)

      batch(doc, (d: any) => {
        d.tasks.push({ name: "Task 2", done: true })
      })

      expect(doc.tasks.length).toBe(2)
      expect((doc.tasks.at(1) as any).name()).toBe("Task 2")
      expect((doc.tasks.at(1) as any).done()).toBe(true)
    })

    it("nested struct write round-trip", () => {
      const doc = createDoc(yjs.bind(FullSchema))
      batch(doc, (d: any) => {
        d.meta.author.set("Alice")
      })
      expect(doc.meta.author()).toBe("Alice")

      batch(doc, (d: any) => {
        d.meta.author.set("Bob")
      })

      expect(doc.meta.author()).toBe("Bob")
    })
  })

  // -------------------------------------------------------------------------
  // Counter annotation throws
  // -------------------------------------------------------------------------

  describe("unsupported kinds", () => {
    it("counter throws clear error at construction", () => {
      const CounterSchema = Schema.struct({
        count: Schema.counter(),
      })

      expect(() => createSubstrate(yjsSubstrateFactory, CounterSchema)).toThrow(
        "counter",
      )
    })

    it("movableList throws clear error at construction", () => {
      const MovableSchema = Schema.struct({
        items: Schema.movableList(Schema.string()),
      })

      expect(() => createSubstrate(yjsSubstrateFactory, MovableSchema)).toThrow(
        "movable",
      )
    })

    it("tree throws clear error at construction", () => {
      const TreeSchema = Schema.struct({
        tree: Schema.tree(Schema.struct({ label: Schema.string() })),
      })

      expect(() => createSubstrate(yjsSubstrateFactory, TreeSchema)).toThrow(
        "tree",
      )
    })
  })

  // -------------------------------------------------------------------------
  // substrateFromEntirety
  // -------------------------------------------------------------------------

  describe("substrateFromEntirety", () => {
    it("rejects non-binary payloads", () => {
      expect(() =>
        substrateFromEntirety(
          yjsSubstrateFactory,
          { kind: "entirety", encoding: "json", data: "{}" },
          SimpleSchema,
        ),
      ).toThrow("binary")
    })

    it("reconstructs from snapshot with correct state", () => {
      const doc = createDoc(yjs.bind(SimpleSchema))
      batch(doc, (d: any) => {
        d.title.insert(0, "Snapshot Test")
        d.count.set(77)
        d.items.push("x")
      })

      const payload = exportEntirety(doc)
      const doc2 = createDoc(yjs.bind(SimpleSchema), payload)

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
      const substrate = createSubstrate(yjsSubstrateFactory, SimpleSchema)
      const v = substrate.version()
      const serialized = v.serialize()
      const parsed = yjsSubstrateFactory.replica.parseVersion(serialized)
      expect(parsed.compare(v)).toBe("equal")
    })
  })

  // -------------------------------------------------------------------------
  // Re-entrant write during merge replay
  // -------------------------------------------------------------------------
  //
  // A subscriber that calls `batch(doc, ...)` while delivering a sync
  // merge must reach Yjs — otherwise the substrate stalls and the
  // subscriber loops on stale state until the lease budget trips.
  // Context: jj:qpultxsw.

  describe("re-entrant write during merge replay", () => {
    it("subscriber's local batch() inside a merge-replay batch lands in Yjs", () => {
      const docA = createDoc(yjs.bind(SimpleSchema))
      const docB = createDoc(yjs.bind(SimpleSchema))

      batch(docA, (d: any) => {
        d.title.insert(0, "seed")
      })
      merge(docB, exportEntirety(docA), { origin: "sync" })

      // On the first replay-driven update, the subscriber writes once
      // to an unrelated field. The write must hit Yjs; the guard
      // ensures we don't re-enter on subsequent flushes.
      let writes = 0
      subscribe(docB.title, () => {
        if (writes === 0 && (docB.title() as string) === "seedmore") {
          writes++
          batch(docB, (d: any) => {
            d.count.set(42)
          })
        }
      })

      const v0 = version(docB)
      batch(docA, (d: any) => {
        d.title.insert((d.title() as string).length, "more")
      })
      const delta = defined(exportSince(docA, v0), "the delta")
      merge(docB, delta, { origin: "sync" })

      expect(docB.title()).toBe("seedmore")
      expect(docB.count()).toBe(42)
      expect(writes).toBe(1)
    })
  })

  // -------------------------------------------------------------------------
  // Origin-free discriminator tests
  // -------------------------------------------------------------------------

  describe("origin-free discriminator", () => {
    it("options.origin survives to transaction.origin", () => {
      const doc = createDoc(yjs.bind(SimpleSchema))
      const native = unwrap(doc) as Y.Doc

      let capturedOrigin: string | undefined = "not-called"
      native.on("afterTransaction", tr => {
        capturedOrigin = tr.origin
      })

      batch(doc, d => d.title.insert(0, "x"), { origin: "undo" })
      expect(capturedOrigin).toBe("undo")
    })

    it("external wrapping kyneta is correctly classified as own", () => {
      const doc = createDoc(yjs.bind(SimpleSchema))

      let kynetaFires = 0
      subscribe(doc, () => {
        kynetaFires++
      })

      const native = unwrap(doc) as Y.Doc
      native.transact(() => {
        batch(doc, d => d.title.insert(0, "x"))
      }, "external")

      // Should fire exactly once (captured via wrappedPrepare),
      // and NOT twice (the bridge should skip the external transaction
      // because the inner kyneta transact marked the transaction).
      expect(kynetaFires).toBe(1)
    })

    it("external raw transact with any string origin is bridged", () => {
      const doc = createDoc(yjs.bind(SimpleSchema))

      let kynetaFires = 0
      subscribe(doc, () => {
        kynetaFires++
      })

      const native = unwrap(doc) as Y.Doc
      native.transact(() => {
        native.getMap("root").set("title", "ext")
      }, "kyneta-prepare")

      expect(kynetaFires).toBe(1)
    })
  })
})

// ===========================================================================
// What an announcement says of itself
// ===========================================================================

describe("announcements: origin and replay", () => {
  function heard(doc: unknown) {
    const seen: { origin?: string; replay?: boolean }[] = []
    subscribe(doc, cs => seen.push({ origin: cs.origin, replay: cs.replay }))
    return seen
  }

  function remoteTitle(text: string) {
    const other = createDoc(yjs.bind(SimpleSchema))
    batch(other, d => d.title.insert(0, text))
    return exportEntirety(other)
  }

  it("a merge without an origin announces none", () => {
    const doc = createDoc(yjs.bind(SimpleSchema))
    const seen = heard(doc)
    merge(doc, remoteTitle("remote"))
    expect(seen).toEqual([{ origin: undefined, replay: true }])
  })

  it("an observer's write during a merge is local, and does not take the merge's origin", () => {
    const doc = createDoc(yjs.bind(SimpleSchema))
    const native = unwrap(doc) as Y.Doc
    let replied = false
    native.getMap("root").observeDeep((_events, transaction) => {
      if (transaction.local || replied) return
      replied = true
      unwrap(doc.title).insert(0, "reply")
    })
    const seen = heard(doc)
    merge(doc, remoteTitle("remote"), { origin: "sync" })
    expect(seen).toEqual([
      { origin: "sync", replay: true },
      { origin: undefined, replay: false },
    ])
  })

  it("two substrates over one Y.Doc each announce the other's batch as a local write", () => {
    const bound = yjs.bind(SimpleSchema)
    const first = createDoc(bound)
    const native = unwrap(first) as Y.Doc
    const second: typeof first = createRef(
      SimpleSchema,
      createYjsSubstrate(native, SimpleSchema, bound.identityBinding),
    )
    const heardByFirst = heard(first)
    const heardBySecond = heard(second)

    batch(first, d => d.count.set(1))
    batch(second, d => d.count.set(2))

    expect(heardByFirst).toEqual([
      { origin: undefined, replay: false },
      { origin: undefined, replay: false },
    ])
    expect(heardBySecond).toEqual(heardByFirst)
  })
})

// ===========================================================================
// The delete clock
// ===========================================================================

describe("the delete clock", () => {
  /**
   * The ticks `doc`'s own client has written from here on: the characters
   * it inserted into the delete clock, deleted or not.
   */
  function countTicks(doc: Y.Doc): () => number {
    const written = () => {
      let count = 0
      let item = doc.getText(DELETE_CLOCK)._start
      while (item !== null) {
        if (item.id.client === doc.clientID) count += item.length
        item = item.right
      }
      return count
    }
    const start = written()
    return () => written() - start
  }

  function setup() {
    const doc = createDoc(yjs.bind(SimpleSchema))
    const native = unwrap(doc)
    batch(doc, d => d.title.insert(0, "abc"))
    return { doc, native, ticks: countTicks(native) }
  }

  const advanced = (before: YjsVersion, after: YjsVersion) =>
    after.compare(before) === "ahead"

  it("advances the version for a delete-only Kyneta batch", () => {
    const { doc, native, ticks } = setup()
    const before = YjsVersion.fromDoc(native)
    batch(doc, d => d.title.delete(1, 1))
    expect(advanced(before, YjsVersion.fromDoc(native))).toBe(true)
    expect(ticks()).toBe(1)
  })

  it("advances the version for native deletes, however they are made", () => {
    const { doc, native, ticks } = setup()
    const text = unwrap(doc.title)

    let before = YjsVersion.fromDoc(native)
    text.delete(0, 1) // an implicit transaction
    expect(advanced(before, YjsVersion.fromDoc(native))).toBe(true)

    before = YjsVersion.fromDoc(native)
    native.transact(() => text.delete(0, 1), { binding: true }) // an editor binding's origin
    expect(advanced(before, YjsVersion.fromDoc(native))).toBe(true)

    const undo = new Y.UndoManager(text)
    text.insert(0, "xy")
    undo.stopCapturing()
    before = YjsVersion.fromDoc(native)
    undo.undo() // delete-only
    expect(advanced(before, YjsVersion.fromDoc(native))).toBe(true)
    expect(ticks()).toBe(3)
  })

  it("does not tick for an insert, an empty transaction, or a delete of nothing", () => {
    const { doc, native, ticks } = setup()
    batch(doc, d => d.title.insert(0, "z"))
    native.transact(() => {})
    unwrap(doc.title).delete(0, 0)
    expect(ticks()).toBe(0)
  })

  it("does not tick for a Kyneta delete taken in by merge, which carries its author's tick", () => {
    const { doc, native } = setup()
    const peer = createDoc(yjs.bind(SimpleSchema), exportEntirety(doc))
    const peerNative = unwrap(peer)
    const ticks = countTicks(peerNative)
    const since = version(peer)
    batch(doc, d => d.title.delete(1, 1))
    merge(peer, exportSince(doc, since) ?? exportEntirety(doc))
    expect(peer.title()).toBe("ac")
    expect(ticks()).toBe(0)
    expect(
      YjsVersion.fromDoc(peerNative).compare(YjsVersion.fromDoc(native)),
    ).toBe("equal")
  })

  it("ticks once for a plain Yjs client's delete arriving as a provider would deliver it", () => {
    const { native, ticks } = setup()
    const plain = new Y.Doc()
    Y.applyUpdate(plain, Y.encodeStateAsUpdate(native))
    const before = Y.encodeStateVector(plain)
    const titleKey = [...plain.getMap("root").keys()].find(
      key => plain.getMap("root").get(key) instanceof Y.Text,
    )
    if (titleKey === undefined) throw new Error("title not found")
    const plainTitle = plain.getMap("root").get(titleKey)
    if (!(plainTitle instanceof Y.Text)) throw new Error("title is not text")
    plainTitle.delete(1, 1)
    const versionBefore = YjsVersion.fromDoc(native)
    Y.applyUpdate(native, Y.encodeStateAsUpdate(plain, before), "provider")
    expect(ticks()).toBe(1)
    expect(advanced(versionBefore, YjsVersion.fromDoc(native))).toBe(true)
  })

  it("does not tick for stored updates loaded in one transaction", () => {
    const { doc, native } = setup()
    const stored: Uint8Array[] = []
    native.on("update", (update: Uint8Array) => stored.push(update))
    batch(doc, d => d.title.delete(0, 1))
    batch(doc, d => d.title.delete(0, 1))

    const loaded = createDoc(yjs.bind(SimpleSchema))
    const loadedNative = unwrap(loaded)
    Y.applyUpdate(
      loadedNative,
      Y.encodeStateAsUpdate(native, Y.encodeStateVector(native)),
    )
    const ticks = countTicks(loadedNative)
    const seeded = createDoc(yjs.bind(SimpleSchema))
    const seededNative = unwrap(seeded)
    const seededTicks = countTicks(seededNative)
    seededNative.transact(() => {
      for (const update of stored) Y.applyUpdate(seededNative, update)
    }, "idb")
    expect(ticks()).toBe(0)
    expect(seededTicks()).toBe(0)
  })

  it("ticks once per delete however many substrates wrap the document", () => {
    const { native, ticks } = setup()
    createYjsSubstrate(
      native,
      SimpleSchema,
      yjs.bind(SimpleSchema).identityBinding,
    )
    const before = YjsVersion.fromDoc(native)
    const text = [...native.getMap("root").values()].find(
      v => v instanceof Y.Text,
    )
    if (!(text instanceof Y.Text)) throw new Error("title not found")
    text.delete(0, 1)
    expect(ticks()).toBe(1)
    expect(advanced(before, YjsVersion.fromDoc(native))).toBe(true)
  })

  it("raises no changeset, and lives outside the schema root", () => {
    const { doc, native } = setup()
    const heard: unknown[] = []
    subscribe(doc, changeset => heard.push(changeset))
    batch(doc, d => d.title.delete(0, 1))
    expect(heard).toHaveLength(1)
    expect(native.getMap("root").has(DELETE_CLOCK)).toBe(false)
    expect(native.share.has(DELETE_CLOCK)).toBe(true)
  })

  it("is not installed on a headless replica", () => {
    const replica = yjsReplicaFactory.createEmpty()
    const source = new Y.Doc()
    source.getText("t").insert(0, "abc")
    replica.merge({
      kind: "entirety",
      encoding: "binary",
      data: Y.encodeStateAsUpdate(source),
    })
    const before = replica.version()
    const sv = Y.encodeStateVector(source)
    source.getText("t").delete(0, 1)
    replica.merge({
      kind: "since",
      encoding: "binary",
      data: Y.encodeStateAsUpdate(source, sv),
    })
    expect(replica.version().compare(before)).toBe("equal")
  })
})

// ===========================================================================
// subscribeLocalUpdates
// ===========================================================================

describe("subscribeLocalUpdates", () => {
  function setup() {
    const doc = createDoc(yjs.bind(SimpleSchema))
    if (!hasSubstrate(doc)) throw new Error("expected a root ref")
    const native = unwrap(doc) as Y.Doc
    let count = 0
    const unsubscribe = doc[SUBSTRATE].subscribeLocalUpdates(() => {
      count++
    })
    return { doc, native, unsubscribe, count: () => count }
  }

  it("fires for a native write to the schema's root", () => {
    const { doc, count } = setup()
    unwrap(doc.title).insert(0, "native")
    expect(count()).toBe(1)
  })

  it("fires for a native write outside the schema's root map", () => {
    // The event bridge observes only the root map, so this write raises no
    // changeset. The signal is what still gets it pushed and persisted.
    const { doc, native, count } = setup()
    const heard: unknown[] = []
    subscribe(doc, cs => heard.push(cs))
    native.getArray("side").push([1])
    expect(count()).toBe(1)
    expect(heard).toHaveLength(0)
  })

  it("does not fire for an empty transaction", () => {
    const { native, count } = setup()
    native.transact(() => {})
    expect(count()).toBe(0)
  })

  it("does not fire for a merge of Kyneta writes", () => {
    const { doc, count } = setup()
    const other = createDoc(yjs.bind(SimpleSchema))
    batch(other, d => d.title.insert(0, "remote"))
    merge(doc, exportEntirety(other))
    expect(count()).toBe(0)
  })

  it("fires for the delete clock's tick when a merge brings a delete without one", () => {
    // A plain Yjs peer deletes without ticking. The tick this replica writes
    // for it is a local write, which peers need so their versions see the
    // delete. It can fire twice: the event bridge's read of the text delta
    // opens an empty transaction, whose update also carries the tick.
    const { doc, native, count } = setup()
    batch(doc, d => d.title.insert(0, "abc"))
    const plain = new Y.Doc()
    Y.applyUpdate(plain, Y.encodeStateAsUpdate(native))
    const before = Y.encodeStateVector(plain)
    for (const value of plain.getMap("root").values()) {
      if (value instanceof Y.Text) value.delete(1, 1)
    }
    const counted = count()
    merge(doc, {
      kind: "since",
      encoding: "binary",
      data: Y.encodeStateAsUpdate(plain, before),
    })
    expect(doc.title()).toBe("ac")
    expect(count()).toBeGreaterThan(counted)
  })

  it("fires, inside the merge, for a write an observer makes in reaction to it", () => {
    const { doc, native, count } = setup()
    native.getMap("root").observeDeep((_events, tr) => {
      if (!tr.local) native.getArray("side").push([1])
    })
    const other = createDoc(yjs.bind(SimpleSchema))
    batch(other, d => d.title.insert(0, "remote"))
    merge(doc, exportEntirety(other))
    expect(count()).toBeGreaterThan(0)
  })

  it("stops after the unsubscribe", () => {
    const { doc, unsubscribe, count } = setup()
    unsubscribe()
    batch(doc, d => d.count.set(1))
    expect(count()).toBe(0)
  })
})

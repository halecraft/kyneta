import type { Substrate, SubstratePayload } from "@kyneta/schema"
import {
  change,
  interpret,
  observation,
  RawPath,
  type Ref,
  readable,
  Schema,
  type SchemaNode,
  subscribe,
  writable,
} from "@kyneta/schema"
import { LoroDoc } from "loro-crdt"
import { describe, expect, it } from "vitest"
import {
  createLoroSubstrate,
  LoroVersion,
  loroSubstrateFactory,
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
  peers: Schema.record(Schema.boolean()),
})

// ===========================================================================
// Helpers
// ===========================================================================

// Generic call signature defers Ref<S> expansion to each call site where
// S is a concrete literal type, avoiding TS2589 on the abstract SchemaNode.
type InterpretSubstrate = <S extends SchemaNode>(
  schema: S,
  substrate: Substrate<LoroVersion>,
) => Ref<S>

const interpretSubstrate: InterpretSubstrate = (schema, substrate) =>
  interpret(schema, substrate.context())
    .with(readable)
    .with(writable)
    .with(observation)
    .done()

// ===========================================================================
// Factory create
// ===========================================================================

describe("loroSubstrateFactory.create", () => {
  it("creates a substrate with default values", () => {
    const substrate = loroSubstrateFactory.create(TestSchema)
    const reader = substrate.reader

    // Text defaults to empty string
    expect(reader.read(RawPath.empty.field("title"))).toBe("")
    // Counter defaults to 0
    expect(reader.read(RawPath.empty.field("count"))).toBe(0)
    // List defaults to empty
    expect(reader.arrayLength(RawPath.empty.field("items"))).toBe(0)
  })

  it("creates a substrate with seed values", () => {
    const substrate = loroSubstrateFactory.create(TestSchema)
    const doc = interpretSubstrate(TestSchema, substrate)
    change(doc, d => {
      d.title.insert(0, "Hello")
      d.theme.set("dark")
    })
    const reader = substrate.reader

    expect(reader.read(RawPath.empty.field("title"))).toBe("Hello")
    expect(reader.read(RawPath.empty.field("theme"))).toBe("dark")
  })

  it("creates a substrate with seed list items", () => {
    const substrate = loroSubstrateFactory.create(TestSchema)
    const doc = interpretSubstrate(TestSchema, substrate)
    change(doc, d => {
      d.items.push({ name: "Task 1", done: false })
    })
    change(doc, d => {
      d.items.push({ name: "Task 2", done: true })
    })
    const reader = substrate.reader

    expect(reader.arrayLength(RawPath.empty.field("items"))).toBe(2)
    expect(
      reader.read(RawPath.empty.field("items").item(0).field("name")),
    ).toBe("Task 1")
    expect(
      reader.read(RawPath.empty.field("items").item(1).field("done")),
    ).toBe(true)
  })
})

// ===========================================================================
// Write round-trip
// ===========================================================================

describe("write round-trip", () => {
  it("text insert via change() is readable", () => {
    const substrate = loroSubstrateFactory.create(TestSchema)
    const doc = interpretSubstrate(TestSchema, substrate)

    change(doc, d => d.title.insert(0, "Hi"))
    expect(doc.title()).toBe("Hi")
  })

  it("counter increment via change() is readable", () => {
    const substrate = loroSubstrateFactory.create(TestSchema)
    const doc = interpretSubstrate(TestSchema, substrate)

    change(doc, d => d.count.increment(5))
    expect(doc.count()).toBe(5)

    change(doc, d => d.count.increment(3))
    expect(doc.count()).toBe(8)
  })

  it("scalar set via change() is readable", () => {
    const substrate = loroSubstrateFactory.create(TestSchema)
    const doc = interpretSubstrate(TestSchema, substrate)

    change(doc, d => d.theme.set("light"))
    expect(doc.theme()).toBe("light")
    change(doc, d => d.theme.set("dark"))
    expect(doc.theme()).toBe("dark")
  })
})

// ===========================================================================
// Version tracking
// ===========================================================================

describe("version tracking", () => {
  it("version() returns a LoroVersion", () => {
    const substrate = loroSubstrateFactory.create(TestSchema)
    const f = substrate.version()
    expect(f).toBeInstanceOf(LoroVersion)
  })

  it("version() advances after mutations", () => {
    const substrate = loroSubstrateFactory.create(TestSchema)
    const doc = interpretSubstrate(TestSchema, substrate)

    const v0 = substrate.version()

    change(doc, d => d.title.insert(0, "A"))
    const v1 = substrate.version()
    expect(v0.compare(v1)).toBe("behind")

    change(doc, d => d.count.increment(1))
    const v2 = substrate.version()
    expect(v1.compare(v2)).toBe("behind")
    expect(v0.compare(v2)).toBe("behind")
  })

  it("version() serialize/parse round-trips", () => {
    const substrate = loroSubstrateFactory.create(TestSchema)
    const doc = interpretSubstrate(TestSchema, substrate)

    change(doc, d => d.title.insert(0, "Hello"))
    const f = substrate.version()
    const serialized = f.serialize()
    const parsed = LoroVersion.parse(serialized)
    expect(parsed.compare(f)).toBe("equal")
  })
})

// ===========================================================================
// Export/import snapshot
// ===========================================================================

describe("export/import snapshot", () => {
  it("exportEntirety returns a binary payload", () => {
    const substrate = loroSubstrateFactory.create(TestSchema)
    const snapshot = substrate.exportEntirety()
    expect(snapshot.encoding).toBe("binary")
    expect(snapshot.data).toBeInstanceOf(Uint8Array)
  })

  it("fromSnapshot reconstructs equivalent state", () => {
    const substrateA = loroSubstrateFactory.create(TestSchema)
    const docA = interpretSubstrate(TestSchema, substrateA)
    change(docA, d => {
      d.title.insert(0, "Original")
      d.theme.set("dark")
    })
    change(docA, d => {
      d.title.insert(8, " Title")
      d.count.increment(42)
    })

    const snapshot = substrateA.exportEntirety()
    const substrateB = loroSubstrateFactory.fromEntirety(snapshot, TestSchema)

    const readerB = substrateB.reader
    expect(readerB.read(RawPath.empty.field("title"))).toBe("Original Title")
    expect(readerB.read(RawPath.empty.field("count"))).toBe(42)
    expect(readerB.read(RawPath.empty.field("theme"))).toBe("dark")
  })

  it("fromSnapshot creates a new epoch (version independent)", () => {
    const substrateA = loroSubstrateFactory.create(TestSchema)
    const docA = interpretSubstrate(TestSchema, substrateA)
    change(docA, d => d.title.insert(0, "Hello"))

    const snapshot = substrateA.exportEntirety()
    const substrateB = loroSubstrateFactory.fromEntirety(snapshot, TestSchema)

    // Both substrates have equivalent state
    expect(substrateB.reader.read(RawPath.empty.field("title"))).toBe("Hello")
  })
})

// ===========================================================================
// Delta sync
// ===========================================================================

describe("delta sync", () => {
  it("exportSince → merge syncs state between substrates", () => {
    const substrateA = loroSubstrateFactory.create(TestSchema)
    const docA = interpretSubstrate(TestSchema, substrateA)

    const substrateB = loroSubstrateFactory.create(TestSchema)
    const _docB = interpretSubstrate(TestSchema, substrateB)

    const sinceVV = substrateB.version()

    // Mutate A
    change(docA, d => {
      d.title.insert(0, "Hello!")
      d.count.increment(10)
    })

    // Export delta and import into B
    const delta = substrateA.exportSince(sinceVV)
    expect(delta).not.toBeNull()
    substrateB.merge(delta!, { origin: "sync" })

    // B should now have A's state
    expect(substrateB.reader.read(RawPath.empty.field("title"))).toBe("Hello!")
    expect(substrateB.reader.read(RawPath.empty.field("count"))).toBe(10)
  })
})

// ===========================================================================
// Concurrent sync
// ===========================================================================

describe("concurrent sync", () => {
  it("two substrates with independent mutations converge after sync", () => {
    const substrateA = loroSubstrateFactory.create(TestSchema)
    const docA = interpretSubstrate(TestSchema, substrateA)

    const substrateB = loroSubstrateFactory.create(TestSchema)
    const docB = interpretSubstrate(TestSchema, substrateB)

    // Sync base state
    const baseA = substrateA.exportEntirety()
    substrateB.merge({
      encoding: "binary",
      data: baseA.data,
    } as SubstratePayload)

    // Independent mutations
    change(docA, d => d.title.insert(0, "A"))
    change(docB, d => d.count.increment(5))

    // Bidirectional sync
    const deltaAtoB = substrateA.exportSince(substrateB.version())
    const deltaBtoA = substrateB.exportSince(substrateA.version())
    if (deltaAtoB) substrateB.merge(deltaAtoB, { origin: "sync" })
    if (deltaBtoA) substrateA.merge(deltaBtoA, { origin: "sync" })

    // Both should have converged
    expect(substrateA.reader.read(RawPath.empty.field("title"))).toBe("A")
    expect(substrateA.reader.read(RawPath.empty.field("count"))).toBe(5)
    expect(substrateB.reader.read(RawPath.empty.field("title"))).toBe("A")
    expect(substrateB.reader.read(RawPath.empty.field("count"))).toBe(5)
  })
})

// ===========================================================================
// Changefeed fires on merge
// ===========================================================================

describe("changefeed fires on merge", () => {
  it("subscribe fires when merge is called", () => {
    const substrateA = loroSubstrateFactory.create(TestSchema)
    const docA = interpretSubstrate(TestSchema, substrateA)

    const substrateB = loroSubstrateFactory.create(TestSchema)
    const docB = interpretSubstrate(TestSchema, substrateB)

    const sinceVV = substrateB.version()

    // Subscribe to B
    const received: unknown[] = []
    subscribe(docB, cs => received.push(cs))

    // Mutate A, then sync to B
    change(docA, d => d.title.insert(0, "Remote"))
    const delta = substrateA.exportSince(sinceVV)!
    substrateB.merge(delta, { origin: "sync" })

    // B's subscriber should have fired
    expect(received.length).toBeGreaterThanOrEqual(1)
  })

  it("nested struct field changefeed fires on merge (todo done toggle)", () => {
    // Replicates: Client A toggles todo.done → syncs to Client B →
    // B's field-level changefeed for `done` should fire so the UI updates.
    const substrateA = loroSubstrateFactory.create(TestSchema)
    const docA = interpretSubstrate(TestSchema, substrateA)

    const substrateB = loroSubstrateFactory.create(TestSchema)
    const docB = interpretSubstrate(TestSchema, substrateB)

    // Both peers add the same item via initial sync
    change(docA, (d: any) => {
      d.items.push({ name: "Buy milk", done: false })
    })
    const snapshot = substrateA.exportEntirety()
    substrateB.merge(snapshot, { origin: "sync" })

    // Verify B has the item
    expect([...docB.items]).toHaveLength(1)
    const itemB = [...docB.items][0] as any
    expect(itemB.done()).toBe(false)

    // Subscribe to the FIELD-LEVEL changefeed on B's item
    const sinceVV = substrateB.version()
    const fieldChanges: unknown[] = []
    const cf = (itemB.done as any)[Symbol.for("kyneta:changefeed")]
    expect(cf).toBeDefined()
    const unsub = cf.subscribe((cs: unknown) => fieldChanges.push(cs))

    // A toggles done
    change(docA, (d: any) => {
      d.items.at(0).done.set(true)
    })

    // Sync the toggle to B
    const delta = substrateA.exportSince(sinceVV)!
    substrateB.merge(delta, { origin: "sync" })

    // B should see the updated value
    expect(itemB.done()).toBe(true)

    // The field-level changefeed should have fired
    expect(fieldChanges.length).toBeGreaterThanOrEqual(1)

    unsub()
  })

  it("multi-key struct update fires per-field changefeeds on merge", () => {
    const substrateA = loroSubstrateFactory.create(TestSchema)
    const docA = interpretSubstrate(TestSchema, substrateA)

    const substrateB = loroSubstrateFactory.create(TestSchema)
    const docB = interpretSubstrate(TestSchema, substrateB)

    // Both peers add the same item via initial sync
    change(docA, (d: any) => {
      d.items.push({ name: "Buy milk", done: false })
    })
    const snapshot = substrateA.exportEntirety()
    substrateB.merge(snapshot, { origin: "sync" })

    const itemB = [...docB.items][0] as any
    const sinceVV = substrateB.version()

    // Subscribe to BOTH field-level changefeeds on B's item
    const nameChanges: unknown[] = []
    const doneChanges: unknown[] = []
    const cfName = (itemB.name as any)[Symbol.for("kyneta:changefeed")]
    const cfDone = (itemB.done as any)[Symbol.for("kyneta:changefeed")]
    const unsub1 = cfName.subscribe((cs: unknown) => nameChanges.push(cs))
    const unsub2 = cfDone.subscribe((cs: unknown) => doneChanges.push(cs))

    // A updates both fields in a single change()
    change(docA, (d: any) => {
      const item = d.items.at(0)
      item.name.set("Buy oat milk")
      item.done.set(true)
    })

    // Sync to B
    const delta = substrateA.exportSince(sinceVV)!
    substrateB.merge(delta, { origin: "sync" })

    // Both field-level changefeeds should have fired
    expect(nameChanges.length).toBeGreaterThanOrEqual(1)
    expect(doneChanges.length).toBeGreaterThanOrEqual(1)

    // Values should be updated
    expect(itemB.name()).toBe("Buy oat milk")
    expect(itemB.done()).toBe(true)

    unsub1()
    unsub2()
  })

  it("batchToOps inverts changeToDiff for map changes (round-trip symmetry)", () => {
    const substrateA = loroSubstrateFactory.create(TestSchema)
    const docA = interpretSubstrate(TestSchema, substrateA)

    const substrateB = loroSubstrateFactory.create(TestSchema)
    const docB = interpretSubstrate(TestSchema, substrateB)

    // Add item on A, sync to B
    change(docA, (d: any) => {
      d.items.push({ name: "Task", done: false })
    })
    substrateB.merge(substrateA.exportEntirety(), { origin: "sync" })

    const sinceVV = substrateB.version()

    // Capture the leaf ops from A's local mutation
    const localOps = change(docA, (d: any) => {
      d.items.at(0).done.set(true)
    })

    // The local op should be a leaf-level replace at ["items", 0, "done"]
    expect(localOps.length).toBe(1)
    expect(localOps[0].path.format()).toBe("items[0].done")
    expect(localOps[0].change.type).toBe("replace")

    // Sync to B — the event bridge produces ops via batchToOps + expandMapOpsToLeaves
    // Subscribe to B's field changefeed to capture the inbound ops indirectly
    const itemB = [...docB.items][0] as any
    const fieldChanges: unknown[] = []
    const cf = (itemB.done as any)[Symbol.for("kyneta:changefeed")]
    const unsub = cf.subscribe((cs: unknown) => fieldChanges.push(cs))

    const delta = substrateA.exportSince(sinceVV)!
    substrateB.merge(delta, { origin: "sync" })

    // The inbound path should have reached the same leaf path
    // (proven by the field-level changefeed firing)
    expect(fieldChanges.length).toBeGreaterThanOrEqual(1)
    expect(itemB.done()).toBe(true)

    unsub()
  })

  it("root scalar field changefeed fires on merge (_props path fix)", () => {
    // Root scalar fields (Schema.string(), Schema.number(), etc.) are stored
    // in the shared _props LoroMap. When a remote peer mutates a scalar,
    // Loro fires an event at path ["_props"]. The event bridge must strip
    // the _props prefix so the changefeed path matches the listener at
    // RawPath.empty.field("theme"), not RawPath.empty.field("_props").field("theme").
    const substrateA = loroSubstrateFactory.create(TestSchema)
    const docA = interpretSubstrate(TestSchema, substrateA)

    const substrateB = loroSubstrateFactory.create(TestSchema)
    const docB = interpretSubstrate(TestSchema, substrateB)

    const sinceVV = substrateB.version()

    // Subscribe to B's tree-level changefeed
    const received: unknown[] = []
    subscribe(docB, cs => received.push(cs))

    // Mutate the root scalar field on A
    change(docA, (d: any) => {
      d.theme.set("dark")
    })

    // Sync to B
    const delta = substrateA.exportSince(sinceVV)!
    substrateB.merge(delta, { origin: "sync" })

    // B's subscriber should have fired
    expect(received.length).toBeGreaterThanOrEqual(1)

    // And the value should be updated
    expect((docB as any).theme()).toBe("dark")
  })

  it("record field changefeed fires on merge (dynamic key insertion)", () => {
    // MapSchema (record) fields must receive MapChange at their own path
    // so the map changefeed's handleStructuralChange wires dynamic child
    // subscriptions. expandMapOpsToLeaves must NOT expand MapChange ops
    // at map paths — only at product paths.
    const substrateA = loroSubstrateFactory.create(TestSchema)
    const docA = interpretSubstrate(TestSchema, substrateA)

    const substrateB = loroSubstrateFactory.create(TestSchema)
    const docB = interpretSubstrate(TestSchema, substrateB)

    const sinceVV = substrateB.version()

    let treeFireCount = 0
    subscribe(docB, () => {
      treeFireCount++
    })

    // Insert a new dynamic key on A
    change(docA, (d: any) => {
      d.peers.set("alice", true)
    })

    const delta = substrateA.exportSince(sinceVV)!
    substrateB.merge(delta, { origin: "sync" })

    expect(treeFireCount).toBeGreaterThanOrEqual(1)
    expect((docB as any).peers()).toEqual({ alice: true })
  })

  it("mixed scalar + container mutation fires both changefeeds on merge", () => {
    // Scalars go through _props (path stripping), containers get their own
    // root container (no stripping). Both must fire in a single merge.
    // Regression guard: overly aggressive _props stripping could break
    // container paths; missing stripping breaks scalar paths.
    const substrateA = loroSubstrateFactory.create(TestSchema)
    const docA = interpretSubstrate(TestSchema, substrateA)

    const substrateB = loroSubstrateFactory.create(TestSchema)
    const docB = interpretSubstrate(TestSchema, substrateB)

    const sinceVV = substrateB.version()

    let treeFireCount = 0
    subscribe(docB, () => {
      treeFireCount++
    })

    // Mutate both a scalar (_props) and a container (LoroText) in one batch
    change(docA, (d: any) => {
      d.theme.set("dark")
      d.title.insert(0, "Hello")
    })

    const delta = substrateA.exportSince(sinceVV)!
    substrateB.merge(delta, { origin: "sync" })

    expect(treeFireCount).toBeGreaterThanOrEqual(1)
    expect((docB as any).theme()).toBe("dark")
    expect(docB.title()).toBe("Hello")
  })
})

// ===========================================================================
// Outbound: mergePendingGroups
// ===========================================================================

describe("outbound: multi-key struct mutation batching", () => {
  it("multi-key struct mutation produces correct state", () => {
    // This test verifies that mergePendingGroups doesn't break
    // correctness: setting 3 keys on the same struct in one transaction
    // should produce the correct final state.
    const substrate = loroSubstrateFactory.create(TestSchema)
    const doc = interpretSubstrate(TestSchema, substrate)

    change(doc, (d: any) => {
      d.items.push({ name: "initial", done: false })
    })

    // Update multiple fields in one transaction
    change(doc, (d: any) => {
      const item = d.items.at(0)
      item.name.set("updated")
      item.done.set(true)
    })

    const item = [...doc.items][0] as any
    expect(item.name()).toBe("updated")
    expect(item.done()).toBe(true)
  })

  it("multi-key struct mutation syncs correctly to another peer", () => {
    const substrateA = loroSubstrateFactory.create(TestSchema)
    const docA = interpretSubstrate(TestSchema, substrateA)

    const substrateB = loroSubstrateFactory.create(TestSchema)
    const docB = interpretSubstrate(TestSchema, substrateB)

    change(docA, (d: any) => {
      d.items.push({ name: "initial", done: false })
    })
    substrateB.merge(substrateA.exportEntirety(), { origin: "sync" })

    const sinceVV = substrateB.version()

    // Update multiple fields in one transaction on A
    change(docA, (d: any) => {
      const item = d.items.at(0)
      item.name.set("updated")
      item.done.set(true)
    })

    // Sync to B
    const delta = substrateA.exportSince(sinceVV)!
    substrateB.merge(delta, { origin: "sync" })

    const itemB = [...docB.items][0] as any
    expect(itemB.name()).toBe("updated")
    expect(itemB.done()).toBe(true)
  })
})

// ===========================================================================
// Changefeed fires on external import
// ===========================================================================

describe("changefeed fires on external import", () => {
  it("kyneta subscriber fires when raw doc.import() is called externally", () => {
    // Create doc1 with some ops
    const doc1 = new LoroDoc()
    doc1.getText("title").insert(0, "External")
    doc1.commit()
    const update = doc1.export({ mode: "update" })

    // Create substrate on a fresh doc2
    const doc2 = new LoroDoc()
    // Ensure root containers exist
    doc2.getText("title")
    doc2.getCounter("count")
    doc2.getList("items")
    doc2.commit()

    const substrate = createLoroSubstrate(doc2, TestSchema)
    const kDoc = interpretSubstrate(TestSchema, substrate)

    // Subscribe via kyneta
    const received: unknown[] = []
    subscribe(kDoc, cs => received.push(cs))

    // External import — bypasses substrate.merge()
    doc2.import(update)

    // Kyneta subscriber should have fired
    expect(received.length).toBeGreaterThanOrEqual(1)
  })
})

// ===========================================================================
// Changefeed fires on external local write
// ===========================================================================

describe("changefeed fires on external local write", () => {
  it("kyneta subscriber fires when raw Loro API mutation + commit happens", () => {
    const doc = new LoroDoc()
    doc.getText("title")
    doc.getCounter("count")
    doc.getList("items")
    doc.commit()

    const substrate = createLoroSubstrate(doc, TestSchema)
    const kDoc = interpretSubstrate(TestSchema, substrate)

    // Subscribe via kyneta
    const received: unknown[] = []
    subscribe(kDoc, cs => received.push(cs))

    // External local write — raw Loro API, not via kyneta change()
    doc.getText("title").insert(0, "External write")
    doc.commit()

    // Kyneta subscriber should have fired
    expect(received.length).toBeGreaterThanOrEqual(1)

    // The value should be readable
    expect(kDoc.title()).toBe("External write")
  })
})

// ===========================================================================
// No double-fire on kyneta local writes
// ===========================================================================

describe("no double-fire on kyneta local writes", () => {
  it("change() fires the kyneta subscriber exactly once", () => {
    const substrate = loroSubstrateFactory.create(TestSchema)
    const doc = interpretSubstrate(TestSchema, substrate)

    let fireCount = 0
    subscribe(doc, () => {
      fireCount++
    })

    change(doc, d => d.title.insert(0, "Hi"))
    expect(fireCount).toBe(1)

    change(doc, d => d.count.increment(1))
    expect(fireCount).toBe(2)
  })
})

// ===========================================================================
// Transaction support
// ===========================================================================

describe("transaction support", () => {
  it("multi-op transaction via change() is atomic", () => {
    const substrate = loroSubstrateFactory.create(TestSchema)
    const doc = interpretSubstrate(TestSchema, substrate)

    let fireCount = 0
    subscribe(doc, () => {
      fireCount++
    })

    // Multiple ops in a single change() call
    change(doc, d => {
      d.title.insert(0, "Hello")
      d.count.increment(10)
    })

    // Tree-level subscribe fires once per affected container in the
    // flush cycle. Two containers changed (title + count) → 2 fires.
    // This matches PlainSubstrate behavior.
    expect(fireCount).toBe(2)

    // Both changes should be applied
    expect(doc.title()).toBe("Hello")
    expect(doc.count()).toBe(10)
  })
})

// ===========================================================================
// Nested structure: list of structs
// ===========================================================================

describe("nested structure", () => {
  it("push struct into list, read back via navigation", () => {
    const substrate = loroSubstrateFactory.create(TestSchema)
    const doc = interpretSubstrate(TestSchema, substrate)

    change(doc, d => {
      d.items.push({ name: "New task", done: false })
    })

    expect(doc.items.length).toBe(1)
    const item = doc.items.at(0)
    expect(item).toBeDefined()
    expect(item?.name()).toBe("New task")
    expect(item?.done()).toBe(false)
  })

  it("push multiple structs and navigate", () => {
    const substrate = loroSubstrateFactory.create(TestSchema)
    const doc = interpretSubstrate(TestSchema, substrate)

    change(doc, d => {
      d.items.push({ name: "First", done: false })
    })
    change(doc, d => {
      d.items.push({ name: "Second", done: true })
    })

    expect(doc.items.length).toBe(2)
    expect(doc.items.at(0)?.name()).toBe("First")
    expect(doc.items.at(1)?.name()).toBe("Second")
    expect(doc.items.at(1)?.done()).toBe(true)
  })
})

// ===========================================================================
// Re-entrant write inside merge-replay subscriber
// ===========================================================================
//
// A subscriber that calls `change(doc, ...)` while delivering a sync
// merge must reach Loro — otherwise the substrate stalls and the
// subscriber loops on stale state until the lease budget trips.
// Context: jj:qpultxsw.

describe("re-entrant write during merge replay", () => {
  it("subscriber's local change() inside a merge-replay batch lands in Loro", async () => {
    const substrateA = loroSubstrateFactory.create(TestSchema)
    const docA = interpretSubstrate(TestSchema, substrateA)

    const substrateB = loroSubstrateFactory.create(TestSchema)
    const docB = interpretSubstrate(TestSchema, substrateB)

    // Seed A and sync to B so both peers start from a common state.
    change(docA, (d: any) => {
      d.title.insert(0, "seed")
    })
    substrateB.merge(substrateA.exportEntirety(), { origin: "sync" })

    // On the first replay-driven update, the subscriber writes once
    // to an unrelated field. The write must hit Loro; the guard
    // ensures we don't re-enter the loop on subsequent flushes.
    let writes = 0
    subscribe(docB.title, () => {
      if (writes === 0 && docB.title() === "seedmore") {
        writes++
        change(docB, (d: any) => {
          d.theme.set("echoed")
        })
      }
    })

    const v0 = substrateB.version()
    change(docA, (d: any) => {
      d.title.insert(d.title().length, "more")
    })
    const delta = substrateA.exportSince(v0 as LoroVersion)!
    substrateB.merge(delta, { origin: "sync" })

    // Drain microtasks so the inner change()'s sub-tick lands.
    await new Promise<void>(r => queueMicrotask(r))

    expect(docB.title()).toBe("seedmore")
    expect(docB.theme()).toBe("echoed")
    expect(writes).toBe(1)
  })
})

// ===========================================================================
// parseVersion
// ===========================================================================

describe("parseVersion", () => {
  it("round-trips through factory", () => {
    const substrate = loroSubstrateFactory.create(TestSchema)
    const doc = interpretSubstrate(TestSchema, substrate)
    change(doc, d => d.title.insert(0, "Hi"))

    const v = substrate.version()
    const serialized = v.serialize()
    const parsed = loroSubstrateFactory.parseVersion(serialized)
    expect(parsed.compare(v)).toBe("equal")
  })
})

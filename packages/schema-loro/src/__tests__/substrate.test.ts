import { describe, expect, it } from "vitest"
import { LoroDoc } from "loro-crdt"
import {
  interpret,
  readable,
  writable,
  changefeed,
  change,
  subscribe,
  LoroSchema,
  Schema,
  type Ref,
  type SchemaNode,
} from "@kyneta/schema"
import type { Substrate, SubstratePayload } from "@kyneta/schema"
import {
  createLoroSubstrate,
  loroSubstrateFactory,
  LoroVersion,
} from "../index.js"

// ===========================================================================
// Shared test schema
// ===========================================================================

const TestSchema = LoroSchema.doc({
  title: LoroSchema.text(),
  count: LoroSchema.counter(),
  items: Schema.list(
    Schema.struct({
      name: Schema.string(),
      done: Schema.boolean(),
    }),
  ),
  theme: Schema.string(),
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
    .with(changefeed)
    .done()

// ===========================================================================
// Factory create
// ===========================================================================

describe("loroSubstrateFactory.create", () => {
  it("creates a substrate with default values", () => {
    const substrate = loroSubstrateFactory.create(TestSchema)
    const reader = substrate.store

    // Text defaults to empty string
    expect(reader.read([{ type: "key", key: "title" }])).toBe("")
    // Counter defaults to 0
    expect(reader.read([{ type: "key", key: "count" }])).toBe(0)
    // List defaults to empty
    expect(reader.arrayLength([{ type: "key", key: "items" }])).toBe(0)
  })

  it("creates a substrate with seed values", () => {
    const substrate = loroSubstrateFactory.create(TestSchema, {
      title: "Hello",
      theme: "dark",
    })
    const reader = substrate.store

    expect(reader.read([{ type: "key", key: "title" }])).toBe("Hello")
    expect(reader.read([{ type: "key", key: "theme" }])).toBe("dark")
  })

  it("creates a substrate with seed list items", () => {
    const substrate = loroSubstrateFactory.create(TestSchema, {
      items: [
        { name: "Task 1", done: false },
        { name: "Task 2", done: true },
      ],
    })
    const reader = substrate.store

    expect(reader.arrayLength([{ type: "key", key: "items" }])).toBe(2)
    expect(
      reader.read([
        { type: "key", key: "items" },
        { type: "index", index: 0 },
        { type: "key", key: "name" },
      ]),
    ).toBe("Task 1")
    expect(
      reader.read([
        { type: "key", key: "items" },
        { type: "index", index: 1 },
        { type: "key", key: "done" },
      ]),
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

    change(doc, (d) => d.title.insert(0, "Hi"))
    expect(doc.title()).toBe("Hi")
  })

  it("counter increment via change() is readable", () => {
    const substrate = loroSubstrateFactory.create(TestSchema)
    const doc = interpretSubstrate(TestSchema, substrate)

    change(doc, (d) => d.count.increment(5))
    expect(doc.count()).toBe(5)

    change(doc, (d) => d.count.increment(3))
    expect(doc.count()).toBe(8)
  })

  it("scalar set via change() is readable", () => {
    const substrate = loroSubstrateFactory.create(TestSchema, {
      theme: "light",
    })
    const doc = interpretSubstrate(TestSchema, substrate)

    expect(doc.theme()).toBe("light")
    change(doc, (d) => d.theme.set("dark"))
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

    change(doc, (d) => d.title.insert(0, "A"))
    const v1 = substrate.version()
    expect(v0.compare(v1)).toBe("behind")

    change(doc, (d) => d.count.increment(1))
    const v2 = substrate.version()
    expect(v1.compare(v2)).toBe("behind")
    expect(v0.compare(v2)).toBe("behind")
  })

  it("version() serialize/parse round-trips", () => {
    const substrate = loroSubstrateFactory.create(TestSchema)
    const doc = interpretSubstrate(TestSchema, substrate)

    change(doc, (d) => d.title.insert(0, "Hello"))
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
  it("exportSnapshot returns a binary payload", () => {
    const substrate = loroSubstrateFactory.create(TestSchema, { title: "Test" })
    const snapshot = substrate.exportSnapshot()
    expect(snapshot.encoding).toBe("binary")
    expect(snapshot.data).toBeInstanceOf(Uint8Array)
  })

  it("fromSnapshot reconstructs equivalent state", () => {
    const substrateA = loroSubstrateFactory.create(TestSchema, {
      title: "Original",
      theme: "dark",
    })
    const docA = interpretSubstrate(TestSchema, substrateA)
    change(docA, (d) => {
      d.title.insert(8, " Title")
      d.count.increment(42)
    })

    const snapshot = substrateA.exportSnapshot()
    const substrateB = loroSubstrateFactory.fromSnapshot(snapshot, TestSchema)

    const readerB = substrateB.store
    expect(readerB.read([{ type: "key", key: "title" }])).toBe("Original Title")
    expect(readerB.read([{ type: "key", key: "count" }])).toBe(42)
    expect(readerB.read([{ type: "key", key: "theme" }])).toBe("dark")
  })

  it("fromSnapshot creates a new epoch (version independent)", () => {
    const substrateA = loroSubstrateFactory.create(TestSchema)
    const docA = interpretSubstrate(TestSchema, substrateA)
    change(docA, (d) => d.title.insert(0, "Hello"))

    const snapshot = substrateA.exportSnapshot()
    const substrateB = loroSubstrateFactory.fromSnapshot(snapshot, TestSchema)

    // Both substrates have equivalent state
    expect(substrateB.store.read([{ type: "key", key: "title" }])).toBe("Hello")
  })
})

// ===========================================================================
// Delta sync
// ===========================================================================

describe("delta sync", () => {
  it("exportSince → importDelta syncs state between substrates", () => {
    const substrateA = loroSubstrateFactory.create(TestSchema)
    const docA = interpretSubstrate(TestSchema, substrateA)

    const substrateB = loroSubstrateFactory.create(TestSchema)
    const _docB = interpretSubstrate(TestSchema, substrateB)

    const sinceVV = substrateB.version()

    // Mutate A
    change(docA, (d) => {
      d.title.insert(0, "Hello!")
      d.count.increment(10)
    })

    // Export delta and import into B
    const delta = substrateA.exportSince(sinceVV)
    expect(delta).not.toBeNull()
    substrateB.importDelta(delta!, "sync")

    // B should now have A's state
    expect(substrateB.store.read([{ type: "key", key: "title" }])).toBe(
      "Hello!",
    )
    expect(substrateB.store.read([{ type: "key", key: "count" }])).toBe(10)
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
    const baseA = substrateA.exportSnapshot()
    substrateB.importDelta({
      encoding: "binary",
      data: baseA.data,
    } as SubstratePayload)

    // Independent mutations
    change(docA, (d) => d.title.insert(0, "A"))
    change(docB, (d) => d.count.increment(5))

    // Bidirectional sync
    const deltaAtoB = substrateA.exportSince(substrateB.version())
    const deltaBtoA = substrateB.exportSince(substrateA.version())
    if (deltaAtoB) substrateB.importDelta(deltaAtoB, "sync")
    if (deltaBtoA) substrateA.importDelta(deltaBtoA, "sync")

    // Both should have converged
    expect(substrateA.store.read([{ type: "key", key: "title" }])).toBe("A")
    expect(substrateA.store.read([{ type: "key", key: "count" }])).toBe(5)
    expect(substrateB.store.read([{ type: "key", key: "title" }])).toBe("A")
    expect(substrateB.store.read([{ type: "key", key: "count" }])).toBe(5)
  })
})

// ===========================================================================
// Changefeed fires on importDelta
// ===========================================================================

describe("changefeed fires on importDelta", () => {
  it("subscribe fires when importDelta is called", () => {
    const substrateA = loroSubstrateFactory.create(TestSchema)
    const docA = interpretSubstrate(TestSchema, substrateA)

    const substrateB = loroSubstrateFactory.create(TestSchema)
    const docB = interpretSubstrate(TestSchema, substrateB)

    const sinceVV = substrateB.version()

    // Subscribe to B
    const received: unknown[] = []
    subscribe(docB, (cs) => received.push(cs))

    // Mutate A, then sync to B
    change(docA, (d) => d.title.insert(0, "Remote"))
    const delta = substrateA.exportSince(sinceVV)!
    substrateB.importDelta(delta, "sync")

    // B's subscriber should have fired
    expect(received.length).toBeGreaterThanOrEqual(1)
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
    subscribe(kDoc, (cs) => received.push(cs))

    // External import — bypasses substrate.importDelta()
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
    subscribe(kDoc, (cs) => received.push(cs))

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

    change(doc, (d) => d.title.insert(0, "Hi"))
    expect(fireCount).toBe(1)

    change(doc, (d) => d.count.increment(1))
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
    change(doc, (d) => {
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

    change(doc, (d) => {
      d.items.push({ name: "New task", done: false })
    })

    expect(doc.items.length).toBe(1)
    const item = doc.items.at(0)
    expect(item).toBeDefined()
    expect(item!.name()).toBe("New task")
    expect(item!.done()).toBe(false)
  })

  it("push multiple structs and navigate", () => {
    const substrate = loroSubstrateFactory.create(TestSchema)
    const doc = interpretSubstrate(TestSchema, substrate)

    change(doc, (d) => {
      d.items.push({ name: "First", done: false })
    })
    change(doc, (d) => {
      d.items.push({ name: "Second", done: true })
    })

    expect(doc.items.length).toBe(2)
    expect(doc.items.at(0)!.name()).toBe("First")
    expect(doc.items.at(1)!.name()).toBe("Second")
    expect(doc.items.at(1)!.done()).toBe(true)
  })
})

// ===========================================================================
// parseVersion
// ===========================================================================

describe("parseVersion", () => {
  it("round-trips through factory", () => {
    const substrate = loroSubstrateFactory.create(TestSchema)
    const doc = interpretSubstrate(TestSchema, substrate)
    change(doc, (d) => d.title.insert(0, "Hi"))

    const v = substrate.version()
    const serialized = v.serialize()
    const parsed = loroSubstrateFactory.parseVersion(serialized)
    expect(parsed.compare(v)).toBe("equal")
  })
})
import { describe, expect, it, vi } from "vitest"
import {
  Schema,
  LoroSchema,
  interpret,
  readable,
  writable,
  changefeed,
  change,
  applyChanges,
  subscribe,
  Zero,
  PlainFrontier,
  plainSubstrateFactory,
} from "../index.js"
import type {
  Changeset,
  Op,
  Substrate,
  SubstratePayload,
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

// Helper: create a full interpreter tree from a substrate
function interpretSubstrate(substrate: Substrate<PlainFrontier>) {
  return interpret(TestSchema, substrate.context())
    .with(readable)
    .with(writable)
    .with(changefeed)
    .done()
}

// ===========================================================================
// PlainFrontier
// ===========================================================================

describe("PlainFrontier", () => {
  it("serialize() returns a numeric string", () => {
    expect(new PlainFrontier(0).serialize()).toBe("0")
    expect(new PlainFrontier(42).serialize()).toBe("42")
    expect(new PlainFrontier(1000).serialize()).toBe("1000")
  })

  it("compare() correctly reports behind/equal/ahead", () => {
    const f0 = new PlainFrontier(0)
    const f1 = new PlainFrontier(1)
    const f5 = new PlainFrontier(5)

    expect(f0.compare(f1)).toBe("behind")
    expect(f1.compare(f0)).toBe("ahead")
    expect(f0.compare(f0)).toBe("equal")
    expect(f5.compare(f5)).toBe("equal")
    expect(f1.compare(f5)).toBe("behind")
    expect(f5.compare(f1)).toBe("ahead")
  })

  it("compare() never returns 'concurrent'", () => {
    // Plain substrates have a total order — exhaustively check
    // a range of values to verify "concurrent" never appears.
    const values = [0, 1, 2, 5, 10, 100]
    for (const a of values) {
      for (const b of values) {
        const result = new PlainFrontier(a).compare(new PlainFrontier(b))
        expect(result).not.toBe("concurrent")
        if (a < b) expect(result).toBe("behind")
        else if (a > b) expect(result).toBe("ahead")
        else expect(result).toBe("equal")
      }
    }
  })

  it("round-trip: parseFrontier(f.serialize()) compares equal to f", () => {
    const original = new PlainFrontier(7)
    const roundTripped = plainSubstrateFactory.parseFrontier(original.serialize())
    expect(roundTripped.compare(original)).toBe("equal")
    expect(original.compare(roundTripped)).toBe("equal")
    expect(roundTripped.value).toBe(7)
  })

  it("parseFrontier rejects invalid input", () => {
    expect(() => plainSubstrateFactory.parseFrontier("abc")).toThrow()
    expect(() => plainSubstrateFactory.parseFrontier("-1")).toThrow()
    expect(() => plainSubstrateFactory.parseFrontier("1.5")).toThrow()
    expect(() => plainSubstrateFactory.parseFrontier("")).toThrow()
  })

  it("value getter exposes the raw integer", () => {
    expect(new PlainFrontier(0).value).toBe(0)
    expect(new PlainFrontier(99).value).toBe(99)
  })
})

// ===========================================================================
// Substrate lifecycle
// ===========================================================================

describe("PlainSubstrate lifecycle", () => {
  it("create(schema, seed) produces a substrate whose store matches Zero.overlay(seed, defaults)", () => {
    const seed = { title: "Hello", theme: "dark" }
    const substrate = plainSubstrateFactory.create(TestSchema, seed)

    const defaults = Zero.structural(TestSchema) as Record<string, unknown>
    const expected = Zero.overlay(seed, defaults, TestSchema) as Record<string, unknown>

    // Store should match the overlay result
    expect(substrate.store).toEqual(expected)
    // Seed values preserved
    expect(substrate.store.title).toBe("Hello")
    expect(substrate.store.theme).toBe("dark")
    // Defaults filled in
    expect(substrate.store.count).toBe(0)
    expect(substrate.store.items).toEqual([])
  })

  it("create(schema) without seed uses structural defaults", () => {
    const substrate = plainSubstrateFactory.create(TestSchema)
    const defaults = Zero.structural(TestSchema) as Record<string, unknown>
    expect(substrate.store).toEqual(defaults)
  })

  it("frontier() starts at 0 for a freshly created substrate", () => {
    const substrate = plainSubstrateFactory.create(TestSchema)
    const f = substrate.frontier()
    expect(f.value).toBe(0)
    expect(f.serialize()).toBe("0")
  })

  it("frontier() increments after mutations via the writable context", () => {
    const substrate = plainSubstrateFactory.create(TestSchema, { title: "" })
    const doc = interpretSubstrate(substrate)

    expect(substrate.frontier().value).toBe(0)

    // Each change() call triggers one flush cycle → one version bump
    change(doc, (d) => d.title.insert(0, "Hi"))
    expect(substrate.frontier().value).toBe(1)

    change(doc, (d) => d.count.increment(5))
    expect(substrate.frontier().value).toBe(2)

    // A multi-op transaction is a single flush cycle → one version bump
    change(doc, (d) => {
      d.title.insert(2, " there")
      d.count.increment(3)
    })
    expect(substrate.frontier().value).toBe(3)
  })

  it("frontier() does not increment for empty transactions", () => {
    const substrate = plainSubstrateFactory.create(TestSchema)
    const doc = interpretSubstrate(substrate)

    expect(substrate.frontier().value).toBe(0)

    // applyChanges with empty array should not bump version
    applyChanges(doc, [])
    expect(substrate.frontier().value).toBe(0)
  })

  it("frontier() is up-to-date inside a subscribe callback (notify-after-commit)", () => {
    const substrate = plainSubstrateFactory.create(TestSchema, { title: "" })
    const doc = interpretSubstrate(substrate)

    expect(substrate.frontier().value).toBe(0)

    // Track the frontier value observed inside the subscriber
    const observedVersions: number[] = []
    subscribe(doc, () => {
      observedVersions.push(substrate.frontier().value)
    })

    change(doc, (d) => d.title.insert(0, "A"))
    change(doc, (d) => d.count.increment(1))
    change(doc, (d) => d.title.insert(1, "B"))

    // Each subscriber call should see the version AFTER the flush,
    // not the stale version from before. Without the fix, subscribers
    // would see [0, 1, 2] instead of [1, 2, 3].
    expect(observedVersions).toEqual([1, 2, 3])
  })

  it("delta() returns the just-flushed ops inside a subscribe callback", () => {
    const substrate = plainSubstrateFactory.create(TestSchema, { title: "", count: 0 })
    const doc = interpretSubstrate(substrate)

    // Track ops retrieved via delta() inside the subscriber
    const opsPerNotification: Op[][] = []
    let prevVersion = 0
    subscribe(doc, () => {
      const currentVer = substrate.frontier().value
      const payload = substrate.exportSince(new PlainFrontier(prevVersion))
      if (payload) {
        opsPerNotification.push(JSON.parse(payload.data as string) as Op[])
      }
      prevVersion = currentVer
    })

    change(doc, (d) => d.title.insert(0, "Hi"))
    change(doc, (d) => d.count.increment(5))

    // Each callback should have been able to retrieve the ops for its own flush cycle
    expect(opsPerNotification).toHaveLength(2)
    expect(opsPerNotification[0]!.length).toBeGreaterThan(0)
    expect(opsPerNotification[0]![0]!.change.type).toBe("text")
    expect(opsPerNotification[1]!.length).toBeGreaterThan(0)
    expect(opsPerNotification[1]![0]!.change.type).toBe("increment")
  })

  it("exportSnapshot() returns a JSON payload matching the current store state", () => {
    const seed = { title: "Test", count: 0, theme: "light" }
    const substrate = plainSubstrateFactory.create(TestSchema, seed)
    const doc = interpretSubstrate(substrate)

    // Mutate the doc
    change(doc, (d) => {
      d.title.insert(4, "!")
      d.count.increment(10)
    })

    const snapshot = substrate.exportSnapshot()
    expect(snapshot.encoding).toBe("json")
    expect(typeof snapshot.data).toBe("string")

    const parsed = JSON.parse(snapshot.data as string)
    expect(parsed).toEqual(substrate.store)
    expect(parsed.title).toBe("Test!")
    expect(parsed.count).toBe(10)
  })

  it("exportSince(frontier) returns null when frontier is ahead", () => {
    const substrate = plainSubstrateFactory.create(TestSchema)
    const futureFrontier = new PlainFrontier(999)
    expect(substrate.exportSince(futureFrontier)).toBeNull()
  })

  it("exportSince(frontier) returns empty ops when frontier matches current version", () => {
    const substrate = plainSubstrateFactory.create(TestSchema)
    const doc = interpretSubstrate(substrate)

    change(doc, (d) => d.count.increment(1))

    const payload = substrate.exportSince(substrate.frontier())
    expect(payload).not.toBeNull()
    const ops = JSON.parse(payload!.data as string)
    expect(ops).toEqual([])
  })

  it("exportSince(frontier) returns ops when frontier is behind", () => {
    const substrate = plainSubstrateFactory.create(TestSchema)
    const doc = interpretSubstrate(substrate)

    const f0 = substrate.frontier()
    change(doc, (d) => d.title.insert(0, "A"))
    change(doc, (d) => d.count.increment(1))

    const payload = substrate.exportSince(f0)
    expect(payload).not.toBeNull()
    expect(payload!.encoding).toBe("json")

    const ops = JSON.parse(payload!.data as string) as Op[]
    expect(ops.length).toBeGreaterThanOrEqual(2)

    // Should contain both a text change and an increment change
    const types = ops.map((op) => op.change.type)
    expect(types).toContain("text")
    expect(types).toContain("increment")
  })

  it("exportSince(partialFrontier) returns only the missing ops", () => {
    const substrate = plainSubstrateFactory.create(TestSchema)
    const doc = interpretSubstrate(substrate)

    change(doc, (d) => d.title.insert(0, "A"))
    const f1 = substrate.frontier()
    expect(f1.value).toBe(1)

    change(doc, (d) => d.count.increment(1))
    expect(substrate.frontier().value).toBe(2)

    // exportSince(f1) should only contain the second mutation
    const payload = substrate.exportSince(f1)!
    const ops = JSON.parse(payload.data as string) as Op[]
    expect(ops.length).toBe(1)
    expect(ops[0]!.change.type).toBe("increment")
  })
})

// ===========================================================================
// Round-trip replication
// ===========================================================================

describe("Round-trip replication", () => {
  it("snapshot round-trip: exportSnapshot → fromSnapshot → stores are equal", () => {
    const substrateA = plainSubstrateFactory.create(TestSchema, {
      title: "Original",
      theme: "dark",
    })
    const docA = interpretSubstrate(substrateA)

    // Apply some mutations
    change(docA, (d) => {
      d.title.insert(8, " Title")
      d.count.increment(42)
      d.items.push({ name: "Item 1", done: false })
    })

    const snapshot = substrateA.exportSnapshot()
    const substrateB = plainSubstrateFactory.fromSnapshot(snapshot, TestSchema)

    // Stores should be deeply equal
    expect(substrateB.store).toEqual(substrateA.store)
    expect(substrateB.store.title).toBe("Original Title")
    expect(substrateB.store.count).toBe(42)
    expect((substrateB.store.items as unknown[])).toHaveLength(1)
  })

  it("delta round-trip: exportSince → importDelta → stores are equal", () => {
    const substrateA = plainSubstrateFactory.create(TestSchema, { title: "Shared" })
    const docA = interpretSubstrate(substrateA)

    // Both substrates start from the same seed
    const substrateB = plainSubstrateFactory.create(TestSchema, { title: "Shared" })
    const docB = interpretSubstrate(substrateB)

    const f0 = substrateA.frontier()

    // Mutate A
    change(docA, (d) => {
      d.title.insert(6, "!")
      d.count.increment(10)
      d.items.push({ name: "New item", done: true })
    })

    // Export the delta and import into B
    const delta = substrateA.exportSince(f0)!
    substrateB.importDelta(delta, "sync")

    // Stores should match
    expect(substrateB.store).toEqual(substrateA.store)
    expect(substrateB.store.title).toBe("Shared!")
    expect(substrateB.store.count).toBe(10)
  })

  it("importDelta with origin 'sync' — changefeed fires with origin 'sync'", () => {
    const substrateA = plainSubstrateFactory.create(TestSchema)
    const docA = interpretSubstrate(substrateA)

    const substrateB = plainSubstrateFactory.create(TestSchema)
    const docB = interpretSubstrate(substrateB)

    const f0 = substrateA.frontier()

    // Mutate A
    change(docA, (d) => d.title.insert(0, "Hello"))

    // Subscribe to B's changefeed before importing
    const received: Changeset<Op>[] = []
    subscribe(docB, (cs) => received.push(cs))

    // Import into B
    const delta = substrateA.exportSince(f0)!
    substrateB.importDelta(delta, "sync")

    // Changefeed should have fired with origin "sync"
    expect(received.length).toBeGreaterThanOrEqual(1)
    for (const cs of received) {
      expect(cs.origin).toBe("sync")
    }
  })

  it("importDelta increments the frontier", () => {
    const substrateA = plainSubstrateFactory.create(TestSchema)
    const docA = interpretSubstrate(substrateA)

    const substrateB = plainSubstrateFactory.create(TestSchema)
    interpretSubstrate(substrateB) // wire up the interpreter tree

    const f0 = substrateA.frontier()

    change(docA, (d) => d.count.increment(1))
    change(docA, (d) => d.count.increment(2))

    expect(substrateB.frontier().value).toBe(0)

    const delta = substrateA.exportSince(f0)!
    substrateB.importDelta(delta)

    // importDelta applies all ops in a single executeBatch call,
    // which triggers one prepare×N + flush×1 cycle → one version bump
    expect(substrateB.frontier().value).toBe(1)
  })

  it("importDelta with empty ops does not increment the frontier", () => {
    const substrate = plainSubstrateFactory.create(TestSchema)
    interpretSubstrate(substrate)

    const emptyPayload: SubstratePayload = { encoding: "json", data: "[]" }
    substrate.importDelta(emptyPayload)

    expect(substrate.frontier().value).toBe(0)
  })
})

// ===========================================================================
// Epoch boundaries
// ===========================================================================

describe("Epoch boundaries", () => {
  it("fromSnapshot creates a fresh epoch: frontier at 0, store matches source", () => {
    const substrateA = plainSubstrateFactory.create(TestSchema, {
      title: "Genesis",
      theme: "light",
    })
    const docA = interpretSubstrate(substrateA)

    // Apply several mutations to advance the frontier
    change(docA, (d) => d.title.insert(7, " v2"))
    change(docA, (d) => d.count.increment(100))
    change(docA, (d) => d.items.push({ name: "Task", done: false }))

    expect(substrateA.frontier().value).toBe(3)

    // Export snapshot and create a new substrate
    const snapshot = substrateA.exportSnapshot()
    const substrateB = plainSubstrateFactory.fromSnapshot(snapshot, TestSchema)

    // New substrate starts at frontier 0 — it's a fresh epoch
    expect(substrateB.frontier().value).toBe(0)

    // But the store matches the source's current state
    expect(substrateB.store).toEqual(substrateA.store)
    expect(substrateB.store.title).toBe("Genesis v2")
    expect(substrateB.store.count).toBe(100)
    expect((substrateB.store.items as unknown[])).toHaveLength(1)
  })

  it("new epoch substrate is fully functional: can mutate, version, export", () => {
    const substrateA = plainSubstrateFactory.create(TestSchema, { title: "Source" })
    const docA = interpretSubstrate(substrateA)
    change(docA, (d) => d.count.increment(50))

    // Create new substrate from snapshot
    const snapshot = substrateA.exportSnapshot()
    const substrateB = plainSubstrateFactory.fromSnapshot(snapshot, TestSchema)
    const docB = interpretSubstrate(substrateB)

    // Mutate the new substrate
    change(docB, (d) => d.title.insert(6, "!"))
    expect(substrateB.frontier().value).toBe(1)
    expect(substrateB.store.title).toBe("Source!")

    // Export from the new substrate works
    const snapshot2 = substrateB.exportSnapshot()
    expect(JSON.parse(snapshot2.data as string).title).toBe("Source!")

    const delta = substrateB.exportSince(new PlainFrontier(0))!
    const ops = JSON.parse(delta.data as string) as Op[]
    expect(ops.length).toBe(1)
    expect(ops[0]!.change.type).toBe("text")
  })

  it("old and new epoch substrates are independent", () => {
    const substrateA = plainSubstrateFactory.create(TestSchema, { title: "Shared" })
    const docA = interpretSubstrate(substrateA)
    change(docA, (d) => d.count.increment(10))

    // Snapshot and create B
    const snapshot = substrateA.exportSnapshot()
    const substrateB = plainSubstrateFactory.fromSnapshot(snapshot, TestSchema)
    const docB = interpretSubstrate(substrateB)

    // Mutate A — should not affect B
    change(docA, (d) => d.title.insert(6, " from A"))
    expect(substrateA.store.title).toBe("Shared from A")
    expect(substrateB.store.title).toBe("Shared")

    // Mutate B — should not affect A
    change(docB, (d) => d.title.insert(6, " from B"))
    expect(substrateB.store.title).toBe("Shared from B")
    expect(substrateA.store.title).toBe("Shared from A")
  })
})

// ===========================================================================
// context() caching
// ===========================================================================

describe("context() caching", () => {
  it("context() returns the same WritableContext on repeated calls", () => {
    const substrate = plainSubstrateFactory.create(TestSchema)
    const ctx1 = substrate.context()
    const ctx2 = substrate.context()
    expect(ctx1).toBe(ctx2)
  })
})
import { describe, expect, it } from "vitest"
import type { Changeset, Op, Substrate, SubstratePayload } from "../index.js"
import {
  applyChanges,
  change,
  changefeed,
  interpret,
  LoroSchema,
  PlainVersion,
  plainSubstrateFactory,
  readable,
  Schema,
  subscribe,
  writable,
  Zero,
} from "../index.js"

// Helper: parse the store snapshot as a plain object for assertions.
// Exercises the public export API rather than reaching through to the
// backing StoreReader (which has no property access).
function snapshotOf(
  substrate: Substrate<PlainVersion>,
): Record<string, unknown> {
  return JSON.parse(substrate.exportSnapshot().data as string) as Record<
    string,
    unknown
  >
}

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
function interpretSubstrate(substrate: Substrate<PlainVersion>) {
  return interpret(TestSchema, substrate.context())
    .with(readable)
    .with(writable)
    .with(changefeed)
    .done()
}

// ===========================================================================
// PlainVersion
// ===========================================================================

describe("PlainVersion", () => {
  it("serialize() returns a numeric string", () => {
    expect(new PlainVersion(0).serialize()).toBe("0")
    expect(new PlainVersion(42).serialize()).toBe("42")
    expect(new PlainVersion(1000).serialize()).toBe("1000")
  })

  it("compare() correctly reports behind/equal/ahead", () => {
    const f0 = new PlainVersion(0)
    const f1 = new PlainVersion(1)
    const f5 = new PlainVersion(5)

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
        const result = new PlainVersion(a).compare(new PlainVersion(b))
        expect(result).not.toBe("concurrent")
        if (a < b) expect(result).toBe("behind")
        else if (a > b) expect(result).toBe("ahead")
        else expect(result).toBe("equal")
      }
    }
  })

  it("round-trip: parseVersion(f.serialize()) compares equal to f", () => {
    const original = new PlainVersion(7)
    const roundTripped = plainSubstrateFactory.parseVersion(
      original.serialize(),
    )
    expect(roundTripped.compare(original)).toBe("equal")
    expect(original.compare(roundTripped)).toBe("equal")
    expect(roundTripped.value).toBe(7)
  })

  it("parseVersion rejects invalid input", () => {
    expect(() => plainSubstrateFactory.parseVersion("abc")).toThrow()
    expect(() => plainSubstrateFactory.parseVersion("-1")).toThrow()
    expect(() => plainSubstrateFactory.parseVersion("1.5")).toThrow()
    expect(() => plainSubstrateFactory.parseVersion("")).toThrow()
  })

  it("value getter exposes the raw integer", () => {
    expect(new PlainVersion(0).value).toBe(0)
    expect(new PlainVersion(99).value).toBe(99)
  })
})

// ===========================================================================
// Substrate lifecycle
// ===========================================================================

describe("PlainSubstrate lifecycle", () => {
  it("create(schema) then change() produces a substrate with initial values", () => {
    const substrate = plainSubstrateFactory.create(TestSchema)
    const doc = interpretSubstrate(substrate)

    change(doc, d => {
      d.title.insert(0, "Hello")
      d.theme.set("dark")
    })

    const snap = snapshotOf(substrate)
    // Values set via change()
    expect(snap.title).toBe("Hello")
    expect(snap.theme).toBe("dark")
    // Defaults filled in
    expect(snap.count).toBe(0)
    expect(snap.items).toEqual([])
  })

  it("create(schema) without seed uses structural defaults", () => {
    const substrate = plainSubstrateFactory.create(TestSchema)
    const defaults = Zero.structural(TestSchema) as Record<string, unknown>
    expect(snapshotOf(substrate)).toEqual(defaults)
  })

  it("version() starts at 0 for a freshly created substrate", () => {
    const substrate = plainSubstrateFactory.create(TestSchema)
    const f = substrate.version()
    expect(f.value).toBe(0)
    expect(f.serialize()).toBe("0")
  })

  it("version() increments after mutations via the writable context", () => {
    const substrate = plainSubstrateFactory.create(TestSchema)
    const doc = interpretSubstrate(substrate)

    expect(substrate.version().value).toBe(0)

    // Each change() call triggers one flush cycle → one version bump
    change(doc, d => d.title.insert(0, "Hi"))
    expect(substrate.version().value).toBe(1)

    change(doc, d => d.count.increment(5))
    expect(substrate.version().value).toBe(2)

    // A multi-op transaction is a single flush cycle → one version bump
    change(doc, d => {
      d.title.insert(2, " there")
      d.count.increment(3)
    })
    expect(substrate.version().value).toBe(3)
  })

  it("version() does not increment for empty transactions", () => {
    const substrate = plainSubstrateFactory.create(TestSchema)
    const doc = interpretSubstrate(substrate)

    expect(substrate.version().value).toBe(0)

    // applyChanges with empty array should not bump version
    applyChanges(doc, [])
    expect(substrate.version().value).toBe(0)
  })

  it("version() is up-to-date inside a subscribe callback (notify-after-commit)", () => {
    const substrate = plainSubstrateFactory.create(TestSchema)
    const doc = interpretSubstrate(substrate)

    expect(substrate.version().value).toBe(0)

    // Track the version value observed inside the subscriber
    const observedVersions: number[] = []
    subscribe(doc, () => {
      observedVersions.push(substrate.version().value)
    })

    change(doc, d => d.title.insert(0, "A"))
    change(doc, d => d.count.increment(1))
    change(doc, d => d.title.insert(1, "B"))

    // Each subscriber call should see the version AFTER the flush,
    // not the stale version from before. Without the fix, subscribers
    // would see [0, 1, 2] instead of [1, 2, 3].
    expect(observedVersions).toEqual([1, 2, 3])
  })

  it("delta() returns the just-flushed ops inside a subscribe callback", () => {
    const substrate = plainSubstrateFactory.create(TestSchema)
    const doc = interpretSubstrate(substrate)

    // Track ops retrieved via delta() inside the subscriber
    const opsPerNotification: Op[][] = []
    let prevVersion = 0
    subscribe(doc, () => {
      const currentVer = substrate.version().value
      const payload = substrate.exportSince(new PlainVersion(prevVersion))
      if (payload) {
        opsPerNotification.push(JSON.parse(payload.data as string) as Op[])
      }
      prevVersion = currentVer
    })

    change(doc, d => d.title.insert(0, "Hi"))
    change(doc, d => d.count.increment(5))

    // Each callback should have been able to retrieve the ops for its own flush cycle
    expect(opsPerNotification).toHaveLength(2)
    expect(opsPerNotification[0]?.length).toBeGreaterThan(0)
    expect(opsPerNotification[0]?.[0]?.change.type).toBe("text")
    expect(opsPerNotification[1]?.length).toBeGreaterThan(0)
    expect(opsPerNotification[1]?.[0]?.change.type).toBe("increment")
  })

  it("exportSnapshot() returns a JSON payload matching the current store state", () => {
    const substrate = plainSubstrateFactory.create(TestSchema)
    const doc = interpretSubstrate(substrate)

    // Set initial values via change(), then mutate further
    change(doc, d => {
      d.title.insert(0, "Test")
      d.theme.set("light")
    })
    change(doc, d => {
      d.title.insert(4, "!")
      d.count.increment(10)
    })

    const snapshot = substrate.exportSnapshot()
    expect(snapshot.encoding).toBe("json")
    expect(typeof snapshot.data).toBe("string")

    const parsed = JSON.parse(snapshot.data as string)
    expect(parsed).toEqual(snapshotOf(substrate))
    expect(parsed.title).toBe("Test!")
    expect(parsed.count).toBe(10)
  })

  it("exportSince(version) returns null when version is ahead", () => {
    const substrate = plainSubstrateFactory.create(TestSchema)
    const futureVersion = new PlainVersion(999)
    expect(substrate.exportSince(futureVersion)).toBeNull()
  })

  it("exportSince(version) returns empty ops when version matches current version", () => {
    const substrate = plainSubstrateFactory.create(TestSchema)
    const doc = interpretSubstrate(substrate)

    change(doc, d => d.count.increment(1))

    const payload = substrate.exportSince(substrate.version())
    expect(payload).not.toBeNull()
    const ops = JSON.parse(payload?.data as string)
    expect(ops).toEqual([])
  })

  it("exportSince(version) returns ops when version is behind", () => {
    const substrate = plainSubstrateFactory.create(TestSchema)
    const doc = interpretSubstrate(substrate)

    const f0 = substrate.version()
    change(doc, d => d.title.insert(0, "A"))
    change(doc, d => d.count.increment(1))

    const payload = substrate.exportSince(f0)
    expect(payload).not.toBeNull()
    expect(payload?.encoding).toBe("json")

    const ops = JSON.parse(payload?.data as string) as Op[]
    expect(ops.length).toBeGreaterThanOrEqual(2)

    // Should contain both a text change and an increment change
    const types = ops.map(op => op.change.type)
    expect(types).toContain("text")
    expect(types).toContain("increment")
  })

  it("exportSince(partialVersion) returns only the missing ops", () => {
    const substrate = plainSubstrateFactory.create(TestSchema)
    const doc = interpretSubstrate(substrate)

    change(doc, d => d.title.insert(0, "A"))
    const f1 = substrate.version()
    expect(f1.value).toBe(1)

    change(doc, d => d.count.increment(1))
    expect(substrate.version().value).toBe(2)

    // exportSince(f1) should only contain the second mutation
    const payload = substrate.exportSince(f1)!
    const ops = JSON.parse(payload.data as string) as Op[]
    expect(ops.length).toBe(1)
    expect(ops[0]?.change.type).toBe("increment")
  })
})

// ===========================================================================
// Round-trip replication
// ===========================================================================

describe("Round-trip replication", () => {
  it("snapshot round-trip: exportSnapshot → fromSnapshot → stores are equal", () => {
    const substrateA = plainSubstrateFactory.create(TestSchema)
    const docA = interpretSubstrate(substrateA)

    // Set initial values and apply mutations
    change(docA, d => {
      d.title.insert(0, "Original")
      d.theme.set("dark")
    })
    change(docA, d => {
      d.title.insert(8, " Title")
      d.count.increment(42)
      d.items.push({ name: "Item 1", done: false })
    })

    const snapshot = substrateA.exportSnapshot()
    const substrateB = plainSubstrateFactory.fromSnapshot(snapshot, TestSchema)

    // Snapshots should be deeply equal
    const snapA = snapshotOf(substrateA)
    const snapB = snapshotOf(substrateB)
    expect(snapB).toEqual(snapA)
    expect(snapB.title).toBe("Original Title")
    expect(snapB.count).toBe(42)
    expect(snapB.items as unknown[]).toHaveLength(1)
  })

  it("delta round-trip: exportSince → importDelta → stores are equal", () => {
    // Both substrates start from the same snapshot (via fromSnapshot)
    const substrateA = plainSubstrateFactory.create(TestSchema)
    const docA = interpretSubstrate(substrateA)

    // Set shared initial state
    change(docA, d => {
      d.title.insert(0, "Shared")
    })

    // Create B from A's snapshot so they start with the same state
    const snapshot = substrateA.exportSnapshot()
    const substrateB = plainSubstrateFactory.fromSnapshot(snapshot, TestSchema)
    interpretSubstrate(substrateB)

    const f0 = substrateA.version()

    // Mutate A
    change(docA, d => {
      d.title.insert(6, "!")
      d.count.increment(10)
      d.items.push({ name: "New item", done: true })
    })

    // Export the delta and import into B
    const delta = substrateA.exportSince(f0)!
    substrateB.importDelta(delta, "sync")

    // Snapshots should match
    expect(snapshotOf(substrateB)).toEqual(snapshotOf(substrateA))
    expect(snapshotOf(substrateB).title).toBe("Shared!")
    expect(snapshotOf(substrateB).count).toBe(10)
  })

  it("importDelta with origin 'sync' — changefeed fires with origin 'sync'", () => {
    const substrateA = plainSubstrateFactory.create(TestSchema)
    const docA = interpretSubstrate(substrateA)

    const substrateB = plainSubstrateFactory.create(TestSchema)
    const docB = interpretSubstrate(substrateB)

    const f0 = substrateA.version()

    // Mutate A
    change(docA, d => d.title.insert(0, "Hello"))

    // Subscribe to B's changefeed before importing
    const received: Changeset<Op>[] = []
    subscribe(docB, cs => received.push(cs))

    // Import into B
    const delta = substrateA.exportSince(f0)!
    substrateB.importDelta(delta, "sync")

    // Changefeed should have fired with origin "sync"
    expect(received.length).toBeGreaterThanOrEqual(1)
    for (const cs of received) {
      expect(cs.origin).toBe("sync")
    }
  })

  it("importDelta increments the version", () => {
    const substrateA = plainSubstrateFactory.create(TestSchema)
    const docA = interpretSubstrate(substrateA)

    const substrateB = plainSubstrateFactory.create(TestSchema)
    interpretSubstrate(substrateB) // wire up the interpreter tree

    const f0 = substrateA.version()

    change(docA, d => d.count.increment(1))
    change(docA, d => d.count.increment(2))

    expect(substrateB.version().value).toBe(0)

    const delta = substrateA.exportSince(f0)!
    substrateB.importDelta(delta)

    // importDelta applies all ops in a single executeBatch call,
    // which triggers one prepare×N + flush×1 cycle → one version bump
    expect(substrateB.version().value).toBe(1)
  })

  it("importDelta with empty ops does not increment the version", () => {
    const substrate = plainSubstrateFactory.create(TestSchema)
    interpretSubstrate(substrate)

    const emptyPayload: SubstratePayload = { encoding: "json", data: "[]" }
    substrate.importDelta(emptyPayload)

    expect(substrate.version().value).toBe(0)
  })
})

// ===========================================================================
// Epoch boundaries
// ===========================================================================

describe("Epoch boundaries", () => {
  it("fromSnapshot creates a fresh epoch: version > 0, store matches source", () => {
    const substrateA = plainSubstrateFactory.create(TestSchema)
    const docA = interpretSubstrate(substrateA)

    // Set initial values and apply several mutations to advance the version
    change(docA, d => {
      d.title.insert(0, "Genesis")
      d.theme.set("light")
    })
    change(docA, d => d.title.insert(7, " v2"))
    change(docA, d => d.count.increment(100))
    change(docA, d => d.items.push({ name: "Task", done: false }))

    expect(substrateA.version().value).toBe(4)

    // Export snapshot and create a new substrate
    const snapshot = substrateA.exportSnapshot()
    const substrateB = plainSubstrateFactory.fromSnapshot(snapshot, TestSchema)

    // fromSnapshot uses executeBatch internally, so version > 0
    expect(substrateB.version().value).toBeGreaterThan(0)

    // But the snapshot matches the source's current state
    const snapA = snapshotOf(substrateA)
    const snapB = snapshotOf(substrateB)
    expect(snapB).toEqual(snapA)
    expect(snapB.title).toBe("Genesis v2")
    expect(snapB.count).toBe(100)
    expect(snapB.items as unknown[]).toHaveLength(1)
  })

  it("new epoch substrate is fully functional: can mutate, version, export", () => {
    const substrateA = plainSubstrateFactory.create(TestSchema)
    const docA = interpretSubstrate(substrateA)
    change(docA, d => {
      d.title.insert(0, "Source")
    })
    change(docA, d => d.count.increment(50))

    // Create new substrate from snapshot
    const snapshot = substrateA.exportSnapshot()
    const substrateB = plainSubstrateFactory.fromSnapshot(snapshot, TestSchema)
    const docB = interpretSubstrate(substrateB)

    // fromSnapshot produces version > 0 because it uses executeBatch
    const vAfterSnapshot = substrateB.version().value
    expect(vAfterSnapshot).toBeGreaterThan(0)

    // Mutate the new substrate
    change(docB, d => d.title.insert(6, "!"))
    expect(substrateB.version().value).toBe(vAfterSnapshot + 1)
    expect(snapshotOf(substrateB).title).toBe("Source!")

    // Export from the new substrate works
    const snapshot2 = substrateB.exportSnapshot()
    expect(JSON.parse(snapshot2.data as string).title).toBe("Source!")

    // Export delta since the snapshot epoch version
    const delta = substrateB.exportSince(new PlainVersion(vAfterSnapshot))!
    const ops = JSON.parse(delta.data as string) as Op[]
    expect(ops.length).toBe(1)
    expect(ops[0]?.change.type).toBe("text")
  })

  it("old and new epoch substrates are independent", () => {
    const substrateA = plainSubstrateFactory.create(TestSchema)
    const docA = interpretSubstrate(substrateA)
    change(docA, d => {
      d.title.insert(0, "Shared")
    })
    change(docA, d => d.count.increment(10))

    // Snapshot and create B
    const snapshot = substrateA.exportSnapshot()
    const substrateB = plainSubstrateFactory.fromSnapshot(snapshot, TestSchema)
    const docB = interpretSubstrate(substrateB)

    // Mutate A — should not affect B
    change(docA, d => d.title.insert(6, " from A"))
    expect(snapshotOf(substrateA).title).toBe("Shared from A")
    expect(snapshotOf(substrateB).title).toBe("Shared")

    // Mutate B — should not affect A
    change(docB, d => d.title.insert(6, " from B"))
    expect(snapshotOf(substrateB).title).toBe("Shared from B")
    expect(snapshotOf(substrateA).title).toBe("Shared from A")
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

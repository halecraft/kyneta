import type { Changeset } from "@kyneta/changefeed"
import { describe, expect, it } from "vitest"
import type { Op, Substrate, SubstratePayload } from "../index.js"
import {
  applyChanges,
  change,
  interpret,
  observation,
  PlainVersion,
  plainReplicaFactory,
  plainSubstrateFactory,
  readable,
  replicaTypesCompatible,
  Schema,
  subscribe,
  writable,
  Zero,
} from "../index.js"

// Helper: parse the store snapshot as a plain object for assertions.
// Exercises the public export API rather than reaching through to the
// backing Reader (which has no property access).
function snapshotOf(
  substrate: Substrate<PlainVersion>,
): Record<string, unknown> {
  return JSON.parse(substrate.exportEntirety().data as string) as Record<
    string,
    unknown
  >
}

// ===========================================================================
// Shared test schema
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

// Helper: create a full interpreter tree from a substrate
function interpretSubstrate(substrate: Substrate<PlainVersion>) {
  return interpret(TestSchema, substrate.context())
    .with(readable)
    .with(writable)
    .with(observation)
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

  it("version() starts at 1 for a freshly created substrate (init ops)", () => {
    const substrate = plainSubstrateFactory.create(TestSchema)
    const f = substrate.version()
    expect(f.value).toBe(1)
    expect(f.serialize()).toBe("1")
  })

  it("version() increments after mutations via the writable context", () => {
    const substrate = plainSubstrateFactory.create(TestSchema)
    const doc = interpretSubstrate(substrate)

    expect(substrate.version().value).toBe(1)

    // Each change() call triggers one flush cycle → one version bump
    change(doc, d => d.title.insert(0, "Hi"))
    expect(substrate.version().value).toBe(2)

    change(doc, d => d.count.increment(5))
    expect(substrate.version().value).toBe(3)

    // A multi-op transaction is a single flush cycle → one version bump
    change(doc, d => {
      d.title.insert(2, " there")
      d.count.increment(3)
    })
    expect(substrate.version().value).toBe(4)
  })

  it("version() does not increment for empty transactions", () => {
    const substrate = plainSubstrateFactory.create(TestSchema)
    const doc = interpretSubstrate(substrate)

    expect(substrate.version().value).toBe(1)

    // applyChanges with empty array should not bump version
    applyChanges(doc, [])
    expect(substrate.version().value).toBe(1)
  })

  it("version() is up-to-date inside a subscribe callback (notify-after-commit)", () => {
    const substrate = plainSubstrateFactory.create(TestSchema)
    const doc = interpretSubstrate(substrate)

    expect(substrate.version().value).toBe(1)

    // Track the version value observed inside the subscriber
    const observedVersions: number[] = []
    subscribe(doc, () => {
      observedVersions.push(substrate.version().value)
    })

    change(doc, d => d.title.insert(0, "A"))
    change(doc, d => d.count.increment(1))
    change(doc, d => d.title.insert(1, "B"))

    // Each subscriber call should see the version AFTER the flush,
    // not the stale version from before.
    expect(observedVersions).toEqual([2, 3, 4])
  })

  it("delta() returns the just-flushed ops inside a subscribe callback", () => {
    const substrate = plainSubstrateFactory.create(TestSchema)
    const doc = interpretSubstrate(substrate)

    // Track ops retrieved via delta() inside the subscriber
    const opsPerNotification: Op[][] = []
    let prevVersion = substrate.version().value
    subscribe(doc, () => {
      const currentVer = substrate.version().value
      const payload = substrate.exportSince(new PlainVersion(prevVersion))
      if (payload) {
        opsPerNotification.push((JSON.parse(payload.data as string) as Op[][]).flat())
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

  it("exportEntirety() returns a JSON payload matching the current store state", () => {
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

    const snapshot = substrate.exportEntirety()
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

  it("exportSince(version) returns null when version matches current version", () => {
    const substrate = plainSubstrateFactory.create(TestSchema)
    const doc = interpretSubstrate(substrate)

    change(doc, d => d.count.increment(1))

    const payload = substrate.exportSince(substrate.version())
    expect(payload).toBeNull()
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

    const batches = JSON.parse(payload?.data as string) as Op[][]
    const ops = batches.flat()
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
    expect(f1.value).toBe(2)

    change(doc, d => d.count.increment(1))
    expect(substrate.version().value).toBe(3)

    // exportSince(f1) should only contain the second mutation
    const payload = substrate.exportSince(f1)!
    const ops = (JSON.parse(payload.data as string) as Op[][]).flat()
    expect(ops.length).toBe(1)
    expect(ops[0]?.change.type).toBe("increment")
  })
})

// ===========================================================================
// Round-trip replication
// ===========================================================================

describe("Round-trip replication", () => {
  it("snapshot round-trip: exportEntirety → fromEntirety → stores are equal", () => {
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

    const snapshot = substrateA.exportEntirety()
    const substrateB = plainSubstrateFactory.fromEntirety(snapshot, TestSchema)

    // Snapshots should be deeply equal
    const snapA = snapshotOf(substrateA)
    const snapB = snapshotOf(substrateB)
    expect(snapB).toEqual(snapA)
    expect(snapB.title).toBe("Original Title")
    expect(snapB.count).toBe(42)
    expect(snapB.items as unknown[]).toHaveLength(1)
  })

  it("delta round-trip: exportSince → merge → stores are equal", () => {
    // Both substrates start from the same snapshot (via fromEntirety)
    const substrateA = plainSubstrateFactory.create(TestSchema)
    const docA = interpretSubstrate(substrateA)

    // Set shared initial state
    change(docA, d => {
      d.title.insert(0, "Shared")
    })

    // Create B from A's snapshot so they start with the same state
    const snapshot = substrateA.exportEntirety()
    const substrateB = plainSubstrateFactory.fromEntirety(snapshot, TestSchema)
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
    substrateB.merge(delta, "sync")

    // Snapshots should match
    expect(snapshotOf(substrateB)).toEqual(snapshotOf(substrateA))
    expect(snapshotOf(substrateB).title).toBe("Shared!")
    expect(snapshotOf(substrateB).count).toBe(10)
  })

  it("merge with origin 'sync' — changefeed fires with origin 'sync'", () => {
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
    substrateB.merge(delta, "sync")

    // Changefeed should have fired with origin "sync"
    expect(received.length).toBeGreaterThanOrEqual(1)
    for (const cs of received) {
      expect(cs.origin).toBe("sync")
    }
  })

  it("merge increments the version", () => {
    const substrateA = plainSubstrateFactory.create(TestSchema)
    const docA = interpretSubstrate(substrateA)

    const substrateB = plainSubstrateFactory.create(TestSchema)
    interpretSubstrate(substrateB) // wire up the interpreter tree

    const f0 = substrateA.version()

    change(docA, d => d.count.increment(1))
    change(docA, d => d.count.increment(2))

    expect(substrateB.version().value).toBe(1)

    const delta = substrateA.exportSince(f0)!
    substrateB.merge(delta)

    // merge preserves batch boundaries — each batch is a separate
    // executeBatch call → 2 version bumps (one per change on A).
    // B starts at 1 (init) + 2 merged batches = 3.
    expect(substrateB.version().value).toBe(3)
  })

  it("merge with empty ops does not increment the version", () => {
    const substrate = plainSubstrateFactory.create(TestSchema)
    interpretSubstrate(substrate)

    const emptyPayload: SubstratePayload = {
      kind: "since",
      encoding: "json",
      data: "[]",
    }
    substrate.merge(emptyPayload)

    expect(substrate.version().value).toBe(1)
  })
})

// ===========================================================================
// merge with kind: "entirety" — live state absorption
// ===========================================================================

describe("merge with entirety payload (PlainSubstrate)", () => {
  it("absorbs a state image and updates the store", () => {
    const substrate = plainSubstrateFactory.create(TestSchema)
    const doc = interpretSubstrate(substrate)

    change(doc, d => d.title.insert(0, "Original"))
    change(doc, d => d.count.increment(5))

    // Build an entirety payload representing different state
    const entirety: SubstratePayload = {
      kind: "entirety",
      encoding: "json",
      data: JSON.stringify({
        title: "Replaced",
        count: 99,
        theme: "dark",
        items: [],
      }),
    }
    substrate.merge(entirety, "sync")

    const snap = snapshotOf(substrate)
    expect(snap.title).toBe("Replaced")
    expect(snap.count).toBe(99)
    expect(snap.theme).toBe("dark")
  })

  it("preserves ref identity after entirety merge", () => {
    const substrate = plainSubstrateFactory.create(TestSchema)
    const doc = interpretSubstrate(substrate)

    // Capture the ref before merge
    const refBefore = doc

    change(doc, d => d.title.insert(0, "Before"))

    const entirety: SubstratePayload = {
      kind: "entirety",
      encoding: "json",
      data: JSON.stringify({
        title: "After",
        count: 0,
        theme: "light",
        items: [],
      }),
    }
    substrate.merge(entirety, "sync")

    // The ref object is still the same identity
    expect(refBefore).toBe(doc)
    // And reads the new state
    expect(doc.title()).toBe("After")
  })

  it("fires changefeed with origin on entirety merge", () => {
    const substrate = plainSubstrateFactory.create(TestSchema)
    const doc = interpretSubstrate(substrate)

    const received: { origin?: string }[] = []
    subscribe(doc, cs => received.push({ origin: cs.origin }))

    const entirety: SubstratePayload = {
      kind: "entirety",
      encoding: "json",
      data: JSON.stringify({
        title: "Synced",
        count: 42,
        theme: "dark",
        items: [],
      }),
    }
    substrate.merge(entirety, "sync")

    expect(received.length).toBeGreaterThanOrEqual(1)
    for (const cs of received) {
      expect(cs.origin).toBe("sync")
    }
  })

  it("bumps version after entirety merge", () => {
    const substrate = plainSubstrateFactory.create(TestSchema)
    interpretSubstrate(substrate)

    expect(substrate.version().value).toBe(1)

    const entirety: SubstratePayload = {
      kind: "entirety",
      encoding: "json",
      data: JSON.stringify({ title: "V1", count: 1, theme: "", items: [] }),
    }
    substrate.merge(entirety)

    expect(substrate.version().value).toBeGreaterThan(0)
  })

  it("empty state image does not bump version", () => {
    const substrate = plainSubstrateFactory.create(TestSchema)
    interpretSubstrate(substrate)

    const entirety: SubstratePayload = {
      kind: "entirety",
      encoding: "json",
      data: JSON.stringify({}),
    }
    substrate.merge(entirety)

    expect(substrate.version().value).toBe(1)
  })
})

describe("merge with entirety payload (PlainReplica)", () => {
  it("absorbs a state image into a replica", () => {
    const replica = plainReplicaFactory.createEmpty()

    const entirety: SubstratePayload = {
      kind: "entirety",
      encoding: "json",
      data: JSON.stringify({ title: "Hello", count: 7 }),
    }
    replica.merge(entirety)

    // The replica should now serve the new state via exportEntirety
    const snap = replica.exportEntirety()
    const state = JSON.parse(snap.data as string)
    expect(state.title).toBe("Hello")
    expect(state.count).toBe(7)
  })

  it("bumps version after entirety merge on replica", () => {
    const replica = plainReplicaFactory.createEmpty()
    expect(replica.version().value).toBe(0)

    const entirety: SubstratePayload = {
      kind: "entirety",
      encoding: "json",
      data: JSON.stringify({ title: "V1" }),
    }
    replica.merge(entirety)

    expect(replica.version().value).toBeGreaterThan(0)
  })

  it("handles since and entirety payloads on the same replica", () => {
    // Start with entirety
    const replica = plainReplicaFactory.createEmpty()
    const entirety: SubstratePayload = {
      kind: "entirety",
      encoding: "json",
      data: JSON.stringify({ title: "Start", count: 0 }),
    }
    replica.merge(entirety)

    const v1 = replica.version()

    // Now create a substrate, mutate, and send a since payload
    const source = plainSubstrateFactory.create(TestSchema)
    const doc = interpretSubstrate(source)
    change(doc, d => d.title.insert(0, "Start"))
    change(doc, d => d.count.increment(5))

    const since = source.exportSince(new PlainVersion(0))!
    expect(since.kind).toBe("since")
    replica.merge(since)

    expect(replica.version().value).toBeGreaterThan(v1.value)
  })
})

// ===========================================================================
// Epoch boundaries
// ===========================================================================

describe("Epoch boundaries", () => {
  it("fromEntirety creates a fresh epoch: version > 0, store matches source", () => {
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

    expect(substrateA.version().value).toBe(5)

    // Export snapshot and create a new substrate
    const snapshot = substrateA.exportEntirety()
    const substrateB = plainSubstrateFactory.fromEntirety(snapshot, TestSchema)

    // fromEntirety uses executeBatch internally, so version > 0
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
    const snapshot = substrateA.exportEntirety()
    const substrateB = plainSubstrateFactory.fromEntirety(snapshot, TestSchema)
    const docB = interpretSubstrate(substrateB)

    // fromEntirety produces version > 0 because it uses executeBatch
    const vAfterSnapshot = substrateB.version().value
    expect(vAfterSnapshot).toBeGreaterThan(0)

    // Mutate the new substrate
    change(docB, d => d.title.insert(6, "!"))
    expect(substrateB.version().value).toBe(vAfterSnapshot + 1)
    expect(snapshotOf(substrateB).title).toBe("Source!")

    // Export from the new substrate works
    const snapshot2 = substrateB.exportEntirety()
    expect(JSON.parse(snapshot2.data as string).title).toBe("Source!")

    // Export delta since the snapshot epoch version
    const delta = substrateB.exportSince(new PlainVersion(vAfterSnapshot))!
    const ops = (JSON.parse(delta.data as string) as Op[][]).flat()
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
    const snapshot = substrateA.exportEntirety()
    const substrateB = plainSubstrateFactory.fromEntirety(snapshot, TestSchema)
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

// ===========================================================================
// ReplicaType
// ===========================================================================

describe("replicaTypesCompatible", () => {
  it("same name and version → true", () => {
    expect(replicaTypesCompatible(["yjs", 1, 0], ["yjs", 1, 0])).toBe(true)
  })

  it("minor mismatch → true (backwards-compatible)", () => {
    expect(replicaTypesCompatible(["yjs", 1, 0], ["yjs", 1, 1])).toBe(true)
  })

  it("major mismatch → false", () => {
    expect(replicaTypesCompatible(["yjs", 1, 0], ["yjs", 2, 0])).toBe(false)
  })

  it("name mismatch → false", () => {
    expect(replicaTypesCompatible(["yjs", 1, 0], ["loro", 1, 0])).toBe(false)
  })
})

describe("ReplicaFactory.replicaType", () => {
  it("plainReplicaFactory identifies as plain", () => {
    expect(plainReplicaFactory.replicaType).toEqual(["plain", 1, 0])
  })
})

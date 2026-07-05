import type { Changeset } from "@kyneta/changefeed"
import { describe, expect, it } from "vitest"
import type { Op, Substrate, SubstratePayload } from "../index.js"
import {
  applyChanges,
  batch,
  interpret,
  observation,
  PlainVersion,
  plainReplicaFactory,
  plainSubstrateFactory,
  readable,
  replicaTypesCompatible,
  requiresBidirectionalSync,
  Schema,
  SYNC_AUTHORITATIVE,
  SYNC_COLLABORATIVE,
  SYNC_EPHEMERAL,
  subscribe,
  writable,
  Zero,
} from "../index.js"
import {
  createPlainReplica,
  createPlainSubstrate,
  createPlainVersionStrategy,
  DEFAULT_INCARNATION,
  LEGACY_INCARNATION,
  parsePlainPayload,
} from "../substrates/plain.js"

// Helper: parse the store snapshot as a plain object for assertions.
// Exercises the public export API rather than reaching through to the
// backing Reader (which has no property access).
function snapshotOf(
  substrate: Substrate<PlainVersion>,
): Record<string, unknown> {
  const parsed = JSON.parse(substrate.exportEntirety().data as string)
  if (parsed && typeof parsed === "object" && "i" in parsed && "s" in parsed) {
    return parsed.s as Record<string, unknown>
  }
  return parsed as Record<string, unknown>
}

// ===========================================================================
// Shared test schema
// ===========================================================================

const TestSchema = Schema.struct({
  title: Schema.text(),
  count: Schema.counter(),
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
    expect(new PlainVersion(0, "test").serialize()).toBe("test:0")
    expect(new PlainVersion(42, "test").serialize()).toBe("test:42")
    expect(new PlainVersion(1000, "test").serialize()).toBe("test:1000")
  })

  it("compare() correctly reports behind/equal/ahead", () => {
    const f0 = new PlainVersion(0, "test")
    const f1 = new PlainVersion(1, "test")
    const f5 = new PlainVersion(5, "test")

    expect(f0.compare(f1)).toBe("behind")
    expect(f1.compare(f0)).toBe("ahead")
    expect(f0.compare(f0)).toBe("equal")
    expect(f5.compare(f5)).toBe("equal")
    expect(f1.compare(f5)).toBe("behind")
    expect(f5.compare(f1)).toBe("ahead")
  })

  it("compare() never returns 'concurrent' for the same incarnation", () => {
    // Plain substrates have a total order — exhaustively check
    // a range of values to verify "concurrent" never appears.
    const values = [0, 1, 2, 5, 10, 100]
    for (const a of values) {
      for (const b of values) {
        const result = new PlainVersion(a, "test").compare(
          new PlainVersion(b, "test"),
        )
        expect(result).not.toBe("concurrent")
        if (a < b) expect(result).toBe("behind")
        else if (a > b) expect(result).toBe("ahead")
        else expect(result).toBe("equal")
      }
    }
  })

  it("compare() returns 'concurrent' across two REAL incarnations, both directions", () => {
    const a1 = new PlainVersion(1, "inc-a")
    const a5 = new PlainVersion(5, "inc-a")
    const b1 = new PlainVersion(1, "inc-b")
    const b5 = new PlainVersion(5, "inc-b")

    expect(a1.compare(b1)).toBe("concurrent")
    expect(b1.compare(a1)).toBe("concurrent")
    expect(a5.compare(b1)).toBe("concurrent")
    expect(a1.compare(b5)).toBe("concurrent")
  })

  it("compare() is a total order when both sides are DEFAULT_INCARNATION", () => {
    const d0 = new PlainVersion(0, DEFAULT_INCARNATION)
    const d1 = new PlainVersion(1, DEFAULT_INCARNATION)

    expect(d0.compare(d1)).toBe("behind")
    expect(d1.compare(d0)).toBe("ahead")
    expect(d0.compare(d0)).toBe("equal")
  })

  it("compare(): DEFAULT is never ahead of REAL, REAL is never behind DEFAULT", () => {
    const def0 = new PlainVersion(0, DEFAULT_INCARNATION)
    const def5 = new PlainVersion(5, DEFAULT_INCARNATION)
    const real1 = new PlainVersion(1, "inc-real")
    const real5 = new PlainVersion(5, "inc-real")

    // DEFAULT(0) behind REAL(1) by value — still resolves via the DEFAULT branch.
    expect(def0.compare(real1)).toBe("behind")
    expect(real1.compare(def0)).toBe("ahead")

    // DEFAULT can never be reported as "ahead" of REAL, even with a larger value —
    // it degrades to "equal" rather than asserting a false ordering.
    expect(def5.compare(real1)).toBe("equal")
    // Symmetric: REAL can never be reported "behind" DEFAULT.
    expect(real1.compare(def5)).toBe("equal")

    expect(def0.compare(real5)).toBe("behind")
    expect(real5.compare(def0)).toBe("ahead")
  })

  it("round-trip: parseVersion(f.serialize()) compares equal to f", () => {
    const original = new PlainVersion(7, "test")
    const roundTripped = plainSubstrateFactory.parseVersion(
      original.serialize(),
    )
    expect(roundTripped.compare(original)).toBe("equal")
    expect(original.compare(roundTripped)).toBe("equal")
    expect(roundTripped.value).toBe(7)
  })

  it("parseVersion handles the legacy bare-integer format", () => {
    const v = plainSubstrateFactory.parseVersion("5")
    expect(v.value).toBe(5)
    expect(v.incarnation).toBe(LEGACY_INCARNATION)
  })

  it("parseVersion handles the new 'incarnation:value' format", () => {
    const v = plainSubstrateFactory.parseVersion("abc123:5")
    expect(v.value).toBe(5)
    expect(v.incarnation).toBe("abc123")
  })

  it("parseVersion rejects invalid input", () => {
    expect(() => plainSubstrateFactory.parseVersion("abc")).toThrow()
    expect(() => plainSubstrateFactory.parseVersion("-1")).toThrow()
    expect(() => plainSubstrateFactory.parseVersion("1.5")).toThrow()
    expect(() => plainSubstrateFactory.parseVersion("")).toThrow()
  })

  it("value getter exposes the raw integer", () => {
    expect(new PlainVersion(0, "test").value).toBe(0)
    expect(new PlainVersion(99, "test").value).toBe(99)
  })
})

describe("PlainVersion.meet()", () => {
  it("returns the minimum of two versions", () => {
    const v3 = new PlainVersion(3, "test")
    const v5 = new PlainVersion(5, "test")
    const meet = v3.meet(v5)
    expect(meet).toBeInstanceOf(PlainVersion)
    expect((meet as PlainVersion).value).toBe(3)
  })

  it("is commutative", () => {
    const a = new PlainVersion(3, "test")
    const b = new PlainVersion(7, "test")
    expect((a.meet(b) as PlainVersion).value).toBe(
      (b.meet(a) as PlainVersion).value,
    )
  })

  it("is idempotent", () => {
    const v = new PlainVersion(5, "test")
    expect((v.meet(v) as PlainVersion).value).toBe(5)
  })

  it("meet with zero returns zero", () => {
    const v = new PlainVersion(5, "test")
    const z = new PlainVersion(0, "test")
    expect((v.meet(z) as PlainVersion).value).toBe(0)
  })

  it("result is always ≤ both operands", () => {
    const pairs = [
      [0, 0],
      [0, 5],
      [3, 7],
      [10, 10],
      [100, 1],
    ]
    for (const [a, b] of pairs) {
      const va = new PlainVersion(a, "test")
      const vb = new PlainVersion(b, "test")
      const m = va.meet(vb) as PlainVersion
      expect(m.compare(va)).not.toBe("ahead")
      expect(m.compare(vb)).not.toBe("ahead")
    }
  })

  it("cross-incarnation meet produces a deterministic zero at the lexicographically-min incarnation", () => {
    const a = new PlainVersion(5, "inc-a")
    const b = new PlainVersion(3, "inc-b")

    const ab = a.meet(b) as PlainVersion
    const ba = b.meet(a) as PlainVersion

    expect(ab.value).toBe(0)
    expect(ba.value).toBe(0)
    // Commutative: both orders pick the same (lexicographically smaller) incarnation.
    expect(ab.incarnation).toBe("inc-a")
    expect(ba.incarnation).toBe("inc-a")
  })

  it("DEFAULT-vs-REAL meet subsumes at the REAL incarnation's root", () => {
    const def = new PlainVersion(3, DEFAULT_INCARNATION)
    const real = new PlainVersion(7, "inc-real")

    const defReal = def.meet(real) as PlainVersion
    const realDef = real.meet(def) as PlainVersion

    expect(defReal.value).toBe(0)
    expect(defReal.incarnation).toBe("inc-real")
    expect(realDef.value).toBe(0)
    expect(realDef.incarnation).toBe("inc-real")
  })
})

// ===========================================================================
// createPlainVersionStrategy
// ===========================================================================

describe("createPlainVersionStrategy", () => {
  it("current(flushCount) embeds the strategy's incarnation", () => {
    // A non-DEFAULT initial incarnation never lazy-mints — current() just
    // stamps every produced version with it, regardless of flushCount.
    const { strategy } = createPlainVersionStrategy("inc-fixed")
    const v1 = strategy.current(1)
    const v5 = strategy.current(5)
    expect(v1.incarnation).toBe("inc-fixed")
    expect(v1.value).toBe(1)
    expect(v5.incarnation).toBe("inc-fixed")
    expect(v5.value).toBe(5)
  })

  it("logOffset returns null for a since-version from a different REAL incarnation", () => {
    const { strategy } = createPlainVersionStrategy("inc-a")
    // Force past DEFAULT so the strategy's incarnation is REAL for this test's
    // purposes — "inc-a" is already REAL (not DEFAULT_INCARNATION).
    const since = new PlainVersion(2, "inc-b")
    expect(strategy.logOffset(since)).toBeNull()
  })

  it("logOffset returns the value for a same-incarnation since-version", () => {
    const { strategy } = createPlainVersionStrategy("inc-a")
    const since = new PlainVersion(2, "inc-a")
    expect(strategy.logOffset(since)).toBe(2)
  })

  it("logOffset treats DEFAULT_INCARNATION as a universal prefix regardless of current incarnation", () => {
    const { strategy } = createPlainVersionStrategy("inc-a")
    const since = new PlainVersion(3, DEFAULT_INCARNATION)
    expect(strategy.logOffset(since)).toBe(3)
  })

  it("adoptIncarnation updates subsequent current()/zero output", () => {
    const { strategy, adoptIncarnation } = createPlainVersionStrategy("inc-a")
    expect(strategy.zero.incarnation).toBe("inc-a")

    adoptIncarnation("inc-b")

    expect(strategy.zero.incarnation).toBe("inc-b")
    expect(strategy.current(5).incarnation).toBe("inc-b")
  })

  it("getIncarnation reflects the live incarnation, including after lazy-mint", () => {
    const { strategy, getIncarnation } =
      createPlainVersionStrategy(DEFAULT_INCARNATION)
    expect(getIncarnation()).toBe(DEFAULT_INCARNATION)

    // flushCount=1 is init-ops-only — stays DEFAULT.
    strategy.current(1)
    expect(getIncarnation()).toBe(DEFAULT_INCARNATION)

    // flushCount=2 is the first real write — lazily mints a REAL incarnation.
    strategy.current(2)
    const minted = getIncarnation()
    expect(minted).not.toBe(DEFAULT_INCARNATION)

    // The minted incarnation is stable across subsequent flushes.
    strategy.current(3)
    expect(getIncarnation()).toBe(minted)
  })
})

// ===========================================================================
// parsePlainPayload
// ===========================================================================

describe("parsePlainPayload", () => {
  it("extracts { incarnation, content } from the new entirety envelope", () => {
    const data = JSON.stringify({ i: "inc-a", s: { title: "Hi" } })
    const { incarnation, content } = parsePlainPayload(data)
    expect(incarnation).toBe("inc-a")
    expect(content).toEqual({ title: "Hi" })
  })

  it("extracts { incarnation, content } from the new since (batched-ops) envelope", () => {
    const data = JSON.stringify({ i: "inc-a", b: [[{ foo: "bar" }]] })
    const { incarnation, content } = parsePlainPayload(data)
    expect(incarnation).toBe("inc-a")
    expect(content).toEqual([[{ foo: "bar" }]])
  })

  it("returns { incarnation: undefined, content } for a legacy bare-object payload", () => {
    const data = JSON.stringify({ title: "Hi" })
    const { incarnation, content } = parsePlainPayload(data)
    expect(incarnation).toBeUndefined()
    expect(content).toEqual({ title: "Hi" })
  })

  it("returns { incarnation: undefined, content } for a legacy bare-array payload", () => {
    const data = JSON.stringify([[{ foo: "bar" }]])
    const { incarnation, content } = parsePlainPayload(data)
    expect(incarnation).toBeUndefined()
    expect(content).toEqual([[{ foo: "bar" }]])
  })
})

// ===========================================================================
// Substrate lifecycle
// ===========================================================================

describe("PlainSubstrate lifecycle", () => {
  it("create(schema) then batch() produces a substrate with initial values", () => {
    const substrate = plainSubstrateFactory.create(TestSchema)
    const doc = interpretSubstrate(substrate)

    batch(doc, d => {
      d.title.insert(0, "Hello")
      d.theme.set("dark")
    })

    const snap = snapshotOf(substrate)
    // Values set via batch()
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
    expect(f.serialize()).toBe(
      `${(substrate.version() as PlainVersion).incarnation}:1`,
    )
  })

  it("version() increments after mutations via the writable context", () => {
    const substrate = plainSubstrateFactory.create(TestSchema)
    const doc = interpretSubstrate(substrate)

    expect(substrate.version().value).toBe(1)

    // Each batch() call triggers one flush cycle → one version bump
    batch(doc, d => d.title.insert(0, "Hi"))
    expect(substrate.version().value).toBe(2)

    batch(doc, d => d.count.increment(5))
    expect(substrate.version().value).toBe(3)

    // A multi-op transaction is a single flush cycle → one version bump
    batch(doc, d => {
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

    batch(doc, d => d.title.insert(0, "A"))
    batch(doc, d => d.count.increment(1))
    batch(doc, d => d.title.insert(1, "B"))

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
      const payload = substrate.exportSince(
        new PlainVersion(
          prevVersion,
          (substrate.version() as PlainVersion).incarnation,
        ),
      )
      if (payload) {
        opsPerNotification.push(
          (
            ((JSON.parse(payload.data as string) as any).b ||
              JSON.parse(payload.data as string)) as Op[][]
          ).flat(),
        )
      }
      prevVersion = currentVer
    })

    batch(doc, d => d.title.insert(0, "Hi"))
    batch(doc, d => d.count.increment(5))

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

    // Set initial values via batch(), then mutate further
    batch(doc, d => {
      d.title.insert(0, "Test")
      d.theme.set("light")
    })
    batch(doc, d => {
      d.title.insert(4, "!")
      d.count.increment(10)
    })

    const snapshot = substrate.exportEntirety()
    expect(snapshot.encoding).toBe("json")
    expect(typeof snapshot.data).toBe("string")

    const parsed =
      (JSON.parse(snapshot.data as string) as any).s ||
      JSON.parse(snapshot.data as string)
    expect(parsed).toEqual(snapshotOf(substrate))
    expect(parsed.title).toBe("Test!")
    expect(parsed.count).toBe(10)
  })

  it("exportSince(version) returns null when version is ahead", () => {
    const substrate = plainSubstrateFactory.create(TestSchema)
    const futureVersion = new PlainVersion(
      999,
      (substrate.version() as PlainVersion).incarnation,
    )
    expect(substrate.exportSince(futureVersion)).toBeNull()
  })

  it("exportSince(version) returns null when version matches current version", () => {
    const substrate = plainSubstrateFactory.create(TestSchema)
    const doc = interpretSubstrate(substrate)

    batch(doc, d => d.count.increment(1))

    const payload = substrate.exportSince(substrate.version())
    expect(payload).toBeNull()
  })

  it("exportSince(version) returns ops when version is behind", () => {
    const substrate = plainSubstrateFactory.create(TestSchema)
    const doc = interpretSubstrate(substrate)

    const f0 = substrate.version()
    batch(doc, d => d.title.insert(0, "A"))
    batch(doc, d => d.count.increment(1))

    const payload = substrate.exportSince(f0)
    expect(payload).not.toBeNull()
    expect(payload?.encoding).toBe("json")

    const batches = ((JSON.parse(payload?.data as string) as any).b ||
      JSON.parse(payload?.data as string)) as Op[][]
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

    batch(doc, d => d.title.insert(0, "A"))
    const f1 = substrate.version()
    expect(f1.value).toBe(2)

    batch(doc, d => d.count.increment(1))
    expect(substrate.version().value).toBe(3)

    // exportSince(f1) should only contain the second mutation
    const payload = substrate.exportSince(f1) as any
    const ops = (
      ((JSON.parse(payload.data as string) as any).b ||
        JSON.parse(payload.data as string)) as Op[][]
    ).flat()
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
    batch(docA, d => {
      d.title.insert(0, "Original")
      d.theme.set("dark")
    })
    batch(docA, d => {
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
    batch(docA, d => {
      d.title.insert(0, "Shared")
    })

    // Create B from A's snapshot so they start with the same state
    const snapshot = substrateA.exportEntirety()
    const substrateB = plainSubstrateFactory.fromEntirety(snapshot, TestSchema)
    interpretSubstrate(substrateB)

    const f0 = substrateA.version()

    // Mutate A
    batch(docA, d => {
      d.title.insert(6, "!")
      d.count.increment(10)
      d.items.push({ name: "New item", done: true })
    })

    // Export the delta and import into B
    const delta = substrateA.exportSince(f0) as any
    substrateB.merge(delta, { origin: "sync" })

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
    batch(docA, d => d.title.insert(0, "Hello"))

    // Subscribe to B's changefeed before importing
    const received: Changeset<Op>[] = []
    subscribe(docB, cs => received.push(cs))

    // Import into B
    const delta = substrateA.exportSince(f0) as any
    substrateB.merge(delta, { origin: "sync" })

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

    batch(docA, d => d.count.increment(1))
    batch(docA, d => d.count.increment(2))

    expect(substrateB.version().value).toBe(1)

    const delta = substrateA.exportSince(f0) as any
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

    batch(doc, d => d.title.insert(0, "Original"))
    batch(doc, d => d.count.increment(5))

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
    substrate.merge(entirety, { origin: "sync" })

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

    batch(doc, d => d.title.insert(0, "Before"))

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
    substrate.merge(entirety, { origin: "sync" })

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
    substrate.merge(entirety, { origin: "sync" })

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
    const state =
      (JSON.parse(snap.data as string) as any).s ||
      JSON.parse(snap.data as string)
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
    batch(doc, d => d.title.insert(0, "Start"))
    batch(doc, d => d.count.increment(5))

    const since = source.exportSince(
      new PlainVersion(0, (source.version() as PlainVersion).incarnation),
    ) as any
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
    batch(docA, d => {
      d.title.insert(0, "Genesis")
      d.theme.set("light")
    })
    batch(docA, d => d.title.insert(7, " v2"))
    batch(docA, d => d.count.increment(100))
    batch(docA, d => d.items.push({ name: "Task", done: false }))

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
    batch(docA, d => {
      d.title.insert(0, "Source")
    })
    batch(docA, d => d.count.increment(50))

    // Create new substrate from snapshot
    const snapshot = substrateA.exportEntirety()
    const substrateB = plainSubstrateFactory.fromEntirety(snapshot, TestSchema)
    const docB = interpretSubstrate(substrateB)

    // fromEntirety produces version > 0 because it uses executeBatch
    const vAfterSnapshot = substrateB.version().value
    expect(vAfterSnapshot).toBeGreaterThan(0)

    // Mutate the new substrate
    batch(docB, d => d.title.insert(6, "!"))
    expect(substrateB.version().value).toBe(vAfterSnapshot + 1)
    expect(snapshotOf(substrateB).title).toBe("Source!")

    // Export from the new substrate works
    const snapshot2 = substrateB.exportEntirety()
    expect((JSON.parse(snapshot2.data as string) as any).s.title).toBe(
      "Source!",
    )

    // Export delta since the snapshot epoch version
    const delta = substrateB.exportSince(
      new PlainVersion(
        vAfterSnapshot,
        (substrateB.version() as PlainVersion).incarnation,
      ),
    ) as any
    const batches = ((JSON.parse(delta.data as string) as any).b ||
      JSON.parse(delta.data as string)) as Op[][]
    const ops = batches.flat()
    expect(ops.length).toBe(1)
    expect(ops[0]?.change.type).toBe("text")
  })

  it("old and new epoch substrates are independent", () => {
    const substrateA = plainSubstrateFactory.create(TestSchema)
    const docA = interpretSubstrate(substrateA)
    batch(docA, d => {
      d.title.insert(0, "Shared")
    })
    batch(docA, d => d.count.increment(10))

    // Snapshot and create B
    const snapshot = substrateA.exportEntirety()
    const substrateB = plainSubstrateFactory.fromEntirety(snapshot, TestSchema)
    const docB = interpretSubstrate(substrateB)

    // Mutate A — should not affect B
    batch(docA, d => d.title.insert(6, " from A"))
    expect(snapshotOf(substrateA).title).toBe("Shared from A")
    expect(snapshotOf(substrateB).title).toBe("Shared")

    // Mutate B — should not affect A
    batch(docB, d => d.title.insert(6, " from B"))
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

// ===========================================================================
// advance() — history trimming
// ===========================================================================

describe("PlainReplica.advance()", () => {
  it("advance to current version (full projection) clears the log", () => {
    const replica = plainReplicaFactory.createEmpty()
    const source = plainSubstrateFactory.create(TestSchema)
    const doc = interpretSubstrate(source)

    batch(doc, d => d.title.insert(0, "Hello"))
    batch(doc, d => d.count.increment(5))

    // Merge source ops into replica
    const delta = source.exportSince(
      new PlainVersion(0, (source.version() as PlainVersion).incarnation),
    ) as any
    replica.merge(delta)

    expect(replica.version().value).toBeGreaterThan(0)
    const vBefore = replica.version()

    // Advance to current version (full projection)
    replica.advance(replica.version())

    // Version unchanged, base now equals version
    expect(replica.version().value).toBe(vBefore.value)
    expect(replica.baseVersion().value).toBe(vBefore.value)

    // exportSince(v0) returns null — history is gone
    expect(
      replica.exportSince(
        new PlainVersion(0, (replica.version() as PlainVersion).incarnation),
      ),
    ).toBeNull()

    // exportEntirety still works
    const entirety = replica.exportEntirety()
    const parsed =
      (JSON.parse(entirety.data as string) as any).s ||
      JSON.parse(entirety.data as string)
    expect(parsed.title).toBe("Hello")
    expect(parsed.count).toBe(5)
  })

  it("partial trim: advance to midpoint preserves remaining ops", () => {
    const replica = plainReplicaFactory.createEmpty()
    const source = plainSubstrateFactory.create(TestSchema)
    const doc = interpretSubstrate(source)

    batch(doc, d => d.title.insert(0, "A"))
    const v2 = source.version()
    batch(doc, d => d.count.increment(1))
    batch(doc, d => d.theme.set("dark"))
    const v4 = source.version()

    // Merge all ops into replica
    const delta = source.exportSince(
      new PlainVersion(0, (source.version() as PlainVersion).incarnation),
    ) as any
    replica.merge(delta)
    expect(replica.version().value).toBe(v4.value)

    // Advance to v2 — trims first 2 flush cycles
    replica.advance(v2)

    expect(replica.baseVersion().value).toBe(v2.value)
    expect(replica.version().value).toBe(v4.value) // version unchanged

    // exportSince(v0) = null (behind base)
    expect(
      replica.exportSince(
        new PlainVersion(0, (replica.version() as PlainVersion).incarnation),
      ),
    ).toBeNull()
    // exportSince(v2) = remaining ops
    expect(replica.exportSince(v2)).not.toBeNull()

    // State is still complete
    const snap =
      (JSON.parse(replica.exportEntirety().data as string) as any).s ||
      JSON.parse(replica.exportEntirety().data as string)
    expect(snap.title).toBe("A")
    expect(snap.count).toBe(1)
    expect(snap.theme).toBe("dark")
  })

  it("advance preserves ongoing operation — new ops can be appended after advance", () => {
    const replica = plainReplicaFactory.createEmpty()
    const source = plainSubstrateFactory.create(TestSchema)
    const doc = interpretSubstrate(source)

    batch(doc, d => d.title.insert(0, "Before"))
    const v2 = source.version()

    const delta1 = source.exportSince(
      new PlainVersion(0, (source.version() as PlainVersion).incarnation),
    ) as any
    replica.merge(delta1)
    replica.advance(v2)

    // New ops after advance
    batch(doc, d => d.count.increment(99))
    const delta2 = source.exportSince(v2) as any
    replica.merge(delta2)

    // exportSince from base returns the new ops
    const since = replica.exportSince(v2)
    expect(since).not.toBeNull()

    // Full state includes both pre-advance and post-advance data
    const snap =
      (JSON.parse(replica.exportEntirety().data as string) as any).s ||
      JSON.parse(replica.exportEntirety().data as string)
    expect(snap.title).toBe("Before")
    expect(snap.count).toBe(99)
  })

  it("advance precondition: target beyond current version throws", () => {
    const replica = plainReplicaFactory.createEmpty()
    expect(() =>
      replica.advance(
        new PlainVersion(999, (replica.version() as PlainVersion).incarnation),
      ),
    ).toThrow()
  })

  it("exportSince returns null for versions behind the base after advance", () => {
    const replica = plainReplicaFactory.createEmpty()
    const source = plainSubstrateFactory.create(TestSchema)
    const doc = interpretSubstrate(source)

    batch(doc, d => d.title.insert(0, "A"))
    const v2 = source.version()
    batch(doc, d => d.count.increment(1))
    batch(doc, d => d.theme.set("dark"))

    replica.merge(
      source.exportSince(
        new PlainVersion(0, (source.version() as PlainVersion).incarnation),
      ) as any,
    )

    // Before advance, exportSince(v0) works
    expect(
      replica.exportSince(
        new PlainVersion(0, (replica.version() as PlainVersion).incarnation),
      ),
    ).not.toBeNull()

    // Advance past v0
    replica.advance(v2)

    // After advance, v0 is behind base → null
    expect(
      replica.exportSince(
        new PlainVersion(0, (replica.version() as PlainVersion).incarnation),
      ),
    ).toBeNull()
    expect(
      replica.exportSince(
        new PlainVersion(1, (replica.version() as PlainVersion).incarnation),
      ),
    ).toBeNull()

    // v2 (the base) still works
    expect(replica.exportSince(v2)).not.toBeNull()

    // exportEntirety always works (returns current state)
    const snap =
      (JSON.parse(replica.exportEntirety().data as string) as any).s ||
      JSON.parse(replica.exportEntirety().data as string)
    expect(snap.title).toBe("A")
  })

  it("round-trip: advance → exportEntirety → new replica has correct state", () => {
    const replica = plainReplicaFactory.createEmpty()
    const source = plainSubstrateFactory.create(TestSchema)
    const doc = interpretSubstrate(source)

    batch(doc, d => d.title.insert(0, "Test"))
    batch(doc, d => d.count.increment(42))

    replica.merge(
      source.exportSince(
        new PlainVersion(0, (source.version() as PlainVersion).incarnation),
      ) as any,
    )
    replica.advance(replica.version())

    // Create a new replica from the trimmed entirety
    const entirety = replica.exportEntirety()
    const replica2 = plainReplicaFactory.fromEntirety(entirety)

    const snap =
      (JSON.parse(replica2.exportEntirety().data as string) as any).s ||
      JSON.parse(replica2.exportEntirety().data as string)
    expect(snap.title).toBe("Test")
    expect(snap.count).toBe(42)
  })
})

describe("PlainSubstrate.advance()", () => {
  it("substrate advance works: base moves, changefeed + reader still function", () => {
    const substrate = plainSubstrateFactory.create(TestSchema)
    const doc = interpretSubstrate(substrate)

    batch(doc, d => d.title.insert(0, "Hello"))
    const v2 = substrate.version()
    batch(doc, d => d.count.increment(5))

    // Advance the substrate
    substrate.advance(v2)
    expect(substrate.baseVersion().value).toBe(v2.value)

    // Reader still works
    expect(doc.title()).toBe("Hello")
    expect(doc.count()).toBe(5)

    // New mutations still work
    batch(doc, d => d.theme.set("dark"))
    expect(doc.theme()).toBe("dark")
    expect(substrate.version().value).toBe(v2.value + 2)
  })
})

// ---------------------------------------------------------------------------
// incarnation-aware merge — cross-lineage adoption via self-sufficient payload
// ---------------------------------------------------------------------------

// Helper: build a substrate whose strategy is seeded with a specific,
// already-REAL incarnation (bypassing the DEFAULT lazy-mint path) so tests
// can construct a known cross-incarnation scenario deterministically.
function createSubstrateWithIncarnation(incarnation: string) {
  const { strategy, adoptIncarnation, getIncarnation } =
    createPlainVersionStrategy(incarnation)
  const doc = { ...(Zero.structural(TestSchema) as object) }
  const substrate = createPlainSubstrate(
    doc,
    strategy,
    adoptIncarnation,
    getIncarnation,
  )
  return substrate
}

describe("incarnation-aware merge", () => {
  it("exportEntirety()'s payload carries an 'i' field once the substrate has a REAL incarnation", () => {
    const source = createSubstrateWithIncarnation("inc-source")
    const doc = interpretSubstrate(source)
    batch(doc, d => d.title.insert(0, "Hello"))

    const payload = source.exportEntirety()
    const parsed = JSON.parse(payload.data as string)
    expect(parsed.i).toBe("inc-source")
    expect(parsed.s.title).toBe("Hello")
  })

  it("exportSince()'s payload carries an 'i' field once the substrate has a REAL incarnation", () => {
    const source = createSubstrateWithIncarnation("inc-source")
    const doc = interpretSubstrate(source)
    const v0 = source.version()
    batch(doc, d => d.title.insert(0, "Hello"))

    const payload = source.exportSince(v0) as SubstratePayload
    const parsed = JSON.parse(payload.data as string)
    expect(parsed.i).toBe("inc-source")
    expect(parsed.b).toBeDefined()
  })

  it("merging an entirety from a different REAL incarnation into a DEFAULT target adopts the incoming incarnation", () => {
    const source = createSubstrateWithIncarnation("inc-source")
    const sourceDoc = interpretSubstrate(source)
    batch(sourceDoc, d => d.title.insert(0, "World"))

    const target = plainReplicaFactory.createEmpty()
    expect((target.version() as PlainVersion).incarnation).toBe(
      DEFAULT_INCARNATION,
    )

    target.merge(source.exportEntirety())

    expect((target.version() as PlainVersion).incarnation).toBe("inc-source")
    const snap = JSON.parse(target.exportEntirety().data as string)
    expect(snap.s.title).toBe("World")
  })

  it("merging an entirety from a different REAL incarnation into a target with its own REAL incarnation also adopts (epoch boundary reset)", () => {
    const source = createSubstrateWithIncarnation("inc-source")
    const sourceDoc = interpretSubstrate(source)
    batch(sourceDoc, d => d.title.insert(0, "Fresh"))

    // Target already has its own REAL incarnation from a prior session.
    const targetHandle = createPlainVersionStrategy("inc-target-old")
    const target = createPlainReplica(
      targetHandle.strategy,
      targetHandle.adoptIncarnation,
      targetHandle.getIncarnation,
    )
    expect((target.version() as PlainVersion).incarnation).toBe(
      "inc-target-old",
    )

    // An entirety payload (epoch boundary trigger) adopts the new incarnation
    // even though the target already had a different REAL one.
    target.merge(source.exportEntirety())

    expect((target.version() as PlainVersion).incarnation).toBe("inc-source")
  })

  it("merging a legacy (no-envelope) payload does not change the target's incarnation", () => {
    const target = plainReplicaFactory.createEmpty()
    const incBefore = (target.version() as PlainVersion).incarnation

    const legacyPayload: SubstratePayload = {
      kind: "entirety",
      encoding: "json",
      data: JSON.stringify({ title: "old" }),
    }
    target.merge(legacyPayload)

    expect((target.version() as PlainVersion).incarnation).toBe(incBefore)
  })

  it("exportSince falls back to entirety (not null) for a cross-REAL-incarnation since-version", () => {
    const { strategy, adoptIncarnation, getIncarnation } =
      createPlainVersionStrategy("inc-a")
    const replica = createPlainReplica(
      strategy,
      adoptIncarnation,
      getIncarnation,
    )

    const crossIncarnationVersion = new PlainVersion(0, "inc-b")
    const result = replica.exportSince(crossIncarnationVersion)
    expect(result).not.toBeNull()
    expect(result?.kind).toBe("entirety")
  })
})

// ---------------------------------------------------------------------------
// requiresBidirectionalSync — sync-mode constant invariant
// ---------------------------------------------------------------------------

describe("requiresBidirectionalSync", () => {
  it("collaborative (concurrent + delta) requires bidirectional", () => {
    expect(requiresBidirectionalSync(SYNC_COLLABORATIVE)).toBe(true)
  })

  it("authoritative (serialized + delta) does not require bidirectional", () => {
    expect(requiresBidirectionalSync(SYNC_AUTHORITATIVE)).toBe(false)
  })

  it("ephemeral (concurrent + snapshot) does not require bidirectional", () => {
    expect(requiresBidirectionalSync(SYNC_EPHEMERAL)).toBe(false)
  })

  // ===========================================================================
  // ReplicaLike structural satisfaction
  // ===========================================================================

  describe("ReplicaLike — variance-safe structural contract", () => {
    it("plain replica satisfies ReplicaLike", () => {
      const replica = plainReplicaFactory.createEmpty()
      // Compile-time check: Replica<PlainVersion> is assignable to ReplicaLike
      const like: import("../substrate.js").ReplicaLike = replica
      expect(like.version().serialize()).toBeDefined()
    })

    it("plain replica factory satisfies ReplicaFactoryLike", () => {
      // Compile-time check: ReplicaFactory<PlainVersion> is assignable to ReplicaFactoryLike
      const like: import("../substrate.js").ReplicaFactoryLike =
        plainReplicaFactory
      expect(like.replicaType).toEqual(["plain", 1, 0])
    })
  })
})

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
  RawPath,
  reaches,
  readable,
  replaceChange,
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
  ALWAYS_AUTHOR,
  createPlainClock,
  createPlainReplica,
  createPlainSubstrate,
  DEFAULT_LINEAGE,
  decodePlainPayload,
  EMPTY_HISTORY,
  planMerge,
} from "../substrates/plain.js"

// Helper: parse the store snapshot as a plain object for assertions.
// Exercises the public export API rather than reaching through to the
// backing Reader (which has no property access).
function snapshotOf(
  substrate: Substrate<PlainVersion>,
): Record<string, unknown> {
  const decoded = decodePlainPayload(substrate.exportEntirety(), "snapshotOf")
  if (decoded.kind !== "entirety") throw new Error("expected an entirety")
  return decoded.state
}

/** The document a plain `"entirety"` payload carries. */
function wholeState(payload: SubstratePayload): Record<string, unknown> {
  const decoded = decodePlainPayload(payload, "wholeState")
  if (decoded.kind !== "entirety") throw new Error("expected an entirety")
  return decoded.state
}

/** The ops a plain `"since"` payload carries, in order. */
function sinceOps(payload: SubstratePayload | null): Op[] {
  if (payload === null) throw new Error("expected a payload")
  const decoded = decodePlainPayload(payload, "sinceOps")
  if (decoded.kind !== "since") throw new Error("expected a delta")
  return decoded.batches.flat()
}

/** A plain whole-document payload: `state` at log position `at`. */
function entiretyAt(
  state: Record<string, unknown>,
  at: number,
  lineage?: string,
): SubstratePayload {
  return {
    kind: "entirety",
    encoding: "json",
    data: JSON.stringify({ at, state }),
    ...(lineage === undefined ? {} : { lineage }),
  }
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

  it("compare() never returns 'concurrent' for the same lineage", () => {
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

  it("compare() returns 'concurrent' across two REAL lineages, both directions (disjoint VV keys)", () => {
    const a1 = new PlainVersion(1, "inc-a")
    const a5 = new PlainVersion(5, "inc-a")
    const b1 = new PlainVersion(1, "inc-b")
    const b5 = new PlainVersion(5, "inc-b")

    expect(a1.compare(b1)).toBe("concurrent")
    expect(b1.compare(a1)).toBe("concurrent")
    expect(a5.compare(b1)).toBe("concurrent")
    expect(a1.compare(b5)).toBe("concurrent")
  })

  it("compare(): two genesis (DEFAULT) versions are equal — both project to ⊥", () => {
    const d0 = new PlainVersion(0, DEFAULT_LINEAGE)
    const d1 = new PlainVersion(1, DEFAULT_LINEAGE)

    // Genesis is the empty vector regardless of counter — it has no internal
    // order (two peers holding only schema-derived structure are equivalent).
    expect(d0.compare(d1)).toBe("equal")
    expect(d1.compare(d0)).toBe("equal")
    expect(d0.compare(d0)).toBe("equal")
  })

  it("compare(): genesis (DEFAULT) is behind any REAL lineage — a VV subset", () => {
    const def0 = new PlainVersion(0, DEFAULT_LINEAGE)
    const def5 = new PlainVersion(5, DEFAULT_LINEAGE)
    const real1 = new PlainVersion(1, "inc-real")
    const real5 = new PlainVersion(5, "inc-real")

    // The empty vector ⊥ is a subset of every REAL lineage → always "behind",
    // regardless of the genesis counter (the projection ignores it).
    expect(def0.compare(real1)).toBe("behind")
    expect(real1.compare(def0)).toBe("ahead")
    expect(def5.compare(real1)).toBe("behind")
    expect(real1.compare(def5)).toBe("ahead")
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

  it("parseVersion handles the new 'lineage:value' format", () => {
    const v = plainSubstrateFactory.parseVersion("abc123:5")
    expect(v.value).toBe(5)
    expect(v.lineage).toBe("abc123")
  })

  it("parseVersion rejects invalid input", () => {
    expect(() => plainSubstrateFactory.parseVersion("5")).toThrow()
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

  it("meet of two divergent REAL lineages is the genesis (empty) version", () => {
    const a = new PlainVersion(5, "inc-a")
    const b = new PlainVersion(3, "inc-b")

    const ab = a.meet(b) as PlainVersion
    const ba = b.meet(a) as PlainVersion

    // Disjoint lineage keys share no common entry → the empty vector ⊥ → genesis.
    expect(ab.value).toBe(0)
    expect(ba.value).toBe(0)
    expect(ab.lineage).toBe(DEFAULT_LINEAGE)
    expect(ba.lineage).toBe(DEFAULT_LINEAGE)
  })

  it("meet of genesis (DEFAULT) and REAL is the genesis version", () => {
    const def = new PlainVersion(3, DEFAULT_LINEAGE)
    const real = new PlainVersion(7, "inc-real")

    const defReal = def.meet(real) as PlainVersion
    const realDef = real.meet(def) as PlainVersion

    // ⊥ ∩ {real} = ⊥ → genesis.
    expect(defReal.value).toBe(0)
    expect(defReal.lineage).toBe(DEFAULT_LINEAGE)
    expect(realDef.value).toBe(0)
    expect(realDef.lineage).toBe(DEFAULT_LINEAGE)
  })
})

// ===========================================================================
// createPlainClock
// ===========================================================================

describe("createPlainClock", () => {
  it("version(flushCount) embeds the clock's lineage", () => {
    // A non-DEFAULT initial lineage never lazy-mints — version() just
    // stamps every produced version with it, regardless of flushCount.
    const clock = createPlainClock("inc-fixed")
    const v1 = clock.version(1)
    const v5 = clock.version(5)
    expect(v1.lineage).toBe("inc-fixed")
    expect(v1.value).toBe(1)
    expect(v5.lineage).toBe("inc-fixed")
    expect(v5.value).toBe(5)
  })

  it("logOffset returns null for a since-version from a different REAL lineage", () => {
    const clock = createPlainClock("inc-a")
    expect(clock.logOffset(new PlainVersion(2, "inc-b"))).toBeNull()
  })

  it("logOffset returns the value for a same-lineage since-version", () => {
    const clock = createPlainClock("inc-a")
    expect(clock.logOffset(new PlainVersion(2, "inc-a"))).toBe(2)
  })

  it("logOffset maps genesis (DEFAULT_LINEAGE) to offset 0 regardless of counter", () => {
    const clock = createPlainClock("inc-a")
    // Genesis is the empty vector ⊥ → the start of the authored log.
    expect(clock.logOffset(new PlainVersion(3, DEFAULT_LINEAGE))).toBe(0)
    expect(clock.logOffset(new PlainVersion(0, DEFAULT_LINEAGE))).toBe(0)
  })

  it("version() is a pure projection (no mint); adopt is the sole lineage mutator", () => {
    const clock = createPlainClock(DEFAULT_LINEAGE)
    clock.version(1)
    clock.version(2)
    expect(clock.lineage()).toBe(DEFAULT_LINEAGE)

    clock.adopt("inc-real")
    expect(clock.lineage()).toBe("inc-real")
    expect(clock.version(0).lineage).toBe("inc-real")
    expect(clock.version(3).lineage).toBe("inc-real")
  })
})

// ===========================================================================
// planMerge — what merging a plain payload does
// ===========================================================================

describe("planMerge", () => {
  const since = (
    lineage: string,
    from: number,
    batchCount: number,
  ): Parameters<typeof planMerge>[2] => ({
    kind: "since",
    lineage,
    from,
    batches: Array.from({ length: batchCount }, (_, i) => [
      { path: RawPath.empty.field("n"), change: replaceChange(from + i) },
    ]),
  })
  const entirety = (
    lineage: string,
    at: number,
  ): Parameters<typeof planMerge>[2] => ({
    kind: "entirety",
    lineage,
    at,
    state: { n: at },
  })

  it.each([
    [
      "a delta at our position appends all of it",
      3,
      "L",
      since("L", 3, 2),
      "append",
      2,
    ],
    [
      "a delta overlapping what we hold appends the rest",
      4,
      "L",
      since("L", 3, 2),
      "append",
      1,
    ],
    [
      "a delta we already hold changes nothing",
      5,
      "L",
      since("L", 3, 2),
      "none",
      0,
    ],
    [
      "a delta that starts past us is a gap",
      2,
      "L",
      since("L", 3, 2),
      "gap",
      0,
    ],
    [
      "a replica at genesis takes a delta from the start",
      0,
      DEFAULT_LINEAGE,
      since("L", 0, 2),
      "append",
      2,
    ],
    [
      "a replica at genesis cannot continue a delta from the middle",
      0,
      DEFAULT_LINEAGE,
      since("L", 3, 2),
      "gap",
      0,
    ],
    [
      "a delta from another lineage is a gap",
      3,
      "L",
      since("M", 3, 2),
      "gap",
      0,
    ],
  ] as const)("%s", (_, position, lineage, payload, kind, appended) => {
    const plan = planMerge(position, lineage, payload)
    expect(plan.kind).toBe(kind)
    if (plan.kind === "append") expect(plan.batches).toHaveLength(appended)
  })

  it.each([
    [
      "a whole document ahead of us is adopted",
      3,
      "L",
      entirety("L", 5),
      "adopt",
    ],
    [
      "a whole document at our position changes nothing",
      5,
      "L",
      entirety("L", 5),
      "none",
    ],
    [
      "a whole document behind us changes nothing",
      6,
      "L",
      entirety("L", 5),
      "none",
    ],
    [
      "a replica at genesis adopts a whole document",
      0,
      DEFAULT_LINEAGE,
      entirety("L", 5),
      "adopt",
    ],
    [
      "a whole document from another lineage is a gap",
      3,
      "L",
      entirety("M", 5),
      "gap",
    ],
  ] as const)("%s", (_, position, lineage, payload, kind) => {
    expect(planMerge(position, lineage, payload).kind).toBe(kind)
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

  it("version() starts at genesis (value 0, DEFAULT_LINEAGE) for a freshly created substrate", () => {
    const substrate = plainSubstrateFactory.create(TestSchema)
    const f = substrate.version() as PlainVersion
    // Op-free genesis: structural init does not flush, so a fresh doc is the
    // empty vector ⊥ — value 0, no lineage yet.
    expect(f.value).toBe(0)
    expect(f.lineage).toBe(DEFAULT_LINEAGE)
    expect(f.serialize()).toBe(`${DEFAULT_LINEAGE}:0`)
  })

  it("version() increments after mutations via the writable context", () => {
    const substrate = plainSubstrateFactory.create(TestSchema)
    const doc = interpretSubstrate(substrate)

    expect(substrate.version().value).toBe(0)
    expect((substrate.version() as PlainVersion).lineage).toBe(DEFAULT_LINEAGE)

    // The first local authored flush mints a REAL lineage and bumps to 1.
    batch(doc, d => d.title.insert(0, "Hi"))
    expect(substrate.version().value).toBe(1)
    expect((substrate.version() as PlainVersion).lineage).not.toBe(
      DEFAULT_LINEAGE,
    )

    batch(doc, d => d.count.increment(5))
    expect(substrate.version().value).toBe(2)

    // A multi-op transaction is a single flush cycle → one version bump
    batch(doc, d => {
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

    batch(doc, d => d.title.insert(0, "A"))
    batch(doc, d => d.count.increment(1))
    batch(doc, d => d.title.insert(1, "B"))

    // Each subscriber call should see the version AFTER the flush,
    // not the stale version from before.
    expect(observedVersions).toEqual([1, 2, 3])
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
          (substrate.version() as PlainVersion).lineage,
        ),
      )
      if (payload) opsPerNotification.push(sinceOps(payload))
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

    const parsed = snapshotOf(substrate)
    expect(parsed.title).toBe("Test!")
    expect(parsed.count).toBe(10)
  })

  it("exportSince(version) is an empty delta when version is ahead", () => {
    const substrate = plainSubstrateFactory.create(TestSchema)
    const doc = interpretSubstrate(substrate)
    batch(doc, d => d.count.increment(1))
    const futureVersion = new PlainVersion(
      999,
      (substrate.version() as PlainVersion).lineage,
    )
    expect(sinceOps(substrate.exportSince(futureVersion))).toEqual([])
  })

  it("exportSince(version) is an empty delta, not null, when version matches current version", () => {
    // `null` means "cannot serve", and the caller answers it with the whole
    // document. A peer that is merely current must not get that.
    const substrate = plainSubstrateFactory.create(TestSchema)
    const doc = interpretSubstrate(substrate)

    batch(doc, d => d.count.increment(1))

    expect(sinceOps(substrate.exportSince(substrate.version()))).toEqual([])
  })

  it("exportSince(genesis) is the whole document once the log is trimmed past genesis", () => {
    const source = plainSubstrateFactory.create(TestSchema)
    const doc = interpretSubstrate(source)
    batch(doc, d => d.count.increment(1))
    batch(doc, d => d.count.increment(1))
    source.advance(source.version())

    const genesis = new PlainVersion(0, DEFAULT_LINEAGE)
    expect(source.exportSince(genesis)).toBeNull()
    const fresh = plainReplicaFactory.createEmpty()
    fresh.merge(source.exportEntirety())
    expect(fresh.version().compare(source.version())).toBe("equal")
  })

  it("exportSince(version) returns ops when version is behind", () => {
    const substrate = plainSubstrateFactory.create(TestSchema)
    const doc = interpretSubstrate(substrate)

    batch(doc, d => d.theme.set("light"))
    const f0 = substrate.version()
    batch(doc, d => d.title.insert(0, "A"))
    batch(doc, d => d.count.increment(1))

    const payload = substrate.exportSince(f0)
    expect(payload).not.toBeNull()
    expect(payload?.encoding).toBe("json")

    const ops = sinceOps(payload)
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
    expect(f1.value).toBe(1)

    batch(doc, d => d.count.increment(1))
    expect(substrate.version().value).toBe(2)

    // exportSince(f1) should only contain the second mutation
    const ops = sinceOps(substrate.exportSince(f1))
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

    expect(substrateB.version().value).toBe(0)

    const delta = substrateA.exportSince(f0) as any
    substrateB.merge(delta)

    // merge preserves batch boundaries — each sender batch is appended
    // separately → 2 version bumps (one per change on A).
    // B starts at genesis (0) + 2 merged batches = 2, adopting A's lineage.
    expect(substrateB.version().value).toBe(2)
    expect((substrateB.version() as PlainVersion).lineage).toBe(
      (substrateA.version() as PlainVersion).lineage,
    )
  })

  it("merge with empty ops does not increment the version", () => {
    const substrate = plainSubstrateFactory.create(TestSchema)
    interpretSubstrate(substrate)

    const emptyPayload: SubstratePayload = {
      kind: "since",
      encoding: "json",
      data: JSON.stringify({ from: 0, batches: [] }),
    }
    substrate.merge(emptyPayload)

    expect(substrate.version().value).toBe(0)
  })
})

// ===========================================================================
// merge with kind: "entirety" — live state absorption
// ===========================================================================

describe("merge with entirety payload (PlainSubstrate)", () => {
  /** A substrate with two authored batches: position 2 on a REAL lineage. */
  function authored() {
    const substrate = plainSubstrateFactory.create(TestSchema)
    const doc = interpretSubstrate(substrate)
    batch(doc, d => d.title.insert(0, "Original"))
    batch(doc, d => d.count.increment(5))
    const lineage = (substrate.version() as PlainVersion).lineage
    return { substrate, doc, lineage }
  }

  const image = (title: string, count: number) => ({
    title,
    count,
    theme: "dark",
    items: [],
  })

  it("adopts a whole document ahead of it: state and position", () => {
    const { substrate, lineage } = authored()

    substrate.merge(entiretyAt(image("Replaced", 99), 5, lineage))

    const snap = snapshotOf(substrate)
    expect(snap.title).toBe("Replaced")
    expect(snap.count).toBe(99)
    expect(substrate.version().serialize()).toBe(`${lineage}:5`)
  })

  it("leaves a whole document at or behind it alone", () => {
    const { substrate, lineage } = authored()
    const before = substrate.version().serialize()

    substrate.merge(entiretyAt(image("Stale", 1), 2, lineage))
    substrate.merge(entiretyAt(image("Staler", 0), 1, lineage))

    expect(snapshotOf(substrate).title).toBe("Original")
    expect(substrate.version().serialize()).toBe(before)
  })

  it("takes the sender's lineage from genesis, never a fresh one (absorb ≠ author)", () => {
    const substrate = plainSubstrateFactory.create(TestSchema)
    expect((substrate.version() as PlainVersion).lineage).toBe(DEFAULT_LINEAGE)

    // Only local authorship mints a lineage. Absorbing a peer's state must
    // never make the receiver claim a fresh identity for content it does not
    // own: a writer with a spurious lineage would fork sync from its peers.
    substrate.merge(entiretyAt(image("from-peer", 1), 1, "peer-lineage"), {
      origin: "sync",
    })

    expect(substrate.version().serialize()).toBe("peer-lineage:1")
  })

  it("preserves ref identity after entirety merge", () => {
    const { substrate, doc, lineage } = authored()
    const refBefore = doc

    substrate.merge(entiretyAt(image("After", 0), 3, lineage), {
      origin: "sync",
    })

    expect(refBefore).toBe(doc)
    expect(doc.title()).toBe("After")
  })

  it("fires changefeed with origin on entirety merge", () => {
    const { substrate, doc, lineage } = authored()
    const received: { origin?: string }[] = []
    subscribe(doc, cs => received.push({ origin: cs.origin }))

    substrate.merge(entiretyAt(image("Synced", 42), 3, lineage), {
      origin: "sync",
    })

    expect(received.length).toBeGreaterThanOrEqual(1)
    for (const cs of received) {
      expect(cs.origin).toBe("sync")
    }
  })

  it("a whole document at genesis position changes nothing", () => {
    const substrate = plainSubstrateFactory.create(TestSchema)
    interpretSubstrate(substrate)

    substrate.merge(entiretyAt({}, 0))

    expect(substrate.version().value).toBe(0)
  })
})

describe("merge with entirety payload (PlainReplica)", () => {
  it("adopts a whole document: state and position", () => {
    const replica = plainReplicaFactory.createEmpty()

    replica.merge(entiretyAt({ title: "Hello", count: 7 }, 3, "peer"))

    const state = decodePlainPayload(replica.exportEntirety(), "test")
    expect(state.kind === "entirety" && state.state).toEqual({
      title: "Hello",
      count: 7,
    })
    expect(replica.version().serialize()).toBe("peer:3")
  })

  it("continues from an adopted whole document with the sender's later deltas", () => {
    const source = plainSubstrateFactory.create(TestSchema)
    const doc = interpretSubstrate(source)
    batch(doc, d => d.title.insert(0, "Start"))

    const replica = plainReplicaFactory.createEmpty()
    replica.merge(source.exportEntirety())
    const adoptedAt = source.version()

    batch(doc, d => d.count.increment(5))
    replica.merge(source.exportSince(adoptedAt) as SubstratePayload)

    expect(replica.version().compare(source.version())).toBe("equal")
  })

  it("applies nothing from a delta that starts past it, so it does not reach the offer", () => {
    const source = plainSubstrateFactory.create(TestSchema)
    const doc = interpretSubstrate(source)
    batch(doc, d => d.title.insert(0, "A"))
    const afterFirst = source.version()
    batch(doc, d => d.title.insert(1, "B"))

    const replica = plainReplicaFactory.createEmpty()

    replica.merge(source.exportSince(afterFirst) as SubstratePayload)
    expect(reaches(replica.version(), source.version())).toBe(false)
    expect(replica.version().value).toBe(0)
  })

  it("takes a redelivered delta once", () => {
    const source = plainSubstrateFactory.create(TestSchema)
    const doc = interpretSubstrate(source)
    const genesis = new PlainVersion(0, DEFAULT_LINEAGE)
    const replica = plainReplicaFactory.createEmpty()
    batch(doc, d => d.title.insert(0, "A"))
    replica.merge(source.exportEntirety())
    const before = source.version()
    batch(doc, d => d.title.insert(1, "B"))

    const delta = source.exportSince(before) as SubstratePayload
    replica.merge(delta)
    replica.merge(delta)

    expect(replica.version().compare(source.version())).toBe("equal")
    const replicaState = decodePlainPayload(replica.exportEntirety(), "test")
    expect(replicaState.kind === "entirety" && replicaState.state.title).toBe(
      "AB",
    )
    void genesis
  })
})

// ===========================================================================
// Lineage boundaries
// ===========================================================================

describe("Lineage boundaries", () => {
  it("fromEntirety creates a fresh lineage: version > 0, store matches source", () => {
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

    // Op-free genesis: 4 authored batches → value 4 (no init flush).
    expect(substrateA.version().value).toBe(4)

    // Export snapshot and create a new substrate
    const snapshot = substrateA.exportEntirety()
    const substrateB = plainSubstrateFactory.fromEntirety(snapshot, TestSchema)

    // fromEntirety takes the document at the source's position
    expect(substrateB.version().compare(substrateA.version())).toBe("equal")

    // But the snapshot matches the source's current state
    const snapA = snapshotOf(substrateA)
    const snapB = snapshotOf(substrateB)
    expect(snapB).toEqual(snapA)
    expect(snapB.title).toBe("Genesis v2")
    expect(snapB.count).toBe(100)
    expect(snapB.items as unknown[]).toHaveLength(1)
  })

  it("new lineage substrate is fully functional: can mutate, version, export", () => {
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

    // fromEntirety takes the document at the source's position
    const vAfterSnapshot = substrateB.version().value
    expect(substrateB.version().compare(substrateA.version())).toBe("equal")

    // Mutate the new substrate
    batch(docB, d => d.title.insert(6, "!"))
    expect(substrateB.version().value).toBe(vAfterSnapshot + 1)
    expect(snapshotOf(substrateB).title).toBe("Source!")

    // Export from the new substrate works
    const snapshot2 = substrateB.exportEntirety()
    expect(wholeState(snapshot2).title).toBe("Source!")

    // Export delta since the snapshot lineage version
    const delta = substrateB.exportSince(
      new PlainVersion(
        vAfterSnapshot,
        (substrateB.version() as PlainVersion).lineage,
      ),
    )
    const ops = sinceOps(delta)
    expect(ops.length).toBe(1)
    expect(ops[0]?.change.type).toBe("text")
  })

  it("old and new lineage substrates are independent", () => {
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
    expect(plainReplicaFactory.replicaType).toEqual(["plain", 2, 0])
  })
})

// ===========================================================================
// advance() — history trimming
// ===========================================================================

describe("PlainReplica.advance()", () => {
  it("trims nothing for a target the base has already passed, genesis included", () => {
    const { source, replica } = replicaFollowing(2)
    replica.advance(source.version())
    const base = replica.baseVersion().serialize()

    replica.advance(new PlainVersion(0, DEFAULT_LINEAGE))
    replica.advance(new PlainVersion(1, source.version().lineage))

    expect(replica.baseVersion().serialize()).toBe(base)
  })

  it("still throws for a target beyond its version", () => {
    const { source, replica } = replicaFollowing(1)
    expect(() =>
      replica.advance(new PlainVersion(99, source.version().lineage)),
    ).toThrow("exceeds")
  })

  it("advance to current version (full projection) clears the log", () => {
    const replica = plainReplicaFactory.createEmpty()
    const source = plainSubstrateFactory.create(TestSchema)
    const doc = interpretSubstrate(source)

    batch(doc, d => d.title.insert(0, "Hello"))
    batch(doc, d => d.count.increment(5))

    // Merge source ops into replica
    const delta = source.exportSince(
      new PlainVersion(0, (source.version() as PlainVersion).lineage),
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
        new PlainVersion(0, (replica.version() as PlainVersion).lineage),
      ),
    ).toBeNull()

    // exportEntirety still works
    const entirety = replica.exportEntirety()
    const parsed = wholeState(entirety)
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
      new PlainVersion(0, (source.version() as PlainVersion).lineage),
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
        new PlainVersion(0, (replica.version() as PlainVersion).lineage),
      ),
    ).toBeNull()
    // exportSince(v2) = remaining ops
    expect(replica.exportSince(v2)).not.toBeNull()

    // State is still complete
    const snap = wholeState(replica.exportEntirety())
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
      new PlainVersion(0, (source.version() as PlainVersion).lineage),
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
    const snap = wholeState(replica.exportEntirety())
    expect(snap.title).toBe("Before")
    expect(snap.count).toBe(99)
  })

  it("advance precondition: target beyond current version throws", () => {
    const replica = plainReplicaFactory.createEmpty()
    const source = plainSubstrateFactory.create(TestSchema)
    const doc = interpretSubstrate(source)
    batch(doc, d => d.title.insert(0, "A"))
    // Replica adopts source's REAL lineage and its single authored batch.
    replica.merge(
      source.exportSince(
        new PlainVersion(0, (source.version() as PlainVersion).lineage),
      ) as any,
    )
    const lineage = (replica.version() as PlainVersion).lineage
    // A same-lineage target beyond the current log length cannot be reached.
    expect(() => replica.advance(new PlainVersion(999, lineage))).toThrow()
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
        new PlainVersion(0, (source.version() as PlainVersion).lineage),
      ) as any,
    )

    // Before advance, exportSince(v0) works
    expect(
      replica.exportSince(
        new PlainVersion(0, (replica.version() as PlainVersion).lineage),
      ),
    ).not.toBeNull()

    // Advance past v0
    replica.advance(v2)

    // After advancing the base to v2 (value 1), genesis is behind the base → null.
    expect(
      replica.exportSince(
        new PlainVersion(0, (replica.version() as PlainVersion).lineage),
      ),
    ).toBeNull()

    // v2 (the base) still works
    expect(replica.exportSince(v2)).not.toBeNull()

    // exportEntirety always works (returns current state)
    const snap = wholeState(replica.exportEntirety())
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
        new PlainVersion(0, (source.version() as PlainVersion).lineage),
      ) as any,
    )
    replica.advance(replica.version())

    // Create a new replica from the trimmed entirety
    const entirety = replica.exportEntirety()
    const replica2 = plainReplicaFactory.fromEntirety(entirety)

    const snap = wholeState(replica2.exportEntirety())
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
// lineage-aware merge / resetFromEntirety — cross-lineage adoption
// ---------------------------------------------------------------------------

// Helper: build a substrate whose clock is seeded with a specific,
// already-REAL lineage (bypassing the DEFAULT lazy-mint path) so tests
// can construct a known cross-lineage scenario deterministically.
function createSubstrateWithLineage(lineage: string) {
  const doc = { ...(Zero.structural(TestSchema) as object) }
  return createPlainSubstrate(
    doc,
    TestSchema,
    createPlainClock(lineage),
    EMPTY_HISTORY,
    ALWAYS_AUTHOR,
  )
}

describe("lineage-aware merge", () => {
  it("exportEntirety()'s payload carries the lineage once the substrate has a REAL lineage", () => {
    const source = createSubstrateWithLineage("inc-source")
    const doc = interpretSubstrate(source)
    batch(doc, d => d.title.insert(0, "Hello"))

    const payload = source.exportEntirety()
    expect(payload.lineage).toBe("inc-source")
    expect(wholeState(payload).title).toBe("Hello")
  })

  it("exportSince()'s payload carries the lineage once the substrate has a REAL lineage", () => {
    const source = createSubstrateWithLineage("inc-source")
    const doc = interpretSubstrate(source)
    const v0 = source.version()
    batch(doc, d => d.title.insert(0, "Hello"))

    const payload = source.exportSince(v0) as SubstratePayload
    expect(payload.lineage).toBe("inc-source")
    expect(sinceOps(payload)).toHaveLength(1)
  })

  it("merging an entirety from a different REAL lineage into a DEFAULT target adopts the incoming lineage", () => {
    const source = createSubstrateWithLineage("inc-source")
    const sourceDoc = interpretSubstrate(source)
    batch(sourceDoc, d => d.title.insert(0, "World"))

    const target = plainReplicaFactory.createEmpty()
    expect((target.version() as PlainVersion).lineage).toBe(DEFAULT_LINEAGE)

    target.merge(source.exportEntirety())

    expect((target.version() as PlainVersion).lineage).toBe("inc-source")
    expect(wholeState(target.exportEntirety()).title).toBe("World")
  })

  it("merging an entirety from a different REAL lineage into a target with its own REAL lineage does NOT adopt (merge() is same-lineage-only)", () => {
    const source = createSubstrateWithLineage("inc-source")
    const sourceDoc = interpretSubstrate(source)
    batch(sourceDoc, d => d.title.insert(0, "Fresh"))

    // Target already has its own REAL lineage from a prior session.
    const target = createPlainReplica(createPlainClock("inc-target-old"))
    expect((target.version() as PlainVersion).lineage).toBe("inc-target-old")

    // REAL -> different REAL is a genuine lineage boundary. `merge()` no
    // longer adopts across lineages — that's `resetFromEntirety`'s job,
    // invoked exclusively by the Synchronizer's explicit lineage gate.
    target.merge(source.exportEntirety())

    expect((target.version() as PlainVersion).lineage).toBe("inc-target-old")
  })

  it("merging an entirety from a different REAL lineage into a target with its own REAL lineage also adopts (lineage boundary reset)", () => {
    const source = createSubstrateWithLineage("inc-source")
    const sourceDoc = interpretSubstrate(source)
    batch(sourceDoc, d => d.title.insert(0, "Fresh"))

    // Target already has its own REAL lineage from a prior session.
    const target = createPlainReplica(createPlainClock("inc-target-old"))
    expect((target.version() as PlainVersion).lineage).toBe("inc-target-old")

    // `resetFromEntirety` is the lineage-boundary path: it adopts the new
    // lineage even though the target already had a different REAL one.
    target.resetFromEntirety(source.exportEntirety())

    expect((target.version() as PlainVersion).lineage).toBe("inc-source")
  })

  it("merging a legacy (no-envelope) payload does not change the target's lineage", () => {
    const target = plainReplicaFactory.createEmpty()
    const lineageBefore = (target.version() as PlainVersion).lineage

    const legacyPayload: SubstratePayload = {
      kind: "entirety",
      encoding: "json",
      data: JSON.stringify({ title: "old" }),
    }
    target.merge(legacyPayload)

    expect((target.version() as PlainVersion).lineage).toBe(lineageBefore)
  })

  it("exportSince falls back to entirety (not null) for a cross-REAL-lineage since-version", () => {
    const replica = createPlainReplica(createPlainClock("inc-a"))

    const crossLineageVersion = new PlainVersion(0, "inc-b")
    const result = replica.exportSince(crossLineageVersion)
    expect(result).not.toBeNull()
    expect(result?.kind).toBe("entirety")
  })
})

// ---------------------------------------------------------------------------
// Plain construction keeps history — upgrade, fromEntirety, replica cache
// ---------------------------------------------------------------------------

/** A source substrate with `n` authored batches, and its genesis version. */
function sourceWithBatches(n: number) {
  const source = plainSubstrateFactory.create(TestSchema)
  const doc = interpretSubstrate(source)
  const genesis = source.version()
  for (let i = 0; i < n; i++) batch(doc, d => d.count.increment(1))
  return { source, doc, genesis }
}

/**
 * A source with one batch, a replica that has adopted its document there, and
 * `n` more source batches the replica has taken in as a delta: the replica's
 * log holds `n` batches above a base at position 1.
 */
function replicaFollowing(n: number) {
  const { source, doc } = sourceWithBatches(1)
  const replica = plainReplicaFactory.createEmpty()
  replica.merge(source.exportEntirety())
  const adopted = source.version()
  for (let i = 0; i < n; i++) batch(doc, d => d.count.increment(1))
  replica.merge(source.exportSince(adopted) as SubstratePayload)
  return { source, doc, replica, adopted }
}

describe("plain upgrade keeps history", () => {
  it("the upgraded substrate carries the replica's version and log", () => {
    const { source, replica } = replicaFollowing(2)

    const upgraded = plainSubstrateFactory.upgrade(replica, TestSchema)
    expect(upgraded.version().serialize()).toBe(replica.version().serialize())
    expect(upgraded.version().compare(source.version())).toBe("equal")

    batch(interpretSubstrate(upgraded), d => d.count.increment(1))
    expect(upgraded.version().compare(source.version())).toBe("ahead")

    const delta = upgraded.exportSince(source.version())
    expect(delta?.kind).toBe("since")
    expect(sinceOps(delta)).toHaveLength(1)
  })

  it("the base offset survives the upgrade", () => {
    const { source, replica, adopted } = replicaFollowing(2)
    const second = new PlainVersion(2, source.version().lineage)
    replica.advance(second)

    const upgraded = plainSubstrateFactory.upgrade(replica, TestSchema)
    expect(upgraded.baseVersion().serialize()).toBe(second.serialize())
    expect(upgraded.exportSince(adopted)).toBeNull()
  })

  it("upgrade refuses a replica this factory did not build", () => {
    const foreign = { ...plainReplicaFactory.createEmpty() }
    expect(() => plainSubstrateFactory.upgrade(foreign, TestSchema)).toThrow(
      "requires a replica produced by this substrate factory",
    )
  })
})

describe("plain fromEntirety", () => {
  it("keeps genesis for a genesis payload", () => {
    const payload = plainSubstrateFactory.create(TestSchema).exportEntirety()
    const substrate = plainSubstrateFactory.fromEntirety(payload, TestSchema)
    expect(substrate.version().lineage).toBe(DEFAULT_LINEAGE)
    expect(substrate.version().serialize()).toBe(
      plainReplicaFactory.fromEntirety(payload).version().serialize(),
    )
  })

  it("adopts the payload's REAL lineage", () => {
    const { source } = sourceWithBatches(1)
    const payload = source.exportEntirety()
    const substrate = plainSubstrateFactory.fromEntirety(payload, TestSchema)
    expect(substrate.version().lineage).toBe(source.version().lineage)
    expect(substrate.version().serialize()).toBe(
      plainReplicaFactory.fromEntirety(payload).version().serialize(),
    )
  })
})

describe("plain merge announces after taking the ops in", () => {
  it("delivers one replayed changeset per sender batch and matches the sender", () => {
    const { source, doc: sourceDoc } = sourceWithBatches(1)
    const target = plainSubstrateFactory.create(TestSchema)
    const doc = interpretSubstrate(target)
    target.merge(source.exportEntirety())
    const adopted = source.version()
    batch(sourceDoc, d => d.count.increment(1))
    batch(sourceDoc, d => d.count.increment(1))
    const seen: { replay: boolean | undefined; count: unknown }[] = []
    subscribe(doc, cs => {
      seen.push({ replay: cs.replay, count: doc.count() })
    })

    target.merge(source.exportSince(adopted) as SubstratePayload)

    // Each batch is announced once the doc holds it, and not before.
    expect(seen).toEqual([
      { replay: true, count: 2 },
      { replay: true, count: 3 },
    ])
    expect(target.exportEntirety().data).toBe(source.exportEntirety().data)
    expect(target.version().serialize()).toBe(source.version().serialize())
  })
})

describe("plain replica materialization", () => {
  it("reflects merge, advance and reset without corrupting its base", () => {
    const S = Schema.struct({ items: Schema.list(Schema.number()) })
    const source = plainSubstrateFactory.create(S)
    const doc = interpret(S, source.context())
      .with(readable)
      .with(writable)
      .with(observation)
      .done()
    const genesis = source.version()
    batch(doc, d => d.items.push(1))
    const afterFirst = source.version()
    batch(doc, d => d.items.push(2))

    const replica = plainReplicaFactory.createEmpty()
    const state = () => wholeState(replica.exportEntirety())
    replica.merge(source.exportSince(genesis) as SubstratePayload)
    expect(state().items).toEqual([1, 2])

    // After a trim, every later materialization replays the retained log onto
    // the base. Replaying in place would grow `items` on each one.
    replica.advance(afterFirst)
    for (let i = 3; i <= 5; i++) {
      const before = source.version()
      batch(doc, d => d.items.push(i))
      replica.merge(source.exportSince(before) as SubstratePayload)
      expect(state().items).toEqual([
        1,
        2,
        ...Array.from({ length: i - 2 }, (_, k) => k + 3),
      ])
    }

    replica.resetFromEntirety(source.exportEntirety())
    expect(state().items).toEqual([1, 2, 3, 4, 5])
  })
})

// ---------------------------------------------------------------------------
// requiresBidirectionalSync — sync-mode constant invariant
// ---------------------------------------------------------------------------

describe("requiresBidirectionalSync", () => {
  it("collaborative requires bidirectional", () => {
    expect(requiresBidirectionalSync(SYNC_COLLABORATIVE)).toBe(true)
  })

  it("authoritative does not: it is request/response, not exchange", () => {
    expect(requiresBidirectionalSync(SYNC_AUTHORITATIVE)).toBe(false)
  })

  it("ephemeral requires bidirectional — both peers write", () => {
    // It did not while ephemeral could only send snapshots, so a peer had
    // nothing to ask for. Now that it sends deltas, two concurrent writers
    // need to hear each other like any other pair.
    expect(requiresBidirectionalSync(SYNC_EPHEMERAL)).toBe(true)
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
      expect(like.replicaType).toEqual(["plain", 2, 0])
    })
  })
})

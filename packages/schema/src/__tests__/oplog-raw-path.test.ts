// The plain op-log stores each op's path as an immutable value, frozen when
// the op is authored. Deleting or reordering an entry afterwards must not
// corrupt an already-logged op that exportSince later serializes. Rationale:
// jj:mlurlzqt.
import { describe, expect, it } from "vitest"
import { CoordinateTrie } from "../coordinate-trie.js"
import {
  batch,
  createRef,
  createSubstrate,
  PlainVersion,
  plainReplicaFactory,
  plainSubstrateFactory,
  Schema,
  type SubstratePayload,
  substrateFromEntirety,
} from "../index.js"
import { type Address, AddressedPath, RawPath } from "../path.js"
import { decodePlainPayload } from "../substrates/plain.js"

const Candidate = Schema.struct({
  name: Schema.string(),
  status: Schema.string(),
})
const RecordDoc = Schema.struct({ candidates: Schema.record(Candidate) })
const ListDoc = Schema.struct({
  items: Schema.list(Schema.struct({ label: Schema.string() })),
})
const SetDoc = Schema.struct({ tags: Schema.set(Schema.string()) })
const TreeDoc = Schema.struct({
  outline: Schema.tree(Schema.struct({ label: Schema.string() })),
})
const KEY = "37687726-cafe-4000-8000-000000000001"

function recordDoc() {
  const substrate = createSubstrate(plainSubstrateFactory, RecordDoc)
  return { substrate, doc: createRef(RecordDoc, substrate) as any }
}
function listDoc() {
  const substrate = createSubstrate(plainSubstrateFactory, ListDoc)
  return { substrate, doc: createRef(ListDoc, substrate) as any }
}

// The start of a substrate's log: offset 0 on its own lineage. Taken after
// its first write, since a genesis cursor is answered with the whole
// document rather than the log, and these tests are about the log.
function logStart(substrate: any): PlainVersion {
  return new PlainVersion(0, substrate.version().lineage)
}

// The serialized batches of the delta since `since`, as they go on the wire.
function sinceBatches(substrate: any, since: unknown): any[][] {
  const payload = substrate.exportSince(since)
  if (payload === null) throw new Error("exportSince returned null")
  return JSON.parse(payload.data as string).batches
}

// Store snapshot for equality assertions; typed structurally so one helper
// serves both a substrate and a replica.
function snap(x: {
  exportEntirety(): SubstratePayload
}): Record<string, unknown> {
  const decoded = decodePlainPayload(x.exportEntirety(), "snap")
  if (decoded.kind !== "entirety") throw new Error("expected an entirety")
  return decoded.state
}

// Merge a genesis since-delta into a schema-less empty replica. Works only
// because record/list/set ops carry their own container structure on replay;
// trees need a seeded [] base, so the tree test uses substrateFromEntirety instead.
function replayInto(substrate: any, since: unknown) {
  const payload = substrate.exportSince(since)
  expect(payload).not.toBeNull()
  const replica = plainReplicaFactory.createEmpty()
  replica.merge(payload)
  return replica
}

describe("plain op-log: history survives deletion and reordering", () => {
  it("exports history after a nested entry is deleted, and a late replica converges", () => {
    const { substrate, doc } = recordDoc()
    batch(doc, (d: any) =>
      d.candidates.set(KEY, { name: "Alice", status: "new" }),
    )
    // A write whose path descends INTO the entry: [candidates, entry(KEY), status].
    // This is the op whose path segment gets tombstoned by the delete below.
    batch(doc, (d: any) => d.candidates.at(KEY).status.set("active"))
    batch(doc, (d: any) => d.candidates.delete(KEY))

    const payload = substrate.exportSince(logStart(substrate))
    expect(payload).not.toBeNull()
    const replica = plainReplicaFactory.createEmpty()
    expect(() => {
      if (payload) replica.merge(payload)
    }).not.toThrow()
  })

  it("exports cleanly after a whole-entry set then delete", () => {
    // Boundary case: a whole-entry set logs a MapChange at the record path
    // (no `entry` segment to tombstone), so it was never affected. Kept to
    // document why the nested case above is the one that matters.
    const { substrate, doc } = recordDoc()
    batch(doc, (d: any) => d.candidates.set(KEY, { name: "A", status: "n" }))
    batch(doc, (d: any) => d.candidates.delete(KEY))
    expect(() => substrate.exportSince(logStart(substrate))).not.toThrow()
  })

  it("serializes a nested op at its authored index even when a later insert in the same batch shifts it", () => {
    const { substrate, doc } = listDoc()
    // One batch: "a" is at index 0 when its label is written, then the insert
    // shifts "a" to index 1 before the batch flushes. The logged label-write
    // must retain index 0 — freezing at flush (rather than at authoring) would
    // capture the shifted index 1 and a late peer would replay at the wrong slot.
    batch(doc, (d: any) => {
      d.items.push({ label: "a" })
      d.items.at(0).label.set("a-edited")
      d.items.insert(0, { label: "b" })
    })

    const ops = sinceBatches(substrate, logStart(substrate)).flat()
    const labelWrite = ops.find(
      o => o.path.at(-1)?.field === "label" && o.change.value === "a-edited",
    )
    expect(labelWrite?.path[1]).toEqual({ type: "index", index: 0 })
  })

  it("serialization of earlier ops is unchanged by a later delete", () => {
    const { substrate, doc } = recordDoc()
    batch(doc, (d: any) => d.candidates.set(KEY, { name: "A", status: "n" }))
    batch(doc, (d: any) => d.candidates.at(KEY).status.set("active"))

    const before = sinceBatches(substrate, logStart(substrate))
    batch(doc, (d: any) => d.candidates.delete(KEY)) // tombstones the entry address
    const after = sinceBatches(substrate, logStart(substrate))

    // The earlier batches must serialize byte-identically — history is immutable.
    expect(after.slice(0, before.length)).toEqual(before)
  })

  it("keeps the entry/index wire segment shape", () => {
    const { substrate, doc } = recordDoc()
    batch(doc, (d: any) => d.candidates.set(KEY, { name: "A", status: "n" }))
    batch(doc, (d: any) => d.candidates.at(KEY).status.set("active"))
    const nested = sinceBatches(substrate, logStart(substrate))
      .flat()
      .find(o => o.path.some((s: any) => s.type === "entry"))
    expect(nested.path).toEqual([
      { type: "field", field: "candidates" },
      { type: "entry", entry: KEY },
      { type: "field", field: "status" },
    ])
  })

  it("format() does not throw on a path with a deleted segment", () => {
    // format() feeds error messages; if it threw on a dead segment it would
    // mask the real error. The toContain assertion also fails if format throws.
    const p = AddressedPath.empty(new CoordinateTrie())
      .field("candidates")
      .entry(KEY)
    ;(p.segments[1] as Address).dead = true
    expect(p.format()).toContain(KEY)
  })

  it("toRaw() projects a path with a deleted segment, preserving its coordinates", () => {
    const p = AddressedPath.empty(new CoordinateTrie())
      .field("candidates")
      .entry(KEY)
      .field("status")
    ;(p.segments[1] as Address).dead = true
    const raw = p.toRaw()
    expect(raw).toBeInstanceOf(RawPath)
    expect(raw.segments.map(s => s.coord())).toEqual([
      "candidates",
      KEY,
      "status",
    ])
  })
})

// ===========================================================================
// Convergence, not just no-throw. The suite's other exportSince→merge tests
// (substrate.test.ts) are all additive (insert/increment/push); none delete or
// reorder before exporting — the exact operations this freeze exists to make
// safe. These assert the late replica's *materialized state* matches the
// source, so a merge that silently diverges (the quiet-failure sibling) fails.
// ===========================================================================

describe("plain op-log: a late replica converges (state, not just no-throw)", () => {
  it("record: nested write then delete → replica materializes identically", () => {
    const { substrate, doc } = recordDoc()
    batch(doc, (d: any) =>
      d.candidates.set(KEY, { name: "Alice", status: "new" }),
    )
    batch(doc, (d: any) => d.candidates.at(KEY).status.set("active"))
    batch(doc, (d: any) => d.candidates.delete(KEY))

    const replica = replayInto(substrate, logStart(substrate))
    // A no-throw merge is necessary but not sufficient — assert convergence.
    expect(snap(replica)).toEqual(snap(substrate))
    expect((snap(substrate).candidates as Record<string, unknown>)[KEY]).toBe(
      undefined,
    )
  })

  it("list: a later BATCH inserts ahead of a logged nested op; the op keeps its authored index", () => {
    // Cross-batch index drift — the same-batch case is covered above, but SC2
    // is "same OR subsequent batches". Here the shifting insert is in a later
    // flushed batch, after the label-write op was already frozen at index 0.
    const { substrate, doc } = listDoc()
    batch(doc, (d: any) => d.items.push({ label: "a" })) // a @ index 0
    batch(doc, (d: any) => d.items.at(0).label.set("a-edited")) // nested write @ 0
    batch(doc, (d: any) => d.items.insert(0, { label: "b" })) // shifts a → index 1

    const replica = replayInto(substrate, logStart(substrate))
    // Had the label-write drifted to index 1, replay would apply "a-edited" to
    // "b". Convergence proves the op replayed at its frozen index 0.
    expect(snap(replica)).toEqual(snap(substrate))
    expect(
      (snap(substrate).items as Array<{ label: string }>).map(i => i.label),
    ).toEqual(["b", "a-edited"])
  })
})

// ===========================================================================
// Sets and trees are the *boundary* — verified structurally safe, unlike maps.
// A tree op DOES log a nested `[outline, entry(node-id)]` path, but a tree
// `delete` records a `TreeChange` instruction and never tombstones that node's
// entry Address (a map `delete` tombstones its entry Address in place — that's
// the hazard). Sets are leaf-shaped: a delete logs at the set's own path, no
// nested segment. So neither triggers the freeze — both export cleanly with OR
// without it. These lock that safety in: the only exportSince-after-delete
// convergence coverage for set/tree, and a tripwire if either container's
// delete ever became tombstone-aware (at which point it would need the freeze).
// ===========================================================================

describe("plain op-log: set and tree entry deletes survive export", () => {
  it("tree: a node created with nested data, then deleted, still exports and converges", () => {
    // `create({ data })` records per-node writes at [outline, node(id), label]
    // — a path that descends INTO the node — but the node's entry segment is
    // not a tombstone-able live Address, so `delete(id)` cannot corrupt it.
    // Convergence coverage for the safe path, not a reproduction of the hazard.
    const substrateA = createSubstrate(plainSubstrateFactory, TreeDoc)
    const docA = createRef(TreeDoc, substrateA) as any
    // Seed B from A's genesis so its tree field is a defaulted [] base to
    // replay a TreeChange onto (a from-empty replica has no schema defaults).
    const substrateB = substrateFromEntirety(
      plainSubstrateFactory,
      substrateA.exportEntirety(),
      TreeDoc,
    )
    let id = ""
    batch(docA, (d: any) => {
      id = d.outline.create({ data: { label: "Root" } })
    })
    batch(docA, (d: any) => d.outline.delete(id))

    const delta = substrateA.exportSince(logStart(substrateA))
    // Non-null guards against a vacuous pass: if the delete erased the history
    // and the delta were empty, both snapshots would trivially match. (Also
    // narrows `SubstratePayload | null` for the merge below.)
    if (delta === null) throw new Error("exportSince returned no delta")
    substrateB.merge(delta, { origin: "sync" })
    expect(snap(substrateB)).toEqual(snap(substrateA))
  })

  it("set: a member added then deleted still exports and converges", () => {
    // Sets are leaf-shaped (no nested-into-member path), so the delete logs at
    // the set's own path — safe like the whole-entry map set. The set analog of
    // the tree case above; locks in that this stays convergence-clean.
    const substrate = createSubstrate(plainSubstrateFactory, SetDoc)
    const doc = createRef(SetDoc, substrate) as any
    batch(doc, (d: any) => {
      d.tags.add("x")
      d.tags.add("y")
    })
    batch(doc, (d: any) => d.tags.delete("x"))

    const replica = replayInto(substrate, logStart(substrate))
    expect(snap(replica)).toEqual(snap(substrate))
  })
})

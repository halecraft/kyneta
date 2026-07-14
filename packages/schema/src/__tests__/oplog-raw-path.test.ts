// The plain op-log stores each op's path as an immutable value, frozen when
// the op is authored. Deleting or reordering an entry afterwards must not
// corrupt an already-logged op that exportSince later serializes. Rationale:
// jj:mlurlzqt.
import { describe, expect, it } from "vitest"
import {
  batch,
  createRef,
  interpret,
  observation,
  plainReplicaFactory,
  plainSubstrateFactory,
  readable,
  Schema,
  stateSubstrateFactory,
  writable,
} from "../index.js"
import { type Address, AddressedPath, AddressTableRegistry } from "../path.js"

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
// The `state` substrate rejects ordered sequences and errors on record
// whole-entry sets, so its freeze is exercised via a plain nested field.
const StateDoc = Schema.struct({
  settings: Schema.struct({ theme: Schema.string() }),
})

const KEY = "37687726-cafe-4000-8000-000000000001"

function recordDoc() {
  const substrate = plainSubstrateFactory.create(RecordDoc)
  return { substrate, doc: createRef(RecordDoc, substrate) as any }
}
function listDoc() {
  const substrate = plainSubstrateFactory.create(ListDoc)
  return { substrate, doc: createRef(ListDoc, substrate) as any }
}

// exportSince, asserting a non-null payload, returning its JSON `data`.
function sinceData(substrate: any, since: unknown): string {
  const payload = substrate.exportSince(since)
  if (payload === null) throw new Error("exportSince returned null")
  return payload.data as string
}

// Store snapshot for equality assertions. Unwraps the `{ i, s }` lineage
// envelope when present (mirrors substrate.test.ts's snapshotOf); typed
// structurally so one helper serves both a substrate and a replica.
function snap(x: {
  exportEntirety(): { data: unknown }
}): Record<string, unknown> {
  const parsed = JSON.parse(x.exportEntirety().data as string)
  return parsed && typeof parsed === "object" && "s" in parsed
    ? (parsed.s as Record<string, unknown>)
    : (parsed as Record<string, unknown>)
}

// Merge a genesis since-delta into a schema-less empty replica. Works only
// because record/list/set ops carry their own container structure on replay;
// trees need a seeded [] base, so the tree test uses fromEntirety instead.
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
    const v0 = substrate.version()
    batch(doc, (d: any) =>
      d.candidates.set(KEY, { name: "Alice", status: "new" }),
    )
    // A write whose path descends INTO the entry: [candidates, entry(KEY), status].
    // This is the op whose path segment gets tombstoned by the delete below.
    batch(doc, (d: any) => d.candidates.at(KEY).status.set("active"))
    batch(doc, (d: any) => d.candidates.delete(KEY))

    const payload = substrate.exportSince(v0)
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
    const v0 = substrate.version()
    batch(doc, (d: any) => d.candidates.set(KEY, { name: "A", status: "n" }))
    batch(doc, (d: any) => d.candidates.delete(KEY))
    expect(() => substrate.exportSince(v0)).not.toThrow()
  })

  it("serializes a nested op at its authored index even when a later insert in the same batch shifts it", () => {
    const { substrate, doc } = listDoc()
    const v0 = substrate.version()
    // One batch: "a" is at index 0 when its label is written, then the insert
    // shifts "a" to index 1 before the batch flushes. The logged label-write
    // must retain index 0 — freezing at flush (rather than at authoring) would
    // capture the shifted index 1 and a late peer would replay at the wrong slot.
    batch(doc, (d: any) => {
      d.items.push({ label: "a" })
      d.items.at(0).label.set("a-edited")
      d.items.insert(0, { label: "b" })
    })

    const ops = (
      JSON.parse(sinceData(substrate, v0)) as Array<
        Array<{
          path: Array<{ type: string; field?: string; index?: number }>
          change: { value?: unknown }
        }>
      >
    ).flat()
    const labelWrite = ops.find(
      o => o.path.at(-1)?.field === "label" && o.change.value === "a-edited",
    )
    expect(labelWrite?.path[1]).toEqual({ type: "index", index: 0 })
  })

  it("serialization of earlier ops is unchanged by a later delete", () => {
    const { substrate, doc } = recordDoc()
    const v0 = substrate.version()
    batch(doc, (d: any) => d.candidates.set(KEY, { name: "A", status: "n" }))
    batch(doc, (d: any) => d.candidates.at(KEY).status.set("active"))

    const before = JSON.parse(sinceData(substrate, v0))
    batch(doc, (d: any) => d.candidates.delete(KEY)) // tombstones the entry address
    const after = JSON.parse(sinceData(substrate, v0))

    // The earlier batches must serialize byte-identically — history is immutable.
    expect(after.slice(0, before.length)).toEqual(before)
  })

  it("keeps the entry/index wire segment shape", () => {
    const { substrate, doc } = recordDoc()
    const v0 = substrate.version()
    batch(doc, (d: any) => d.candidates.set(KEY, { name: "A", status: "n" }))
    batch(doc, (d: any) => d.candidates.at(KEY).status.set("active"))
    const nested = (JSON.parse(sinceData(substrate, v0)) as any[][])
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
    const p = new AddressedPath([], new AddressTableRegistry())
      .field("candidates")
      .entry(KEY)
    ;(p.segments[1] as Address).dead = true
    expect(p.format()).toContain(KEY)
  })

  it("toRaw() projects a path with a deleted segment, preserving its coordinates", () => {
    const p = new AddressedPath([], new AddressTableRegistry())
      .field("candidates")
      .entry(KEY)
      .field("status")
    ;(p.segments[1] as Address).dead = true
    const raw = p.toRaw()
    expect(raw.isAddressed).toBe(false)
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
    const v0 = substrate.version()
    batch(doc, (d: any) =>
      d.candidates.set(KEY, { name: "Alice", status: "new" }),
    )
    batch(doc, (d: any) => d.candidates.at(KEY).status.set("active"))
    batch(doc, (d: any) => d.candidates.delete(KEY))

    const replica = replayInto(substrate, v0)
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
    const v0 = substrate.version()
    batch(doc, (d: any) => d.items.push({ label: "a" })) // a @ index 0
    batch(doc, (d: any) => d.items.at(0).label.set("a-edited")) // nested write @ 0
    batch(doc, (d: any) => d.items.insert(0, { label: "b" })) // shifts a → index 1

    const replica = replayInto(substrate, v0)
    // Had the label-write drifted to index 1, replay would apply "a-edited" to
    // "b". Convergence proves the op replayed at its frozen index 0.
    expect(snap(replica)).toEqual(snap(substrate))
    expect((snap(substrate).items as Array<{ label: string }>).map(i => i.label)).toEqual([
      "b",
      "a-edited",
    ])
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
    const substrateA = plainSubstrateFactory.create(TreeDoc)
    const docA = createRef(TreeDoc, substrateA) as any
    // Seed B from A's genesis so its tree field is a defaulted [] base to
    // replay a TreeChange onto (a from-empty replica has no schema defaults).
    const substrateB = plainSubstrateFactory.fromEntirety(
      substrateA.exportEntirety(),
      TreeDoc,
    )
    const v0 = substrateA.version()
    let id = ""
    batch(docA, (d: any) => {
      id = d.outline.create({ data: { label: "Root" } })
    })
    batch(docA, (d: any) => d.outline.delete(id))

    const delta = substrateA.exportSince(v0)
    // Non-null guards against a vacuous pass: if the delete erased the history
    // and the delta were empty, both snapshots would trivially match.
    expect(delta).not.toBeNull()
    substrateB.merge(delta, { origin: "sync" })
    expect(snap(substrateB)).toEqual(snap(substrateA))
  })

  it("set: a member added then deleted still exports and converges", () => {
    // Sets are leaf-shaped (no nested-into-member path), so the delete logs at
    // the set's own path — safe like the whole-entry map set. The set analog of
    // the tree case above; locks in that this stays convergence-clean.
    const substrate = plainSubstrateFactory.create(SetDoc)
    const doc = createRef(SetDoc, substrate) as any
    const v0 = substrate.version()
    batch(doc, (d: any) => {
      d.tags.add("x")
      d.tags.add("y")
    })
    batch(doc, (d: any) => d.tags.delete("x"))

    const replica = replayInto(substrate, v0)
    expect(snap(replica)).toEqual(snap(substrate))
  })
})

// ===========================================================================
// The `state` substrate got the same authoring-time freeze. It exports
// entirety (never serialized ops) and drains its op-log every batch, so the
// freeze has no observable corruption path — its changefeed even re-derives
// addressed paths. The one place the frozen value surfaces is the ops
// `afterBatch` flushes; assert those are RawPath, a direct guard on the
// `path.toRaw()` line (defense-in-depth, uniform with the plain substrate).
// ===========================================================================

describe("state substrate: flushed op-log paths are frozen too", () => {
  it("records flushed ops as immutable RawPath, not live AddressedPath", () => {
    const substrate = stateSubstrateFactory.create(StateDoc) as any
    const flushed: Array<{ path: { isAddressed: boolean } }> = []
    // Intercept afterBatch's return — the only surface exposing the frozen
    // ops before they're drained (the changefeed re-derives addressed paths).
    const origAfterBatch = substrate.afterBatch.bind(substrate)
    substrate.afterBatch = (options: unknown) => {
      const result = origAfterBatch(options)
      if (Array.isArray(result)) {
        for (const b of result) for (const op of b) flushed.push(op)
      }
      return result
    }
    const doc = interpret(StateDoc, substrate.context())
      .with(readable)
      .with(writable)
      .with(observation)
      .done() as any
    batch(doc, (d: any) => d.settings.theme.set("dark"))

    expect(flushed.length).toBeGreaterThan(0)
    // Without the freeze these paths would be the live AddressedPath
    // (isAddressed === true) that the addressing registry mutates in place.
    for (const op of flushed) expect(op.path.isAddressed).toBe(false)
  })
})

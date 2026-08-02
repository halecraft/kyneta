// opaque-boundary — writes aimed at, or inside, a subtree stored as one value.
//
// Two schema shapes are stored as a single opaque value rather than as nested
// containers: a `.json()` node, and a `sum` (which is what `.nullable()`
// expands to). A change aimed at or inside one of those has nowhere to land, so
// the substrate must widen it into a whole-value write of the entire subtree.
//
// These tests exist because the widening rule drifted per-substrate. `json` is
// the reference — it stores everything as plain objects, so it has no widening
// to get wrong and is correct in every case below. Every other substrate is
// measured against it.
//
// The `state` cases assert on the EXPORTED TREE rather than on the document,
// and that detail is why the bugs here survived. The substrate keeps two
// copies: a plain-object shadow that local reads come from, and the StateTree
// that actually replicates. `prepare` updates the shadow straight from the
// change, so a local read stays correct no matter how mangled the tree gets.
// Only other peers ever see the damage.

import type { Changeset } from "@kyneta/changefeed"
import { describe, expect, it } from "vitest"
import {
  batch,
  createDoc,
  ephemeral,
  json,
  Schema,
  SUBSTRATE,
  state,
  subscribe,
} from "../index.js"
import { isStateTuple } from "../substrates/state-tree.js"

// ===========================================================================
// Shared schemas — one per {shape × wrapper} cell
// ===========================================================================

const Struct = Schema.struct({
  from: Schema.number(),
  to: Schema.number().nullable(),
})

const StructNullable = Schema.struct({ v: Struct.nullable() })
const StructJson = Schema.struct({
  v: Schema.struct.json({ from: Schema.number(), to: Schema.number() }),
})
const ListNullable = Schema.struct({
  v: Schema.list(Schema.number()).nullable(),
})
const ListJson = Schema.struct({ v: Schema.list.json(Schema.number()) })
const RecordNullable = Schema.struct({
  v: Schema.record(Schema.number()).nullable(),
})
const RecordJson = Schema.struct({ v: Schema.record.json(Schema.number()) })

/** The StateTree as a peer would receive it. */
function exported(doc: unknown): Record<string, [unknown, number]> {
  const substrate = (
    doc as Record<symbol, { exportEntirety(): { data: string } }>
  )[SUBSTRATE]
  return JSON.parse(substrate.exportEntirety().data)
}

// A `.nullable()` field types as `ScalarRef<T | null>`, which exposes no
// members of its own — reaching inside one is a compile error even though the
// runtime proxy resolves the variant by value and allows it. Casting is what a
// caller has to write today.
const inner = (ref: unknown) => ref as any

// ===========================================================================
// json — the reference. Correct in every cell.
// ===========================================================================

describe("json substrate (reference behaviour)", () => {
  it("interior leaf write through a nullable struct", () => {
    const doc = createDoc(json.bind(StructNullable))
    doc.v.set({ from: 1, to: null })
    inner(doc.v).to.set(2)
    expect(doc.v()).toEqual({ from: 1, to: 2 })
  })

  it("interior leaf write inside a .json() struct", () => {
    const doc = createDoc(json.bind(StructJson))
    doc.v.set({ from: 1, to: 5 })
    inner(doc.v).to.set(2)
    expect(doc.v()).toEqual({ from: 1, to: 2 })
  })

  it("push onto a nullable list", () => {
    const doc = createDoc(json.bind(ListNullable))
    doc.v.set([1, 2])
    inner(doc.v).push(3)
    expect(doc.v()).toEqual([1, 2, 3])
  })

  it("push onto a .json() list", () => {
    const doc = createDoc(json.bind(ListJson))
    inner(doc.v).push(1)
    inner(doc.v).push(2)
    expect(doc.v()).toEqual([1, 2])
  })

  it("key write on a nullable record", () => {
    const doc = createDoc(json.bind(RecordNullable))
    doc.v.set({ a: 1 })
    inner(doc.v).set("b", 2)
    expect(doc.v()).toEqual({ a: 1, b: 2 })
  })

  it("key write on a .json() record", () => {
    const doc = createDoc(json.bind(RecordJson))
    inner(doc.v).set("a", 1)
    inner(doc.v).set("b", 2)
    expect(doc.v()).toEqual({ a: 1, b: 2 })
  })
})

// ===========================================================================
// ephemeral — a whole-document LWW register, so it has no per-field tree to
// corrupt. Included to confirm it tracks the reference.
// ===========================================================================

describe("ephemeral substrate", () => {
  it("interior leaf write through a nullable struct", () => {
    const doc = createDoc(ephemeral.bind(StructNullable))
    doc.v.set({ from: 1, to: null })
    inner(doc.v).to.set(2)
    expect(doc.v()).toEqual({ from: 1, to: 2 })
  })

  it("key write on a nullable record", () => {
    const doc = createDoc(ephemeral.bind(RecordNullable))
    doc.v.set({ a: 1 })
    inner(doc.v).set("b", 2)
    expect(doc.v()).toEqual({ a: 1, b: 2 })
  })
})

// ===========================================================================
// state — bug class C. A register must stay ONE leaf tuple.
// ===========================================================================
//
// Splitting a register into per-field tuples does two kinds of damage. It drops
// whichever sibling fields the change never mentioned, and it hands the
// deliberately schema-blind `mergeStateTree` something it can blend field-by-
// field across two peers' variants. Tree *shape* is the only signal a headless
// relay has that a register is a single value.

// No nullable-list case here, and the reason is worth recording. A `sequence`
// carries the `positional-ot` composition law, which `state` and `ephemeral` do
// not allow, so `state.bind(...)` rejects a nullable list at compile time.
// `.json()` does not have this problem: collapsing the subtree to an inert blob
// erases the inner laws, leaving only `lww`. So `list.json` binds and a nullable
// list does not — an asymmetry between two shapes that are otherwise stored
// identically, but rejecting is the safe direction and it is the law system
// working as designed.
describe("state substrate — registers stay atomic", () => {
  it("interior leaf write keeps the sum register whole", () => {
    const doc = createDoc(state.bind(StructNullable))
    doc.v.set({ from: 1, to: null })
    inner(doc.v).to.set(2)

    const tree = exported(doc)
    expect(isStateTuple(tree.v)).toBe(true)
    expect(tree.v?.[0]).toEqual({ from: 1, to: 2 })
  })

  it("interior leaf write keeps the .json() register whole", () => {
    const doc = createDoc(state.bind(StructJson))
    doc.v.set({ from: 1, to: 5 })
    inner(doc.v).to.set(2)

    const tree = exported(doc)
    expect(isStateTuple(tree.v)).toBe(true)
    expect(tree.v?.[0]).toEqual({ from: 1, to: 2 })
  })

  it("push onto a .json() list reaches the tree", () => {
    const doc = createDoc(state.bind(ListJson))
    inner(doc.v).push(1)
    inner(doc.v).push(2)

    expect(doc.v()).toEqual([1, 2])
    expect(exported(doc).v?.[0]).toEqual([1, 2])
  })

  it("key write on a nullable record reaches the tree", () => {
    const doc = createDoc(state.bind(RecordNullable))
    doc.v.set({ a: 1 })
    inner(doc.v).set("b", 2)

    const tree = exported(doc)
    expect(isStateTuple(tree.v)).toBe(true)
    expect(tree.v?.[0]).toEqual({ a: 1, b: 2 })
  })

  it("key write on a .json() record reaches the tree", () => {
    const doc = createDoc(state.bind(RecordJson))
    inner(doc.v).set("a", 1)
    inner(doc.v).set("b", 2)

    const tree = exported(doc)
    expect(isStateTuple(tree.v)).toBe(true)
    expect(tree.v?.[0]).toEqual({ a: 1, b: 2 })
  })
})

// ===========================================================================
// Widening must stay invisible outside the substrate
// ===========================================================================
//
// Re-aiming a write at its register is a substrate-internal move. It happens
// inside `prepare`, after the changefeed layer has already recorded the op and
// after the inverse has been captured. Both of those work in terms of the
// original path, so neither should notice — but nothing pinned that before, and
// a subscriber suddenly notified at the register instead of the leaf would be a
// visible behaviour change for anything built on the changefeed.

describe("widening does not leak past the substrate", () => {
  it("a subscriber is still notified at the leaf path, not the register", () => {
    const doc = createDoc(state.bind(StructNullable))
    doc.v.set({ from: 1, to: null })

    const paths: string[] = []
    subscribe(doc, (cs: Changeset<any>) => {
      for (const c of cs.changes) paths.push(c.path.format())
    })

    inner(doc.v).to.set(2)

    // The op is authored at `v.to`; only the tree write is re-aimed at `v`.
    expect(paths.some(p => p.includes("to"))).toBe(true)
  })

  it("aborting a batch restores the whole register", () => {
    const doc = createDoc(state.bind(StructNullable))
    doc.v.set({ from: 1, to: 3 })

    expect(() => {
      batch(doc, d => {
        inner(d.v).to.set(99)
        throw new Error("abort it")
      })
    }).toThrow("abort it")

    // The recorded inverse targets the leaf path and is re-aimed the same way
    // on replay, so the register has to come back whole — `from` included.
    expect(doc.v()).toEqual({ from: 1, to: 3 })
    expect(exported(doc).v?.[0]).toEqual({ from: 1, to: 3 })
  })
})

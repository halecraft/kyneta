// state-sum-atomicity — sum & .json() nodes are atomic LWW registers.
//
// A sum variant or a `.json()` blob must merge as ONE value: a variant switch
// moves the tag and its fields together. The state substrate stores each such
// register as a single leaf tuple so the schema-blind
// `mergeStateTree` can never blend fields across variants. These tests pin the
// property at the builder level (applyChangeToStateTree / mergeStateTree) and
// end-to-end through the substrate.

import { describe, expect, it } from "vitest"
import { replaceChange, Schema } from "../index.js"
import { RawPath } from "../path.js"
import { ephemeralSubstrateFactory } from "../substrates/ephemeral.js"
import {
  applyChangeToStateTree,
  isStateTuple,
  mergeStateTree,
  type StateTree,
} from "../substrates/state-tree.js"

const Shape = Schema.discriminatedUnion("kind", [
  Schema.struct({ kind: Schema.string("circle"), radius: Schema.number() }),
  Schema.struct({ kind: Schema.string("square"), side: Schema.number() }),
])
const Doc = Schema.struct({ shape: Shape, label: Schema.string() })

const shapePath = RawPath.empty.field("shape")
const asRecord = (t: StateTree) => t as Record<string, [any, number]>

// ---------------------------------------------------------------------------
// Builder: a register is stored as ONE tuple, not a decomposed record
// ---------------------------------------------------------------------------

describe("applyChangeToStateTree stores a sum as one atomic tuple", () => {
  it("a variant write becomes a single [value, ts] leaf", () => {
    const tree: StateTree = {}
    applyChangeToStateTree(
      tree,
      shapePath,
      replaceChange({ kind: "square", side: 3 }),
      200,
      Doc,
    )
    const node = asRecord(tree).shape
    expect(isStateTuple(node)).toBe(true)
    expect(node[0]).toEqual({ kind: "square", side: 3 })
  })

  it("deep-clones the value so the tree does not alias the caller", () => {
    const tree: StateTree = {}
    const value = { kind: "circle", radius: 5 }
    applyChangeToStateTree(tree, shapePath, replaceChange(value), 100, Doc)
    value.radius = 999 // mutate the caller's object after the write
    expect(asRecord(tree).shape[0].radius).toBe(5)
  })

  it("a product still decomposes into per-field tuples", () => {
    const Prod = Schema.struct({
      user: Schema.struct({ x: Schema.number(), y: Schema.number() }),
    })
    const tree: StateTree = {}
    applyChangeToStateTree(
      tree,
      RawPath.empty.field("user"),
      replaceChange({ x: 1, y: 2 }),
      100,
      Prod,
    )
    const user = (tree as Record<string, StateTree>).user
    expect(isStateTuple(user)).toBe(false)
    expect((user as Record<string, StateTree>).x).toEqual([1, 100])
    expect((user as Record<string, StateTree>).y).toEqual([2, 100])
  })
})

// ---------------------------------------------------------------------------
// Merge: concurrent variant switches converge to one whole variant
// ---------------------------------------------------------------------------

describe("mergeStateTree merges a sum register atomically", () => {
  it("higher-timestamp variant wins whole; no field blend", () => {
    const a: StateTree = {
      shape: [{ kind: "circle", radius: 5 }, 100],
      label: ["a", 100],
    }
    const b: StateTree = {
      shape: [{ kind: "square", side: 3 }, 200],
      label: ["b", 50],
    }
    mergeStateTree(a, b)
    const shape = asRecord(a).shape
    expect(shape[0]).toEqual({ kind: "square", side: 3 })
    expect(shape[0].radius).toBeUndefined() // losing variant's field is gone
    expect(asRecord(a).label[0]).toBe("a") // independent field, A wins (T=100>50)
  })

  it("converges regardless of merge order (commutative)", () => {
    const mk = (): [StateTree, StateTree] => [
      { shape: [{ kind: "circle", radius: 5 }, 100] },
      { shape: [{ kind: "square", side: 3 }, 200] },
    ]
    const [a1, b1] = mk()
    mergeStateTree(a1, b1)
    const [a2, b2] = mk()
    mergeStateTree(b2, a2)
    expect(asRecord(a1).shape).toEqual(asRecord(b2).shape)
  })

  it("field-level product merge still works (regression)", () => {
    const a: StateTree = { x: [1, 100], y: [2, 50] }
    const b: StateTree = { x: [9, 50], y: [8, 200] }
    mergeStateTree(a, b)
    expect(asRecord(a).x).toEqual([1, 100]) // A wins x
    expect(asRecord(a).y).toEqual([8, 200]) // B wins y
  })
})

// ---------------------------------------------------------------------------
// .json() boundary — same atomicity
// ---------------------------------------------------------------------------

describe(".json() blob is an atomic register", () => {
  const JsonDoc = Schema.struct({
    blob: Schema.struct.json({ a: Schema.number(), b: Schema.number() }),
  })

  it("stores the whole blob as one tuple", () => {
    const tree: StateTree = {}
    applyChangeToStateTree(
      tree,
      RawPath.empty.field("blob"),
      replaceChange({ a: 1, b: 2 }),
      100,
      JsonDoc,
    )
    const node = (tree as Record<string, StateTree>).blob
    expect(isStateTuple(node)).toBe(true)
    expect((node as [any, number])[0]).toEqual({ a: 1, b: 2 })
  })
})

// ---------------------------------------------------------------------------
// nullable struct (positional sum) — atomic
// ---------------------------------------------------------------------------

describe("nullable struct is an atomic register", () => {
  const NullDoc = Schema.struct({
    opt: Schema.struct({ x: Schema.number(), y: Schema.number() }).nullable(),
  })

  it("stores the present variant whole; null wins by timestamp", () => {
    const tree: StateTree = {}
    applyChangeToStateTree(
      tree,
      RawPath.empty.field("opt"),
      replaceChange({ x: 1, y: 2 }),
      100,
      NullDoc,
    )
    expect(isStateTuple((tree as Record<string, StateTree>).opt)).toBe(true)

    mergeStateTree(tree, { opt: [null, 200] })
    expect(asRecord(tree).opt).toEqual([null, 200])
  })
})

// ---------------------------------------------------------------------------
// End-to-end through the substrate: two peers converge, no blend
// ---------------------------------------------------------------------------

describe("state substrate converges concurrent variant switches", () => {
  const payload = (data: unknown) => ({
    kind: "entirety" as const,
    encoding: "json" as const,
    data: JSON.stringify(data),
  })

  it("merged peers read a coherent single variant", () => {
    const subA = ephemeralSubstrateFactory.fromEntirety(
      payload({
        shape: [{ kind: "circle", radius: 5 }, 100],
        label: ["a", 100],
      }),
      Doc,
    )
    subA.merge(
      payload({ shape: [{ kind: "square", side: 3 }, 200], label: ["b", 50] }),
    )

    // Higher-T variant (square) wins whole; circle's `radius` is gone.
    expect(subA.reader.read(shapePath)).toEqual({ kind: "square", side: 3 })
    expect(subA.reader.read(shapePath.field("radius"))).toBeUndefined()
    // Independent field kept A's value.
    expect(subA.reader.read(RawPath.empty.field("label"))).toBe("a")
  })
})

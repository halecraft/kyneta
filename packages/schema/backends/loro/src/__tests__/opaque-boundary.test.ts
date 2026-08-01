// opaque-boundary — writes aimed at, or inside, a subtree stored as one value.
//
// A `.json()` node and a `sum` (which is what `.nullable()` expands to) are both
// stored as a single opaque plain value in the parent container, with no nested
// Loro containers inside. For a sum that is forced rather than chosen:
// `.nullable()` is only offered on plain schemas, so a variant can never hold a
// CRDT type worth building a container for.
//
// So a change aimed at or inside one has nowhere to land, and has to be widened
// into a whole-value write of the entire subtree. `findOpaqueBoundary` decides
// where that widening starts, and reports both kinds of boundary alike.
//
// It used to report only `.json()` nodes. Sums fell through to the direct write
// path, which then went looking for a Loro container that was never created —
// so a write inside a nullable struct threw, and a mutation of a nullable
// collection silently failed to reach the CRDT while still reading back
// correctly from the local shadow.
//
// Worth pinning on this backend and not only on Yjs: the bug was reported
// against Yjs, but it lives in shared `@kyneta/schema` code and Loro failed the
// same way for the same reason. A fix verified on one backend proves nothing
// about the other.
//
// The `.json()` cases are regression guards. `list.json` + push works *only
// because* the boundary is reported even for a path that stops on it — there is
// no container to push into, so widening is the entire mechanism.

import type { Ref, SchemaNode, Substrate } from "@kyneta/schema"
import {
  batch,
  interpret,
  observation,
  readable,
  Schema,
  writable,
} from "@kyneta/schema"
import { describe, expect, it } from "vitest"
import { createDoc, loro, loroSubstrateFactory } from "../index.js"
import type { LoroVersion } from "../version.js"

const Struct = Schema.struct({
  from: Schema.number(),
  to: Schema.number().nullable(),
})

const StructNullable = Schema.struct({ v: Struct.nullable() })
const ListNullable = Schema.struct({
  v: Schema.list(Schema.number()).nullable(),
})
const ListJson = Schema.struct({ v: Schema.list.json(Schema.number()) })
const RecordNullable = Schema.struct({
  v: Schema.record(Schema.number()).nullable(),
})
const RecordJson = Schema.struct({ v: Schema.record.json(Schema.number()) })
// Hoisted rather than built inline in the test body: binding a schema
// constructed inside a function trips TypeScript's instantiation-depth limit.
const StructJson = Schema.struct({
  v: Schema.struct.json({ from: Schema.number(), to: Schema.number() }),
})

function interpretSubstrate<S extends SchemaNode>(
  schema: S,
  substrate: Substrate<LoroVersion>,
): Ref<S> {
  return interpret(schema, substrate.context())
    .with(readable)
    .with(writable)
    .with(observation)
    .done()
}

/**
 * Run `write` on a fresh peer, merge into a second peer, return what the second
 * peer sees.
 *
 * Local reads cannot be trusted for these tests. Every substrate keeps a plain
 * shadow that reads are served from, and `prepare` updates it straight from the
 * change — so a write that never reached the CRDT still reads back correctly on
 * the peer that made it. Only a second peer can tell the difference. A
 * `nullable` record key write reads back as `{a:1,b:2}` locally while the CRDT
 * holds `{a:1}` and a stray `b` at the document root.
 */
function afterMerge(schema: SchemaNode, write: (d: any) => void): unknown {
  // Builds the ref without going through `interpretSubstrate`. That helper is
  // generic in the schema, and asking it to build `Ref<S>` for these shapes
  // exceeds TypeScript's instantiation-depth limit. Erasing the inference is
  // the point of the cast; these tests assert on runtime values anyway.
  const mk = (sub: Substrate<LoroVersion>): any =>
    (interpret as any)(schema, sub.context())
      .with(readable)
      .with(writable)
      .with(observation)
      .done()

  const subA = loroSubstrateFactory.create(schema)
  const docA = mk(subA)
  const subB = loroSubstrateFactory.create(schema)
  const docB = mk(subB)
  write(docA)
  subB.merge(subA.exportEntirety(), { origin: "sync" })
  return docB.v()
}

// A `.nullable()` field types as `ScalarRef<T | null>`, which exposes no members
// of its own — reaching inside one is a compile error even though the runtime
// proxy resolves the variant by value and allows it. Casting is what a caller
// has to write today.
const inner = (ref: unknown) => ref as any

// ===========================================================================
// .json() — currently correct. These are the guards.
// ===========================================================================

describe(".json() subtrees (regression guards)", () => {
  it("interior leaf write inside a .json() struct", () => {
    const doc = createDoc(loro.bind(StructJson))
    batch(doc, d => d.v.set({ from: 1, to: 5 }))
    batch(doc, d => inner(d.v).to.set(2))
    expect(doc.v()).toEqual({ from: 1, to: 2 })
  })

  it("push onto a .json() list", () => {
    const doc = createDoc(loro.bind(ListJson))
    batch(doc, d => inner(d.v).push(1))
    batch(doc, d => inner(d.v).push(2))
    expect(doc.v()).toEqual([1, 2])
  })

  it("key write on a .json() record", () => {
    const doc = createDoc(loro.bind(RecordJson))
    batch(doc, d => inner(d.v).set("a", 1))
    batch(doc, d => inner(d.v).set("b", 2))
    expect(doc.v()).toEqual({ a: 1, b: 2 })
  })

  it("a .json() collection replicates whole", () => {
    expect(
      afterMerge(ListJson, d => {
        batch(d, (x: any) => inner(x.v).push(1))
        batch(d, (x: any) => inner(x.v).push(2))
      }),
    ).toEqual([1, 2])
  })
})

// ===========================================================================
// Bug class A — a write INSIDE a sum
// ===========================================================================

describe("writes inside a sum", () => {
  it("interior leaf write through a non-null nullable struct", () => {
    const doc = createDoc(loro.bind(StructNullable))
    batch(doc, d => d.v.set({ from: 1, to: null }))
    batch(doc, d => inner(d.v).to.set(2))
    expect(doc.v()).toEqual({ from: 1, to: 2 })
  })

  it("an interior leaf write replicates via delta", () => {
    const subA = loroSubstrateFactory.create(StructNullable)
    const docA = interpretSubstrate(StructNullable, subA)
    const subB = loroSubstrateFactory.create(StructNullable)
    const docB = interpretSubstrate(StructNullable, subB)

    batch(docA, (d: any) => d.v.set({ from: 1, to: null }))
    subB.merge(subA.exportEntirety(), { origin: "sync" })
    const since = subB.version()

    batch(docA, (d: any) => inner(d.v).to.set(2))
    const delta = subA.exportSince(since)
    if (delta) subB.merge(delta, { origin: "sync" })

    expect((docB as any).v()).toEqual({ from: 1, to: 2 })
  })

  it("the same write one field over, without a sum, works (control)", () => {
    const schema = Schema.struct({ required: Struct })
    const doc = createDoc(loro.bind(schema))
    batch(doc, d => d.required.set({ from: 1, to: null }))
    batch(doc, d => d.required.to.set(2))
    expect(doc.required()).toEqual({ from: 1, to: 2 })
  })
})

// ===========================================================================
// Bug class B — a collection mutation AT a sum
// ===========================================================================

describe("collection mutations at a sum", () => {
  it("push onto a nullable list", () => {
    expect(
      afterMerge(ListNullable, d => {
        batch(d, (x: any) => x.v.set([1, 2]))
        batch(d, (x: any) => inner(x.v).push(3))
      }),
    ).toEqual([1, 2, 3])
  })

  it("key write on a nullable record", () => {
    // Asserted on a merged peer on purpose. This one PASSES on a local read —
    // the shadow takes the write while the CRDT does not, so `b` is lost on
    // replication and a stray `b` is left at the document root.
    expect(
      afterMerge(RecordNullable, d => {
        batch(d, (x: any) => x.v.set({ a: 1 }))
        batch(d, (x: any) => inner(x.v).set("b", 2))
      }),
    ).toEqual({ a: 1, b: 2 })
  })
})

// ===========================================================================
// Whole-value writes at a sum — currently correct, must stay so
// ===========================================================================

describe("whole-value writes at a sum (regression guards)", () => {
  it("set, then reset to null", () => {
    const doc = createDoc(loro.bind(StructNullable))
    batch(doc, d => d.v.set({ from: 1, to: 3 }))
    expect(doc.v()).toEqual({ from: 1, to: 3 })
    batch(doc, d => d.v.set(null))
    expect(doc.v()).toBe(null)
  })

  it("a whole-value write replicates via delta", () => {
    const subA = loroSubstrateFactory.create(StructNullable)
    const docA = interpretSubstrate(StructNullable, subA)
    const subB = loroSubstrateFactory.create(StructNullable)
    const docB = interpretSubstrate(StructNullable, subB)

    subB.merge(subA.exportEntirety(), { origin: "sync" })
    const since = subB.version()

    batch(docA, (d: any) => d.v.set({ from: 4, to: 5 }))
    const delta = subA.exportSince(since)
    if (delta) subB.merge(delta, { origin: "sync" })

    expect((docB as any).v()).toEqual({ from: 4, to: 5 })
  })
})

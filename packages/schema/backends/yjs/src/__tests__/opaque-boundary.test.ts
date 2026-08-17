// opaque-boundary — writes aimed at, or inside, a subtree stored as one value.
//
// A `.json()` node and a `sum` (which is what `.nullable()` expands to) are both
// stored as a single opaque plain value in the parent container, with no nested
// Yjs types inside. For a sum that is forced rather than chosen: `.nullable()`
// is only offered on plain schemas, so a variant can never hold a CRDT type
// worth building a container for.
//
// So a change aimed at or inside one has nowhere to land. There is no Y.Map at
// `optional` to write `to` into, and no Y.Array at a nullable list to push
// onto. Such a change has to be widened into a whole-value write of the entire
// subtree. `findOpaqueBoundary` decides where that widening starts.
//
// `findOpaqueBoundary` reports both kinds of boundary alike. It used to report
// only `.json()` nodes, and sums failed two ways as a result: a write *inside*
// one threw out of the schema descent, and a collection mutation *at* one threw
// out of the direct write path looking for a container that was never created.
//
// The `.json()` cases here are regression guards, not aspirations. `list.json`
// + push works *only because* the boundary is reported even for a path that
// stops on it — there is no container to push into, so widening is the entire
// mechanism. Any rule that skipped terminating boundaries would break them.

import { createDoc, createDocAs, Schema, unwrap } from "@kyneta/schema"
import { describe, expect, it } from "vitest"
import * as Y from "yjs"
import { yjs } from "../bind-yjs.js"

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

function ydoc(ref: unknown): Y.Doc {
  return unwrap(ref as never) as Y.Doc
}

/** One-way sync: apply everything peer `from` knows onto peer `to`. */
function sync(from: unknown, to: unknown): void {
  Y.applyUpdate(ydoc(to), Y.encodeStateAsUpdate(ydoc(from)))
}

/**
 * Run `write` on a fresh peer, sync into a second peer, return what the second
 * peer sees.
 *
 * Local reads cannot be trusted for these tests. Every substrate keeps a plain
 * shadow that reads are served from, and `prepare` updates it straight from the
 * change — so a write that never reached the CRDT still reads back correctly on
 * the peer that made it. Only a second peer can tell the difference. The Loro
 * backend has a case where exactly this happens: a nullable record key write
 * reads back complete locally while the CRDT never received it.
 */
// Takes a thunk rather than a bound schema: passing the binding through a
// parameter makes `createDoc` re-infer its generics here, which trips
// TypeScript's instantiation-depth limit on these schemas.
function afterSync(make: () => any, write: (d: any) => void): unknown {
  const a = make()
  const b = make()
  write(a)
  sync(a, b)
  return b.v()
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
    const doc = createDoc(yjs.bind(StructJson))
    doc.v.set({ from: 1, to: 5 })
    inner(doc.v).to.set(2)
    expect(doc.v()).toEqual({ from: 1, to: 2 })
  })

  it("push onto a .json() list", () => {
    const doc = createDoc(yjs.bind(ListJson))
    inner(doc.v).push(1)
    inner(doc.v).push(2)
    expect(doc.v()).toEqual([1, 2])
  })

  it("key write on a .json() record", () => {
    const doc = createDoc(yjs.bind(RecordJson))
    inner(doc.v).set("a", 1)
    inner(doc.v).set("b", 2)
    expect(doc.v()).toEqual({ a: 1, b: 2 })
  })

  it("a .json() collection replicates whole", () => {
    expect(
      afterSync(
        () => createDoc(yjs.bind(ListJson)),
        d => {
          inner(d.v).push(1)
          inner(d.v).push(2)
        },
      ),
    ).toEqual([1, 2])
  })

  it("a .json() record replicates whole", () => {
    expect(
      afterSync(
        () => createDoc(yjs.bind(RecordJson)),
        d => {
          inner(d.v).set("a", 1)
          inner(d.v).set("b", 2)
        },
      ),
    ).toEqual({ a: 1, b: 2 })
  })
})

// ===========================================================================
// Bug class A — a write INSIDE a sum
// ===========================================================================

describe("writes inside a sum", () => {
  it("interior leaf write through a non-null nullable struct", () => {
    const doc = createDoc(yjs.bind(StructNullable))
    doc.v.set({ from: 1, to: null })
    inner(doc.v).to.set(2)
    expect(doc.v()).toEqual({ from: 1, to: 2 })
  })

  it("an interior leaf write replicates", () => {
    const bound = yjs.bind(StructNullable)
    const a = createDocAs("peer-a", bound)
    const b = createDocAs("peer-b", bound)
    a.v.set({ from: 1, to: null })
    inner(a.v).to.set(2)
    sync(a, b)
    expect(b.v()).toEqual({ from: 1, to: 2 })
  })

  it("the same write one field over, without a sum, works (control)", () => {
    const schema = Schema.struct({ required: Struct })
    const doc = createDoc(yjs.bind(schema))
    doc.required.set({ from: 1, to: null })
    doc.required.to.set(2)
    expect(doc.required()).toEqual({ from: 1, to: 2 })
  })
})

// ===========================================================================
// Bug class B — a collection mutation AT a sum
// ===========================================================================
//
// Wider than a write inside a sum, and more damaging: mutating the collection
// is the reason to reach for a nullable list or record in the first place.

describe("collection mutations at a sum", () => {
  it("push onto a nullable list", () => {
    expect(
      afterSync(
        () => createDoc(yjs.bind(ListNullable)),
        d => {
          d.v.set([1, 2])
          inner(d.v).push(3)
        },
      ),
    ).toEqual([1, 2, 3])
  })

  it("key write on a nullable record", () => {
    expect(
      afterSync(
        () => createDoc(yjs.bind(RecordNullable)),
        d => {
          d.v.set({ a: 1 })
          inner(d.v).set("b", 2)
        },
      ),
    ).toEqual({ a: 1, b: 2 })
  })
})

// ===========================================================================
// Whole-value writes at a sum — currently correct, must stay so
// ===========================================================================

describe("whole-value writes at a sum (regression guards)", () => {
  it("set, then reset to null", () => {
    const doc = createDoc(yjs.bind(StructNullable))
    doc.v.set({ from: 1, to: 3 })
    expect(doc.v()).toEqual({ from: 1, to: 3 })
    doc.v.set(null)
    expect(doc.v()).toBe(null)
  })

  it("materializing from null replicates", () => {
    const bound = yjs.bind(StructNullable)
    const a = createDocAs("peer-a", bound)
    const b = createDocAs("peer-b", bound)
    expect(a.v()).toBe(null)
    sync(a, b)
    expect(b.v()).toBe(null)

    a.v.set({ from: 4, to: 5 })
    sync(a, b)
    expect(b.v()).toEqual({ from: 4, to: 5 })
  })

  it("the variant is stored as one atomic value, not a nested Y.Map", () => {
    // Storage shape, not readback. A nested Y.Map would read back correctly
    // here but merge field-by-field when two peers switch variants at once,
    // producing a value that is half of each.
    const doc = createDoc(yjs.bind(StructNullable))
    doc.v.set({ from: 1, to: 3 })
    const entries = Object.values(ydoc(doc).getMap("root").toJSON())
    expect(entries).toContainEqual({ from: 1, to: 3 })
  })
})

// bind-constraints-ephemeral — what `ephemeral.bind()` accepts and rejects.
//
// `ephemeral` is a field-level LWW map. It declares a closed law set,
// `EphemeralLaws = "lww" | "lww-per-key" | "lww-tag-replaced"`, and
// `target.bind(schema)` applies `RestrictLaws<S, AllowedLaws>`: a schema
// carrying any other law resolves to `never`, so the call fails to compile.
// See TECHNICAL.md §"Composition-law enforcement".
//
// **A rejection case asserts twice over one call.** `tsc` is one of them: a
// `@ts-expect-error` whose call stops being an error becomes unused and fails
// the build, so the `types` task carries that half. The `toThrow` beneath it
// carries the other, for the caller `tsc` never sees — JavaScript, or any path
// holding an `any`. Acceptances are checked by both tasks.
//
// The two halves read different tables. `EphemeralLaws` belongs to the binding
// target; what a `StateTree` can store belongs to the substrate. §4 pins them
// against each other, and found them disagreeing about `.nullable()` the first
// time it ran.
//
// This suite exists because the contract held by accident. It matches
// `state-tree.ts`'s header — structs, maps, and opaque registers — and nothing
// asserted it, so the only way to find out what the target accepts was to
// attempt a bind and read the compiler error. A contract nobody can look up is one
// people guess at, and a guess written down reads exactly like a fact.
//
// The Loro and Yjs backends have carried an equivalent suite for their own law
// sets; this is the core-substrate one.

import { describe, expect, expectTypeOf, it } from "vitest"
import { type BoundSchema, ephemeral, Schema } from "../index.js"
import { ephemeralSubstrateFactory } from "../substrates/ephemeral.js"

// ===========================================================================
// §1 — Accepted: schemas within EphemeralLaws
// ===========================================================================

describe("ephemeral.bind() accepts LWW-family schemas", () => {
  it("scalars", () => {
    const schema = Schema.struct({
      name: Schema.string(),
      count: Schema.number(),
      active: Schema.boolean(),
    })
    const bound = ephemeral.bind(schema)
    expect(bound.schema).toBe(schema)
    expectTypeOf(bound).toMatchTypeOf<BoundSchema<typeof schema>>()
  })

  it("nested structs", () => {
    const schema = Schema.struct({
      outer: Schema.struct({ inner: Schema.struct({ x: Schema.number() }) }),
    })
    expect(ephemeral.bind(schema).schema).toBe(schema)
  })

  it("record — the roster shape the substrate exists for", () => {
    // A dynamic-key map carries `lww-per-key`: each key merges independently,
    // which is what lets peers write their own entry without clobbering.
    const schema = Schema.struct({ peers: Schema.record(Schema.number()) })
    expect(ephemeral.bind(schema).schema).toBe(schema)
  })

  it("record of structs", () => {
    const schema = Schema.struct({
      cursors: Schema.record(
        Schema.struct({ x: Schema.number(), y: Schema.number() }),
      ),
    })
    expect(ephemeral.bind(schema).schema).toBe(schema)
  })

  it("discriminated union — lww-tag-replaced", () => {
    const schema = Schema.struct({
      shape: Schema.discriminatedUnion("kind", [
        Schema.struct({
          kind: Schema.string("circle"),
          radius: Schema.number(),
        }),
        Schema.struct({ kind: Schema.string("square"), side: Schema.number() }),
      ]),
    })
    expect(ephemeral.bind(schema).schema).toBe(schema)
  })

  it("nullable struct — the positional-sum form", () => {
    const schema = Schema.struct({
      optional: Schema.struct({ a: Schema.number() }).nullable(),
    })
    expect(ephemeral.bind(schema).schema).toBe(schema)
  })

  it("`.json()`-wrapped collections", () => {
    // `.json()` collapses a subtree to an inert blob, leaving only `lww`. It is
    // the one route by which a sequence reaches this substrate — as an opaque
    // register, not as a sequence.
    const schema = Schema.struct({
      blobList: Schema.list.json(Schema.number()),
      blobRecord: Schema.record.json(Schema.string()),
      blobStruct: Schema.struct.json({ a: Schema.number() }),
    })
    expect(ephemeral.bind(schema).schema).toBe(schema)
  })
})

// ===========================================================================
// §2 — Rejected: CRDT laws outside EphemeralLaws
// ===========================================================================
//
// Each case asserts twice over one call. `@ts-expect-error` must sit directly
// above the failing call, which is why these cannot be driven from a table the
// way a runtime matrix could — the duplication is inherent to the mechanism,
// not an oversight. The `toThrow` beneath it covers the caller `tsc` never
// sees: JavaScript, or any path holding an `any`.
//
// The two guards answer different questions and can disagree. The law set is a
// property of the binding target; what the StateTree can store is a property
// of the substrate. §4 pins them against each other.

describe("ephemeral.bind() rejects CRDT schemas", () => {
  it("rejects a bare sequence (positional-ot)", () => {
    const schema = Schema.struct({ items: Schema.list(Schema.number()) })
    // @ts-expect-error — positional-ot is not in EphemeralLaws
    expect(() => ephemeral.bind(schema)).toThrow(/cannot store/)
  })

  it("rejects text (positional-ot)", () => {
    const schema = Schema.struct({ body: Schema.text() })
    // @ts-expect-error — positional-ot is not in EphemeralLaws
    expect(() => ephemeral.bind(schema)).toThrow(/cannot store/)
  })

  it("rejects a counter (additive)", () => {
    const schema = Schema.struct({ hits: Schema.counter() })
    // @ts-expect-error — additive is not in EphemeralLaws
    expect(() => ephemeral.bind(schema)).toThrow(/cannot store/)
  })

  it("rejects a set (add-wins-per-key)", () => {
    const schema = Schema.struct({ tags: Schema.set(Schema.string()) })
    // @ts-expect-error — add-wins-per-key is not in EphemeralLaws
    expect(() => ephemeral.bind(schema)).toThrow(/cannot store/)
  })

  it("rejects a tree (tree-move)", () => {
    const schema = Schema.struct({ nodes: Schema.tree(Schema.string()) })
    // @ts-expect-error — tree-move is not in EphemeralLaws
    expect(() => ephemeral.bind(schema)).toThrow(/cannot store/)
  })

  it("rejects a movable list (positional-ot-move)", () => {
    const schema = Schema.struct({
      ranked: Schema.movableList(Schema.string()),
    })
    // @ts-expect-error — positional-ot-move is not in EphemeralLaws
    expect(() => ephemeral.bind(schema)).toThrow(/cannot store/)
  })

  it("rejects a CRDT type nested deep inside a struct", () => {
    const schema = Schema.struct({
      a: Schema.struct({ b: Schema.struct({ c: Schema.text() }) }),
    })
    // @ts-expect-error — depth does not launder the law
    expect(() => ephemeral.bind(schema)).toThrow(/cannot store/)
  })

  it("rejects a CRDT type inside a record's item", () => {
    const schema = Schema.struct({ byKey: Schema.record(Schema.counter()) })
    // @ts-expect-error — the item's law propagates to the record
    expect(() => ephemeral.bind(schema)).toThrow(/cannot store/)
  })

  it("rejects a nullable sequence — `.nullable()` does not erase inner laws", () => {
    // Worth its own case. `.nullable()` wraps a schema in a sum, and it is easy
    // to assume the wrap makes the inside opaque the way `.json()` does. It does
    // not: the sequence's `positional-ot` still surfaces, so the whole schema is
    // still out of reach. Only `.json()` collapses a subtree to plain `lww`.
    const schema = Schema.struct({
      maybeItems: Schema.list(Schema.number()).nullable(),
    })
    // @ts-expect-error — positional-ot survives the .nullable() wrap
    expect(() => ephemeral.bind(schema)).toThrow(/cannot store/)
  })
})

// ===========================================================================
// §3 — The seam `bind()` cannot see
// ===========================================================================
//
// `ephemeralSubstrateFactory.create` is exported and takes a schema directly,
// so `bind()` is not on every path to a substrate. It matters more than a
// second door usually would: the tree is seeded from the schema's structural
// zero at construction, so an unrepresentable field is already stored wrongly
// before a caller could write to it.

describe("createStateSubstrate rejects what bind() would have", () => {
  it("refuses an unrepresentable kind", () => {
    const schema = Schema.struct({ items: Schema.list(Schema.number()) })
    expect(() => ephemeralSubstrateFactory.create(schema)).toThrow(
      /cannot store a sequence/,
    )
  })

  it("refuses .decay() below a register", () => {
    // The same gap, in the rule next door: `.decay()` inside a `.json()` blob
    // binds cleanly and then never fires, which is why `bind()` rejects it.
    // Reaching the substrate directly used to skip that check entirely.
    const schema = Schema.struct({
      blob: Schema.struct.json({ inner: Schema.string().decay(1000) }),
    })
    expect(() => ephemeralSubstrateFactory.create(schema)).toThrow(
      /decay\(\) cannot be set inside/,
    )
  })

  it("accepts a .json()-wrapped collection", () => {
    // The escape hatch the rejection messages point at. A wrapped list keeps
    // its sequence API and replicates as one register value.
    const schema = Schema.struct({ tags: Schema.list.json(Schema.string()) })
    expect(() => ephemeralSubstrateFactory.create(schema)).not.toThrow()
  })
})

// ===========================================================================
// §4 — The two guards agree
// ===========================================================================
//
// `EphemeralLaws` is a property of the binding target; what a `StateTree` can
// hold is a property of the substrate. Nothing derives one from the other, so
// they are two tables that must agree and can drift. Left to drift, a kind the
// types reject would bind at runtime, or a kind the types allow would throw
// where no `@ts-expect-error` marks it.
//
// The table below is the same set §1 and §2 assert one case at a time, read
// back as data. A kind added to either list belongs in both.

describe("the runtime rule matches the law set", () => {
  const item = <S>(kind: string, schema: S) => ({ kind, schema })

  const accepted = [
    item("scalar", Schema.string()),
    item("struct", Schema.struct({ n: Schema.string() })),
    item("record", Schema.record(Schema.string())),
    item(
      "record of structs",
      Schema.record(Schema.struct({ n: Schema.number() })),
    ),
    item("nullable struct", Schema.struct({ n: Schema.string() }).nullable()),
    item("list.json", Schema.list.json(Schema.string())),
    item("record.json", Schema.record.json(Schema.string())),
    item("struct.json", Schema.struct.json({ n: Schema.number() })),
  ]

  const rejected = [
    item("sequence", Schema.list(Schema.number())),
    item("text", Schema.text()),
    item("counter", Schema.counter()),
    item("set", Schema.set(Schema.string())),
    item("tree", Schema.tree(Schema.string())),
    item("movable", Schema.movableList(Schema.string())),
    item("nullable sequence", Schema.list(Schema.number()).nullable()),
  ]

  for (const { kind, schema } of accepted) {
    it(`accepts ${kind}`, () => {
      const doc = Schema.struct({ v: schema as never })
      expect(() => ephemeralSubstrateFactory.create(doc)).not.toThrow()
    })
  }

  for (const { kind, schema } of rejected) {
    it(`rejects ${kind}`, () => {
      const doc = Schema.struct({ v: schema as never })
      expect(() => ephemeralSubstrateFactory.create(doc)).toThrow(
        /cannot store/,
      )
    })
  }
})

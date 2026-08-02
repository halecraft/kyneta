// bind-constraints-ephemeral — what `ephemeral.bind()` accepts and rejects.
//
// `ephemeral` is a field-level LWW map. It declares a closed law set,
// `EphemeralLaws = "lww" | "lww-per-key" | "lww-tag-replaced"`, and
// `target.bind(schema)` applies `RestrictLaws<S, AllowedLaws>`: a schema
// carrying any other law resolves to `never`, so the call fails to compile.
// See TECHNICAL.md §"Composition-law enforcement".
//
// **`tsc` is the assertion in the rejection cases below, not vitest.** A test
// body that calls `bind()` under a `@ts-expect-error` and asserts nothing looks
// like dead weight, and is the opposite: if the call ever stops being an error,
// the directive becomes unused and `tsgo --noEmit` fails the build. The
// rejections are checked by the `types` task, the acceptances by both.
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
// Each case is a compile-time assertion. `@ts-expect-error` must sit directly
// above the failing call, which is why these cannot be driven from a table the
// way a runtime matrix could — the duplication is inherent to the mechanism,
// not an oversight.

describe("ephemeral.bind() rejects CRDT schemas", () => {
  it("rejects a bare sequence (positional-ot)", () => {
    const schema = Schema.struct({ items: Schema.list(Schema.number()) })
    // @ts-expect-error — positional-ot is not in EphemeralLaws
    ephemeral.bind(schema)
  })

  it("rejects text (positional-ot)", () => {
    const schema = Schema.struct({ body: Schema.text() })
    // @ts-expect-error — positional-ot is not in EphemeralLaws
    ephemeral.bind(schema)
  })

  it("rejects a counter (additive)", () => {
    const schema = Schema.struct({ hits: Schema.counter() })
    // @ts-expect-error — additive is not in EphemeralLaws
    ephemeral.bind(schema)
  })

  it("rejects a set (add-wins-per-key)", () => {
    const schema = Schema.struct({ tags: Schema.set(Schema.string()) })
    // @ts-expect-error — add-wins-per-key is not in EphemeralLaws
    ephemeral.bind(schema)
  })

  it("rejects a tree (tree-move)", () => {
    const schema = Schema.struct({ nodes: Schema.tree(Schema.string()) })
    // @ts-expect-error — tree-move is not in EphemeralLaws
    ephemeral.bind(schema)
  })

  it("rejects a movable list (positional-ot-move)", () => {
    const schema = Schema.struct({
      ranked: Schema.movableList(Schema.string()),
    })
    // @ts-expect-error — positional-ot-move is not in EphemeralLaws
    ephemeral.bind(schema)
  })

  it("rejects a CRDT type nested deep inside a struct", () => {
    const schema = Schema.struct({
      a: Schema.struct({ b: Schema.struct({ c: Schema.text() }) }),
    })
    // @ts-expect-error — depth does not launder the law
    ephemeral.bind(schema)
  })

  it("rejects a CRDT type inside a record's item", () => {
    const schema = Schema.struct({ byKey: Schema.record(Schema.counter()) })
    // @ts-expect-error — the item's law propagates to the record
    ephemeral.bind(schema)
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
    ephemeral.bind(schema)
  })
})

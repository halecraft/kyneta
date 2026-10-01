// protocol-guards — the six symbol-keyed protocols and the guards that narrow
// to them.
//
// Each of these slots is attached at runtime rather than declared on a public
// type: a root ref gets `[SUBSTRATE]`, a sequence item gets `[DELETED]`, a
// migrated schema gets `[MIGRATION_CHAIN]`, and so on. Reaching one used to
// mean `(x as any)[SYMBOL]`, which switched off far more checking than the
// property access needed — it also stopped verifying that `x` was the right
// kind of thing at all, and let the result be used as anything.
//
// The guards replace that. `hasChangefeed` in `@kyneta/changefeed` is the
// reference implementation; these follow it exactly.
//
// Two kinds of assertion below, and the distinction matters. The runtime tests
// check what the guard *decides*. The `expectTypeOf` tests check what it
// narrows to — which no runtime test can see, and which is the half that
// would silently rot: a guard written `value is any` passes every runtime test
// here while restoring no checking whatsoever.

import { describe, expect, expectTypeOf, it } from "vitest"
import { batch, createDoc } from "../basic/index.js"
import { hasTransact, TRANSACT } from "../interpreters/writable.js"
import {
  type HasMigrationChain,
  hasMigrationChain,
  MIGRATION_CHAIN,
} from "../migration.js"
import { type HasSubstrate, hasSubstrate, SUBSTRATE } from "../native.js"
import { DELETED, type HasDeleted, hasDeleted } from "../ref/address.js"
import { type HasPopulated, hasPopulated, POPULATED } from "../ref/observe.js"
import { Schema } from "../schema.js"
import { BACKING_DOC, type HasBackingDoc, hasBackingDoc } from "../substrate.js"

const Doc = Schema.struct({
  title: Schema.string(),
  items: Schema.list(Schema.struct({ label: Schema.string() })),
})

// Every guard answers `false` for the same set of non-objects, because they all
// share `hasChangefeed`'s shape. Table-driven so a guard added later that
// forgets the nullish handling is caught by adding one row.
const guards = [
  ["hasSubstrate", hasSubstrate as (v: unknown) => boolean, SUBSTRATE],
  ["hasBackingDoc", hasBackingDoc as (v: unknown) => boolean, BACKING_DOC],
  ["hasMigrationChain", hasMigrationChain, MIGRATION_CHAIN],
  ["hasPopulated", hasPopulated, POPULATED],
  ["hasDeleted", hasDeleted, DELETED],
  ["hasTransact", hasTransact, TRANSACT],
] as const

describe("every protocol guard agrees on what is not a carrier", () => {
  for (const [name, guard] of guards) {
    it(`${name} rejects nullish values, primitives and bare objects`, () => {
      expect(guard(null)).toBe(false)
      expect(guard(undefined)).toBe(false)
      expect(guard(42)).toBe(false)
      expect(guard("hello")).toBe(false)
      expect(guard(true)).toBe(false)
      expect(guard({})).toBe(false)
      expect(guard({ other: 1 })).toBe(false)
    })
  }

  for (const [name, guard, symbol] of guards) {
    it(`${name} accepts an object carrying the symbol`, () => {
      expect(guard({ [symbol]: {} })).toBe(true)
    })

    it(`${name} accepts a function carrying the symbol`, () => {
      // Carriers are frequently callable — `populatedFeed(ref)` returns a
      // function that also implements the changefeed protocol — so `typeof
      // value === "object"` alone would reject a legitimate carrier.
      const callable = Object.assign(() => true, { [symbol]: {} })
      expect(guard(callable)).toBe(true)
    })
  }
})

// ---------------------------------------------------------------------------
// What each guard narrows to
// ---------------------------------------------------------------------------

describe("narrowing", () => {
  it("hasSubstrate narrows to a carrier whose slot is a Substrate", () => {
    const value: unknown = {}
    if (hasSubstrate(value)) {
      expectTypeOf(value).toEqualTypeOf<HasSubstrate>()
      expectTypeOf(value[SUBSTRATE].version).toBeFunction()
    }
  })

  it("hasBackingDoc carries its backing type through", () => {
    const value: unknown = {}
    if (hasBackingDoc<{ marker: number }>(value)) {
      expectTypeOf(value).toEqualTypeOf<HasBackingDoc<{ marker: number }>>()
      expectTypeOf(value[BACKING_DOC].marker).toEqualTypeOf<number>()
    }
  })

  it("hasMigrationChain narrows to a schema carrying a chain", () => {
    const value: unknown = {}
    if (hasMigrationChain(value)) {
      expectTypeOf(value).toEqualTypeOf<HasMigrationChain>()
      expectTypeOf(value[MIGRATION_CHAIN].entries).toBeObject()
    }
  })

  it("hasPopulated narrows to a boolean-returning carrier", () => {
    const value: unknown = {}
    if (hasPopulated(value)) {
      expectTypeOf(value).toEqualTypeOf<HasPopulated>()
      expectTypeOf(value[POPULATED]()).toEqualTypeOf<boolean>()
    }
  })

  it("hasDeleted narrows to a boolean-returning carrier", () => {
    const value: unknown = {}
    if (hasDeleted(value)) {
      expectTypeOf(value).toEqualTypeOf<HasDeleted>()
      expectTypeOf(value[DELETED]()).toEqualTypeOf<boolean>()
    }
  })

  it("leaves the value unnarrowed when the guard is false", () => {
    // The other half of the contract, and the one a `value is any` guard
    // breaks: outside the narrowed branch the value must still be `unknown`.
    const value: unknown = {}
    if (!hasPopulated(value)) {
      expectTypeOf(value).toEqualTypeOf<unknown>()
    }
  })
})

// ---------------------------------------------------------------------------
// Against real refs, not hand-built stand-ins
// ---------------------------------------------------------------------------

describe("against refs the interpreter actually produces", () => {
  it("a document root carries a substrate; a field does not", () => {
    const doc: any = createDoc(Doc)
    expect(hasSubstrate(doc)).toBe(true)
    expect(hasSubstrate(doc.title)).toBe(false)
  })

  it("every ref tracks population", () => {
    const doc: any = createDoc(Doc)
    expect(hasPopulated(doc)).toBe(true)
    expect(hasPopulated(doc.title)).toBe(true)
  })

  it("every ref inside the document tracks deletion; the root does not", () => {
    // The root has no parent to be removed from, so it carries no deletion
    // state. Everything below it does — including a struct field, which cannot
    // itself be removed but must still report when the container holding it
    // was. `deletedFeed` throws on exactly the refs this returns false for.
    const doc: any = createDoc(Doc)
    batch(doc, (d: any) => d.items.push({ label: "a" }))

    expect(hasDeleted(doc)).toBe(false)
    expect(hasDeleted(doc.title)).toBe(true)
    expect(hasDeleted(doc.items)).toBe(true)
    expect(hasDeleted(doc.items.at(0))).toBe(true)
  })

  it("a plain schema carries no migration chain", () => {
    expect(hasMigrationChain(Doc)).toBe(false)
  })
})

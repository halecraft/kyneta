// pollution — namespace isolation between user data and framework metadata.
//
// Refs expose the user's schema fields as properties. Framework metadata
// therefore CANNOT be attached under string keys: a schema with a field named
// `populated` or `deleted` would be silently shadowed by the framework,
// making the user's data unreachable.
//
// The framework stores this metadata under unique symbols instead
// (`[POPULATED]` in with-changefeed.ts, `[DELETED]` in with-addressing.ts),
// read through the free-function facades `populated(ref)` / `populatedFeed(ref)`
// and `deleted(ref)` / `deletedFeed(ref)`.
//
// These tests pin that isolation in both directions: the user's colliding
// fields behave as ordinary data, and the framework's metadata stays correct
// on the very same refs.

import { describe, expect, it } from "vitest"
import { batch, createDoc, Schema } from "../basic/index.js"
import {
  deleted,
  deletedFeed,
  populated,
  populatedFeed,
  remove,
} from "../index.js"

// ---------------------------------------------------------------------------
// A schema whose field names collide with framework metadata
// ---------------------------------------------------------------------------

const CollidingSchema = Schema.struct({
  // Field names deliberately chosen to collide with every framework facade:
  // both the plain-boolean names and the `*Feed` carrier names.
  populated: Schema.boolean(),
  populatedFeed: Schema.number(),
  deleted: Schema.string(),
  deletedFeed: Schema.boolean(),
  items: Schema.list(
    Schema.struct({
      name: Schema.string(),
      deleted: Schema.boolean(),
    }),
  ),
})

/** Narrow `at()`'s optional return — a missing item is a test failure. */
function present<T>(ref: T | undefined): T {
  if (ref === undefined) throw new Error("expected the list item to exist")
  return ref
}

// ===========================================================================
// User fields win the namespace
// ===========================================================================

describe("namespace isolation — user fields", () => {
  it("exposes colliding field names as ordinary data refs", () => {
    const doc = createDoc(CollidingSchema)

    // These resolve to the user's fields, not framework metadata.
    expect(doc.populated()).toBe(false)
    expect(doc.populatedFeed()).toBe(0)
    expect(doc.deleted()).toBe("")
    expect(doc.deletedFeed()).toBe(false)
  })

  it("reads and writes colliding fields like any other field", () => {
    const doc = createDoc(CollidingSchema)

    batch(doc, d => {
      d.populated.set(true)
      d.deleted.set("tombstone")
    })

    expect(doc.populated()).toBe(true)
    expect(doc.deleted()).toBe("tombstone")
  })

  it("keeps colliding fields intact inside list items", () => {
    const doc = createDoc(CollidingSchema)

    batch(doc, d => {
      d.items.push({ name: "first", deleted: true })
    })

    const row = present(doc.items.at(0))
    expect(row.name()).toBe("first")
    expect(row.deleted()).toBe(true)
  })
})

// ===========================================================================
// Framework metadata stays correct on the same refs
// ===========================================================================

describe("namespace isolation — framework metadata", () => {
  it("tracks population on a doc whose fields shadow the facade names", () => {
    const doc = createDoc(CollidingSchema)

    // Framework state — read via the facade, never via a property.
    expect(populated(doc)).toBe(false)
    expect(populated(doc.populated)).toBe(false)

    batch(doc, d => d.populated.set(true))

    expect(populated(doc)).toBe(true)
    expect(populated(doc.populated)).toBe(true)
    // The untouched sibling stays unpopulated — the user's `deleted` field.
    expect(populated(doc.deleted)).toBe(false)
  })

  it("tracks deletion of a list item that carries its own `deleted` field", () => {
    const doc = createDoc(CollidingSchema)

    batch(doc, d => {
      d.items.push({ name: "first", deleted: false })
    })

    const row = present(doc.items.at(0))
    expect(deleted(row)).toBe(false)
    // The user's field — independent of the framework's deletion state.
    expect(row.deleted()).toBe(false)

    remove(row)

    expect(doc.items.length).toBe(0)
    expect(deleted(row)).toBe(true)
  })

  it("exposes reactive carriers without colliding with user fields", () => {
    const doc = createDoc(CollidingSchema)

    // `populatedFeed(ref)` returns a callable; the user's same-named field
    // remains reachable as an ordinary ref.
    expect(populatedFeed(doc.populated)()).toBe(false)
    expect(typeof doc.deleted()).toBe("string")

    batch(doc, d => d.populated.set(true))

    expect(populatedFeed(doc.populated)()).toBe(true)
  })

  it("never attaches framework metadata under a string key", () => {
    const doc = createDoc(CollidingSchema)
    batch(doc, d => {
      d.items.push({ name: "x", deleted: false })
    })
    const row = present(doc.items.at(0))

    // The regression this suite exists to prevent: attaching metadata as
    // `Object.defineProperty(ref, "populated", ...)` would make these
    // properties framework callables instead of the user's data.
    expect(typeof doc.populated()).toBe("boolean")
    expect(typeof doc.populatedFeed()).toBe("number")
    expect(typeof doc.deleted()).toBe("string")
    expect(typeof doc.deletedFeed()).toBe("boolean")
    expect(typeof row.deleted()).toBe("boolean")

    // And the item ref carries deletion metadata only under the symbol.
    expect(deleted(row)).toBe(false)
    expect(typeof deletedFeed(row)).toBe("function")
  })
})

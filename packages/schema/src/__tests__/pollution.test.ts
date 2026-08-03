// pollution — namespace isolation between user data and framework metadata.
//
// Refs expose the user's schema fields as properties. Framework metadata
// therefore CANNOT be attached under string keys: a schema with a field named
// `isPopulated` or `deleted` would be silently shadowed by the framework,
// making the user's data unreachable.
//
// The framework stores this metadata under unique symbols instead
// (`[POPULATED]` in with-changefeed.ts, `[DELETED]` in with-addressing.ts),
// read through the free-function facades `isPopulated(ref)` / `populatedFeed(ref)`
// and `isDeleted(ref)` / `deletedFeed(ref)`.
//
// These tests pin that isolation in both directions: the user's colliding
// fields behave as ordinary data, and the framework's metadata stays correct
// on the very same refs.

import { describe, expect, it } from "vitest"
import { batch, createDoc, Schema } from "../basic/index.js"
import {
  deletedFeed,
  isDeleted,
  isPopulated,
  populatedFeed,
  remove,
} from "../index.js"

// ---------------------------------------------------------------------------
// A schema whose field names collide with framework metadata
// ---------------------------------------------------------------------------

const CollidingSchema = Schema.struct({
  // Field names deliberately chosen to collide with framework metadata.
  isPopulated: Schema.boolean(),
  deleted: Schema.string(),
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
    expect(doc.isPopulated()).toBe(false)
    expect(doc.deleted()).toBe("")
  })

  it("reads and writes colliding fields like any other field", () => {
    const doc = createDoc(CollidingSchema)

    batch(doc, d => {
      d.isPopulated.set(true)
      d.deleted.set("tombstone")
    })

    expect(doc.isPopulated()).toBe(true)
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
    expect(isPopulated(doc)).toBe(false)
    expect(isPopulated(doc.isPopulated)).toBe(false)

    batch(doc, d => d.isPopulated.set(true))

    expect(isPopulated(doc)).toBe(true)
    expect(isPopulated(doc.isPopulated)).toBe(true)
    // The untouched sibling stays unpopulated — the user's `deleted` field.
    expect(isPopulated(doc.deleted)).toBe(false)
  })

  it("tracks deletion of a list item that carries its own `deleted` field", () => {
    const doc = createDoc(CollidingSchema)

    batch(doc, d => {
      d.items.push({ name: "first", deleted: false })
    })

    const row = present(doc.items.at(0))
    expect(isDeleted(row)).toBe(false)
    // The user's field — independent of the framework's deletion state.
    expect(row.deleted()).toBe(false)

    remove(row)

    expect(doc.items.length).toBe(0)
    expect(isDeleted(row)).toBe(true)
  })

  it("exposes reactive carriers without colliding with user fields", () => {
    const doc = createDoc(CollidingSchema)

    // `populatedFeed(ref)` returns a callable; the user's same-named field
    // remains reachable as an ordinary ref.
    expect(populatedFeed(doc.isPopulated)()).toBe(false)
    expect(typeof doc.deleted()).toBe("string")

    batch(doc, d => d.isPopulated.set(true))

    expect(populatedFeed(doc.isPopulated)()).toBe(true)
  })

  it("never attaches framework metadata under a string key", () => {
    const doc = createDoc(CollidingSchema)
    batch(doc, d => {
      d.items.push({ name: "x", deleted: false })
    })
    const row = present(doc.items.at(0))

    // The regression this suite exists to prevent: attaching metadata as
    // `Object.defineProperty(ref, "isPopulated", ...)` would make these
    // properties framework callables instead of the user's data.
    expect(typeof doc.isPopulated()).toBe("boolean")
    expect(typeof doc.deleted()).toBe("string")
    expect(typeof row.deleted()).toBe("boolean")

    // And the item ref carries deletion metadata only under the symbol.
    expect(isDeleted(row)).toBe(false)
    expect(typeof deletedFeed(row)).toBe("function")
  })
})

// `registerCacheHandler` historically composed handlers by wrapping
// the previous one in a fresh closure. Every re-interpretation at the
// same path (e.g. a sum-field re-dispatch after cache invalidation)
// appended a frame; eventually invoking the handler exceeded the V8
// stack. The fix keys registrations by registrant path so the registry
// size is bounded by the number of *distinct* registrants, not the
// number of registrations.

import { describe, expect, it } from "vitest"
import { json } from "../bind.js"
import { createDoc } from "../create-doc.js"
import { change } from "../facade/change.js"
import { __getCacheHandlerCountAtPath } from "../interpreters/with-caching.js"
import { TRANSACT } from "../interpreters/writable.js"
import { RawPath } from "../path.js"
import { Schema } from "../schema.js"

describe("with-caching: registrant-keyed handler registry", () => {
  it("repeated variant set() keeps the registry bounded by distinct registrants", () => {
    // Discriminated union as a product field. Every variant toggle
    // re-interprets the sum and re-registers a cache handler at the
    // sum-field's path. With the fix, registrants are keyed by path
    // and replace on re-registration.
    const schema = Schema.struct({
      payload: Schema.discriminatedUnion("type", [
        Schema.struct({
          type: Schema.string("A"),
          aVal: Schema.number(),
        }),
        Schema.struct({
          type: Schema.string("B"),
          bVal: Schema.string(),
        }),
      ]),
    })

    const doc = createDoc(json.bind(schema)) as any
    const ctx = doc[TRANSACT]
    const sumPathKey = RawPath.empty.field("payload").key

    change(doc, (d: any) => {
      d.payload.set({ type: "A", aVal: 0 })
    })
    const initialSize = __getCacheHandlerCountAtPath(ctx, sumPathKey)
    // Sanity-check that the inspector sees the registrant-keyed
    // registry (a future revert to composed closures would change
    // the data structure and this would read as 0).
    expect(initialSize).toBeGreaterThan(0)

    for (let i = 0; i < 50; i++) {
      change(doc, (d: any) => {
        if (i % 2 === 0) {
          d.payload.set({ type: "B", bVal: "x" })
        } else {
          d.payload.set({ type: "A", aVal: i })
        }
      })
    }

    expect(__getCacheHandlerCountAtPath(ctx, sumPathKey)).toBe(initialSize)
    expect(doc.payload.type).toBe("A")
    expect(doc.payload.aVal()).toBe(49)
  })
})

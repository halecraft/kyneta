// Regression: `registerCacheHandler` composes new handlers by wrapping the
// existing one in a fresh closure. Every re-interpretation at the same path
// (e.g. a sum-field re-dispatch after cache invalidation) appends a frame to
// the chain, so invoking the handler eventually exceeds the call-stack.
//
// The fix is to store handlers in a Set/array and iterate, not compose
// closures. Then chain depth is bounded by the number of *distinct*
// registrants, not the number of registrations.

import { describe, expect, it } from "vitest"
import { json } from "../bind.js"
import { createDoc } from "../create-doc.js"
import { change } from "../facade/change.js"
import { Schema } from "../schema.js"

describe("with-caching: handler-chain growth on repeated sum re-interpretation", () => {
  it("repeated variant set() does not blow the stack via composed-handler recursion", () => {
    // A discriminated union as a field of a product. The parent product
    // registers its `invalidateProduct` at the sum-field's path, and each
    // variant interpretation registers its own `invalidateProduct` at the
    // same path. The composed-closure registration accretes one frame per
    // re-interpretation.
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

    // Initial variant
    change(doc, (d: any) => {
      d.payload.set({ type: "A", aVal: 0 })
    })

    // Toggle the variant many times. Each set() invokes the composed handler
    // at the sum's path (RangeError if the chain is deeper than the V8 stack)
    // and then a subsequent access of `doc.payload` re-interprets the sum,
    // appending another frame.
    const ITERATIONS = 15_000
    for (let i = 0; i < ITERATIONS; i++) {
      change(doc, (d: any) => {
        if (i % 2 === 0) {
          d.payload.set({ type: "B", bVal: "x" })
        } else {
          d.payload.set({ type: "A", aVal: i })
        }
      })
    }

    // Last iteration is i = ITERATIONS - 1 (odd → variant A with aVal = i)
    expect(doc.payload.type).toBe("A")
    expect(doc.payload.aVal()).toBe(ITERATIONS - 1)
  })
})

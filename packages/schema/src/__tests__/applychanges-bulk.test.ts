// applychanges-bulk — blast-radius perf-sanity (NOT a benchmark).
//
// After the with-changefeed dispatcher refactor (jj:yksllknw), every
// `executeBatch` calls `ctx.prepare × N` then `ctx.flush × 1`. Each
// prepare now dispatches an `accumulate` Msg through the per-context
// dispatcher; the flush dispatches a single `flush` Msg. This test
// applies 10_000 ops in one batch and verifies:
//
// 1. No `BudgetExhaustedError` (default 100k budget is comfortable).
// 2. Wall-clock stays well under a generous cap.
//
// If this fails, the fix is to bracket `executeBatch` with a single
// synthetic begin/end dispatch so all N prepares + 1 flush share one
// outer dispatch cycle. Almost certainly won't be needed.

import { describe, expect, it } from "vitest"
import { replaceChange } from "../change.js"
import {
  applyChanges,
  interpret,
  observation,
  plainContext,
  readable,
  Schema,
  writable,
} from "../index.js"
import { RawPath } from "../path.js"

describe("applyChanges bulk perf-sanity", () => {
  it("10_000 replace ops in a single batch complete without budget exhaustion", () => {
    const schema = Schema.struct({
      n: Schema.number(),
    })
    const ctx = plainContext({ n: 0 })
    const doc = interpret(schema, ctx)
      .with(readable)
      .with(writable)
      .with(observation)
      .done() as any

    const ops = Array.from({ length: 10_000 }, (_, i) => ({
      path: RawPath.empty.field("n"),
      change: replaceChange(i),
    }))

    const start = performance.now()
    expect(() => applyChanges(doc, ops)).not.toThrow()
    const elapsed = performance.now() - start

    expect(doc.n()).toBe(9999)
    // Generous cap; this is a blast-radius check, not a benchmark.
    expect(elapsed).toBeLessThan(2_000)
  })
})

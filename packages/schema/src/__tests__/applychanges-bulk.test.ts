// applychanges-bulk — blast-radius sanity (NOT a benchmark, NOT a timing test).
//
// `applyChanges` calls `ctx.prepare × N` inside one `runBatch`, which seals
// one batch and dispatches a single `deliver` message through the context's
// delivery dispatcher. This test applies 10_000 ops in one batch
// and verifies the load-INVARIANT signals:
//
// 1. No `BudgetExhaustedError` — a per-op dispatch storm or runaway cascade
//    would exhaust the default 100k budget. This is the real regression guard.
// 2. Correctness — the final value reflects all 10_000 ops.
//
// A wall-clock assertion (`elapsed < 2000ms`) was removed deliberately: under
// `pnpm verify`'s concurrent turbo load it measured CPU contention, not the
// code, and flaked (~0.7s standalone vs ~2.5s under load). A genuine
// O(N²)/dispatch-storm regression trips the budget above (or blows past any
// cap by orders of magnitude), so the budget + correctness checks catch it
// without the flake. If item 1 ever fails, bracket the prepare-loop with a
// single synthetic begin/end dispatch so all N prepares + 1 flush share one
// outer dispatch cycle.

import { describe, expect, it } from "vitest"
import { replaceChange } from "../change.js"
import { applyChanges, Schema } from "../index.js"
import { RawPath } from "../path.js"
import { contextOver, refOver } from "./stack.js"

describe("applyChanges bulk perf-sanity", () => {
  it("10_000 replace ops in a single batch complete without budget exhaustion", () => {
    const schema = Schema.struct({
      n: Schema.number(),
    })
    const ctx = contextOver(schema, { n: 0 })
    const doc = refOver(schema, ctx) as any

    const ops = Array.from({ length: 10_000 }, (_, i) => ({
      path: RawPath.empty.field("n"),
      change: replaceChange(i),
    }))

    expect(() => applyChanges(doc, ops)).not.toThrow()
    expect(doc.n()).toBe(9999)
  })
})

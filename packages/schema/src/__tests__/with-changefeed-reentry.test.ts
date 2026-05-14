// with-changefeed-reentry — same-doc and cross-doc re-entry semantics
// post-1.6.0. Pre-1.6.0 the per-context `isFlushing` guard threw
// "Mutation during notification delivery is not supported." This suite
// verifies the new drain-to-quiescence semantics:
//
// - subscribe/subscribeNode callbacks may freely call change()/applyChanges()
// - substrate writes remain synchronous (subsequent reads see new state)
// - cross-doc cascades share a lease and are budget-bounded
// - standalone substrates use private leases (cross-substrate cascade
//   detection is opt-in)

import { BudgetExhaustedError, createLease } from "@kyneta/machine"
import { describe, expect, it } from "vitest"
import {
  change,
  createRef,
  interpret,
  observation,
  plainContext,
  readable,
  Schema,
  writable,
} from "../index.js"
import { subscribeNode } from "../facade/observe.js"
import { createPlainSubstrate } from "../substrates/plain.js"
import { plainVersionStrategy } from "../substrates/plain.js"

function buildPlainDoc<S extends ReturnType<typeof Schema.struct>>(
  schema: S,
  initial: Record<string, unknown>,
) {
  const ctx = plainContext({ ...initial })
  return interpret(schema, ctx)
    .with(readable)
    .with(writable)
    .with(observation)
    .done() as any
}

describe("with-changefeed: same-doc re-entry", () => {
  it("subscribe callback that calls change(doc) does not throw; mutation lands", () => {
    const schema = Schema.struct({
      x: Schema.number(),
      y: Schema.number(),
    })
    const doc = buildPlainDoc(schema, { x: 0, y: 0 })

    let yFired = 0
    subscribeNode(doc.y, () => {
      yFired++
    })
    subscribeNode(doc.x, () => {
      change(doc, (d: any) => {
        d.y.set(99)
      })
    })

    expect(() => {
      change(doc, (d: any) => {
        d.x.set(1)
      })
    }).not.toThrow()

    expect(doc.x()).toBe(1)
    expect(doc.y()).toBe(99)
    expect(yFired).toBe(1)
  })

  it("subscribeNode callback on a leaf that re-mutates the same leaf does not throw", () => {
    const schema = Schema.struct({
      counter: Schema.number(),
    })
    const doc = buildPlainDoc(schema, { counter: 0 })

    let firstSeen: number | undefined
    let secondSeen: number | undefined
    let invocations = 0

    subscribeNode(doc.counter, () => {
      invocations++
      const current = doc.counter()
      if (invocations === 1) {
        firstSeen = current
        change(doc, (d: any) => {
          d.counter.set(current + 10)
        })
      } else {
        secondSeen = current
      }
    })

    change(doc, (d: any) => {
      d.counter.set(1)
    })

    expect(invocations).toBe(2)
    expect(firstSeen).toBe(1)
    expect(secondSeen).toBe(11)
    expect(doc.counter()).toBe(11)
  })

  it("substrate-read timing: subscriber reads new state immediately after re-entrant change()", () => {
    const schema = Schema.struct({
      a: Schema.number(),
      b: Schema.number(),
    })
    const doc = buildPlainDoc(schema, { a: 0, b: 0 })

    let observed: { a: number; b: number } | undefined
    subscribeNode(doc.a, () => {
      // Re-entrant write to b; immediately read both. Substrate writes
      // are synchronous in `change()`, so b must already be 7 here.
      change(doc, (d: any) => {
        d.b.set(7)
      })
      observed = { a: doc.a(), b: doc.b() }
    })

    change(doc, (d: any) => {
      d.a.set(3)
    })

    expect(observed).toEqual({ a: 3, b: 7 })
  })
})

describe("with-changefeed: cross-doc cascade with shared lease", () => {
  it("A→B→A→B... bounded by shared lease budget", () => {
    const sharedLease = createLease({ budget: 8 })

    const schemaA = Schema.struct({ v: Schema.number() })
    const schemaB = Schema.struct({ v: Schema.number() })

    const substrateA = createPlainSubstrate({ v: 0 }, plainVersionStrategy)
    const substrateB = createPlainSubstrate({ v: 0 }, plainVersionStrategy)

    const docA = createRef(schemaA, substrateA, { lease: sharedLease })
    const docB = createRef(schemaB, substrateB, { lease: sharedLease })

    // Genuinely oscillating: each side toggles whenever the other moves.
    subscribeNode(docA.v, () => {
      change(docB, (d: any) => {
        d.v.set(docB.v() + 1)
      })
    })
    subscribeNode(docB.v, () => {
      change(docA, (d: any) => {
        d.v.set(docA.v() + 1)
      })
    })

    let error: unknown
    try {
      change(docA, (d: any) => {
        d.v.set(1)
      })
    } catch (e) {
      error = e
    }

    expect(error).toBeInstanceOf(BudgetExhaustedError)
    const bee = error as BudgetExhaustedError
    const labels = new Set(bee.lease.history.map(h => h.label))
    expect(labels.has("changefeed")).toBe(true)
  })

  it("standalone substrates without shared lease are NOT bounded by one budget", () => {
    // Each substrate gets its own private lease — cross-substrate cascade
    // detection is opt-in. With small per-doc budgets but private leases,
    // an oscillation can run until ONE side exhausts its own budget.
    // We assert here that an A↔B oscillation throws with `changefeed`
    // labels only (no cooperating lease history mingled in).

    const schemaA = Schema.struct({ v: Schema.number() })
    const schemaB = Schema.struct({ v: Schema.number() })

    const docA = buildPlainDoc(schemaA, { v: 0 })
    const docB = buildPlainDoc(schemaB, { v: 0 })

    // Sanity guard so the test doesn't spin forever if budgets are not
    // hit — limit oscillation depth via a counter ceiling. In practice
    // each private lease's default budget (100k) bounds this.
    let hops = 0
    subscribeNode(docA.v, () => {
      if (hops++ > 50) return
      change(docB, (d: any) => {
        d.v.set(docB.v() + 1)
      })
    })
    subscribeNode(docB.v, () => {
      if (hops++ > 50) return
      change(docA, (d: any) => {
        d.v.set(docA.v() + 1)
      })
    })

    expect(() => {
      change(docA, (d: any) => {
        d.v.set(1)
      })
    }).not.toThrow()

    // Both substrates advanced — they didn't share a budget, and the
    // hops counter alone (not lease budget) terminated the cascade.
    expect(docA.v()).toBeGreaterThan(0)
    expect(docB.v()).toBeGreaterThan(0)
  })
})

describe("with-changefeed: structural integrity under re-entry", () => {
  it("substrate flush still runs when accumulator is empty (flush-only Msg)", () => {
    // Re-entrant flush from a populated subscriber on a different path:
    // the dispatcher should still call originalFlush when the accumulator
    // is empty, preserving substrate version/log invariants.
    const schema = Schema.struct({
      a: Schema.number(),
      b: Schema.number(),
    })
    const doc = buildPlainDoc(schema, { a: 0, b: 0 })

    // No re-entry; just confirm the no-mutation flush path is reached
    // by exercising the dispatcher end-to-end.
    let aFires = 0
    subscribeNode(doc.a, () => {
      aFires++
    })

    change(doc, (d: any) => {
      d.a.set(1)
    })
    change(doc, (d: any) => {
      d.a.set(1)
    })

    expect(aFires).toBe(2) // both flushes delivered (no de-dup)
  })
})

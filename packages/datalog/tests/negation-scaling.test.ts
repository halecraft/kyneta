// === Negation Scaling ===
//
// Last-writer-wins is the workload `@kyneta/perspective` resolves every value
// conflict with, and for a long time it was the evidence that "evaluating LWW
// via Datalog is correct but inefficient" — the justification for keeping a
// hand-written native solver beside the rules. It was not the rules. The
// planner recorded a delta-driven negation as binding nothing, so the atom
// beside it fell back to a full scan per substitution and the program cost
// |superseded| x |active_value| per round.
//
// `plan.test.ts` guards the mask directly. This file guards the consequence,
// end to end through the public `evaluate`, because the mask is one of several
// ways to lose the same property.
//
// **Every assertion here is a ratio, never a clock.** The failure this catches
// is a change in *shape* — 4x the facts costing 16x the time instead of 4x —
// and a shape is the same on a busy CI box as on an idle laptop. Wall-clock
// ceilings in this package have a history of failing under a loaded machine
// while the code was fine, which teaches the reader to ignore them.

import { describe, expect, it } from "vitest"
import type { Fact, Rule } from "../src/index.js"
import {
  _,
  atom,
  evaluate,
  fact,
  gt,
  negation,
  neq,
  positiveAtom,
  rule,
  varTerm,
} from "../src/index.js"

/**
 * `performance` is a standard global in every runtime this package targets,
 * but its declaration lives in `lib.dom.d.ts` and `@types/node` — and this
 * package pulls in neither, so that nothing in `src` can reach for a platform
 * API without saying so. Declaring the one member the measurement uses keeps
 * that line where it belongs. `Date.now` is not a substitute: the ratio below
 * floors its denominator at half a millisecond, which needs sub-millisecond
 * resolution to mean anything.
 */
declare const performance: { now(): number }

const $ = varTerm

/** Competing writers per slot. Bounded, as concurrent writes to one field are. */
const WRITERS = 4

// ---------------------------------------------------------------------------
// The rules — `buildDefaultLWWRules()` from @kyneta/perspective's bootstrap
// ---------------------------------------------------------------------------

/** A value is superseded when a later lamport wrote the same slot. */
const supersededByLamport: Rule = rule(
  atom("superseded", [$("CnId"), $("Slot")]),
  [
    positiveAtom(atom("active_value", [$("CnId"), $("Slot"), _, $("L1"), _])),
    positiveAtom(atom("active_value", [$("CnId2"), $("Slot"), _, $("L2"), _])),
    neq($("CnId"), $("CnId2")),
    gt($("L2"), $("L1")),
  ],
)

/** The sole survivor per slot, via stratified negation. */
const winnerRule: Rule = rule(
  atom("winner", [$("Slot"), $("CnId"), $("Value")]),
  [
    positiveAtom(
      atom("active_value", [$("CnId"), $("Slot"), $("Value"), _, _]),
    ),
    negation(atom("superseded", [$("CnId"), $("Slot")])),
  ],
)

// ---------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------

/**
 * `total` writes spread over `total / WRITERS` slots, each writer holding a
 * distinct lamport so exactly one wins its slot.
 *
 * Bounded writers per slot is the realistic shape, and it is what makes the
 * *rule* linear: `superseded` pairs values within a slot, so pairs grow with
 * the slot count, not with the square of the store. (Put all `n` values in one
 * slot and `superseded` genuinely does have n² answers — that is a property of
 * the rule that no evaluator can plan away, and not the case here.)
 */
function activeValues(total: number): Fact[] {
  const facts: Fact[] = []
  for (let s = 0; s < total / WRITERS; s++) {
    for (let w = 0; w < WRITERS; w++) {
      facts.push(
        fact("active_value", [
          `cn-${s}-${w}`,
          `slot-${s}`,
          `v-${s}-${w}`,
          w,
          "p",
        ]),
      )
    }
  }
  return facts
}

/** The `superseded` facts the rules above would derive: everyone but the winner. */
function supersededFacts(total: number): Fact[] {
  const facts: Fact[] = []
  for (let s = 0; s < total / WRITERS; s++) {
    for (let w = 0; w < WRITERS - 1; w++) {
      facts.push(fact("superseded", [`cn-${s}-${w}`, `slot-${s}`]))
    }
  }
  return facts
}

/** Milliseconds one evaluation takes. */
function timeMs(rules: readonly Rule[], facts: readonly Fact[]): number {
  const started = performance.now()
  evaluate(rules, facts)
  return performance.now() - started
}

/**
 * Cost of 4x the facts, as a multiple of the cost of the baseline.
 *
 * Linear lands near 4, quadratic near 16. The two sizes are timed in
 * alternation, so a load that arrives mid-measurement slows both rather than
 * only the second, and each keeps its fastest run: load only ever adds time.
 * Timing all the small runs first let a busy machine (every package verifying
 * at once) land on the large ones alone and report 10x for linear code. The
 * floor on the denominator keeps a fast machine measuring the small case as ~0
 * from producing a huge ratio.
 */
function growthOver4x(
  rules: readonly Rule[],
  build: (n: number) => Fact[],
): number {
  const smallFacts = build(2000)
  const largeFacts = build(8000)
  evaluate(rules, smallFacts)
  evaluate(rules, largeFacts)
  let small = Number.POSITIVE_INFINITY
  let large = Number.POSITIVE_INFINITY
  for (let i = 0; i < 5; i++) {
    small = Math.min(small, timeMs(rules, smallFacts))
    large = Math.min(large, timeMs(rules, largeFacts))
  }
  return large / Math.max(small, 0.5)
}

// ---------------------------------------------------------------------------

describe("LWW through pure Datalog", () => {
  it("derives one winner per slot", () => {
    const result = evaluate(
      [supersededByLamport, winnerRule],
      activeValues(2000),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.getRelation("winner").size).toBe(2000 / WRITERS)
    // Everyone else is superseded, and nobody is superseded twice.
    expect(result.value.getRelation("superseded").size).toBe(
      2000 - 2000 / WRITERS,
    )
  })

  it("picks the highest lamport, not the first or last writer", () => {
    const result = evaluate(
      [supersededByLamport, winnerRule],
      [
        fact("active_value", ["a", "s", "early", 1, "p"]),
        fact("active_value", ["b", "s", "latest", 9, "p"]),
        fact("active_value", ["c", "s", "middle", 5, "p"]),
      ],
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.getRelation("winner").tuples()).toEqual([
      ["s", "b", "latest"],
    ])
  })

  it("scales linearly in the negation alone", () => {
    // `superseded` arrives ground, so the only work is the negation and the
    // atom planned beside it. This is the isolated regression: it ran 40x
    // slower, and quadratically, when the planner scanned here.
    const growth = growthOver4x([winnerRule], n => [
      ...activeValues(n),
      ...supersededFacts(n),
    ])

    expect(growth).toBeLessThan(8)
  })

  it("scales linearly across the whole program", () => {
    // Both strata together — deriving `superseded`, then negating over it.
    const growth = growthOver4x([supersededByLamport, winnerRule], activeValues)

    expect(growth).toBeLessThan(8)
  })
})

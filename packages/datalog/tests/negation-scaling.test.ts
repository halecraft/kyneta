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
// **The measure is work, never time.** Every tuple the evaluator examines
// passes through `matchAtomWithTuple`, so counting its calls counts the work an
// evaluation does, exactly and the same on every run. The failure this catches
// is a change in *shape*, 4x the facts costing 16x the work instead of 4x, and
// a count shows a shape without the noise a clock picks up from a loaded
// machine. A clock-based version of this file failed under a full parallel
// verify while the code was fine.

import { describe, expect, it, vi } from "vitest"
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

/** Tuples examined: one per `matchAtomWithTuple` call. `work` resets it. */
const examined = vi.hoisted(() => ({ count: 0 }))

vi.mock("../src/unify.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/unify.js")>()
  return {
    ...actual,
    matchAtomWithTuple: (
      ...args: Parameters<typeof actual.matchAtomWithTuple>
    ) => {
      examined.count++
      return actual.matchAtomWithTuple(...args)
    },
  }
})

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

/** Tuples one evaluation examines. */
function work(rules: readonly Rule[], facts: readonly Fact[]): number {
  examined.count = 0
  evaluate(rules, facts)
  return examined.count
}

/**
 * Work for 4x the facts, as a multiple of the work for the baseline.
 *
 * Linear is exactly 4 here, and the regression this guards exactly 16. The
 * count is exact, so the bound sits just above linear.
 */
function growthOver4x(
  rules: readonly Rule[],
  build: (n: number) => Fact[],
): number {
  return work(rules, build(8000)) / work(rules, build(2000))
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

    expect(growth).toBeLessThan(5)
  })

  it("scales linearly across the whole program", () => {
    // Both strata together — deriving `superseded`, then negating over it.
    const growth = growthOver4x([supersededByLamport, winnerRule], activeValues)

    expect(growth).toBeLessThan(5)
  })
})

// === How the default rule program stratifies ===
// Finer-grained stratification splits independent SCCs at the same dependency
// level into separate strata, so that LWW and Fugue — which share no predicate —
// never end up in one stratum and settle together. That is what makes the two
// rule families independently schedulable. These tests pin the shape the
// default program produces.
//
// The stratifier's own tests live with it, in `@kyneta/datalog`.

import type { Rule, Stratum } from "@kyneta/datalog"
import {
  _,
  atom,
  bodyPredicates,
  positiveAtom,
  rule,
  stratify,
  varTerm,
} from "@kyneta/datalog"
import { describe, expect, it } from "vitest"
import { buildDefaultLWWRules, buildDefaultRules } from "../../src/bootstrap.js"
import { defined } from "../helpers/defined.js"

/**
 * The stratum that holds `predicate`, or a failure naming it.
 *
 * Every test here locates strata this way, so "the program did not stratify
 * the way this test assumes" fails once, here, with the predicate named —
 * rather than as an `undefined.index` further down, or as a `?.index`
 * comparison that quietly passes.
 */
function stratumFor(strata: readonly Stratum[], predicate: string): Stratum {
  return defined(
    strata.find(s => s.predicates.has(predicate)),
    `a stratum holding "${predicate}"`,
  )
}

// ---------------------------------------------------------------------------
// Finer-Grained Stratification (Plan 007, Phase 1, Task 1.3)
// ---------------------------------------------------------------------------

describe("finer-grained stratification", () => {
  it("default LWW + Fugue rules produce 4 strata instead of 2", () => {
    const rules = buildDefaultRules()
    const result = stratify(rules)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const strata = result.value

    // Should produce 4 strata: 2 families × 2 dependency levels.
    const strataWithRules = strata.filter(s => s.rules.length > 0)
    expect(strataWithRules.length).toBe(4)

    // Stratum for superseded: 2 rules (supersededByLamport, supersededByPeer)
    const supersededStratum = stratumFor(strata, "superseded")
    expect(supersededStratum.rules.length).toBe(2)

    // Stratum for fugue_child + fugue_descendant: 3 rules
    const fugueChildStratum = stratumFor(strata, "fugue_child")
    expect(fugueChildStratum.predicates.has("fugue_descendant")).toBe(true)
    expect(fugueChildStratum.rules.length).toBe(3)

    // Stratum for winner: 1 rule
    const winnerStratum = stratumFor(strata, "winner")
    expect(winnerStratum.rules.length).toBe(1)

    // Stratum for fugue_before: 5 rules
    const fugueBeforeStratum = stratumFor(strata, "fugue_before")
    expect(fugueBeforeStratum.rules.length).toBe(5)

    // Ordering: level 0 strata before level 1 strata.
    expect(supersededStratum.index).toBeLessThan(winnerStratum.index)
    expect(fugueChildStratum.index).toBeLessThan(fugueBeforeStratum.index)

    // LWW and Fugue strata are separate at each level.
    expect(supersededStratum.index).not.toBe(fugueChildStratum.index)
    expect(winnerStratum.index).not.toBe(fugueBeforeStratum.index)
  })

  it("strata at the same dependency level are independent (no cross-references)", () => {
    const rules = buildDefaultRules()
    const result = stratify(rules)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const strata = result.value
    const supersededStratum = stratumFor(strata, "superseded")
    const fugueChildStratum = stratumFor(strata, "fugue_child")

    // Verify they are at the same dependency level (both at level 0).
    // They should have separate indices but both come before the level-1 strata.
    const winnerStratum = stratumFor(strata, "winner")
    const fugueBeforeStratum = stratumFor(strata, "fugue_before")

    expect(supersededStratum.index).toBeLessThan(winnerStratum.index)
    expect(supersededStratum.index).toBeLessThan(fugueBeforeStratum.index)
    expect(fugueChildStratum.index).toBeLessThan(winnerStratum.index)
    expect(fugueChildStratum.index).toBeLessThan(fugueBeforeStratum.index)

    // No derived predicate from superseded stratum appears in fugue stratum bodies.
    const supersededPreds = supersededStratum.predicates
    for (const r of fugueChildStratum.rules) {
      const bodyPreds = bodyPredicates(r.body)
      for (const bp of bodyPreds) {
        expect(supersededPreds.has(bp)).toBe(false)
      }
    }
  })

  it("adding a cross-family rule merges components into one stratum", () => {
    // Start with LWW + Fugue rules, then add a rule that bridges them.
    const defaultRules = buildDefaultRules()

    // Cross-family rule: references both active_value (LWW input)
    // and fugue_child (Fugue derived) — this creates a derived-predicate
    // link between LWW and Fugue strata at level 0.
    const crossRule: Rule = rule(atom("mixed", [varTerm("S"), varTerm("P")]), [
      positiveAtom(atom("superseded", [varTerm("CnId"), varTerm("S")])),
      positiveAtom(
        atom("fugue_child", [varTerm("P"), varTerm("CnId2"), _, _, _]),
      ),
    ])

    const result = stratify([...defaultRules, crossRule])
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const strata = result.value

    // The cross rule should merge superseded and fugue_child into one
    // component at level 0 (since mixed depends on both derived preds
    // at level 0).
    const supersededStratum = stratumFor(strata, "superseded")
    const fugueChildStratum = stratumFor(strata, "fugue_child")
    const mixedStratum = stratumFor(strata, "mixed")

    // mixed, superseded, and fugue_child should all be in the same stratum
    // because mixed references derived predicates from both families at level 0.
    expect(supersededStratum.index).toBe(fugueChildStratum.index)
    expect(mixedStratum.index).toBe(supersededStratum.index)
  })

  it("single-family rule sets produce same strata as before", () => {
    // LWW rules only — should produce 2 strata (superseded, winner).
    const lwwRules = buildDefaultLWWRules()
    const result = stratify(lwwRules)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const strata = result.value
    const strataWithRules = strata.filter(s => s.rules.length > 0)
    expect(strataWithRules.length).toBe(2)

    const supersededStratum = stratumFor(strata, "superseded")
    const winnerStratum = stratumFor(strata, "winner")
    expect(winnerStratum.index).toBeGreaterThan(supersededStratum.index)
  })

  it("ground predicates do not bridge independent families", () => {
    // Two independent rule families that share a ground predicate.
    // family_a derives from ground_input, family_b derives from ground_input.
    // They should NOT be merged into one stratum.
    const rules: Rule[] = [
      rule(atom("derived_a", [varTerm("X")]), [
        positiveAtom(atom("ground_input", [varTerm("X"), varTerm("Y")])),
      ]),
      rule(atom("derived_b", [varTerm("Y")]), [
        positiveAtom(atom("ground_input", [varTerm("X"), varTerm("Y")])),
      ]),
    ]

    const result = stratify(rules)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const strata = result.value
    const aStratum = stratumFor(strata, "derived_a")
    const bStratum = stratumFor(strata, "derived_b")

    // They should be in separate strata — ground_input doesn't bridge them.
    expect(aStratum.index).not.toBe(bStratum.index)
  })
})

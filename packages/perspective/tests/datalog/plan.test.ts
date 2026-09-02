// === Rule Evaluation Plan Tests ===
//
// `planRuleEvaluation` is the evaluator's functional core: every decision
// about how to evaluate a rule body — which database each element reads, which
// element the delta drives, which positions are already known, and what order
// to visit them in — is made here, before a single tuple is touched.
//
// That means it can be tested directly, which matters most for join order:
// the one decision that is a genuine judgement call, and the only one that
// changes the order facts come out in.

import { describe, expect, it } from "vitest"
import {
  evaluatePositiveAtom,
  planRuleEvaluation,
} from "../../src/datalog/evaluate.js"
import type { Rule } from "../../src/datalog/types.js"
import {
  _,
  aggregation,
  atom,
  constTerm,
  Database,
  fact,
  gt,
  negation,
  positiveAtom,
  rule,
  varTerm,
} from "../../src/datalog/types.js"
import { EMPTY_SUBSTITUTION } from "../../src/datalog/unify.js"

const $ = varTerm
const NO_DELTA_PREDS: ReadonlySet<string> = new Set<string>()

/** A database holding `count` distinct tuples for `predicate`. */
function sized(predicate: string, count: number): Database {
  const db = new Database()
  for (let i = 0; i < count; i++) db.addFact(fact(predicate, [i, i]))
  return db
}

/** Merge several sized relations into one database. */
function withSizes(spec: Record<string, number>): Database {
  const db = new Database()
  for (const [pred, count] of Object.entries(spec)) {
    for (let i = 0; i < count; i++) db.addFact(fact(pred, [i, i]))
  }
  return db
}

/** The body predicates a plan visits, in plan order. */
function predicateOrder(steps: readonly { element: unknown }[]): string[] {
  return steps.map(s => {
    const el = s.element as { kind: string; atom?: { predicate: string } }
    return el.atom?.predicate ?? el.kind
  })
}

// The rule from the Runeloop report: recursive fire spread over materialized
// adjacency. Its three atoms have very different sizes, which is what makes
// join order matter.
const fireSpread: Rule = rule(atom("lit", [$("X2"), $("Y2")]), [
  positiveAtom(atom("lit", [$("X1"), $("Y1")])),
  positiveAtom(atom("adj", [$("X1"), $("Y1"), $("X2"), $("Y2")])),
  positiveAtom(atom("flammable", [$("X2"), $("Y2")])),
])

describe("planRuleEvaluation — structure", () => {
  it("marks exactly one delta source, at the requested index", () => {
    const plan = planRuleEvaluation(fireSpread, 1, new Set(["adj"]))
    const sources = plan.filter(s => s.isDeltaSource)
    expect(sources).toHaveLength(1)
    expect(
      (sources[0]?.element as { atom: { predicate: string } }).atom.predicate,
    ).toBe("adj")
  })

  it("marks no delta source on the non-delta path (deltaIdx = -1)", () => {
    const plan = planRuleEvaluation(fireSpread, -1, NO_DELTA_PREDS)
    expect(plan.some(s => s.isDeltaSource)).toBe(false)
    expect(plan.every(s => s.source === "new")).toBe(true)
  })

  it("visits every body element exactly once", () => {
    const plan = planRuleEvaluation(fireSpread, 0, new Set(["lit"]), {
      current: withSizes({ lit: 100, adj: 400, flammable: 100 }),
      delta: sized("lit", 1),
    })
    expect(plan).toHaveLength(fireSpread.body.length)
    expect(new Set(predicateOrder(plan)).size).toBe(3)
  })
})

describe("planRuleEvaluation — the asymmetric join", () => {
  // For a self-join P ⋈ P the correct incremental update is
  // ΔP ⋈ P_new + P_old ⋈ ΔP. Using P_new on both sides would count every pair
  // where both elements are in ΔP twice.
  const selfJoin: Rule = rule(atom("path", [$("X"), $("Z")]), [
    positiveAtom(atom("path", [$("X"), $("Y")])),
    positiveAtom(atom("path", [$("Y"), $("Z")])),
  ])

  it("reads P_new before the delta source and P_old after it", () => {
    const plan = planRuleEvaluation(selfJoin, 1, new Set(["path"]))
    const byIndex = new Map(
      plan.map(s => [selfJoin.body.indexOf(s.element), s.source]),
    )

    expect(byIndex.get(0)).toBe("new") // before deltaIdx, same predicate
    expect(byIndex.get(1)).toBe("delta")
  })

  it("keys old/new on the original body index, not on plan order", () => {
    // Sizes here make the planner put body[1] (the delta source) first, so
    // plan order and body order disagree. body[0] must still read P_new.
    const plan = planRuleEvaluation(selfJoin, 1, new Set(["path"]), {
      current: sized("path", 500),
      delta: sized("path", 1),
    })

    expect(plan[0]?.isDeltaSource).toBe(true) // reordered to the front
    const nonDelta = plan.find(s => !s.isDeltaSource)
    expect(selfJoin.body.indexOf(nonDelta!.element)).toBe(0)
    expect(nonDelta?.source).toBe("new")
  })

  it("reads P_old for a predicate the delta does not touch", () => {
    const plan = planRuleEvaluation(fireSpread, 0, new Set(["lit"]))
    const adj = plan.find(
      s =>
        (s.element as { atom?: { predicate: string } }).atom?.predicate ===
        "adj",
    )
    expect(adj?.source).toBe("old")
  })
})

describe("planRuleEvaluation — known positions", () => {
  it("marks constants as known even with nothing bound yet", () => {
    const r = rule(atom("h", [$("Y")]), [
      positiveAtom(atom("p", [constTerm("a"), $("Y")])),
    ])
    expect(planRuleEvaluation(r, -1, NO_DELTA_PREDS)[0]?.mask).toBe(0b01)
  })

  it("marks variables bound by earlier steps, and nothing else", () => {
    const plan = planRuleEvaluation(fireSpread, -1, NO_DELTA_PREDS)
    // lit(X1, Y1) leads with nothing known; adj then knows its first two
    // positions; flammable knows both of its own.
    expect(plan[0]?.mask).toBe(0)
    expect(plan[1]?.mask).toBe(0b0011)
    expect(plan[2]?.mask).toBe(0b11)
  })

  it("never marks a wildcard as known", () => {
    const r = rule(atom("h", [$("X")]), [
      positiveAtom(atom("p", [$("X"), _])),
      positiveAtom(atom("q", [$("X"), _])),
    ])
    expect(planRuleEvaluation(r, -1, NO_DELTA_PREDS)[1]?.mask).toBe(0b01)
  })

  it("falls back to a full scan for atoms too wide to mask", () => {
    // The mask is 32 bits. Wider atoms are unreachable in practice but must
    // degrade to scanning rather than mask a wrong position.
    const wide = Array.from({ length: 40 }, (_v, i) => $(`V${i}`))
    const r = rule(atom("h", [$("V0")]), [
      positiveAtom(atom("bound", [$("V0")])),
      positiveAtom(atom("wide", wide)),
    ])
    const plan = planRuleEvaluation(r, -1, NO_DELTA_PREDS)
    const wideStep = plan.find(
      s =>
        (s.element as { atom?: { predicate: string } }).atom?.predicate ===
        "wide",
    )
    expect(wideStep?.mask).toBe(0)
  })
})

describe("planRuleEvaluation — join order", () => {
  it("keeps source order when given no size estimates", () => {
    expect(
      predicateOrder(planRuleEvaluation(fireSpread, 0, new Set(["lit"]))),
    ).toEqual(["lit", "adj", "flammable"])
  })

  it("leads with the tiny delta on a per-tick update", () => {
    // exploded(X, Y) :- lit(X, Y), spores(X, Y). One spore fact arrives over a
    // database with 3,000 lit facts. Source order would scan all of `lit`.
    const sporeBoom = rule(atom("exploded", [$("X"), $("Y")]), [
      positiveAtom(atom("lit", [$("X"), $("Y")])),
      positiveAtom(atom("spores", [$("X"), $("Y")])),
    ])

    const plan = planRuleEvaluation(sporeBoom, 1, new Set(["spores"]), {
      current: withSizes({ lit: 3000, spores: 50 }),
      delta: sized("spores", 1),
    })

    expect(predicateOrder(plan)).toEqual(["spores", "lit"])
    expect(plan[1]?.mask).toBe(0b11) // `lit` is now an indexed lookup
  })

  it("does NOT lead with the delta when the delta is the whole fact set", () => {
    // During a batch seed the "delta" is every ground fact, so hoisting it
    // would put the largest relation first. This is the case a fixed
    // delta-source-first rule gets wrong.
    const plan = planRuleEvaluation(fireSpread, 1, new Set(["adj"]), {
      current: withSizes({ lit: 1, adj: 11640, flammable: 3000 }),
      delta: sized("adj", 11640),
    })

    expect(predicateOrder(plan)[0]).toBe("lit")
    expect(predicateOrder(plan)).toEqual(["lit", "adj", "flammable"])
  })

  it("schedules a guard as soon as its variables are bound", () => {
    const r = rule(atom("h", [$("X")]), [
      positiveAtom(atom("big", [$("X"), $("Y")])),
      positiveAtom(atom("small", [$("X")])),
      gt($("X"), constTerm(5)),
    ])

    const plan = planRuleEvaluation(r, -1, NO_DELTA_PREDS, {
      current: withSizes({ big: 5000, small: 20 }),
      delta: new Database(),
    })

    // `small` is cheapest, then the guard becomes free, and it runs before the
    // expensive join rather than after it.
    expect(predicateOrder(plan)).toEqual(["small", "guard", "big"])
  })

  it("keeps source order for a body containing an aggregation", () => {
    // Aggregation is a group-by boundary that resets provenance weight to 1.
    // It does not commute with joins, so nothing in the body may move.
    const r = rule(atom("h", [$("G"), $("N")]), [
      positiveAtom(atom("big", [$("G"), $("V")])),
      aggregation({
        fn: "count",
        groupBy: ["G"],
        over: "V",
        result: "N",
        source: atom("small", [$("G"), $("V")]),
      }),
    ])

    const plan = planRuleEvaluation(r, -1, NO_DELTA_PREDS, {
      current: withSizes({ big: 5000, small: 20 }),
      delta: new Database(),
    })

    expect(predicateOrder(plan)).toEqual(["big", "aggregation"])
  })
})

describe("planRuleEvaluation — safety", () => {
  it("never schedules a negation before the atoms that bind it", () => {
    // unburned(X, Y) :- flammable(X, Y), not lit(X, Y).
    // `lit` is far smaller, but scheduling the negation first would evaluate
    // it with unbound variables — a different rule entirely.
    const unburned = rule(atom("unburned", [$("X"), $("Y")]), [
      positiveAtom(atom("flammable", [$("X"), $("Y")])),
      negation(atom("lit", [$("X"), $("Y")])),
    ])

    const plan = planRuleEvaluation(unburned, -1, NO_DELTA_PREDS, {
      current: withSizes({ flammable: 3000, lit: 1 }),
      delta: new Database(),
    })

    expect(predicateOrder(plan)).toEqual(["flammable", "lit"])
    expect(plan[1]?.element.kind).toBe("negation")
  })

  it("never schedules a guard before the atoms that bind it", () => {
    const r = rule(atom("h", [$("X"), $("Y")]), [
      gt($("X"), $("Y")),
      positiveAtom(atom("p", [$("X"), $("Y")])),
    ])

    const plan = planRuleEvaluation(r, -1, NO_DELTA_PREDS, {
      current: sized("p", 100),
      delta: new Database(),
    })

    expect(predicateOrder(plan)).toEqual(["p", "guard"])
  })

  it("evaluates identically with the mask omitted and with mask 0", () => {
    // `evaluatePositiveAtom` takes the mask as an optional trailing parameter,
    // and `0` is the correct degenerate answer: scan everything. That is what
    // keeps callers without a plan — including the existing tests that pin the
    // `allEntries` weight semantics — correct rather than merely compiling.
    const db = new Database()
    db.addFact(fact("p", ["a", 1]))
    db.addFact(fact("p", ["b", 2]))
    db.addFact(fact("p", ["a", 3]))

    const a = atom("p", [$("X"), $("Y")])
    const omitted = evaluatePositiveAtom(a, db, [EMPTY_SUBSTITUTION])
    const explicit = evaluatePositiveAtom(a, db, [EMPTY_SUBSTITUTION], false, 0)

    expect(omitted).toEqual(explicit)
    expect(omitted).toHaveLength(3)

    // Same for the weighted path, where the default for `allEntries` matters.
    const weighted = new Database()
    weighted.relation("q").addWeighted(["x"], 3)
    const q = atom("q", [$("X")])
    expect(
      evaluatePositiveAtom(q, weighted, [EMPTY_SUBSTITUTION], true),
    ).toEqual(evaluatePositiveAtom(q, weighted, [EMPTY_SUBSTITUTION], true, 0))
  })

  it("falls back to source order when nothing is safely evaluable", () => {
    // A guard over variables no atom binds. The plan cannot improve on source
    // order, and must not drop the element.
    const r = rule(atom("h", [$("X")]), [
      positiveAtom(atom("p", [$("X")])),
      gt($("Unbound"), constTerm(1)),
    ])

    const plan = planRuleEvaluation(r, -1, NO_DELTA_PREDS, {
      current: sized("p", 100),
      delta: new Database(),
    })

    expect(plan).toHaveLength(2)
    expect(predicateOrder(plan)).toEqual(["p", "guard"])
  })
})

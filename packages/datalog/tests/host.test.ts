// === Host relations and functions ===
//
// Foreign strata: a relation the host computes, placed by the stratifier
// after its inputs and before its readers, re-run when an input's presence
// changes, diffed against its previous output. Compute elements: a host
// function inside the join, a guard that binds. And the two checks that keep
// rules and hosts honest with each other: `hostErrors` for the engine,
// `declarationErrors` for a consumer linking a pack.
//
// The differential sweep over the grid terrain lives in `evaluator.test.ts`,
// beside the other sweeps.

import { zsetIsEmpty, zsetSingleton, zsetSize } from "@kyneta/zset"
import { describe, expect, it } from "vitest"
import { evaluateNaive, planRuleEvaluation } from "../src/evaluate.js"
import {
  createEvaluator,
  evaluateUnified as evaluate,
  factsToZSet,
} from "../src/evaluator.js"
import {
  declarationErrors,
  type ForeignRelation,
  type Host,
  type HostFunction,
  hostErrors,
} from "../src/host.js"
import { stratify } from "../src/stratify.js"
import type { Fact, Rule } from "../src/types.js"
import {
  _,
  atom,
  compute,
  constTerm,
  Database,
  fact,
  factKey,
  lt,
  positiveAtom,
  rule,
  varTerm,
} from "../src/types.js"
import { countingDistanceField, DISTANCE_FIELD } from "./fields.js"

const $ = varTerm
const NO_DELTA_PREDS: ReadonlySet<string> = new Set<string>()

const double: HostFunction = {
  arity: 1,
  version: "1",
  apply: args => (args[0] as number) * 2,
}

/**
 * A foreign relation with a body that returns nothing; enough for placement.
 * `arity` defaults to 1, the width every rule in this file reads it at.
 */
function foreign(
  predicate: string,
  inputs: readonly string[],
  body: ForeignRelation["compute"] = () => [],
  arity = 1,
): ForeignRelation {
  return { predicate, arity, inputs, version: "1", compute: body }
}

/** Sorted `key: weight` pairs of a step delta, for exact comparisons. */
function weights(
  zs: ReadonlyMap<string, { weight: number }>,
): [string, number][] {
  return [...zs.entries()]
    .map(([k, e]) => [k, e.weight] as [string, number])
    .sort()
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

describe("hostErrors: what the engine checks before it runs", () => {
  const host: Host = { functions: { double } }

  it("names a function the host lacks", () => {
    const r = rule(atom("d", [$("X"), $("Y")]), [
      positiveAtom(atom("n", [$("X")])),
      compute("double", [$("X")], $("Y")),
    ])
    expect(hostErrors([r], {})).toEqual([
      { kind: "unknownHostFunction", fn: "double", rule: r },
    ])
    expect(hostErrors([r], host)).toEqual([])
  })

  it("refuses a rule that derives a foreign predicate", () => {
    const r = rule(atom("dist", [$("X"), $("Y"), constTerm(0)]), [
      positiveAtom(atom("origin", [$("X"), $("Y")])),
    ])
    expect(hostErrors([r], { relations: [DISTANCE_FIELD] })).toEqual([
      { kind: "foreignPredicateDerived", predicate: "dist", rule: r },
    ])
  })

  it("static safety: an argument nothing binds is an error; one bound by another compute is not", () => {
    const unbound = rule(atom("d", [$("Y")]), [
      compute("double", [$("X")], $("Y")),
    ])
    expect(hostErrors([unbound], host)).toMatchObject([
      { kind: "unboundComputeArgument", fn: "double", variable: "X" },
    ])

    // Textual order does not matter: binding is computed to a fixed point.
    const chained = rule(atom("d", [$("Z")]), [
      compute("double", [$("Y")], $("Z")),
      positiveAtom(atom("n", [$("X")])),
      compute("double", [$("X")], $("Y")),
    ])
    expect(hostErrors([chained], host)).toEqual([])

    // Two computes feeding each other bind nothing.
    const cycle = rule(atom("d", [$("Y")]), [
      compute("double", [$("Y")], $("X")),
      compute("double", [$("X")], $("Y")),
    ])
    expect(hostErrors([cycle], host)).toHaveLength(2)
  })
})

describe("declarationErrors: what a consumer checks when it links a pack", () => {
  const declared = {
    predicate: "dist",
    arity: 3,
    inputs: ["origin", "adj", "blocked"],
    version: "1",
  }

  it("passes a host that registers what is declared", () => {
    expect(
      declarationErrors(
        { relations: [declared] },
        { relations: [DISTANCE_FIELD] },
      ),
    ).toEqual([])
  })

  it("reports a declaration with no registration", () => {
    expect(declarationErrors({ relations: [declared] }, {})).toEqual([
      { kind: "unregisteredForeignRelation", predicate: "dist" },
    ])
  })

  it("reports a declared function the host lacks, or one that differs", () => {
    const needsHash = {
      functions: { hash: { arity: 3, version: "1" } },
    }
    expect(declarationErrors(needsHash, {})).toEqual([
      { kind: "unregisteredHostFunction", fn: "hash" },
    ])

    const hash = (arity: number, version: string): HostFunction => ({
      arity,
      version,
      apply: args => String(args[0]),
    })
    expect(
      declarationErrors(needsHash, { functions: { hash: hash(3, "1") } }),
    ).toEqual([])

    // A different arity, and a different version, each on their own.
    expect(
      declarationErrors(needsHash, { functions: { hash: hash(2, "1") } }),
    ).toMatchObject([{ kind: "hostFunctionDeclarationMismatch", fn: "hash" }])
    expect(
      declarationErrors(needsHash, { functions: { hash: hash(3, "2") } }),
    ).toMatchObject([{ kind: "hostFunctionDeclarationMismatch", fn: "hash" }])
  })

  it("reports a different version, input list or arity", () => {
    const other = { ...DISTANCE_FIELD, version: "2" }
    expect(
      declarationErrors({ relations: [declared] }, { relations: [other] }),
    ).toMatchObject([{ kind: "foreignDeclarationMismatch", predicate: "dist" }])
    const fewer = { ...DISTANCE_FIELD, inputs: ["origin", "adj"] }
    expect(
      declarationErrors({ relations: [declared] }, { relations: [fewer] }),
    ).toHaveLength(1)
    const narrower = { ...DISTANCE_FIELD, arity: 2 }
    expect(
      declarationErrors({ relations: [declared] }, { relations: [narrower] }),
    ).toMatchObject([
      {
        kind: "foreignDeclarationMismatch",
        predicate: "dist",
        registered: { arity: 2 },
      },
    ])
  })
})

describe("registering a host function", () => {
  it("refuses a bare function, naming it", () => {
    // TypeScript rejects this outright — the cast is how the test expresses a
    // JavaScript caller who did not get that warning. Without the guard the
    // bare function's built-in `.apply` would be invoked later with the
    // argument array as its `this` and no arguments, failing somewhere inside
    // a join rather than here.
    const stale = {
      functions: { double: ((args: readonly unknown[]) => args[0]) as never },
    }
    expect(() => createEvaluator([], stale)).toThrow(
      /host function "double" must be registered as \{ arity, version, apply \}/,
    )
  })
})

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

describe("foreign relations in the stratifier", () => {
  const derivesA = rule(atom("a", [$("X")]), [
    positiveAtom(atom("g", [$("X")])),
  ])
  const readsF = rule(atom("r", [$("X")]), [positiveAtom(atom("f", [$("X")]))])

  function strataFor(rules: Rule[], relations: ForeignRelation[]) {
    const result = stratify(rules, { relations })
    if (!result.ok) throw new Error(JSON.stringify(result.error))
    const indexOf = (pred: string) =>
      result.value.find(s => s.predicates.has(pred))?.index ?? -1
    return { strata: result.value, indexOf }
  }

  it("lands strictly above its inputs and strictly below its readers, alone", () => {
    const f = foreign("f", ["a", "b"])
    const { strata, indexOf } = strataFor([derivesA, readsF], [f])
    expect(indexOf("f")).toBeGreaterThan(indexOf("a"))
    expect(indexOf("f")).toBeGreaterThan(indexOf("b"))
    expect(indexOf("r")).toBeGreaterThan(indexOf("f"))

    const own = strata.find(s => s.foreign !== undefined)
    expect(own?.foreign).toBe(f)
    expect(own?.rules).toEqual([])
    expect(own?.predicates).toEqual(new Set(["f"]))
  })

  it("with no inputs it still precedes its readers and has no rules", () => {
    const f = foreign("f", [])
    const { strata, indexOf } = strataFor([readsF], [f])
    expect(indexOf("r")).toBeGreaterThan(indexOf("f"))
    expect(strata.find(s => s.foreign === f)?.rules).toEqual([])
  })

  it("refuses a reader of the wrong width, where it would refuse a missing name", () => {
    const readsWide = rule(atom("r", [$("X"), $("Y")]), [
      positiveAtom(atom("f", [$("X"), $("Y")])),
    ])
    const host = { relations: [foreign("f", [])] }

    const result = stratify([readsWide], host)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe("foreignArityMismatch")

    // And it reaches a caller of the evaluator as a throw, not as an `r`
    // nothing ever derived.
    expect(() => createEvaluator([readsWide], host)).toThrow(
      /"f" with 2 terms, but it holds 1-tuples/,
    )
  })

  it("a rule deriving it is an error, and recursing through it is cyclic", () => {
    const derivesF = rule(atom("f", [$("X")]), [
      positiveAtom(atom("g", [$("X")])),
    ])
    const derived = stratify([derivesF], { relations: [foreign("f", ["g"])] })
    expect(derived.ok).toBe(false)
    if (!derived.ok) expect(derived.error.kind).toBe("foreignPredicateDerived")

    const cyclic = stratify([readsF], { relations: [foreign("f", ["r"])] })
    expect(cyclic.ok).toBe(false)
    if (!cyclic.ok) expect(cyclic.error.kind).toBe("cyclicNegation")
  })
})

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

describe("a foreign stratum at run time", () => {
  /** The demand pattern: the hoisted body becomes an ordinary input. */
  const originRule = rule(atom("origin", [$("X"), $("Y")]), [
    positiveAtom(atom("player", [$("P")])),
    positiveAtom(atom("at", [$("P"), $("X"), $("Y")])),
  ])
  const blockedRule = rule(atom("blocked", [$("X"), $("Y")]), [
    positiveAtom(atom("wall", [$("X"), $("Y")])),
  ])
  /** A reader: every step that gets closer to an origin. */
  const towardRule = rule(atom("toward", [$("X"), $("Y"), $("X2"), $("Y2")]), [
    positiveAtom(atom("dist", [$("X"), $("Y"), $("D")])),
    positiveAtom(atom("adj", [$("X"), $("Y"), $("X2"), $("Y2")])),
    positiveAtom(atom("dist", [$("X2"), $("Y2"), $("D2")])),
    lt($("D2"), $("D")),
  ])
  const rules = [originRule, blockedRule, towardRule]

  /** Three tiles in a row, the player on the left one. */
  const line: Fact[] = [
    fact("adj", [0, 0, 1, 0]),
    fact("adj", [1, 0, 0, 0]),
    fact("adj", [1, 0, 2, 0]),
    fact("adj", [2, 0, 1, 0]),
    fact("player", ["p"]),
    fact("at", ["p", 0, 0]),
  ]
  const dist = (x: number, y: number, d: number) =>
    factKey(fact("dist", [x, y, d]))

  it("runs at construction, then only when an input's presence flips, and says which", () => {
    const field = countingDistanceField()
    const evaluator = createEvaluator(rules, { relations: [field] })
    expect(field.runs.count).toBe(1)
    expect([...field.runs.lastChanged].sort()).toEqual([
      "adj",
      "blocked",
      "origin",
    ])

    evaluator.step(factsToZSet(line))
    expect(field.runs.count).toBe(2)
    expect([...field.runs.lastChanged].sort()).toEqual(["adj", "origin"])
    expect(evaluator.currentDatabase().getRelation("dist").has([2, 0, 2])).toBe(
      true,
    )

    // Unrelated facts do not reach it.
    evaluator.step(factsToZSet([fact("unrelated", [1])]))
    expect(field.runs.count).toBe(2)

    // A wall flips `blocked`, so it runs and only `blocked` changed.
    evaluator.step(factsToZSet([fact("wall", [1, 0])]))
    expect(field.runs.count).toBe(3)
    expect([...field.runs.lastChanged]).toEqual(["blocked"])
    expect(evaluator.currentDatabase().getRelation("dist").has([2, 0, 2])).toBe(
      false,
    )

    // The same wall again raises its weight without flipping presence.
    evaluator.step(factsToZSet([fact("wall", [1, 0])]))
    expect(field.runs.count).toBe(3)

    // A rule change recomputes everything, and every input is "changed".
    evaluator.changeRules(
      zsetSingleton("marker", rule(atom("m", [constTerm(1)]), []), 1),
    )
    expect(field.runs.count).toBe(4)
    expect([...field.runs.lastChanged].sort()).toEqual([
      "adj",
      "blocked",
      "origin",
    ])
  })

  it("the step delta holds exactly what appeared or disappeared, readers included", () => {
    const evaluator = createEvaluator(rules, { relations: [DISTANCE_FIELD] })
    evaluator.step(factsToZSet(line))

    const walled = evaluator.step(factsToZSet([fact("wall", [1, 0])]))
    expect(weights(walled)).toEqual([
      [factKey(fact("blocked", [1, 0])), 1],
      [dist(1, 0, 1), -1],
      [dist(2, 0, 2), -1],
      [factKey(fact("toward", [1, 0, 0, 0])), -1],
      [factKey(fact("toward", [2, 0, 1, 0])), -1],
    ])
  })

  it("the demand pattern: the player moves in one step, and the field follows the origin", () => {
    const evaluator = createEvaluator(rules, { relations: [DISTANCE_FIELD] })
    evaluator.step(factsToZSet(line))

    const moved = evaluator.step(
      factsToZSet([fact("at", ["p", 2, 0])]).size === 0
        ? factsToZSet([])
        : new Map([
            ...factsToZSet([fact("at", ["p", 0, 0])], -1),
            ...factsToZSet([fact("at", ["p", 2, 0])]),
          ]),
    )
    const distances = evaluator.currentDatabase().getRelation("dist").tuples()
    expect([...distances].sort()).toEqual([
      [0, 0, 2],
      [1, 0, 1],
      [2, 0, 0],
    ])
    // The old origin's outputs went with it; the tile in the middle kept its
    // distance and is not in the delta at all.
    expect(weights(moved)).toContainEqual([dist(0, 0, 0), -1])
    expect(weights(moved)).toContainEqual([dist(0, 0, 2), 1])
    expect(weights(moved).some(([k]) => k === dist(1, 0, 1))).toBe(false)
  })

  it("a tuple returned twice is present once", () => {
    const twice = foreign("twice", ["g"], read => [
      ...read.getRelation("g").tuples(),
      ...read.getRelation("g").tuples(),
    ])
    const evaluator = createEvaluator([], { relations: [twice] })
    const delta = evaluator.step(factsToZSet([fact("g", [1])]))
    expect(zsetSize(delta)).toBe(1)
    expect(
      evaluator.currentDatabase().getRelation("twice").getWeight([1]),
    ).toBe(1)
  })

  it("a tuple of a width the relation does not declare throws", () => {
    const wide = foreign("w", ["g"], () => [[1, 2]])
    expect(() => createEvaluator([], { relations: [wide] })).toThrow(
      /"w" declares arity 1 and yielded a tuple of 2/,
    )
  })

  it("an undeclared read throws, naming the predicate", () => {
    const nosy = foreign("nosy", ["a"], read => read.getRelation("b").tuples())
    expect(() => createEvaluator([], { relations: [nosy] })).toThrow(
      /"nosy" read "b"/,
    )
  })

  it("a relation with no inputs holds from construction", () => {
    const constants = foreign("k", [], () => [[1], [2]])
    const evaluator = createEvaluator([], { relations: [constants] })
    expect(evaluator.currentDatabase().getRelation("k").size).toBe(2)
    expect(zsetIsEmpty(evaluator.step(factsToZSet([fact("g", [1])])))).toBe(
      true,
    )
  })

  it("batch equals incremental", () => {
    const host: Host = { relations: [DISTANCE_FIELD] }
    const batch = evaluate(rules, [...line, fact("wall", [1, 0])], host)
    expect(batch.ok).toBe(true)
    if (!batch.ok) return

    const evaluator = createEvaluator(rules, host)
    evaluator.step(factsToZSet(line))
    evaluator.step(factsToZSet([fact("wall", [1, 0])]))

    for (const pred of ["dist", "toward", "blocked"]) {
      expect(
        [...evaluator.currentDatabase().getRelation(pred).tuples()].sort(),
      ).toEqual([...batch.value.getRelation(pred).tuples()].sort())
    }
  })
})

// ---------------------------------------------------------------------------
// Compute elements
// ---------------------------------------------------------------------------

describe("compute elements: a guard that binds", () => {
  const host: Host = {
    functions: {
      double,
      half: {
        arity: 1,
        version: "1",
        apply: args => {
          const n = args[0] as number
          return n % 2 === 0 ? n / 2 : undefined
        },
      },
      isNull: { arity: 1, version: "1", apply: args => args[0] === null },
      tag: {
        arity: 2,
        version: "1",
        apply: args => `${String(args[0])}:${String(args[1])}`,
      },
    },
  }
  const numbers = [fact("n", [1]), fact("n", [2]), fact("n", [3])]
  const tuples = (db: Database, pred: string) =>
    [...db.getRelation(pred).tuples()].sort()

  it("binds an unbound result", () => {
    const r = rule(atom("d", [$("X"), $("Y")]), [
      positiveAtom(atom("n", [$("X")])),
      compute("double", [$("X")], $("Y")),
    ])
    const result = evaluate([r], numbers, host)
    expect(result.ok && tuples(result.value, "d")).toEqual([
      [1, 2],
      [2, 4],
      [3, 6],
    ])
    // The naive oracle agrees.
    expect(tuples(evaluateNaive([r], numbers, host), "d")).toEqual([
      [1, 2],
      [2, 4],
      [3, 6],
    ])
  })

  it("filters against a bound result, and against a constant", () => {
    const bound = rule(atom("pair", [$("X"), $("Y")]), [
      positiveAtom(atom("n", [$("X")])),
      positiveAtom(atom("n", [$("Y")])),
      compute("double", [$("X")], $("Y")),
    ])
    const result = evaluate([bound], numbers, host)
    expect(result.ok && tuples(result.value, "pair")).toEqual([[1, 2]])

    const constant = rule(atom("four", [$("X")]), [
      positiveAtom(atom("n", [$("X")])),
      compute("double", [$("X")], constTerm(4)),
    ])
    const c = evaluate([constant], numbers, host)
    expect(c.ok && tuples(c.value, "four")).toEqual([[2]])
  })

  it("a wildcard result keeps the row; undefined drops it", () => {
    const wild = rule(atom("kept", [$("X")]), [
      positiveAtom(atom("n", [$("X")])),
      compute("double", [$("X")], _),
    ])
    const w = evaluate([wild], numbers, host)
    expect(w.ok && tuples(w.value, "kept")).toEqual([[1], [2], [3]])

    const halves = rule(atom("h", [$("X"), $("Y")]), [
      positiveAtom(atom("n", [$("X")])),
      compute("half", [$("X")], $("Y")),
    ])
    const h = evaluate([halves], numbers, host)
    expect(h.ok && tuples(h.value, "h")).toEqual([[2, 1]])
  })

  it("a null-bound argument is a value, passed as null", () => {
    const r = rule(atom("nul", [$("X"), $("Y")]), [
      positiveAtom(atom("v", [$("X")])),
      compute("isNull", [$("X")], $("Y")),
    ])
    const result = evaluate([r], [fact("v", [null]), fact("v", ["a"])], host)
    expect(result.ok && tuples(result.value, "nul")).toEqual([
      [null, true],
      ["a", false],
    ])
  })

  it("the planner orders it after its arguments and prices it as a filter", () => {
    const r = rule(atom("d", [$("X"), $("Y")]), [
      compute("double", [$("X")], $("Y")),
      positiveAtom(atom("n", [$("X")])),
    ])
    const db = new Database()
    for (const f of numbers) db.addFact(f)
    const planned = planRuleEvaluation(r, -1, NO_DELTA_PREDS, {
      current: db,
      delta: db,
    })
    expect(planned.map(s => s.element.kind)).toEqual(["atom", "compute"])
    expect(planned[1]?.source).toBe("new")
    // Without sizes the plan keeps source order.
    expect(
      planRuleEvaluation(r, -1, NO_DELTA_PREDS).map(s => s.element.kind),
    ).toEqual(["compute", "atom"])
  })

  it("is incremental across ticks, without a recompute", () => {
    const draw = rule(atom("draw", [$("X"), $("T"), $("V")]), [
      positiveAtom(atom("tile", [$("X")])),
      positiveAtom(atom("tick", [$("T")])),
      compute("tag", [$("T"), $("X")], $("V")),
    ])
    const evaluator = createEvaluator([draw], host)
    evaluator.step(factsToZSet([fact("tile", [1]), fact("tile", [2])]))
    const first = evaluator.step(factsToZSet([fact("tick", [1])]))
    expect(weights(first)).toEqual([
      [factKey(fact("draw", [1, 1, "1:1"])), 1],
      [factKey(fact("draw", [2, 1, "1:2"])), 1],
    ])

    const next = evaluator.step(
      new Map([
        ...factsToZSet([fact("tick", [1])], -1),
        ...factsToZSet([fact("tick", [2])]),
      ]),
    )
    expect(weights(next)).toEqual([
      [factKey(fact("draw", [1, 1, "1:1"])), -1],
      [factKey(fact("draw", [1, 2, "2:1"])), 1],
      [factKey(fact("draw", [2, 1, "1:2"])), -1],
      [factKey(fact("draw", [2, 2, "2:2"])), 1],
    ])
  })

  it("an unregistered function is an error from evaluate and a throw from createEvaluator", () => {
    const r = rule(atom("d", [$("X"), $("Y")]), [
      positiveAtom(atom("n", [$("X")])),
      compute("missing", [$("X")], $("Y")),
    ])
    const result = evaluate([r], numbers, host)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe("unknownHostFunction")
    expect(() => createEvaluator([r], host)).toThrow(/"missing"/)

    const unsafe = rule(atom("d", [$("Y")]), [
      compute("double", [$("X")], $("Y")),
    ])
    const safety = evaluate([unsafe], [], host)
    expect(safety.ok).toBe(false)
    if (!safety.ok) expect(safety.error.kind).toBe("unboundComputeArgument")
  })
})

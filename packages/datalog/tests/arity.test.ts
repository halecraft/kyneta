// === One arity per predicate ===
//
// The law: a predicate has one arity, and every mention of it agrees. See
// `src/arity.ts` for why an engine that keys relations by name alone has no
// choice but to enforce it.
//
// These tests live in their own file rather than in `stratify.test.ts` or
// `host.test.ts` because the law spans both — it covers predicates the rules
// derive and predicates the host declares, and it is the same law either way.

import { zsetAdd, zsetSingleton } from "@kyneta/zset"
import { describe, expect, it } from "vitest"
import { analyzeArity } from "../src/arity.js"
import {
  createEvaluator,
  evaluateUnified as evaluate,
  factsToZSet,
} from "../src/evaluator.js"
import { hostErrors } from "../src/host.js"
import { stratify } from "../src/stratify.js"
import {
  _,
  aggregation,
  atom,
  compute,
  constTerm,
  fact,
  negation,
  positiveAtom,
  rule,
  varTerm,
} from "../src/types.js"
import { defined } from "./defined.js"
import { DISTANCE_FIELD } from "./fields.js"

const $ = varTerm

/** A host registering the worked-example distance field, which holds 3-tuples. */
const field = { relations: [DISTANCE_FIELD] }

describe("two mentions that disagree with each other", () => {
  it("names the predicate and both rules when two heads disagree", () => {
    const wide = rule(atom("foo", [$("X"), $("Y"), $("Z")]), [
      positiveAtom(atom("src3", [$("X"), $("Y"), $("Z")])),
    ])
    const narrow = rule(atom("foo", [$("X"), $("Y")]), [
      positiveAtom(atom("src2", [$("X"), $("Y")])),
    ])

    const { errors } = analyzeArity([wide, narrow])
    expect(errors).toHaveLength(1)
    const conflict = defined(errors[0], "the conflict")
    expect(conflict.kind).toBe("arityConflict")
    if (conflict.kind !== "arityConflict") return

    expect(conflict.predicate).toBe("foo")
    // Which mention lands in `first` follows the order the rules arrived in,
    // and rule order reaches the engine from a consumer's constraint set. The
    // claim worth pinning is that both sites are named, not which is which.
    expect([conflict.first.arity, conflict.second.arity].sort()).toEqual([2, 3])
    expect([conflict.first.rule, conflict.second.rule]).toContain(wide)
    expect([conflict.first.rule, conflict.second.rule]).toContain(narrow)
  })

  it("catches a body atom reading a relation at a width no rule writes", () => {
    // `foo` is written at 2 and read at 3. The reader can never match.
    const writes = rule(atom("foo", [$("X"), $("Y")]), [
      positiveAtom(atom("src", [$("X"), $("Y")])),
    ])
    const reads = rule(atom("bar", [$("X")]), [
      positiveAtom(atom("foo", [$("X"), $("Y"), $("Z")])),
    ])

    const { errors } = analyzeArity([writes, reads])
    expect(errors).toMatchObject([{ kind: "arityConflict", predicate: "foo" }])
    const conflict = defined(errors[0], "the conflict")
    if (conflict.kind !== "arityConflict") return
    // One site is the head that writes it, the other the body that reads it.
    expect([conflict.first.position, conflict.second.position].sort()).toEqual([
      "body",
      "head",
    ])
  })

  it("catches a negation and an aggregation source too", () => {
    const writes = rule(atom("foo", [$("X"), $("Y")]), [
      positiveAtom(atom("src", [$("X"), $("Y")])),
    ])
    const negated = rule(atom("bar", [$("X")]), [
      positiveAtom(atom("src", [$("X"), $("Y")])),
      negation(atom("foo", [$("X")])),
    ])
    expect(analyzeArity([writes, negated]).errors).toMatchObject([
      { kind: "arityConflict", predicate: "foo" },
    ])

    const aggregated = rule(atom("count_foo", [$("X"), $("N")]), [
      aggregation({
        fn: "count",
        groupBy: ["X"],
        over: "Y",
        result: "N",
        source: atom("foo", [$("X"), $("Y"), $("Z")]),
      }),
    ])
    expect(analyzeArity([writes, aggregated]).errors).toMatchObject([
      { kind: "arityConflict", predicate: "foo" },
    ])
  })

  it("accepts a program that agrees, wildcards included", () => {
    // A wildcard occupies a position: `foo(X, _)` is arity 2, not 1.
    const writes = rule(atom("foo", [$("X"), $("Y")]), [
      positiveAtom(atom("src", [$("X"), $("Y")])),
    ])
    const reads = rule(atom("bar", [$("X")]), [
      positiveAtom(atom("foo", [$("X"), _])),
    ])
    const analysis = analyzeArity([writes, reads])
    expect(analysis.errors).toEqual([])
    expect(analysis.arity.get("foo")).toBe(2)
  })
})

describe("the error reaches a caller", () => {
  const wide = rule(atom("foo", [$("X"), $("Y"), $("Z")]), [
    positiveAtom(atom("src3", [$("X"), $("Y"), $("Z")])),
  ])
  const narrow = rule(atom("foo", [$("X"), $("Y")]), [
    positiveAtom(atom("src2", [$("X"), $("Y")])),
  ])

  it("through stratify's Result, and as a throw from createEvaluator", () => {
    const result = stratify([wide, narrow])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe("arityConflict")

    // The message has to name both widths, or it does not tell the reader
    // which of the two rules is the one they meant to write.
    expect(() => createEvaluator([wide, narrow])).toThrow(
      /"foo" is used at two widths.*arity 2.*arity 3|"foo" is used at two widths.*arity 3.*arity 2/,
    )
  })
})

describe("a compute element that calls a function at the wrong width", () => {
  it("is refused, naming both widths", () => {
    // `dist` takes 4 arguments; this rule passes 3. Without the check the
    // function reads `undefined` for the fourth and returns NaN, which the
    // engine stores as an ordinary value that then joins with itself.
    const host = {
      functions: {
        dist: {
          arity: 4,
          version: "1",
          apply: (args: readonly unknown[]) =>
            Math.hypot(
              (args[2] as number) - (args[0] as number),
              (args[3] as number) - (args[1] as number),
            ),
        },
      },
    }
    const r = rule(atom("d", [$("A"), $("D")]), [
      positiveAtom(atom("p", [$("A"), $("X"), $("Y"), $("Z")])),
      compute("dist", [$("X"), $("Y"), $("Z")], $("D")),
    ])
    expect(analyzeArity([r], host).errors).toEqual([
      {
        kind: "hostFunctionArityMismatch",
        fn: "dist",
        declared: 4,
        found: 3,
        rule: r,
      },
    ])
  })
})

describe("ground facts are held to the program's arity", () => {
  // `edge` is read at 2, so the program's arity for it is 2.
  const spread = rule(atom("reach", [$("Y")]), [
    positiveAtom(atom("reach", [$("X")])),
    positiveAtom(atom("edge", [$("X"), $("Y")])),
  ])

  it("refuses a fact of the wrong width, naming both widths", () => {
    const evaluator = createEvaluator([spread])
    expect(() =>
      evaluator.step(factsToZSet([fact("edge", [1, 2, 3])])),
    ).toThrow(/"edge" carries 3 values.*at arity 2/)
  })

  it("leaves a predicate the program never mentions alone", () => {
    // Deliberate limit: an unmentioned predicate has no arity to check
    // against, and inferring one from the first fact seen would be stateful
    // and surprising. See `checkGroundArity` in `evaluator.ts`.
    const evaluator = createEvaluator([spread])
    expect(() =>
      evaluator.step(factsToZSet([fact("unrelated", [1, 2, 3, 4])])),
    ).not.toThrow()
  })

  it("follows a rule change, in both directions", () => {
    // The arity map is state the evaluator holds and refreshes when the rules
    // change. If it ever went stale, this check would keep enforcing the old
    // program's shapes against the new one — silently, and in whichever
    // direction happened to be wrong.
    const reads2 = rule(atom("out", [$("A")]), [
      positiveAtom(atom("foo", [$("A"), $("B")])),
    ])
    const reads3 = rule(atom("out", [$("A")]), [
      positiveAtom(atom("foo", [$("A"), $("B"), $("C")])),
    ])

    const evaluator = createEvaluator([reads2])
    expect(() =>
      evaluator.step(factsToZSet([fact("foo", [1, 2, 3])])),
    ).toThrow()

    evaluator.changeRules(
      zsetAdd(zsetSingleton("r2", reads2, -1), zsetSingleton("r3", reads3, 1)),
    )

    // What the old program refused, the new one accepts, and the reverse.
    expect(() =>
      evaluator.step(factsToZSet([fact("foo", [1, 2, 3])])),
    ).not.toThrow()
    expect(() => evaluator.step(factsToZSet([fact("foo", [9, 9])]))).toThrow(
      /at arity 3/,
    )
  })

  it("throws from the batch API too, rather than returning an error value", () => {
    // `evaluate` reports *rule* problems through its Result. A wrong-width
    // fact is not one: it is a mistake in the data a caller handed over, the
    // same class as passing a string where a number belongs. It throws here
    // for the same reason it throws from `step`, and the asymmetry is
    // deliberate — do not turn it into a Result without changing `step` too.
    const reads2 = rule(atom("out", [$("A")]), [
      positiveAtom(atom("foo", [$("A"), $("B")])),
    ])
    expect(() => evaluate([reads2], [fact("foo", [1, 2, 3])])).toThrow(
      /"foo" carries 3 values/,
    )
  })

  it("rejects the whole delta, leaving the database untouched", () => {
    // This is the test that fails if anyone moves the check inside
    // `applyGroundDelta`'s loop. That loop mutates as it walks, so a throw
    // part-way through would store the facts before the bad one with none of
    // their derivations — and a later step never revisits them.
    const evaluator = createEvaluator([spread])
    const facts = [
      fact("reach", [0]),
      fact("edge", [0, 1]),
      fact("edge", [1, 2]),
      fact("edge", [2, 3, 999]), // the bad one, after three good ones
    ]
    expect(() => evaluator.step(factsToZSet(facts))).toThrow(/"edge" carries 3/)

    const db = evaluator.currentDatabase()
    expect(db.getRelation("edge").size).toBe(0)
    expect(db.getRelation("reach").size).toBe(0)

    // And the evaluator still works: a later valid delta derives everything,
    // rather than building on a half-written base.
    evaluator.step(
      factsToZSet([
        fact("reach", [0]),
        fact("edge", [0, 1]),
        fact("edge", [1, 2]),
      ]),
    )
    expect([
      ...evaluator.currentDatabase().getRelation("reach").tuples(),
    ]).toEqual([[0], [1], [2]])
  })
})

describe("a compute element that can never produce a row", () => {
  it("refuses a wildcard argument, naming the position", () => {
    // `_` matches anything and binds nothing, so it never resolves to a value
    // — and a host function needs one for every argument. Every row is
    // dropped, which without this check is an empty relation and no error.
    const r = rule(atom("d", [$("X"), $("Y")]), [
      positiveAtom(atom("n", [$("X")])),
      compute("double", [$("X"), _], $("Y")),
    ])
    expect(
      hostErrors([r], {
        functions: {
          double: { arity: 1, version: "1", apply: args => args[0] },
        },
      }),
    ).toEqual([
      { kind: "wildcardComputeArgument", fn: "double", index: 1, rule: r },
    ])
  })

  it("still allows a wildcard as the *result*, which is meaningful", () => {
    // A wildcard result means "call it, keep the row, discard the answer" —
    // useful when the function is being used as a filter.
    const r = rule(atom("d", [$("X")]), [
      positiveAtom(atom("n", [$("X")])),
      compute("double", [$("X")], _),
    ])
    expect(
      hostErrors([r], {
        functions: {
          double: { arity: 1, version: "1", apply: args => args[0] },
        },
      }),
    ).toEqual([])
  })
})

describe("a mention that disagrees with a declared arity", () => {
  it("reports the declaration as the authority, not a conflict between rules", () => {
    // `dist` holds 3-tuples. Reading it at 2 unifies with nothing, deriving an
    // empty relation and reporting no error at all. Because the host *declared*
    // the width there is a right answer to point at, so this is a mismatch
    // against the declaration rather than a disagreement between two rules.
    const positive = rule(atom("near", [$("X"), $("Y")]), [
      positiveAtom(atom("dist", [$("X"), $("Y")])),
    ])
    expect(analyzeArity([positive], field).errors).toEqual([
      {
        kind: "foreignArityMismatch",
        predicate: "dist",
        declared: 3,
        found: 2,
        rule: positive,
      },
    ])
  })

  it("passes at the declared width, in every position", () => {
    const right = rule(atom("near", [$("X"), $("Y")]), [
      positiveAtom(atom("dist", [$("X"), $("Y"), $("D")])),
      negation(atom("dist", [$("Y"), $("X"), constTerm(0)])),
    ])
    expect(analyzeArity([right], field).errors).toEqual([])
  })
})

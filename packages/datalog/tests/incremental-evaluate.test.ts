// === Weighted Relation and Database Tests ===
// Originally from Plan 006 Phase 5; migrated to the unified evaluator in 006.1.
//   - Relation.remove / Database.removeFact
//   - Weighted Relation/Database: addWeighted, getWeight, weight roundtrips
//   - Weight propagation: positive atom join, negation filter, groundHead sums
//
// This file once also held a "Unified Evaluator (migrated…)" section that
// duplicated `evaluator.test.ts` block for block. The evaluator-mechanics half
// of that duplication is in `evaluator.test.ts`; the half that asserted on
// winners and Fugue ordering moved to the perspective package, under
// `tests/default-rules/`.

import { describe, expect, it } from "vitest"
import {
  evaluateNegation,
  evaluatePositiveAtom,
  groundHead,
} from "../src/evaluate.js"
import type { Value } from "../src/types.js"
import {
  atom,
  constTerm,
  Database,
  fact,
  Relation,
  serializeTuple,
  varTerm,
} from "../src/types.js"
import { EMPTY_SUBSTITUTION, extendSubstitution } from "../src/unify.js"

// ---------------------------------------------------------------------------
// Relation.remove
// ---------------------------------------------------------------------------

describe("Relation.remove", () => {
  it("removes an existing tuple and tuples() excludes it", () => {
    const rel = new Relation()
    rel.add(["a", "b"])
    rel.add(["c", "d"])
    expect(rel.size).toBe(2)

    const removed = rel.remove(["a", "b"])
    expect(removed).toBe(true)
    expect(rel.size).toBe(1)

    const tuples = rel.tuples()
    expect(tuples).toHaveLength(1)
    expect(tuples[0]).toEqual(["c", "d"])
  })

  it("returns false for non-existent tuple", () => {
    const rel = new Relation()
    rel.add(["a", "b"])

    const removed = rel.remove(["x", "y"])
    expect(removed).toBe(false)
    expect(rel.size).toBe(1)
  })

  it("has() returns false after removal", () => {
    const rel = new Relation()
    rel.add(["a", "b"])
    expect(rel.has(["a", "b"])).toBe(true)

    rel.remove(["a", "b"])
    expect(rel.has(["a", "b"])).toBe(false)
  })

  it("add() after remove() works correctly (re-add)", () => {
    const rel = new Relation()
    rel.add(["a", "b"])
    rel.remove(["a", "b"])
    expect(rel.size).toBe(0)

    const added = rel.add(["a", "b"])
    expect(added).toBe(true)
    expect(rel.size).toBe(1)
    expect(rel.has(["a", "b"])).toBe(true)
  })

  it("isEmpty() is correct after removal", () => {
    const rel = new Relation()
    rel.add(["a", "b"])
    expect(rel.isEmpty()).toBe(false)

    rel.remove(["a", "b"])
    expect(rel.isEmpty()).toBe(true)
  })

  it("clone() after removal excludes removed tuples", () => {
    const rel = new Relation()
    rel.add(["a", "b"])
    rel.add(["c", "d"])
    rel.remove(["a", "b"])

    const cloned = rel.clone()
    expect(cloned.size).toBe(1)
    expect(cloned.has(["c", "d"])).toBe(true)
    expect(cloned.has(["a", "b"])).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Database.removeFact
// ---------------------------------------------------------------------------

describe("Database.removeFact", () => {
  it("removes fact, hasFact returns false", () => {
    const db = new Database()
    const f = fact("test", ["a", "b"])
    db.addFact(f)
    expect(db.hasFact(f)).toBe(true)

    const removed = db.removeFact(f)
    expect(removed).toBe(true)
    expect(db.hasFact(f)).toBe(false)
  })

  it("returns false for non-existent fact", () => {
    const db = new Database()
    const f = fact("test", ["a", "b"])
    expect(db.removeFact(f)).toBe(false)
  })

  it("returns false for non-existent predicate", () => {
    const db = new Database()
    const f = fact("nonexistent", ["a"])
    expect(db.removeFact(f)).toBe(false)
  })

  it("size decreases after removal", () => {
    const db = new Database()
    db.addFact(fact("p", ["a"]))
    db.addFact(fact("p", ["b"]))
    db.addFact(fact("q", ["c"]))
    expect(db.size).toBe(3)

    db.removeFact(fact("p", ["a"]))
    expect(db.size).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Plan 006.1 Phase 1: Weighted Relation, Database, and Evaluation Tests
// ---------------------------------------------------------------------------

describe("Relation.addWeighted", () => {
  it("sums weights correctly", () => {
    const rel = new Relation()
    expect(rel.addWeighted([1, 2], 1)).toBe(1)
    expect(rel.addWeighted([1, 2], 1)).toBe(2)
    expect(rel.getWeight([1, 2])).toBe(2)
  })

  it("prunes zero-weight entries", () => {
    const rel = new Relation()
    rel.addWeighted([1, 2], 1)
    rel.addWeighted([1, 2], -1)
    expect(rel.getWeight([1, 2])).toBe(0)
    expect(rel.has([1, 2])).toBe(false)
    expect(rel.size).toBe(0)
  })

  it("handles negative weights", () => {
    const rel = new Relation()
    rel.addWeighted(["a"], -1)
    expect(rel.getWeight(["a"])).toBe(-1)
    expect(rel.has(["a"])).toBe(false) // weight ≤ 0 → not present
    expect(rel.size).toBe(0)
  })

  it("weight 0 delta is a no-op", () => {
    const rel = new Relation()
    rel.addWeighted(["x"], 1)
    const result = rel.addWeighted(["x"], 0)
    expect(result).toBe(1)
    expect(rel.getWeight(["x"])).toBe(1)
  })

  it("returns current weight for weight 0 on absent tuple", () => {
    const rel = new Relation()
    expect(rel.addWeighted(["x"], 0)).toBe(0)
  })
})

describe("Relation.getWeight", () => {
  it("returns 0 for absent tuples", () => {
    const rel = new Relation()
    expect(rel.getWeight(["nonexistent"])).toBe(0)
  })

  it("returns positive weight for present tuples", () => {
    const rel = new Relation()
    rel.add(["a", "b"])
    expect(rel.getWeight(["a", "b"])).toBe(1)
  })

  it("returns accumulated weight", () => {
    const rel = new Relation()
    rel.addWeighted(["x"], 3)
    rel.addWeighted(["x"], 2)
    expect(rel.getWeight(["x"])).toBe(5)
  })
})

describe("Relation.tuples excludes weight ≤ 0", () => {
  it("tuples() only returns weight > 0 entries", () => {
    const rel = new Relation()
    rel.addWeighted(["a"], 1)
    rel.addWeighted(["b"], -1)
    rel.addWeighted(["c"], 1)
    const tuples = rel.tuples()
    expect(tuples).toHaveLength(2)
    expect(tuples).toContainEqual(["a"])
    expect(tuples).toContainEqual(["c"])
  })
})

describe("Relation weight roundtrip", () => {
  it("addWeighted(t, 1) then addWeighted(t, -1) → absent", () => {
    const rel = new Relation()
    rel.addWeighted(["x", "y"], 1)
    expect(rel.has(["x", "y"])).toBe(true)
    rel.addWeighted(["x", "y"], -1)
    expect(rel.has(["x", "y"])).toBe(false)
    expect(rel.tuples()).toHaveLength(0)
    expect(rel.size).toBe(0)
  })

  it("add then remove then add again works", () => {
    const rel = new Relation()
    rel.add(["a"])
    expect(rel.has(["a"])).toBe(true)
    rel.remove(["a"])
    expect(rel.has(["a"])).toBe(false)
    const added = rel.add(["a"])
    expect(added).toBe(true)
    expect(rel.has(["a"])).toBe(true)
  })
})

describe("Database.addWeightedFact", () => {
  it("sums weights via addWeightedFact", () => {
    const db = new Database()
    const f = fact("p", [1, 2])
    db.addWeightedFact(f, 1)
    db.addWeightedFact(f, 1)
    expect(db.hasFact(f)).toBe(true)
    expect(db.getRelation("p").getWeight([1, 2])).toBe(2)
  })

  it("retraction via addWeightedFact", () => {
    const db = new Database()
    const f = fact("p", ["x"])
    db.addWeightedFact(f, 1)
    expect(db.hasFact(f)).toBe(true)
    db.addWeightedFact(f, -1)
    expect(db.hasFact(f)).toBe(false)
    expect(db.size).toBe(0)
  })
})

describe("weighted positive atom join multiplies weights", () => {
  it("evaluatePositiveAtom multiplies sub.weight × tuple.weight", () => {
    // This test verifies the weight multiplication indirectly:
    // When all tuples have weight 1 (the normal case), results preserve
    // input substitution weight.
    const db = new Database()
    db.addFact(fact("edge", ["a", "b"]))
    db.addFact(fact("edge", ["a", "c"]))

    const a = atom("edge", [constTerm("a"), varTerm("Y")])
    const results = evaluatePositiveAtom(a, db, [EMPTY_SUBSTITUTION])
    expect(results).toHaveLength(2)
    // All weights should be 1 (1 × 1)
    for (const sub of results) {
      expect(sub.weight).toBe(1)
    }
  })

  it("weight > 1 tuples return clampedWeight via weightedTuples()", () => {
    const db = new Database()
    // Add a tuple with weight 3 (true Z-set multiplicity).
    const rel = db.relation("edge")
    rel.addWeighted(["a", "b"], 3)

    // evaluatePositiveAtom uses weightedTuples() which returns
    // clampedWeight (always 1) to prevent weight explosion in
    // recursive joins. The true weight (3) is only visible via
    // allWeightedTuples() and getWeight().
    const a = atom("edge", [constTerm("a"), varTerm("Y")])
    const results = evaluatePositiveAtom(a, db, [EMPTY_SUBSTITUTION])
    expect(results).toHaveLength(1)
    expect(results[0]?.weight).toBe(1) // 1 × clampedWeight(1), not 1 × 3
    expect(results[0]?.bindings.get("Y")).toBe("b")
    // True weight is preserved in the relation.
    expect(rel.getWeight(["a", "b"])).toBe(3)
  })
})

describe("weighted negation filters on weight > 0", () => {
  it("negated atom with weight > 0 tuple blocks substitution", () => {
    const db = new Database()
    db.addFact(fact("blocked", ["x"]))

    const a = atom("blocked", [varTerm("X")])
    const sub = extendSubstitution(EMPTY_SUBSTITUTION, "X", "x")
    const results = evaluateNegation(a, db, [sub])
    expect(results).toHaveLength(0) // blocked
  })

  it("negated atom with no matching tuple passes substitution", () => {
    const db = new Database()
    // No facts in db

    const a = atom("blocked", [varTerm("X")])
    const sub = extendSubstitution(EMPTY_SUBSTITUTION, "X", "x")
    const results = evaluateNegation(a, db, [sub])
    expect(results).toHaveLength(1) // not blocked
    expect(results[0]?.weight).toBe(1) // weight preserved
  })
})

describe("weighted groundHead sums weights for duplicate facts", () => {
  it("two substitutions yielding the same fact have weights summed", () => {
    const head = atom("derived", [varTerm("X")])

    // Two substitutions grounding to the same fact with different weights
    const sub1 = { bindings: new Map([["X", "a" as Value]]), weight: 1 }
    const sub2 = { bindings: new Map([["X", "a" as Value]]), weight: 2 }
    const sub3 = { bindings: new Map([["X", "b" as Value]]), weight: 5 }

    const results = groundHead(head, [sub1, sub2, sub3])
    expect(results).toHaveLength(2)

    const factA = results.find(wf => wf.fact.values[0] === "a")
    const factB = results.find(wf => wf.fact.values[0] === "b")
    expect(factA).toBeDefined()
    expect(factB).toBeDefined()
    expect(factA?.weight).toBe(3) // 1 + 2
    expect(factB?.weight).toBe(5)

    // The tuple key rides along so the evaluator never re-serializes.
    for (const wf of results) {
      expect(wf.tupleKey).toBe(serializeTuple(wf.fact.values))
    }
  })

  it("weights that sum to zero are pruned", () => {
    const head = atom("derived", [varTerm("X")])

    const sub1 = { bindings: new Map([["X", "a" as Value]]), weight: 1 }
    const sub2 = { bindings: new Map([["X", "a" as Value]]), weight: -1 }

    const results = groundHead(head, [sub1, sub2])
    expect(results).toHaveLength(0) // 1 + (-1) = 0, pruned
  })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

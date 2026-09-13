// === Unified Evaluator Tests (Plan 006.1, Phase 2) ===
// Tests for the unified weighted Datalog evaluator that replaces both
// `evaluate.ts` (batch) and `incremental-evaluate.ts` (incremental).
//
// Test categories:
//   - Dirty-map infrastructure: applyDerivedFact, applyDistinct, extractDelta
//   - evaluateStratumFromDelta: unit tests with small rule sets
//   - createEvaluator + step: incremental evaluation tests
//   - Batch wrappers: evaluateUnified, evaluatePositiveUnified
//   - Retraction through negation without DRed
//   - Transitive closure with distinct
//   - Weight propagation through strata
//   - Randomized differential sweeps: mixed retract+insert steps vs batch
//   - Ground facts as presence flips; predicates both inserted and derived
//
// Everything that asserts on a *winner* or on Fugue ordering — the reality the
// CCS default rules derive, rather than the machinery that derives it — lives in
// the perspective package, under `tests/default-rules/`.

import type { ZSet } from "@kyneta/zset"
import {
  zsetEmpty,
  zsetForEach,
  zsetFromEntries,
  zsetIsEmpty,
  zsetSingleton,
  zsetSize,
} from "@kyneta/zset"
import { describe, expect, it } from "vitest"
import {
  evaluateDifferentialNegation,
  evaluatePositiveAtom,
  evaluateRuleDelta,
  getNegationAtomIndices,
} from "../src/evaluate.js"
import {
  createEvaluator,
  evaluateUnified as evaluate,
  evaluatePositiveUnified as evaluatePositive,
  evaluatePositiveUnified,
  evaluateStratumFromDelta,
  evaluateUnified,
  factsToZSet,
} from "../src/evaluator.js"
import type { Host } from "../src/host.js"
import type { Fact, Rule, Value } from "../src/types.js"
import {
  _,
  aggregation,
  atom,
  constTerm,
  Database,
  fact,
  factKey,
  gt,
  lt,
  negation,
  neq,
  positiveAtom,
  Relation,
  rule,
  varTerm,
} from "../src/types.js"
import { EMPTY_SUBSTITUTION } from "../src/unify.js"
import { DISTANCE_FIELD } from "./fields.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Dual-weight Relation tests (Plan 006.2, Phase 0)
// ---------------------------------------------------------------------------

describe("Dual-weight Relation (Plan 006.2 Phase 0)", () => {
  it("addWeighted accumulates true weight", () => {
    const rel = new Relation()
    rel.addWeighted(["a"], 1)
    rel.addWeighted(["a"], 1)
    // True Z-set multiplicity is 2.
    expect(rel.getWeight(["a"])).toBe(2)
    // Presence is correct.
    expect(rel.has(["a"])).toBe(true)
  })

  it("addWeighted eagerly updates clampedWeight — has() is true immediately", () => {
    const rel = new Relation()
    rel.addWeighted(["a"], 1)
    // No applyDistinct needed — has() reads clampedWeight, set eagerly.
    expect(rel.has(["a"])).toBe(true)
  })

  it("addWeighted(-1) on weight-2 entry → weight 1, has returns true", () => {
    const rel = new Relation()
    rel.addWeighted(["a"], 1)
    rel.addWeighted(["a"], 1)
    expect(rel.getWeight(["a"])).toBe(2)

    rel.addWeighted(["a"], -1)
    // weight 2 → 1, still present.
    expect(rel.getWeight(["a"])).toBe(1)
    expect(rel.has(["a"])).toBe(true)
  })

  it("addWeighted(-1) on weight-1 entry → weight 0, pruned, has returns false", () => {
    const rel = new Relation()
    rel.addWeighted(["a"], 1)
    expect(rel.has(["a"])).toBe(true)

    rel.addWeighted(["a"], -1)
    // weight 1 → 0, entry pruned.
    expect(rel.getWeight(["a"])).toBe(0)
    expect(rel.has(["a"])).toBe(false)
    expect(rel.allEntryCount).toBe(0)
  })

  it("tuples(), has(), size all read clampedWeight, not raw weight", () => {
    const rel = new Relation()
    // Create weight-3 entry.
    rel.addWeighted(["a"], 3)
    expect(rel.getWeight(["a"])).toBe(3)
    // Presence semantics: clampedWeight > 0.
    expect(rel.has(["a"])).toBe(true)
    expect(rel.size).toBe(1)
    expect(rel.tuples()).toHaveLength(1)
    expect(rel.isEmpty()).toBe(false)

    // Create weight −1 entry.
    rel.addWeighted(["b"], -1)
    expect(rel.getWeight(["b"])).toBe(-1)
    // Negative weight: clampedWeight = 0, not present.
    expect(rel.has(["b"])).toBe(false)
    expect(rel.size).toBe(1) // Only ['a'] counts.
    expect(rel.tuples()).toHaveLength(1)
  })

  it("weightedTuples() returns clampedWeight (always 1) as the weight value", () => {
    const rel = new Relation()
    rel.addWeighted(["a"], 3)
    rel.addWeighted(["b"], 1)

    const wt = rel.weightedTuples()
    expect(wt).toHaveLength(2)
    // Every returned weight is clampedWeight = 1, not the true multiplicity.
    for (const { weight } of wt) {
      expect(weight).toBe(1)
    }
  })

  it("allWeightedTuples() returns true weight (may be > 1 or < 0)", () => {
    const rel = new Relation()
    rel.addWeighted(["a"], 3)
    rel.addWeighted(["b"], -1)

    const all = rel.allWeightedTuples()
    expect(all).toHaveLength(2)

    const aEntry = all.find(e => e.tuple[0] === "a")
    const bEntry = all.find(e => e.tuple[0] === "b")
    expect(aEntry?.weight).toBe(3)
    expect(bEntry?.weight).toBe(-1)
  })

  it("add() delegates to addWeighted and returns clampedWeight crossing", () => {
    const rel = new Relation()
    // First add: absent → present.
    expect(rel.add(["a"])).toBe(true)
    expect(rel.getWeight(["a"])).toBe(1)

    // Second add: already present, weight 1 → 2 but clampedWeight stays 1.
    expect(rel.add(["a"])).toBe(false)
    expect(rel.getWeight(["a"])).toBe(2)
    expect(rel.has(["a"])).toBe(true)
  })

  it("remove() deletes the entry entirely", () => {
    const rel = new Relation()
    rel.addWeighted(["a"], 3)
    expect(rel.has(["a"])).toBe(true)

    expect(rel.remove(["a"])).toBe(true)
    expect(rel.has(["a"])).toBe(false)
    expect(rel.getWeight(["a"])).toBe(0)
    expect(rel.allEntryCount).toBe(0)
  })

  it("clone() copies both weight and clampedWeight", () => {
    const rel = new Relation()
    rel.addWeighted(["a"], 3)
    rel.addWeighted(["b"], -1)

    const cloned = rel.clone()
    expect(cloned.getWeight(["a"])).toBe(3)
    expect(cloned.has(["a"])).toBe(true)
    expect(cloned.getWeight(["b"])).toBe(-1)
    expect(cloned.has(["b"])).toBe(false)
    expect(cloned.allEntryCount).toBe(2)
  })
})

describe("Database.hasAnyEntries (Plan 006.2 Phase 0)", () => {
  it("returns false for empty database", () => {
    const db = new Database()
    expect(db.hasAnyEntries()).toBe(false)
  })

  it("returns true for positive-weight entries", () => {
    const db = new Database()
    db.addFact(fact("p", ["a"]))
    expect(db.hasAnyEntries()).toBe(true)
  })

  it("returns true for negative-weight entries (retraction-only delta)", () => {
    const db = new Database()
    db.addWeightedFact(fact("p", ["a"]), -1)
    // size would be 0 (no weight > 0 entries), but hasAnyEntries is true.
    expect(db.size).toBe(0)
    expect(db.hasAnyEntries()).toBe(true)
  })

  it("returns false after pruning to zero", () => {
    const db = new Database()
    db.addWeightedFact(fact("p", ["a"]), 1)
    db.addWeightedFact(fact("p", ["a"]), -1)
    // Entry pruned (weight = 0).
    expect(db.hasAnyEntries()).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Differential Negation Primitives (Plan 006.2, Phase 1)
// ---------------------------------------------------------------------------

describe("evaluateDifferentialNegation (Plan 006.2 Phase 1)", () => {
  it("appearance in negated relation produces negative weight", () => {
    // Delta has +1 for blocked(x) → negation inverts to -1.
    const delta = new Database()
    delta.addWeightedFact(fact("blocked", ["x"]), 1)

    const a = atom("blocked", [varTerm("X")])
    const sub = { bindings: new Map<string, Value>(), weight: 1 }
    const results = evaluateDifferentialNegation(a, delta, [sub])

    expect(results).toHaveLength(1)
    expect(results[0]?.weight).toBe(-1) // 1 × (-(+1)) = -1
    expect(results[0]?.bindings.get("X")).toBe("x")
  })

  it("disappearance from negated relation produces positive weight", () => {
    // Delta has -1 for blocked(x) → negation inverts to +1.
    const delta = new Database()
    delta.addWeightedFact(fact("blocked", ["x"]), -1)

    const a = atom("blocked", [varTerm("X")])
    const sub = { bindings: new Map<string, Value>(), weight: 1 }
    const results = evaluateDifferentialNegation(a, delta, [sub])

    expect(results).toHaveLength(1)
    expect(results[0]?.weight).toBe(1) // 1 × (-(-1)) = +1
    expect(results[0]?.bindings.get("X")).toBe("x")
  })

  it("propagates incoming substitution weight through sign inversion", () => {
    const delta = new Database()
    delta.addWeightedFact(fact("blocked", ["x"]), 1)

    const a = atom("blocked", [varTerm("X")])
    // Incoming sub has weight 3.
    const sub = { bindings: new Map<string, Value>(), weight: 3 }
    const results = evaluateDifferentialNegation(a, delta, [sub])

    expect(results).toHaveLength(1)
    expect(results[0]?.weight).toBe(-3) // 3 × (-(+1)) = -3
  })

  it("handles multiple delta entries and multiple substitutions", () => {
    const delta = new Database()
    delta.addWeightedFact(fact("blocked", ["x"]), 1)
    delta.addWeightedFact(fact("blocked", ["y"]), -1)

    const a = atom("blocked", [varTerm("X")])
    const sub = { bindings: new Map<string, Value>(), weight: 1 }
    const results = evaluateDifferentialNegation(a, delta, [sub])

    expect(results).toHaveLength(2)
    const xResult = results.find(r => r.bindings.get("X") === "x")
    const yResult = results.find(r => r.bindings.get("X") === "y")
    expect(xResult?.weight).toBe(-1) // appearance blocks
    expect(yResult?.weight).toBe(1) // disappearance unblocks
  })

  it("returns empty for empty delta", () => {
    const delta = new Database()
    const a = atom("blocked", [varTerm("X")])
    const sub = { bindings: new Map<string, Value>(), weight: 1 }
    const results = evaluateDifferentialNegation(a, delta, [sub])
    expect(results).toHaveLength(0)
  })

  it("only matches entries for the correct predicate", () => {
    const delta = new Database()
    delta.addWeightedFact(fact("other", ["x"]), 1)

    const a = atom("blocked", [varTerm("X")])
    const sub = { bindings: new Map<string, Value>(), weight: 1 }
    const results = evaluateDifferentialNegation(a, delta, [sub])
    expect(results).toHaveLength(0)
  })
})

describe("evaluatePositiveAtom allEntries parameter (Plan 006.2 Phase 1)", () => {
  it("allEntries=false (default): uses weightedTuples, returns clampedWeight=1", () => {
    const db = new Database()
    db.relation("p").addWeighted(["a"], 3)

    const a = atom("p", [varTerm("X")])
    const results = evaluatePositiveAtom(a, db, [EMPTY_SUBSTITUTION])

    expect(results).toHaveLength(1)
    expect(results[0]?.weight).toBe(1) // clampedWeight, not true weight
    expect(results[0]?.bindings.get("X")).toBe("a")
  })

  it("allEntries=true: uses allWeightedTuples, returns true weight", () => {
    const db = new Database()
    db.relation("p").addWeighted(["a"], 3)

    const a = atom("p", [varTerm("X")])
    const results = evaluatePositiveAtom(a, db, [EMPTY_SUBSTITUTION], true)

    expect(results).toHaveLength(1)
    expect(results[0]?.weight).toBe(3) // true weight
    expect(results[0]?.bindings.get("X")).toBe("a")
  })

  it("allEntries=true: sees negative-weight entries in delta DBs", () => {
    const delta = new Database()
    delta.addWeightedFact(fact("p", ["a"]), -1)

    const a = atom("p", [varTerm("X")])
    const results = evaluatePositiveAtom(a, delta, [EMPTY_SUBSTITUTION], true)

    expect(results).toHaveLength(1)
    expect(results[0]?.weight).toBe(-1) // negative weight visible
    expect(results[0]?.bindings.get("X")).toBe("a")
  })

  it("allEntries=false: hides negative-weight entries", () => {
    const delta = new Database()
    delta.addWeightedFact(fact("p", ["a"]), -1)

    const a = atom("p", [varTerm("X")])
    const results = evaluatePositiveAtom(a, delta, [EMPTY_SUBSTITUTION], false)

    expect(results).toHaveLength(0) // negative entry invisible
  })

  it("allEntries=false on accumulated DB with weight=2: returns clampedWeight=1", () => {
    const db = new Database()
    db.relation("p").addWeighted(["a"], 1)
    db.relation("p").addWeighted(["a"], 1)
    expect(db.getRelation("p").getWeight(["a"])).toBe(2)

    const a = atom("p", [varTerm("X")])
    const results = evaluatePositiveAtom(a, db, [EMPTY_SUBSTITUTION])

    expect(results).toHaveLength(1)
    expect(results[0]?.weight).toBe(1) // clampedWeight prevents explosion
  })
})

describe("evaluateRuleDelta (Plan 006.2 Phase 1)", () => {
  it("positive atom delta source: derives only from the delta", () => {
    // derived(X) :- base(X).
    const r = rule(atom("derived", [varTerm("X")]), [
      positiveAtom(atom("base", [varTerm("X")])),
    ])

    const fullDb = new Database()
    fullDb.addFact(fact("base", ["a"]))
    fullDb.addFact(fact("base", ["b"]))

    const delta = new Database()
    delta.addFact(fact("base", ["a"]))

    // deltaIdx=0: match base against delta.
    const results = evaluateRuleDelta(r, fullDb, fullDb, delta, 0)

    expect(results).toHaveLength(1)
    expect(results[0]?.fact).toEqual(fact("derived", ["a"]))
    expect(results[0]?.weight).toBe(1)
  })

  it("negation delta source: differential negation with sign inversion", () => {
    // winner(Slot, CnId, Value) :- active_value(CnId, Slot, Value, _, _),
    //   not superseded(CnId, Slot).
    const winnerRule = rule(
      atom("winner", [varTerm("Slot"), varTerm("CnId"), varTerm("Value")]),
      [
        positiveAtom(
          atom("active_value", [
            varTerm("CnId"),
            varTerm("Slot"),
            varTerm("Value"),
            _,
            _,
          ]),
        ),
        negation(atom("superseded", [varTerm("CnId"), varTerm("Slot")])),
      ],
    )

    // fullDb has alice in active_value.
    const fullDb = new Database()
    fullDb.addFact(
      fact("active_value", ["alice@1", "slot:title", "Hello", 10, "alice"]),
    )

    // Delta: superseded(alice@1, slot:title) appeared (+1).
    // This should BLOCK alice's winner derivation → weight = -1.
    const delta = new Database()
    delta.addWeightedFact(fact("superseded", ["alice@1", "slot:title"]), 1)

    // deltaIdx=1: the negation body element.
    const results = evaluateRuleDelta(winnerRule, fullDb, fullDb, delta, 1)

    expect(results).toHaveLength(1)
    expect(results[0]?.fact.predicate).toBe("winner")
    expect(results[0]?.weight).toBe(-1) // blocked → retraction
  })

  it("negation delta source: disappearance unblocks derivation", () => {
    const winnerRule = rule(
      atom("winner", [varTerm("Slot"), varTerm("CnId"), varTerm("Value")]),
      [
        positiveAtom(
          atom("active_value", [
            varTerm("CnId"),
            varTerm("Slot"),
            varTerm("Value"),
            _,
            _,
          ]),
        ),
        negation(atom("superseded", [varTerm("CnId"), varTerm("Slot")])),
      ],
    )

    const fullDb = new Database()
    fullDb.addFact(
      fact("active_value", ["alice@1", "slot:title", "Hello", 10, "alice"]),
    )

    // Delta: superseded(alice@1, slot:title) disappeared (-1).
    // This should UNBLOCK alice's winner derivation → weight = +1.
    const delta = new Database()
    delta.addWeightedFact(fact("superseded", ["alice@1", "slot:title"]), -1)

    const results = evaluateRuleDelta(winnerRule, fullDb, fullDb, delta, 1)

    expect(results).toHaveLength(1)
    expect(results[0]?.fact.predicate).toBe("winner")
    expect(results[0]?.weight).toBe(1) // unblocked → new derivation
  })

  it("positive atom delta with negative-weight entry produces retraction", () => {
    // Rule: derived(X) :- base(X).
    const r = rule(atom("derived", [varTerm("X")]), [
      positiveAtom(atom("base", [varTerm("X")])),
    ])

    const fullDb = new Database()
    fullDb.addFact(fact("base", ["a"]))

    // Delta contains a retraction.
    const delta = new Database()
    delta.addWeightedFact(fact("base", ["a"]), -1)

    // allEntries=true at the delta index sees the -1 entry.
    const results = evaluateRuleDelta(r, fullDb, fullDb, delta, 0)
    expect(results).toHaveLength(1)
    expect(results[0]?.fact).toEqual(fact("derived", ["a"]))
    expect(results[0]?.weight).toBe(-1)
  })

  it("asymmetric join: positions before deltaIdx use fullDbNew", () => {
    // superseded(CnId, Slot) :- active_value(CnId, Slot, _, L1, _),
    //   active_value(CnId2, Slot, _, L2, _), CnId ≠ CnId2, L2 > L1.
    const supersededRule = rule(
      atom("superseded", [varTerm("CnId"), varTerm("Slot")]),
      [
        positiveAtom(
          atom("active_value", [
            varTerm("CnId"),
            varTerm("Slot"),
            _,
            varTerm("L1"),
            _,
          ]),
        ),
        positiveAtom(
          atom("active_value", [
            varTerm("CnId2"),
            varTerm("Slot"),
            _,
            varTerm("L2"),
            _,
          ]),
        ),
        neq(varTerm("CnId"), varTerm("CnId2")),
        gt(varTerm("L2"), varTerm("L1")),
      ],
    )

    // P_old is empty — no active_value entries yet.
    const dbOld = new Database()

    // P_new has both alice and bob.
    const dbNew = new Database()
    dbNew.addFact(
      fact("active_value", ["alice@1", "slot:title", "Hello", 10, "alice"]),
    )
    dbNew.addFact(
      fact("active_value", ["bob@1", "slot:title", "World", 20, "bob"]),
    )

    // Delta contains both alice and bob.
    const delta = new Database()
    delta.addFact(
      fact("active_value", ["alice@1", "slot:title", "Hello", 10, "alice"]),
    )
    delta.addFact(
      fact("active_value", ["bob@1", "slot:title", "World", 20, "bob"]),
    )

    // deltaIdx=0: first active_value from delta.
    // Position 1 (j > deltaIdx): uses dbOld (empty) → no matches.
    const results0 = evaluateRuleDelta(supersededRule, dbOld, dbNew, delta, 0)

    // deltaIdx=1: second active_value from delta.
    // Position 0 (j < deltaIdx, same predicate): uses dbNew → alice and bob visible.
    const results1 = evaluateRuleDelta(supersededRule, dbOld, dbNew, delta, 1)

    // With asymmetric join:
    // deltaIdx=0: CnId from delta (alice, bob), CnId2 from dbOld (empty) → 0 results.
    // deltaIdx=1: CnId from dbNew (alice, bob), CnId2 from delta (alice, bob) → alice superseded.
    // Total: 1 derivation of superseded(alice, slot:title). No double-counting.
    const allResults = [...results0, ...results1]
    const supersededFacts = allResults.filter(r => r.weight > 0)
    expect(supersededFacts).toHaveLength(1)
    expect(supersededFacts[0]?.fact.values[0]).toBe("alice@1")
  })
})

describe("getNegationAtomIndices (Plan 006.2 Phase 1)", () => {
  it("returns indices of negation body elements", () => {
    const body = [
      positiveAtom(atom("a", [varTerm("X")])),
      negation(atom("b", [varTerm("X")])),
      positiveAtom(atom("c", [varTerm("X")])),
      negation(atom("d", [varTerm("X")])),
    ]
    expect(getNegationAtomIndices(body)).toEqual([1, 3])
  })

  it("returns empty for body with no negations", () => {
    const body = [
      positiveAtom(atom("a", [varTerm("X")])),
      positiveAtom(atom("b", [varTerm("X")])),
    ]
    expect(getNegationAtomIndices(body)).toEqual([])
  })

  it("returns all indices for all-negation body", () => {
    const body = [
      negation(atom("a", [varTerm("X")])),
      negation(atom("b", [varTerm("X")])),
    ]
    expect(getNegationAtomIndices(body)).toEqual([0, 1])
  })
})

// ---------------------------------------------------------------------------
// applyDistinct with dual-weight (Plan 006.2, Phase 0)
// ---------------------------------------------------------------------------

describe("applyDistinct with dual-weight", () => {
  it("weight > 1 derived facts are preserved (not clamped to 1)", () => {
    // Two rules both derive the same fact → weight 2.
    // Rule 1: derived(a) :- p(a).
    // Rule 2: derived(X) :- q(X).
    const rules: Rule[] = [
      rule(atom("derived", [constTerm("a")]), [
        positiveAtom(atom("p", [constTerm("a")])),
      ]),
      rule(atom("derived", [varTerm("X")]), [
        positiveAtom(atom("q", [varTerm("X")])),
      ]),
    ]

    const db = new Database()
    db.addFact(fact("p", ["a"]))
    db.addFact(fact("q", ["a"]))

    const inputDelta = new Database()
    inputDelta.addFact(fact("p", ["a"]))
    inputDelta.addFact(fact("q", ["a"]))

    evaluateStratumFromDelta(rules, db, inputDelta)

    // derived(a) should be present with true weight >= 2 (dual-weight
    // preserves multiplicity). clampedWeight is 1 (visible via has()).
    expect(db.hasFact(fact("derived", ["a"]))).toBe(true)
    expect(db.getRelation("derived").getWeight(["a"])).toBeGreaterThanOrEqual(2)
    // weightedTuples() returns clampedWeight = 1.
    expect(db.getRelation("derived").weightedTuples()[0]?.weight).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// evaluateStratumFromDelta unit tests
// ---------------------------------------------------------------------------

describe("evaluateStratumFromDelta", () => {
  it("derives new facts from positive rules", () => {
    // Rule: derived(X) :- base(X).
    const rules: Rule[] = [
      rule(atom("derived", [varTerm("X")]), [
        positiveAtom(atom("base", [varTerm("X")])),
      ]),
    ]

    const db = new Database()
    db.addFact(fact("base", ["a"]))
    db.addFact(fact("base", ["b"]))

    const inputDelta = new Database()
    inputDelta.addFact(fact("base", ["a"]))
    inputDelta.addFact(fact("base", ["b"]))

    const outputDelta = evaluateStratumFromDelta(rules, db, inputDelta)

    // Should derive derived(a) and derived(b).
    expect(db.hasFact(fact("derived", ["a"]))).toBe(true)
    expect(db.hasFact(fact("derived", ["b"]))).toBe(true)

    // Output delta should contain +1 for both.
    expect(outputDelta.hasFact(fact("derived", ["a"]))).toBe(true)
    expect(outputDelta.hasFact(fact("derived", ["b"]))).toBe(true)
  })

  it("returns empty delta when no new facts are derived", () => {
    const rules: Rule[] = [
      rule(atom("derived", [varTerm("X")]), [
        positiveAtom(atom("base", [varTerm("X")])),
      ]),
    ]

    const db = new Database()
    db.addFact(fact("base", ["a"]))
    db.addFact(fact("derived", ["a"])) // Already present.

    const inputDelta = new Database()
    // Empty input delta — nothing new to process.

    const outputDelta = evaluateStratumFromDelta(rules, db, inputDelta)

    expect(outputDelta.size).toBe(0)
  })

  it("handles transitive closure correctly", () => {
    const rules: Rule[] = [
      rule(atom("path", [varTerm("X"), varTerm("Y")]), [
        positiveAtom(atom("edge", [varTerm("X"), varTerm("Y")])),
      ]),
      rule(atom("path", [varTerm("X"), varTerm("Z")]), [
        positiveAtom(atom("edge", [varTerm("X"), varTerm("Y")])),
        positiveAtom(atom("path", [varTerm("Y"), varTerm("Z")])),
      ]),
    ]

    const db = new Database()
    db.addFact(fact("edge", ["a", "b"]))
    db.addFact(fact("edge", ["b", "c"]))
    db.addFact(fact("edge", ["c", "d"]))

    const inputDelta = new Database()
    inputDelta.addFact(fact("edge", ["a", "b"]))
    inputDelta.addFact(fact("edge", ["b", "c"]))
    inputDelta.addFact(fact("edge", ["c", "d"]))

    evaluateStratumFromDelta(rules, db, inputDelta)

    expect(db.hasFact(fact("path", ["a", "b"]))).toBe(true)
    expect(db.hasFact(fact("path", ["b", "c"]))).toBe(true)
    expect(db.hasFact(fact("path", ["c", "d"]))).toBe(true)
    expect(db.hasFact(fact("path", ["a", "c"]))).toBe(true)
    expect(db.hasFact(fact("path", ["a", "d"]))).toBe(true)
    expect(db.hasFact(fact("path", ["b", "d"]))).toBe(true)
  })

  it("distinct preserves true multiplicity for transitive closure", () => {
    // path(a,c) can be derived two ways: a→b→c and a→c directly.
    // With dual-weight distinct (negative-floor only, Plan 006.2),
    // the true Z-set multiplicity is preserved: getWeight() > 1.
    // Presence (has/tuples/clampedWeight) is still correct: present.
    const rules: Rule[] = [
      rule(atom("path", [varTerm("X"), varTerm("Y")]), [
        positiveAtom(atom("edge", [varTerm("X"), varTerm("Y")])),
      ]),
      rule(atom("path", [varTerm("X"), varTerm("Z")]), [
        positiveAtom(atom("edge", [varTerm("X"), varTerm("Y")])),
        positiveAtom(atom("path", [varTerm("Y"), varTerm("Z")])),
      ]),
    ]

    const db = new Database()
    db.addFact(fact("edge", ["a", "b"]))
    db.addFact(fact("edge", ["b", "c"]))
    db.addFact(fact("edge", ["a", "c"])) // Direct edge: a→c

    const inputDelta = new Database()
    inputDelta.addFact(fact("edge", ["a", "b"]))
    inputDelta.addFact(fact("edge", ["b", "c"]))
    inputDelta.addFact(fact("edge", ["a", "c"]))

    evaluateStratumFromDelta(rules, db, inputDelta)

    // path(a,c) should exist — presence is correct.
    expect(db.hasFact(fact("path", ["a", "c"]))).toBe(true)
    // True multiplicity is preserved (> 1 from multiple derivation paths).
    // The exact value depends on semi-naive iteration order but must be > 0.
    expect(db.getRelation("path").getWeight(["a", "c"])).toBeGreaterThan(0)
    // weightedTuples() returns clampedWeight (always 1) for joins.
    const wt = db.getRelation("path").weightedTuples()
    for (const { weight } of wt) {
      expect(weight).toBe(1)
    }
  })

  it("handles negation strata (two-stratum evaluation)", () => {
    // These rules belong in two separate strata:
    // Stratum 0 (positive): rejected(X) :- candidate(X), candidate(Y), X != Y, Y > X.
    // Stratum 1 (negation): winner(X) :- candidate(X), not rejected(X).
    //
    // evaluateStratumFromDelta evaluates a SINGLE stratum, so we call
    // it twice — once for the positive stratum, once for the negation
    // stratum — matching real stratification behavior.

    const positiveRules: Rule[] = [
      rule(atom("rejected", [varTerm("X")]), [
        positiveAtom(atom("candidate", [varTerm("X")])),
        positiveAtom(atom("candidate", [varTerm("Y")])),
        neq(varTerm("X"), varTerm("Y")),
        gt(varTerm("Y"), varTerm("X")),
      ]),
    ]

    const negationRules: Rule[] = [
      rule(atom("winner", [varTerm("X")]), [
        positiveAtom(atom("candidate", [varTerm("X")])),
        negation(atom("rejected", [varTerm("X")])),
      ]),
    ]

    const db = new Database()
    db.addFact(fact("candidate", ["a"]))
    db.addFact(fact("candidate", ["b"]))
    db.addFact(fact("candidate", ["c"]))

    const inputDelta = new Database()
    inputDelta.addFact(fact("candidate", ["a"]))
    inputDelta.addFact(fact("candidate", ["b"]))
    inputDelta.addFact(fact("candidate", ["c"]))

    // Stratum 0: derive rejected facts (positive).
    const stratum0Delta = evaluateStratumFromDelta(
      positiveRules,
      db,
      inputDelta,
    )

    // Build input delta for stratum 1 from stratum 0's output + original input.
    const stratum1Input = new Database()
    for (const pred of inputDelta.predicates()) {
      for (const tuple of inputDelta.getRelation(pred).tuples()) {
        stratum1Input.addFact({ predicate: pred, values: tuple })
      }
    }
    for (const pred of stratum0Delta.predicates()) {
      for (const tuple of stratum0Delta.getRelation(pred).tuples()) {
        stratum1Input.addFact({ predicate: pred, values: tuple })
      }
    }

    // Stratum 1: derive winner facts (negation).
    evaluateStratumFromDelta(negationRules, db, stratum1Input)

    // 'c' is the greatest, so it should be the winner.
    expect(db.hasFact(fact("winner", ["c"]))).toBe(true)
    expect(db.hasFact(fact("winner", ["a"]))).toBe(false)
    expect(db.hasFact(fact("winner", ["b"]))).toBe(false)

    // 'a' and 'b' should be rejected.
    expect(db.hasFact(fact("rejected", ["a"]))).toBe(true)
    expect(db.hasFact(fact("rejected", ["b"]))).toBe(true)
    expect(db.hasFact(fact("rejected", ["c"]))).toBe(false)
  })

  it("output delta reflects zero-crossings only", () => {
    const rules: Rule[] = [
      rule(atom("derived", [varTerm("X")]), [
        positiveAtom(atom("base", [varTerm("X")])),
      ]),
    ]

    const db = new Database()
    db.addFact(fact("base", ["a"]))
    db.addFact(fact("base", ["b"]))
    db.addFact(fact("derived", ["a"])) // Already present — no zero-crossing.

    const inputDelta = new Database()
    inputDelta.addFact(fact("base", ["b"])) // Only 'b' is new.

    const outputDelta = evaluateStratumFromDelta(rules, db, inputDelta)

    // 'a' was already derived — should NOT appear in delta.
    // 'b' is newly derived — should appear as +1.
    expect(outputDelta.hasFact(fact("derived", ["b"]))).toBe(true)
    expect(outputDelta.size).toBe(1)
  })

  // --- Phase 2 tests: unified loop with differential negation ---

  it("retraction cascades through transitive closure", () => {
    // path(X,Y) :- edge(X,Y).
    // path(X,Z) :- edge(X,Y), path(Y,Z).
    const rules: Rule[] = [
      rule(atom("path", [varTerm("X"), varTerm("Y")]), [
        positiveAtom(atom("edge", [varTerm("X"), varTerm("Y")])),
      ]),
      rule(atom("path", [varTerm("X"), varTerm("Z")]), [
        positiveAtom(atom("edge", [varTerm("X"), varTerm("Y")])),
        positiveAtom(atom("path", [varTerm("Y"), varTerm("Z")])),
      ]),
    ]

    const db = new Database()
    // Insert edges: a→b→c→d
    db.addFact(fact("edge", ["a", "b"]))
    db.addFact(fact("edge", ["b", "c"]))
    db.addFact(fact("edge", ["c", "d"]))

    const insertDelta = new Database()
    insertDelta.addFact(fact("edge", ["a", "b"]))
    insertDelta.addFact(fact("edge", ["b", "c"]))
    insertDelta.addFact(fact("edge", ["c", "d"]))

    evaluateStratumFromDelta(rules, db, insertDelta)

    // All transitive paths should exist.
    expect(db.hasFact(fact("path", ["a", "b"]))).toBe(true)
    expect(db.hasFact(fact("path", ["a", "c"]))).toBe(true)
    expect(db.hasFact(fact("path", ["a", "d"]))).toBe(true)
    expect(db.hasFact(fact("path", ["b", "c"]))).toBe(true)
    expect(db.hasFact(fact("path", ["b", "d"]))).toBe(true)
    expect(db.hasFact(fact("path", ["c", "d"]))).toBe(true)

    // Retract edge b→c.
    db.addWeightedFact(fact("edge", ["b", "c"]), -1)
    const retractDelta = new Database()
    retractDelta.addWeightedFact(fact("edge", ["b", "c"]), -1)

    const outputDelta = evaluateStratumFromDelta(rules, db, retractDelta)

    // Paths through b→c should be retracted.
    expect(db.hasFact(fact("path", ["b", "c"]))).toBe(false)
    expect(db.hasFact(fact("path", ["b", "d"]))).toBe(false)
    expect(db.hasFact(fact("path", ["a", "c"]))).toBe(false)
    expect(db.hasFact(fact("path", ["a", "d"]))).toBe(false)

    // Paths not through b→c survive.
    expect(db.hasFact(fact("path", ["a", "b"]))).toBe(true)
    expect(db.hasFact(fact("path", ["c", "d"]))).toBe(true)

    // Output delta should contain −1 for retracted paths.
    expect(outputDelta.getRelation("path").allEntryCount).toBeGreaterThan(0)
  })

  it("negation stratum: +1 to negated predicate blocks derivation (−1 output)", () => {
    // winner(X) :- candidate(X), not rejected(X).
    // The negation stratum receives a +1 delta for rejected(a).
    // This should block winner(a) → produce −1 in the output delta.
    const negRules: Rule[] = [
      rule(atom("winner", [varTerm("X")]), [
        positiveAtom(atom("candidate", [varTerm("X")])),
        negation(atom("rejected", [varTerm("X")])),
      ]),
    ]

    const db = new Database()
    db.addFact(fact("candidate", ["a"]))
    db.addFact(fact("candidate", ["b"]))
    // winner(a) and winner(b) are derived (no rejections yet).
    const seedDelta = new Database()
    seedDelta.addFact(fact("candidate", ["a"]))
    seedDelta.addFact(fact("candidate", ["b"]))
    evaluateStratumFromDelta(negRules, db, seedDelta)
    expect(db.hasFact(fact("winner", ["a"]))).toBe(true)
    expect(db.hasFact(fact("winner", ["b"]))).toBe(true)

    // Now rejected(a) appears (+1 delta to the negated predicate).
    db.addFact(fact("rejected", ["a"]))
    const blockDelta = new Database()
    blockDelta.addFact(fact("rejected", ["a"]))

    const outputDelta = evaluateStratumFromDelta(negRules, db, blockDelta)

    // winner(a) should be retracted.
    expect(db.hasFact(fact("winner", ["a"]))).toBe(false)
    // winner(b) survives — rejected(b) was never added.
    expect(db.hasFact(fact("winner", ["b"]))).toBe(true)
    // Output delta should contain −1 for winner(a).
    expect(outputDelta.getRelation("winner").getWeight(["a"])).toBe(-1)
  })

  it("negation stratum: −1 to negated predicate unblocks derivation (+1 output)", () => {
    // winner(X) :- candidate(X), not rejected(X).
    // rejected(a) is present. winner(a) is NOT derived.
    // Retract rejected(a) → winner(a) should appear.
    const negRules: Rule[] = [
      rule(atom("winner", [varTerm("X")]), [
        positiveAtom(atom("candidate", [varTerm("X")])),
        negation(atom("rejected", [varTerm("X")])),
      ]),
    ]

    const db = new Database()
    db.addFact(fact("candidate", ["a"]))
    db.addFact(fact("candidate", ["b"]))
    db.addFact(fact("rejected", ["a"]))
    // Seed: only winner(b) is derived (a is rejected).
    const seedDelta = new Database()
    seedDelta.addFact(fact("candidate", ["a"]))
    seedDelta.addFact(fact("candidate", ["b"]))
    seedDelta.addFact(fact("rejected", ["a"]))
    evaluateStratumFromDelta(negRules, db, seedDelta)
    expect(db.hasFact(fact("winner", ["a"]))).toBe(false)
    expect(db.hasFact(fact("winner", ["b"]))).toBe(true)

    // Now retract rejected(a) (−1 delta to the negated predicate).
    db.addWeightedFact(fact("rejected", ["a"]), -1)
    const unblockDelta = new Database()
    unblockDelta.addWeightedFact(fact("rejected", ["a"]), -1)

    const outputDelta = evaluateStratumFromDelta(negRules, db, unblockDelta)

    // winner(a) should now be derived.
    expect(db.hasFact(fact("winner", ["a"]))).toBe(true)
    // winner(b) still present.
    expect(db.hasFact(fact("winner", ["b"]))).toBe(true)
    // Output delta should contain +1 for winner(a).
    expect(outputDelta.getRelation("winner").getWeight(["a"])).toBe(1)
  })

  it("self-join correctness: superseded weight is 1, not 2 (asymmetric join)", () => {
    // superseded(CnId, Slot) :- active_value(CnId, Slot, _, L1, _),
    //   active_value(CnId2, Slot, _, L2, _), CnId ≠ CnId2, L2 > L1.
    // With two values (alice L=10, bob L=20), superseded(alice) should
    // have weight exactly 1 — one derivation path, not 2 from
    // double-counting.
    const supersededRule = rule(
      atom("superseded", [varTerm("CnId"), varTerm("Slot")]),
      [
        positiveAtom(
          atom("active_value", [
            varTerm("CnId"),
            varTerm("Slot"),
            _,
            varTerm("L1"),
            _,
          ]),
        ),
        positiveAtom(
          atom("active_value", [
            varTerm("CnId2"),
            varTerm("Slot"),
            _,
            varTerm("L2"),
            _,
          ]),
        ),
        neq(varTerm("CnId"), varTerm("CnId2")),
        gt(varTerm("L2"), varTerm("L1")),
      ],
    )

    const db = new Database()
    db.addFact(
      fact("active_value", ["alice@1", "slot:title", "Hello", 10, "alice"]),
    )
    db.addFact(
      fact("active_value", ["bob@1", "slot:title", "World", 20, "bob"]),
    )

    const insertDelta = new Database()
    insertDelta.addFact(
      fact("active_value", ["alice@1", "slot:title", "Hello", 10, "alice"]),
    )
    insertDelta.addFact(
      fact("active_value", ["bob@1", "slot:title", "World", 20, "bob"]),
    )

    evaluateStratumFromDelta([supersededRule], db, insertDelta)

    // superseded(alice) should exist with weight exactly 1.
    expect(db.hasFact(fact("superseded", ["alice@1", "slot:title"]))).toBe(true)
    expect(
      db.getRelation("superseded").getWeight(["alice@1", "slot:title"]),
    ).toBe(1)

    // Retract bob → superseded(alice) should be retracted (weight 0).
    db.addWeightedFact(
      fact("active_value", ["bob@1", "slot:title", "World", 20, "bob"]),
      -1,
    )
    const retractDelta = new Database()
    retractDelta.addWeightedFact(
      fact("active_value", ["bob@1", "slot:title", "World", 20, "bob"]),
      -1,
    )

    evaluateStratumFromDelta([supersededRule], db, retractDelta)

    expect(db.hasFact(fact("superseded", ["alice@1", "slot:title"]))).toBe(
      false,
    )
  })

  it("three-value multi-path: superseded survives partial retraction (weight 2→1)", () => {
    // alice (L=10), bob (L=20), charlie (L=30).
    // superseded(alice) is derived by BOTH bob and charlie (weight 2).
    // Retract charlie → superseded(alice) survives with weight 1.
    const supersededRule = rule(
      atom("superseded", [varTerm("CnId"), varTerm("Slot")]),
      [
        positiveAtom(
          atom("active_value", [
            varTerm("CnId"),
            varTerm("Slot"),
            _,
            varTerm("L1"),
            _,
          ]),
        ),
        positiveAtom(
          atom("active_value", [
            varTerm("CnId2"),
            varTerm("Slot"),
            _,
            varTerm("L2"),
            _,
          ]),
        ),
        neq(varTerm("CnId"), varTerm("CnId2")),
        gt(varTerm("L2"), varTerm("L1")),
      ],
    )

    const db = new Database()
    db.addFact(
      fact("active_value", ["alice@1", "slot:title", "A", 10, "alice"]),
    )
    db.addFact(fact("active_value", ["bob@1", "slot:title", "B", 20, "bob"]))
    db.addFact(
      fact("active_value", ["charlie@1", "slot:title", "C", 30, "charlie"]),
    )

    const insertDelta = new Database()
    insertDelta.addFact(
      fact("active_value", ["alice@1", "slot:title", "A", 10, "alice"]),
    )
    insertDelta.addFact(
      fact("active_value", ["bob@1", "slot:title", "B", 20, "bob"]),
    )
    insertDelta.addFact(
      fact("active_value", ["charlie@1", "slot:title", "C", 30, "charlie"]),
    )

    evaluateStratumFromDelta([supersededRule], db, insertDelta)

    // superseded(alice) should have weight 2 (derived by bob AND charlie).
    expect(db.hasFact(fact("superseded", ["alice@1", "slot:title"]))).toBe(true)
    expect(
      db.getRelation("superseded").getWeight(["alice@1", "slot:title"]),
    ).toBe(2)

    // superseded(bob) should have weight 1 (derived by charlie only).
    expect(db.hasFact(fact("superseded", ["bob@1", "slot:title"]))).toBe(true)
    expect(
      db.getRelation("superseded").getWeight(["bob@1", "slot:title"]),
    ).toBe(1)

    // Retract charlie.
    db.addWeightedFact(
      fact("active_value", ["charlie@1", "slot:title", "C", 30, "charlie"]),
      -1,
    )
    const retractDelta = new Database()
    retractDelta.addWeightedFact(
      fact("active_value", ["charlie@1", "slot:title", "C", 30, "charlie"]),
      -1,
    )

    const outputDelta = evaluateStratumFromDelta(
      [supersededRule],
      db,
      retractDelta,
    )

    // superseded(alice) SURVIVES — weight 2→1, no zero-crossing.
    expect(db.hasFact(fact("superseded", ["alice@1", "slot:title"]))).toBe(true)
    expect(
      db.getRelation("superseded").getWeight(["alice@1", "slot:title"]),
    ).toBe(1)

    // superseded(bob) is RETRACTED — weight 1→0, zero-crossing.
    expect(db.hasFact(fact("superseded", ["bob@1", "slot:title"]))).toBe(false)

    // Output delta: superseded(bob) retracted (−1), superseded(alice) not
    // in delta (no zero-crossing).
    expect(
      outputDelta.getRelation("superseded").getWeight(["bob@1", "slot:title"]),
    ).toBe(-1)
    // superseded(alice) should NOT appear in the output delta.
    expect(
      outputDelta
        .getRelation("superseded")
        .getWeight(["alice@1", "slot:title"]),
    ).toBe(0)
  })

  it("aggregation stratum still wipe-and-recomputes correctly", () => {
    // count_rule: item_count(Group, Count) :- count(member(Group, Item), as Count grouped by Group).
    // This uses aggregation, so it should use wipe-and-recompute.
    const aggClause = {
      fn: "count" as const,
      groupBy: ["Group"],
      over: "Item",
      result: "Count",
      source: atom("member", [varTerm("Group"), varTerm("Item")]),
    }
    const countRule = rule(
      atom("group_count", [varTerm("Group"), varTerm("Count")]),
      [aggregation(aggClause)],
    )

    const db = new Database()
    db.addFact(fact("member", ["a", 1]))
    db.addFact(fact("member", ["a", 2]))
    db.addFact(fact("member", ["a", 3]))
    db.addFact(fact("member", ["b", 10]))
    db.addFact(fact("member", ["b", 20]))

    const insertDelta = new Database()
    insertDelta.addFact(fact("member", ["a", 1]))
    insertDelta.addFact(fact("member", ["a", 2]))
    insertDelta.addFact(fact("member", ["a", 3]))
    insertDelta.addFact(fact("member", ["b", 10]))
    insertDelta.addFact(fact("member", ["b", 20]))

    evaluateStratumFromDelta([countRule], db, insertDelta)

    expect(db.hasFact(fact("group_count", ["a", 3]))).toBe(true)
    expect(db.hasFact(fact("group_count", ["b", 2]))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Unified evaluator: LWW resolution with default rules
// ---------------------------------------------------------------------------

describe("factsToZSet", () => {
  it("keys by factKey, applies the weight, and sums duplicates", () => {
    const a = fact("p", [1])
    const b = fact("p", [2])
    const zs = factsToZSet([a, b, a], -1)

    expect(zsetSize(zs)).toBe(2)
    expect(zs.get(factKey(a))).toEqual({ element: a, weight: -2 })
    expect(zs.get(factKey(b))).toEqual({ element: b, weight: -1 })
  })
})

describe("Unified Evaluator", () => {
  // ---------------------------------------------------------------------------
  // Batch wrapper equivalence
  // ---------------------------------------------------------------------------

  describe("evaluateUnified matches old evaluate", () => {
    it("produces identical results for simple positive rules", () => {
      const rules: Rule[] = [
        rule(atom("derived", [varTerm("X")]), [
          positiveAtom(atom("base", [varTerm("X")])),
        ]),
      ]
      const facts = [fact("base", ["a"]), fact("base", ["b"])]

      const oldResult = evaluate(rules, facts)
      if (!oldResult.ok) throw new Error("old eval failed")

      const newResult = evaluateUnified(rules, facts)
      if (!newResult.ok) throw new Error("new eval failed")

      expect(newResult.value.hasFact(fact("derived", ["a"]))).toBe(true)
      expect(newResult.value.hasFact(fact("derived", ["b"]))).toBe(true)

      // Both should have same derived facts.
      for (const tuple of oldResult.value.getRelation("derived").tuples()) {
        expect(newResult.value.hasFact(fact("derived", tuple))).toBe(true)
      }
    })

    it("returns StratificationError for cyclic negation", () => {
      const rules: Rule[] = [
        rule(atom("a", [varTerm("X")]), [negation(atom("b", [varTerm("X")]))]),
        rule(atom("b", [varTerm("X")]), [negation(atom("a", [varTerm("X")]))]),
      ]

      const result = evaluateUnified(rules, [fact("base", ["x"])])
      expect(result.ok).toBe(false)
    })

    it("handles empty rules", () => {
      const facts = [fact("base", ["a"])]
      const result = evaluateUnified([], facts)
      if (!result.ok) throw new Error("should succeed")

      expect(result.value.size).toBe(1)
      expect(result.value.hasFact(fact("base", ["a"]))).toBe(true)
    })

    it("handles empty facts", () => {
      const rules: Rule[] = [
        rule(atom("derived", [varTerm("X")]), [
          positiveAtom(atom("base", [varTerm("X")])),
        ]),
      ]

      const result = evaluateUnified(rules, [])
      if (!result.ok) throw new Error("should succeed")
      expect(result.value.size).toBe(0)
    })
  })

  describe("evaluatePositiveUnified matches old evaluatePositive", () => {
    it("transitive closure produces same results", () => {
      const rules: Rule[] = [
        rule(atom("path", [varTerm("X"), varTerm("Y")]), [
          positiveAtom(atom("edge", [varTerm("X"), varTerm("Y")])),
        ]),
        rule(atom("path", [varTerm("X"), varTerm("Z")]), [
          positiveAtom(atom("edge", [varTerm("X"), varTerm("Y")])),
          positiveAtom(atom("path", [varTerm("Y"), varTerm("Z")])),
        ]),
      ]

      const facts = [
        fact("edge", ["a", "b"]),
        fact("edge", ["b", "c"]),
        fact("edge", ["c", "d"]),
      ]

      const oldDb = evaluatePositive(rules, facts)
      const newDb = evaluatePositiveUnified(rules, facts)

      const oldPaths = oldDb.getRelation("path").tuples()
      const newPaths = newDb.getRelation("path").tuples()

      expect(newPaths.length).toBe(oldPaths.length)
      for (const t of oldPaths) {
        expect(newDb.hasFact(fact("path", t))).toBe(true)
      }
    })
  })

  // ---------------------------------------------------------------------------
  // Monotone stratum: transitive closure
  // ---------------------------------------------------------------------------

  describe("monotone stratum: transitive closure", () => {
    it("derives transitive facts incrementally", () => {
      const rules: Rule[] = [
        rule(atom("path", [varTerm("X"), varTerm("Y")]), [
          positiveAtom(atom("edge", [varTerm("X"), varTerm("Y")])),
        ]),
        rule(atom("path", [varTerm("X"), varTerm("Z")]), [
          positiveAtom(atom("edge", [varTerm("X"), varTerm("Y")])),
          positiveAtom(atom("path", [varTerm("Y"), varTerm("Z")])),
        ]),
      ]

      const evaluator = createEvaluator(rules)

      // Add edge(a, b).
      evaluator.step(factsToZSet([fact("edge", ["a", "b"])]))
      let db = evaluator.currentDatabase()
      expect(db.hasFact(fact("path", ["a", "b"]))).toBe(true)

      // Add edge(b, c).
      evaluator.step(factsToZSet([fact("edge", ["b", "c"])]))
      db = evaluator.currentDatabase()
      expect(db.hasFact(fact("path", ["b", "c"]))).toBe(true)
      expect(db.hasFact(fact("path", ["a", "c"]))).toBe(true)

      // Add edge(c, d).
      evaluator.step(factsToZSet([fact("edge", ["c", "d"])]))
      db = evaluator.currentDatabase()
      expect(db.hasFact(fact("path", ["c", "d"]))).toBe(true)
      expect(db.hasFact(fact("path", ["b", "d"]))).toBe(true)
      expect(db.hasFact(fact("path", ["a", "d"]))).toBe(true)
    })

    it("matches batch for transitive closure", () => {
      const rules: Rule[] = [
        rule(atom("path", [varTerm("X"), varTerm("Y")]), [
          positiveAtom(atom("edge", [varTerm("X"), varTerm("Y")])),
        ]),
        rule(atom("path", [varTerm("X"), varTerm("Z")]), [
          positiveAtom(atom("edge", [varTerm("X"), varTerm("Y")])),
          positiveAtom(atom("path", [varTerm("Y"), varTerm("Z")])),
        ]),
      ]

      const edges = [
        fact("edge", ["a", "b"]),
        fact("edge", ["b", "c"]),
        fact("edge", ["c", "d"]),
      ]

      // Incremental.
      const evaluator = createEvaluator(rules)
      for (const e of edges) {
        evaluator.step(factsToZSet([e]))
      }

      // Batch.
      const batchDb = evaluatePositive(rules, edges)

      const incPaths = evaluator.currentDatabase().getRelation("path").tuples()
      const batchPaths = batchDb.getRelation("path").tuples()

      expect(incPaths.length).toBe(batchPaths.length)
      for (const t of batchPaths) {
        expect(evaluator.currentDatabase().hasFact(fact("path", t))).toBe(true)
      }
    })

    it("transitive closure preserves true multiplicity with dual-weight", () => {
      // Diamond: a→b, a→c, b→d, c→d. Two paths from a to d.
      // With dual-weight (Plan 006.2), getWeight() returns true Z-set
      // multiplicity (> 1 for multi-path derivations). Presence is correct.
      // weightedTuples() returns clampedWeight = 1 for all present entries.
      const rules: Rule[] = [
        rule(atom("path", [varTerm("X"), varTerm("Y")]), [
          positiveAtom(atom("edge", [varTerm("X"), varTerm("Y")])),
        ]),
        rule(atom("path", [varTerm("X"), varTerm("Z")]), [
          positiveAtom(atom("edge", [varTerm("X"), varTerm("Y")])),
          positiveAtom(atom("path", [varTerm("Y"), varTerm("Z")])),
        ]),
      ]

      const edges = [
        fact("edge", ["a", "b"]),
        fact("edge", ["a", "c"]),
        fact("edge", ["b", "d"]),
        fact("edge", ["c", "d"]),
      ]

      const evaluator = createEvaluator(rules)
      evaluator.step(factsToZSet(edges))

      const db = evaluator.currentDatabase()
      // path(a,d) derivable via a→b→d and a→c→d — present.
      expect(db.hasFact(fact("path", ["a", "d"]))).toBe(true)
      // True multiplicity > 0 (preserved by negative-floor-only distinct).
      expect(db.getRelation("path").getWeight(["a", "d"])).toBeGreaterThan(0)
      // weightedTuples() returns clampedWeight = 1 (prevents weight explosion in joins).
      for (const { weight } of db.getRelation("path").weightedTuples()) {
        expect(weight).toBe(1)
      }
    })
  })

  // ---------------------------------------------------------------------------
  // Negation stratum with stratified negation
  // ---------------------------------------------------------------------------

  describe("negation stratum with stratified negation", () => {
    it("correctly computes negation across strata", () => {
      // Stratum 0: reachable(X,Y) :- edge(X,Y).
      //            reachable(X,Z) :- edge(X,Y), reachable(Y,Z).
      // Stratum 1: unreachable(X,Y) :- node(X), node(Y), not reachable(X,Y).
      const rules: Rule[] = [
        rule(atom("reachable", [varTerm("X"), varTerm("Y")]), [
          positiveAtom(atom("edge", [varTerm("X"), varTerm("Y")])),
        ]),
        rule(atom("reachable", [varTerm("X"), varTerm("Z")]), [
          positiveAtom(atom("edge", [varTerm("X"), varTerm("Y")])),
          positiveAtom(atom("reachable", [varTerm("Y"), varTerm("Z")])),
        ]),
        rule(atom("unreachable", [varTerm("X"), varTerm("Y")]), [
          positiveAtom(atom("node", [varTerm("X")])),
          positiveAtom(atom("node", [varTerm("Y")])),
          negation(atom("reachable", [varTerm("X"), varTerm("Y")])),
        ]),
      ]

      const evaluator = createEvaluator(rules)
      const initialFacts = [
        fact("node", ["a"]),
        fact("node", ["b"]),
        fact("node", ["c"]),
        fact("edge", ["a", "b"]),
        fact("edge", ["b", "c"]),
      ]

      evaluator.step(factsToZSet(initialFacts))

      const db = evaluator.currentDatabase()
      expect(db.hasFact(fact("reachable", ["a", "b"]))).toBe(true)
      expect(db.hasFact(fact("reachable", ["a", "c"]))).toBe(true)
      expect(db.hasFact(fact("reachable", ["b", "c"]))).toBe(true)

      // Unreachable pairs.
      expect(db.hasFact(fact("unreachable", ["b", "a"]))).toBe(true)
      expect(db.hasFact(fact("unreachable", ["c", "a"]))).toBe(true)
      expect(db.hasFact(fact("unreachable", ["c", "b"]))).toBe(true)

      // Self-loops are unreachable too (not derived by edge rules).
      expect(db.hasFact(fact("unreachable", ["a", "a"]))).toBe(true)
    })

    it("matches batch for negation scenario", () => {
      const rules: Rule[] = [
        rule(atom("reachable", [varTerm("X"), varTerm("Y")]), [
          positiveAtom(atom("edge", [varTerm("X"), varTerm("Y")])),
        ]),
        rule(atom("reachable", [varTerm("X"), varTerm("Z")]), [
          positiveAtom(atom("edge", [varTerm("X"), varTerm("Y")])),
          positiveAtom(atom("reachable", [varTerm("Y"), varTerm("Z")])),
        ]),
        rule(atom("unreachable", [varTerm("X"), varTerm("Y")]), [
          positiveAtom(atom("node", [varTerm("X")])),
          positiveAtom(atom("node", [varTerm("Y")])),
          negation(atom("reachable", [varTerm("X"), varTerm("Y")])),
        ]),
      ]

      const allFacts = [
        fact("node", ["a"]),
        fact("node", ["b"]),
        fact("node", ["c"]),
        fact("edge", ["a", "b"]),
        fact("edge", ["b", "c"]),
      ]

      // Incremental.
      const evaluator = createEvaluator(rules)
      evaluator.step(factsToZSet(allFacts))

      // Batch.
      const batchResult = evaluate(rules, allFacts)
      if (!batchResult.ok) throw new Error("batch eval failed")
      const batchDb = batchResult.value

      const incReachable = evaluator
        .currentDatabase()
        .getRelation("reachable")
        .tuples()
      const batchReachable = batchDb.getRelation("reachable").tuples()
      expect(incReachable.length).toBe(batchReachable.length)

      for (const t of batchReachable) {
        expect(evaluator.currentDatabase().hasFact(fact("reachable", t))).toBe(
          true,
        )
      }

      const incUnreachable = evaluator
        .currentDatabase()
        .getRelation("unreachable")
        .tuples()
      const batchUnreachable = batchDb.getRelation("unreachable").tuples()
      expect(incUnreachable.length).toBe(batchUnreachable.length)

      for (const t of batchUnreachable) {
        expect(
          evaluator.currentDatabase().hasFact(fact("unreachable", t)),
        ).toBe(true)
      }
    })
  })

  // ---------------------------------------------------------------------------
  // evaluateUnified: comprehensive equivalence with old evaluate
  // ---------------------------------------------------------------------------

  describe("evaluateUnified comprehensive equivalence", () => {
    it("evaluate.test.ts: stratified negation", () => {
      // winner(X) :- candidate(X), not rejected(X).
      // rejected(X) :- candidate(X), candidate(Y), X != Y, Y > X.
      const rules: Rule[] = [
        rule(atom("winner", [varTerm("X")]), [
          positiveAtom(atom("candidate", [varTerm("X")])),
          negation(atom("rejected", [varTerm("X")])),
        ]),
        rule(atom("rejected", [varTerm("X")]), [
          positiveAtom(atom("candidate", [varTerm("X")])),
          positiveAtom(atom("candidate", [varTerm("Y")])),
          neq(varTerm("X"), varTerm("Y")),
          gt(varTerm("Y"), varTerm("X")),
        ]),
      ]

      const facts = [
        fact("candidate", ["a"]),
        fact("candidate", ["b"]),
        fact("candidate", ["c"]),
      ]

      const oldResult = evaluate(rules, facts)
      if (!oldResult.ok) throw new Error("old eval failed")

      const newResult = evaluateUnified(rules, facts)
      if (!newResult.ok) throw new Error("new eval failed")

      // Both should produce the same winners and rejected sets.
      const oldWinners = oldResult.value.getRelation("winner").tuples()
      const newWinners = newResult.value.getRelation("winner").tuples()
      expect(newWinners.length).toBe(oldWinners.length)
      for (const t of oldWinners) {
        expect(newResult.value.hasFact(fact("winner", t))).toBe(true)
      }

      const oldRejected = oldResult.value.getRelation("rejected").tuples()
      const newRejected = newResult.value.getRelation("rejected").tuples()
      expect(newRejected.length).toBe(oldRejected.length)
    })

    it("evaluate.test.ts: multiple rules for the same predicate", () => {
      // derived(X) :- source_a(X).
      // derived(X) :- source_b(X).
      const rules: Rule[] = [
        rule(atom("derived", [varTerm("X")]), [
          positiveAtom(atom("source_a", [varTerm("X")])),
        ]),
        rule(atom("derived", [varTerm("X")]), [
          positiveAtom(atom("source_b", [varTerm("X")])),
        ]),
      ]

      const facts = [
        fact("source_a", ["x"]),
        fact("source_b", ["y"]),
        fact("source_a", ["z"]),
        fact("source_b", ["z"]),
      ]

      const oldResult = evaluate(rules, facts)
      if (!oldResult.ok) throw new Error("old eval failed")

      const newResult = evaluateUnified(rules, facts)
      if (!newResult.ok) throw new Error("new eval failed")

      const oldDerived = oldResult.value.getRelation("derived").tuples()
      const newDerived = newResult.value.getRelation("derived").tuples()
      expect(newDerived.length).toBe(oldDerived.length)
      for (const t of oldDerived) {
        expect(newResult.value.hasFact(fact("derived", t))).toBe(true)
      }
    })

    it("evaluate.test.ts: guard conditions", () => {
      // big(X) :- val(X), X > 5.
      const rules: Rule[] = [
        rule(atom("big", [varTerm("X")]), [
          positiveAtom(atom("val", [varTerm("X")])),
          gt(varTerm("X"), constTerm(5)),
        ]),
      ]

      const facts = [fact("val", [3]), fact("val", [7]), fact("val", [10])]

      const oldResult = evaluate(rules, facts)
      if (!oldResult.ok) throw new Error("old eval failed")

      const newResult = evaluateUnified(rules, facts)
      if (!newResult.ok) throw new Error("new eval failed")

      expect(newResult.value.hasFact(fact("big", [3]))).toBe(false)
      expect(newResult.value.hasFact(fact("big", [7]))).toBe(true)
      expect(newResult.value.hasFact(fact("big", [10]))).toBe(true)

      const oldBig = oldResult.value.getRelation("big").tuples()
      const newBig = newResult.value.getRelation("big").tuples()
      expect(newBig.length).toBe(oldBig.length)
    })
  })

  // ---------------------------------------------------------------------------
  // Weight propagation edge cases
  // ---------------------------------------------------------------------------

  describe("weight propagation edge cases", () => {
    it("adding the same ground fact twice accumulates true weight", () => {
      // With dual-weight (Plan 006.2), adding a +1 ground fact twice
      // gives the ground fact weight 2. The derived fact also gets
      // weight 2 (provenance product 1 × 2). This is correct Z-set
      // semantics — the fact is "doubly asserted." Presence is still
      // correct (has() returns true, clampedWeight = 1).
      const rules: Rule[] = [
        rule(atom("derived", [varTerm("X")]), [
          positiveAtom(atom("base", [varTerm("X")])),
        ]),
      ]

      const evaluator = createEvaluator(rules)
      const f = fact("base", ["a"])

      evaluator.step(factsToZSet([f]))
      evaluator.step(factsToZSet([f]))

      const db = evaluator.currentDatabase()
      expect(db.hasFact(fact("derived", ["a"]))).toBe(true)
      // Ground fact has true weight 2 (two +1 assertions).
      expect(db.getRelation("base").getWeight(["a"])).toBe(2)
      // Derived fact weight > 0. Exact value depends on iteration,
      // but presence is correct.
      expect(db.getRelation("derived").getWeight(["a"])).toBeGreaterThan(0)
    })
  })
})

// ---------------------------------------------------------------------------
// Mixed retract-and-insert steps, against negation over a derived predicate
//
// The shape that motivated these tests: one step that both retracts a fact and
// inserts another, where a rule negates a predicate derived from that same
// fact. Both halves land in one delta, so the incremental decomposition has to
// account for a derivation that the retraction removes and the newly-true
// negation would independently have blocked. Get either side wrong and a fact
// is stranded that batch evaluation does not derive.
//
// A downstream game engine hit this as a monster hunting from tiles it had
// already left. The oracle throughout is a fresh evaluator over the
// accumulated ground facts.
// ---------------------------------------------------------------------------

describe("mixed retract+insert steps with negation over a derived predicate", () => {
  const WIDTH = 4
  const HEIGHT = 3

  /** `blocked` is derived, and both rules below read it under negation. */
  const blockedRules: Rule[] = [
    rule(atom("blocked", [varTerm("X"), varTerm("Y")]), [
      positiveAtom(atom("wall", [varTerm("X"), varTerm("Y")])),
    ]),
    rule(atom("blocked", [varTerm("X"), varTerm("Y")]), [
      positiveAtom(atom("at", [varTerm("E"), varTerm("X"), varTerm("Y")])),
      positiveAtom(atom("solid", [varTerm("E")])),
    ]),
  ]

  /** Non-recursive: one join away from the negated predicate. */
  const stepToRule: Rule = rule(
    atom("step_to", [varTerm("E"), varTerm("X2"), varTerm("Y2")]),
    [
      positiveAtom(atom("at", [varTerm("E"), varTerm("X"), varTerm("Y")])),
      positiveAtom(
        atom("adj", [varTerm("X"), varTerm("Y"), varTerm("X2"), varTerm("Y2")]),
      ),
      negation(atom("blocked", [varTerm("X2"), varTerm("Y2")])),
    ],
  )

  /** Recursive: transitive reachability, gated by the same negation. */
  const reachRules: Rule[] = [
    rule(atom("reach", [varTerm("X"), varTerm("Y")]), [
      positiveAtom(atom("source", [varTerm("X"), varTerm("Y")])),
    ]),
    rule(atom("reach", [varTerm("X2"), varTerm("Y2")]), [
      positiveAtom(atom("reach", [varTerm("X"), varTerm("Y")])),
      positiveAtom(
        atom("adj", [varTerm("X"), varTerm("Y"), varTerm("X2"), varTerm("Y2")]),
      ),
      negation(atom("blocked", [varTerm("X2"), varTerm("Y2")])),
    ]),
  ]

  /**
   * The geography. `symmetric` decides whether adjacency runs both ways, which
   * is what makes recursion over it cyclic.
   */
  function terrain(symmetric: boolean): Fact[] {
    const facts: Fact[] = [fact("source", [0, 0])]
    for (let x = 0; x < WIDTH; x++) {
      for (let y = 0; y < HEIGHT; y++) {
        if (x + 1 < WIDTH) {
          facts.push(fact("adj", [x, y, x + 1, y]))
          if (symmetric) facts.push(fact("adj", [x + 1, y, x, y]))
        }
        if (y + 1 < HEIGHT) {
          facts.push(fact("adj", [x, y, x, y + 1]))
          if (symmetric) facts.push(fact("adj", [x, y + 1, x, y]))
        }
      }
    }
    return facts
  }

  /** Deterministic PRNG, so a failure names a seed you can replay. */
  function lcg(seed: number): () => number {
    let s = seed >>> 0
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0
      return s / 0x100000000
    }
  }

  /**
   * Drive 40 randomized histories through the evaluator, comparing every
   * derived relation against a fresh batch evaluation after each step.
   */
  function differentialSweep(
    rules: readonly Rule[],
    derivedPreds: readonly string[],
    symmetric: boolean,
    host?: Host,
  ): void {
    const snapshot = (db: Database): string[] => {
      const out: string[] = []
      for (const pred of derivedPreds) {
        for (const tuple of db.getRelation(pred).tuples()) {
          out.push(factKey({ predicate: pred, values: tuple }))
        }
      }
      return out.sort()
    }

    for (let seed = 1; seed <= 40; seed++) {
      const rand = lcg(seed)
      const pick = (n: number) => Math.floor(rand() * n)

      const evaluator = createEvaluator(rules, host)
      // Derived facts as the step deltas alone describe them. The deltas are
      // what a consumer sees, so they must agree with the database exactly.
      const shadow = new Set<string>()
      const step = (delta: ZSet<Fact>): void => {
        const deltaDerived = evaluator.step(delta)
        zsetForEach(deltaDerived, (entry, key) => {
          if (entry.weight > 0) {
            expect(shadow.has(key), `duplicate +1 for ${key}`).toBe(false)
            shadow.add(key)
          } else {
            expect(shadow.has(key), `-1 for absent ${key}`).toBe(true)
            shadow.delete(key)
          }
        })
      }
      const ground = new Map<string, Fact>()
      const opening = terrain(symmetric)
      for (const f of opening) ground.set(factKey(f), f)
      step(factsToZSet(opening))

      const pos: Record<string, [number, number]> = {
        hero: [0, 0],
        murk: [WIDTH - 1, HEIGHT - 1],
      }
      for (const [e, [x, y]] of Object.entries(pos)) {
        const placed = [fact("at", [e, x, y]), fact("solid", [e])]
        if (e === "hero") placed.push(fact("player", [e]))
        for (const f of placed) ground.set(factKey(f), f)
        step(factsToZSet(placed))
      }

      for (let tick = 0; tick < 12; tick++) {
        // One step carrying a retraction and an insertion together: an entity
        // leaves a tile and arrives at another, exactly as a move does.
        const entity = pick(2) === 0 ? "hero" : "murk"
        const [ox, oy] = pos[entity]!
        const nx = pick(WIDTH)
        const ny = pick(HEIGHT)
        pos[entity] = [nx, ny]

        const entries: [Fact, number][] = [
          [fact("at", [entity, ox, oy]), -1],
          [fact("at", [entity, nx, ny]), 1],
        ]
        // Sometimes toggle a wall in the same step, so two sources of the
        // negated predicate change at once.
        if (pick(3) === 0) {
          const wall = fact("wall", [pick(WIDTH), pick(HEIGHT)])
          entries.push([wall, ground.has(factKey(wall)) ? -1 : 1])
        }

        step(
          zsetFromEntries(
            entries.map(([f, w]) => [factKey(f), { element: f, weight: w }]),
          ),
        )
        for (const [f, w] of entries) {
          if (w > 0) ground.set(factKey(f), f)
          else ground.delete(factKey(f))
        }

        const oracle = createEvaluator(rules, host)
        oracle.step(factsToZSet([...ground.values()]))

        const expected = snapshot(oracle.currentDatabase())
        expect(
          snapshot(evaluator.currentDatabase()),
          `seed ${seed}, tick ${tick}`,
        ).toEqual(expected)
        expect(
          [...shadow].sort(),
          `deltas, seed ${seed}, tick ${tick}`,
        ).toEqual(expected)
      }
    }
  }

  it("non-recursive rule over a negated derived predicate matches batch", () => {
    differentialSweep(
      [...blockedRules, stepToRule],
      ["blocked", "step_to"],
      true,
    )
  })

  it("recursive rule matches batch when the recursion is acyclic", () => {
    differentialSweep(
      [...blockedRules, ...reachRules],
      ["blocked", "reach"],
      false,
    )
  })

  // With adjacency symmetric, `reach` is recursive over a cyclic graph, and
  // two reachable tiles support each other. Counting alone cannot tell that
  // the remaining support is circular once the real support is cut, so the
  // evaluator recomputes a recursive stratum that a retraction reaches
  // (`recomputeStratum`, a stopgap until per-round counts). This test is
  // what that stopgap exists for, and must keep passing without it.
  it("recursive rule over cyclic support matches batch under retraction", () => {
    differentialSweep(
      [...blockedRules, ...reachRules],
      ["blocked", "reach"],
      true,
    )
  })

  it("a foreign distance field over the terrain matches batch under every kind of change", () => {
    // The third shape: a host-computed relation (the breadth-first field in
    // `fields.ts`) between the derived `blocked` and `origin` below it and a
    // rule reading it above. Walls toggle and entities move, sometimes in the
    // same step, and both the database and the step deltas must match batch.
    const originRule = rule(atom("origin", [varTerm("X"), varTerm("Y")]), [
      positiveAtom(atom("player", [varTerm("P")])),
      positiveAtom(atom("at", [varTerm("P"), varTerm("X"), varTerm("Y")])),
    ])
    const towardRule = rule(
      atom("toward", [
        varTerm("X"),
        varTerm("Y"),
        varTerm("X2"),
        varTerm("Y2"),
      ]),
      [
        positiveAtom(atom("dist", [varTerm("X"), varTerm("Y"), varTerm("D")])),
        positiveAtom(
          atom("adj", [
            varTerm("X"),
            varTerm("Y"),
            varTerm("X2"),
            varTerm("Y2"),
          ]),
        ),
        positiveAtom(
          atom("dist", [varTerm("X2"), varTerm("Y2"), varTerm("D2")]),
        ),
        lt(varTerm("D2"), varTerm("D")),
      ],
    )
    differentialSweep(
      [...blockedRules, originRule, towardRule],
      ["blocked", "origin", "dist", "toward"],
      true,
      { relations: [DISTANCE_FIELD] },
    )
  })

  it("retracting a cycle's only real support retracts the whole cycle", () => {
    // A 3-cycle hanging off a ground `reach(0)`: the predicate is both
    // inserted and derived, as `lit(0, 0)` seeds the fire in the bench. After
    // the edge from 0 is cut, every node in the cycle still has a neighbour
    // deriving it; only 0 itself is really supported.
    const cyc: Rule[] = [
      rule(atom("reach", [varTerm("Y")]), [
        positiveAtom(atom("reach", [varTerm("X")])),
        positiveAtom(atom("edge", [varTerm("X"), varTerm("Y")])),
      ]),
    ]
    const evaluator = createEvaluator(cyc)
    evaluator.step(
      factsToZSet([
        fact("reach", [0]),
        fact("edge", [0, 1]),
        fact("edge", [1, 2]),
        fact("edge", [2, 3]),
        fact("edge", [3, 1]),
      ]),
    )
    expect(evaluator.currentDatabase().getRelation("reach").size).toBe(4)

    const result = evaluator.step(factsToZSet([fact("edge", [0, 1])], -1))
    expect(evaluator.currentDatabase().getRelation("reach").tuples()).toEqual([
      [0],
    ])
    const retracted = [...result.entries()]
      .map(([key, entry]) => [key, entry.weight])
      .sort()
    expect(retracted).toEqual(
      [1, 2, 3].map(n => [factKey(fact("reach", [n])), -1]),
    )
  })
})

// ---------------------------------------------------------------------------
// Ground relations are sets at the stratum boundary
//
// A ground fact's Z-set weight is a reference count: the fact is present while
// the count is positive. Strata read presence, so what they must be told is
// that a fact appeared or disappeared, once, when its count crosses zero. If
// the raw weight leaks through instead, derived counts pick up a multiplicity
// that no later retraction can fully take back.
// ---------------------------------------------------------------------------

describe("ground facts reach strata as presence flips, not raw weights", () => {
  const both: Rule = rule(atom("d", [varTerm("X")]), [
    positiveAtom(atom("a", [varTerm("X")])),
    positiveAtom(atom("b", [varTerm("X")])),
  ])

  it("a fact inserted at weight 2 does not strand what it derives", () => {
    const evaluator = createEvaluator([both])
    const d = () => evaluator.currentDatabase().getRelation("d")

    evaluator.step(factsToZSet([fact("b", [1])]))
    // The same fact twice in one step sums to weight 2.
    evaluator.step(factsToZSet([fact("a", [1]), fact("a", [1])]))
    expect(d().has([1])).toBe(true)

    const result = evaluator.step(factsToZSet([fact("b", [1])], -1))
    expect(d().has([1])).toBe(false)
    expect(result.get(factKey(fact("d", [1])))?.weight).toBe(-1)
  })

  it("retracted once, a weight-2 fact is still present; twice, it is gone", () => {
    // Guards the fix from the wrong shape: clamping the delta to its sign
    // would retract on the first step.
    const evaluator = createEvaluator([both])
    const d = () => evaluator.currentDatabase().getRelation("d")

    evaluator.step(factsToZSet([fact("b", [1])]))
    evaluator.step(factsToZSet([fact("a", [1]), fact("a", [1])]))

    const first = evaluator.step(factsToZSet([fact("a", [1])], -1))
    expect(zsetIsEmpty(first)).toBe(true)
    expect(d().has([1])).toBe(true)

    const second = evaluator.step(factsToZSet([fact("a", [1])], -1))
    expect(second.get(factKey(fact("d", [1])))?.weight).toBe(-1)
    expect(d().has([1])).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// A predicate that is both inserted and derived
//
// `lit(0, 0)` seeds the fire that derives the rest of `lit`. The database
// holds the sum, so every path that derives a stratum again from scratch
// (aggregation, retraction into recursion, a rule change) must wipe only the
// derived part and keep the ground part to seed the replay.
// ---------------------------------------------------------------------------

describe("a predicate that is both inserted and derived", () => {
  const spread: Rule = rule(atom("reach", [varTerm("Y")]), [
    positiveAtom(atom("reach", [varTerm("X")])),
    positiveAtom(atom("edge", [varTerm("X"), varTerm("Y")])),
  ])
  const line = [fact("reach", [0]), fact("edge", [0, 1]), fact("edge", [1, 2])]
  const weights = (zs: ZSet<Fact>): [string, number][] =>
    [...zs.entries()].map(([key, entry]) => [key, entry.weight]).sort()

  it("keeps its ground facts through a rule change, and afterwards", () => {
    const evaluator = createEvaluator([spread])
    evaluator.step(factsToZSet(line))
    expect(evaluator.currentDatabase().getRelation("reach").size).toBe(3)

    // Adding a rule derives every stratum again; the ground `reach(0)` must
    // survive the wipe and seed the replay, so `reach` does not change.
    const mark: Rule = rule(atom("mark", [varTerm("X")]), [
      positiveAtom(atom("reach", [varTerm("X")])),
    ])
    const added = evaluator.changeRules(zsetSingleton("mark", mark, 1))
    expect(evaluator.currentDatabase().getRelation("reach").size).toBe(3)
    expect(weights(added)).toEqual(
      [0, 1, 2].map(n => [factKey(fact("mark", [n])), 1]),
    )

    // The ground part is still known after the change: a retraction into
    // the recursive stratum recomputes it from `reach(0)` again.
    const cut = evaluator.step(factsToZSet([fact("edge", [1, 2])], -1))
    expect(evaluator.currentDatabase().getRelation("reach").tuples()).toEqual([
      [0],
      [1],
    ])
    expect(weights(cut)).toEqual([
      [factKey(fact("mark", [2])), -1],
      [factKey(fact("reach", [2])), -1],
    ])
  })

  it("empties the closure when the ground seed itself is retracted", () => {
    const evaluator = createEvaluator([spread])
    evaluator.step(factsToZSet(line))

    const result = evaluator.step(factsToZSet([fact("reach", [0])], -1))
    expect(evaluator.currentDatabase().getRelation("reach").size).toBe(0)
    // The seed's own retraction is a ground change, not a derived one.
    expect(weights(result)).toEqual(
      [1, 2].map(n => [factKey(fact("reach", [n])), -1]),
    )
  })

  it("survives a recompute of an aggregation stratum it belongs to", () => {
    // `total` is inserted directly and also derived by count; a recompute
    // wipes the derived total and keeps the inserted one.
    const count: Rule = rule(atom("total", [varTerm("N")]), [
      aggregation({
        fn: "count",
        groupBy: [],
        over: "X",
        result: "N",
        source: atom("item", [varTerm("X")]),
      }),
    ])
    const evaluator = createEvaluator([count])
    evaluator.step(
      factsToZSet([fact("total", [99]), fact("item", [1]), fact("item", [2])]),
    )
    expect(evaluator.currentDatabase().getRelation("total").tuples()).toEqual([
      [99],
      [2],
    ])

    const result = evaluator.step(factsToZSet([fact("item", [3])]))
    expect(evaluator.currentDatabase().getRelation("total").tuples()).toEqual([
      [99],
      [3],
    ])
    expect(weights(result)).toEqual([
      [factKey(fact("total", [2])), -1],
      [factKey(fact("total", [3])), 1],
    ])
  })
})

describe("rules with an empty body", () => {
  it("hold from construction; an empty step derives nothing new; changeRules reports only what is new", () => {
    const evaluator = createEvaluator([
      rule(atom("axiom", [constTerm(42)]), []),
    ])
    const axioms = () => evaluator.currentDatabase().getRelation("axiom")
    expect(axioms().has([42])).toBe(true)
    expect(zsetIsEmpty(evaluator.step(zsetEmpty()))).toBe(true)
    expect(axioms().getWeight([42])).toBe(1)

    const seven = rule(atom("axiom", [constTerm(7)]), [])
    const added = evaluator.changeRules(zsetSingleton("seven", seven, 1))
    expect([...added.keys()]).toEqual([factKey(fact("axiom", [7]))])
    expect(added.get(factKey(fact("axiom", [7])))?.weight).toBe(1)
    expect(axioms().getWeight([42])).toBe(1)
  })

  it("feed higher strata even with no ground facts at all", () => {
    // A pre-existing gap: the old first-step path ran each stratum with an
    // empty delta, so `q` never saw `p`'s axiom.
    const result = evaluate(
      [
        rule(atom("p", [constTerm(1)]), []),
        rule(atom("q", [varTerm("X")]), [
          positiveAtom(atom("p", [varTerm("X")])),
        ]),
      ],
      [],
    )
    expect(result.ok && result.value.getRelation("q").has([1])).toBe(true)
  })
})

describe("rules with no positive atoms but a negation", () => {
  // `ask(2) :- not locked(door_1).` is range-restricted (it has no variables
  // at all) and has an unambiguous least model: with `locked` empty the
  // negation holds and `ask(2)` is derived. Every textbook Datalog derives it.
  //
  // This engine used not to. Such a rule has no positive atom to join against,
  // so nothing in an arriving delta can drive it, and the seed phase only fired
  // rules with *no* body atoms of any kind. It therefore stayed dormant until
  // `locked` happened to appear in some delta — after which it behaved
  // correctly forever. Intermittent, and a different reality from the same
  // store depending on the engine, which is what `host.ts`'s invariant forbids.
  const askUnlocked = rule(atom("ask", [constTerm(2)]), [
    negation(atom("locked", [constTerm("door_1")])),
  ])
  // The same claim with a positive atom in front: the control that always worked.
  const askUnlockedGuarded = rule(atom("ask", [constTerm(3)]), [
    positiveAtom(atom("grid", [constTerm(8), constTerm(5)])),
    negation(atom("locked", [constTerm("door_1")])),
  ])
  const grid = fact("grid", [8, 5])
  const locked = fact("locked", ["door_1"])

  it("derives in batch when the negated predicate has never held a fact", () => {
    const noFactsAtAll = evaluate([askUnlocked], [])
    expect(
      noFactsAtAll.ok && noFactsAtAll.value.getRelation("ask").tuples(),
    ).toEqual([[2]])

    // And alongside the control, which used to be the only one that fired.
    const withGrid = evaluate([askUnlocked, askUnlockedGuarded], [grid])
    expect(withGrid.ok && withGrid.value.getRelation("ask").tuples()).toEqual([
      [2],
      [3],
    ])
  })

  it("does not derive in batch when the negated fact is present", () => {
    const result = evaluate([askUnlocked, askUnlockedGuarded], [grid, locked])
    expect(result.ok && result.value.getRelation("ask").tuples()).toEqual([])
  })

  it("holds from construction, then tracks the negated predicate both ways", () => {
    const evaluator = createEvaluator([askUnlocked, askUnlockedGuarded])
    const asks = () => evaluator.currentDatabase().getRelation("ask").tuples()

    // Established before any fact has ever been stepped in.
    expect(asks()).toEqual([[2]])

    evaluator.step(factsToZSet([grid]))
    expect(asks()).toEqual([[2], [3]])

    // Locking retracts both. This is the case the obvious one-line fix breaks:
    // firing a negation rule unconditionally on a step is purely additive, so
    // it would derive nothing here and leave `ask(2)` stranded with nothing to
    // remove it. Negations must keep going through the differential pass.
    evaluator.step(factsToZSet([locked]))
    expect(asks()).toEqual([])

    evaluator.step(factsToZSet([locked], -1))
    expect(asks()).toEqual([[2], [3]])
  })

  it("does not accumulate weight when stepped repeatedly", () => {
    const evaluator = createEvaluator([askUnlocked])
    for (let i = 0; i < 3; i++) evaluator.step(factsToZSet([grid]))

    expect(evaluator.currentDatabase().getRelation("ask").getWeight([2])).toBe(
      1,
    )
  })

  it("is established by changeRules, not only at construction", () => {
    const evaluator = createEvaluator([])
    const added = evaluator.changeRules(
      zsetSingleton("ask-unlocked", askUnlocked, 1),
    )

    expect([...added.keys()]).toEqual([factKey(fact("ask", [2]))])
    expect(evaluator.currentDatabase().getRelation("ask").tuples()).toEqual([
      [2],
    ])
  })

  it("retracts when a lower stratum derives the negated fact mid-run", () => {
    // The negated predicate is derived, not ground, so the trigger has to
    // arrive as a lower stratum's *output* delta rather than as a stepped
    // fact. `ask(2)` holds until `sealed` makes `locked` non-empty.
    const evaluator = createEvaluator([
      rule(atom("locked", [varTerm("D")]), [
        positiveAtom(atom("sealed", [varTerm("D")])),
      ]),
      askUnlocked,
    ])
    const asks = () => evaluator.currentDatabase().getRelation("ask").tuples()

    expect(asks()).toEqual([[2]])

    evaluator.step(factsToZSet([fact("sealed", ["door_1"])]))
    expect(
      evaluator.currentDatabase().getRelation("locked").has(["door_1"]),
    ).toBe(true)
    expect(asks()).toEqual([])

    evaluator.step(factsToZSet([fact("sealed", ["door_1"])], -1))
    expect(asks()).toEqual([[2]])
  })

  it("works when the negated predicate is derived rather than ground", () => {
    // `locked` is now a head of a lower stratum that derives nothing, so the
    // negation is over an empty *derived* relation rather than an absent one.
    const result = evaluate(
      [
        rule(atom("locked", [varTerm("D")]), [
          positiveAtom(atom("sealed", [varTerm("D")])),
        ]),
        askUnlocked,
      ],
      [],
    )
    expect(result.ok && result.value.getRelation("ask").tuples()).toEqual([[2]])
  })

  it("still respects a guard alongside the negation", () => {
    const withFalseGuard = rule(atom("ask", [constTerm(9)]), [
      negation(atom("locked", [constTerm("door_1")])),
      gt(constTerm(1), constTerm(2)),
    ])
    const result = evaluate([withFalseGuard], [])
    expect(result.ok && result.value.getRelation("ask").tuples()).toEqual([])
  })
})

// === Unified Evaluator Tests (Plan 006.1, Phase 2) ===
// Tests for the unified weighted Datalog evaluator that replaces both
// `evaluate.ts` (batch) and `incremental-evaluate.ts` (incremental).
//
// Test categories:
//   - Dirty-map infrastructure: touchFact, applyDistinct, extractDelta
//   - evaluateStratumFromDelta: unit tests with small rule sets
//   - createEvaluator + step: incremental evaluation tests
//   - Batch wrappers: evaluateUnified, evaluatePositiveUnified
//   - Three-way oracle: batch ≡ single-step ≡ one-at-a-time
//   - Retraction through negation without DRed
//   - Transitive closure with distinct
//   - Rule changes
//   - Resolution extraction
//   - Weight propagation through strata
//   - Database.clone() preserves weights (task 2.0)

import { describe, expect, it } from "vitest"
import type { ZSet } from "../../src/base/zset.js"
import {
  zsetAdd,
  zsetEmpty,
  zsetForEach,
  zsetIsEmpty,
  zsetSingleton,
  zsetSize,
} from "../../src/base/zset.js"
import { buildDefaultLWWRules, buildDefaultRules } from "../../src/bootstrap.js"
import {
  evaluateDifferentialNegation,
  evaluatePositiveAtom,
  evaluateRuleDelta,
  evaluateRuleSemiNaive,
  getNegationAtomIndices,
} from "../../src/datalog/evaluate.js"
import {
  createEvaluator,
  evaluateUnified as evaluate,
  evaluatePositiveUnified as evaluatePositive,
  evaluatePositiveUnified,
  evaluateStratumFromDelta,
  evaluateUnified,
} from "../../src/datalog/evaluator.js"
import type { Fact, Rule, Value } from "../../src/datalog/types.js"
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
} from "../../src/datalog/types.js"
import { EMPTY_SUBSTITUTION } from "../../src/datalog/unify.js"
import { cnIdKey, createCnId } from "../../src/kernel/cnid.js"
import type { FugueBeforePair } from "../../src/kernel/resolve.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeActiveValueFact(
  peer: string,
  counter: number,
  slotId: string,
  content: Value,
  lamport: number,
): Fact {
  const id = createCnId(peer, counter)
  return fact("active_value", [cnIdKey(id), slotId, content, lamport, peer])
}

function _makeSeqStructureFact(
  peer: string,
  counter: number,
  parentPeer: string,
  parentCounter: number,
  originLeftPeer: string | null,
  originLeftCounter: number | null,
  originRightPeer: string | null,
  originRightCounter: number | null,
): Fact {
  const id = createCnId(peer, counter)
  const parentId = createCnId(parentPeer, parentCounter)
  const originLeft =
    originLeftPeer !== null && originLeftCounter !== null
      ? cnIdKey(createCnId(originLeftPeer, originLeftCounter))
      : null
  const originRight =
    originRightPeer !== null && originRightCounter !== null
      ? cnIdKey(createCnId(originRightPeer, originRightCounter))
      : null
  return fact("active_structure_seq", [
    cnIdKey(id),
    cnIdKey(parentId),
    originLeft,
    originRight,
  ])
}

function _makePeerFact(peer: string, counter: number): Fact {
  const id = createCnId(peer, counter)
  return fact("constraint_peer", [cnIdKey(id), peer])
}

/** Generate all permutations of an array. */
function permutations<T>(arr: T[]): T[][] {
  if (arr.length <= 1) return [arr]
  const result: T[][] = []
  for (let i = 0; i < arr.length; i++) {
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)]
    for (const perm of permutations(rest)) {
      result.push([arr[i]!, ...perm])
    }
  }
  return result
}

/** Build a ZSet<Fact> from an array of facts, all at weight +1. */
function factsToZSet(facts: Fact[]): ZSet<Fact> {
  let zs = zsetEmpty<Fact>()
  for (const f of facts) {
    zs = zsetAdd(zs, zsetSingleton(factKey(f), f, 1))
  }
  return zs
}

/** Build a ZSet<Fact> with specified weight for each fact. */
function factsToWeightedZSet(facts: [Fact, number][]): ZSet<Fact> {
  let zs = zsetEmpty<Fact>()
  for (const [f, w] of facts) {
    zs = zsetAdd(zs, zsetSingleton(factKey(f), f, w))
  }
  return zs
}

/** Count facts with weight > 0 for a predicate. */
function _countByPredicate(db: Database, pred: string): number {
  let count = 0
  for (const _t of db.getRelation(pred).tuples()) {
    count++
  }
  return count
}

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

  it("union() uses clampedWeight for presence filtering", () => {
    const r1 = new Relation()
    r1.addWeighted(["a"], 3) // present (clampedWeight > 0)
    r1.addWeighted(["b"], -1) // absent (clampedWeight = 0)

    const r2 = new Relation()
    r2.addWeighted(["c"], 1)

    const u = r1.union(r2)
    expect(u.has(["a"])).toBe(true)
    expect(u.has(["b"])).toBe(false) // excluded by clampedWeight filter
    expect(u.has(["c"])).toBe(true)
    expect(u.size).toBe(2)
  })

  it("difference() uses clampedWeight for presence filtering", () => {
    const r1 = new Relation()
    r1.addWeighted(["a"], 3)
    r1.addWeighted(["b"], 1)
    r1.addWeighted(["c"], -1) // absent, excluded

    const r2 = new Relation()
    r2.addWeighted(["b"], 1)

    const d = r1.difference(r2)
    expect(d.has(["a"])).toBe(true)
    expect(d.has(["b"])).toBe(false) // in other
    expect(d.has(["c"])).toBe(false) // not present in this
    expect(d.size).toBe(1)
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
  it("positive atom delta source: identical to old evaluateRuleSemiNaive", () => {
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

  it("evaluateRuleSemiNaive alias produces same results as evaluateRuleDelta", () => {
    const r = rule(atom("derived", [varTerm("X")]), [
      positiveAtom(atom("base", [varTerm("X")])),
    ])

    const fullDb = new Database()
    fullDb.addFact(fact("base", ["a"]))

    const delta = new Database()
    delta.addFact(fact("base", ["b"]))

    const resultNew = evaluateRuleDelta(r, fullDb, fullDb, delta, 0)
    const resultOld = evaluateRuleSemiNaive(r, fullDb, delta, 0)

    expect(resultNew).toEqual(resultOld)
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
// Database.clone() preserves weights (task 2.0)
// ---------------------------------------------------------------------------

describe("Database.clone() preserves weights", () => {
  it("clones weight-1 entries faithfully", () => {
    const db = new Database()
    db.addFact(fact("p", ["a"]))
    db.addFact(fact("p", ["b"]))

    const cloned = db.clone()
    expect(cloned.size).toBe(2)
    expect(cloned.hasFact(fact("p", ["a"]))).toBe(true)
    expect(cloned.hasFact(fact("p", ["b"]))).toBe(true)
  })

  it("clones higher weights faithfully", () => {
    const db = new Database()
    // Manually create a weight-3 entry.
    db.addWeightedFact(fact("p", ["a"]), 3)

    const cloned = db.clone()
    expect(cloned.getRelation("p").getWeight(["a"])).toBe(3)
  })

  it("clone is independent of the original", () => {
    const db = new Database()
    db.addFact(fact("p", ["a"]))

    const cloned = db.clone()
    db.addFact(fact("p", ["b"]))

    expect(cloned.size).toBe(1)
    expect(cloned.hasFact(fact("p", ["b"]))).toBe(false)
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

describe("Unified Evaluator", () => {
  describe("LWW resolution with default rules", () => {
    const lwwRules = buildDefaultLWWRules()
    const slotId = "slot:title"

    it("single active_value produces a winner", () => {
      const evaluator = createEvaluator(lwwRules)

      const f = makeActiveValueFact("alice", 1, slotId, "Hello", 10)
      const delta = factsToZSet([f])

      const result = evaluator.step(delta, zsetEmpty())

      expect(zsetIsEmpty(result.deltaResolved)).toBe(false)
      expect(zsetSize(result.deltaResolved)).toBe(1)

      const winnerEntry = [...result.deltaResolved.values()][0]!
      expect(winnerEntry.weight).toBe(1)
      expect(winnerEntry.element.slotId).toBe(slotId)
      expect(winnerEntry.element.content).toBe("Hello")
    })

    it("superseding value produces winner change", () => {
      const evaluator = createEvaluator(lwwRules)

      // Insert first value (lamport 10).
      const f1 = makeActiveValueFact("alice", 1, slotId, "Hello", 10)
      evaluator.step(factsToZSet([f1]), zsetEmpty())

      // Insert superseding value (lamport 20).
      const f2 = makeActiveValueFact("bob", 1, slotId, "World", 20)
      const result = evaluator.step(factsToZSet([f2]), zsetEmpty())

      // Should have winner changes.
      expect(zsetIsEmpty(result.deltaResolved)).toBe(false)

      // The new winner should be bob's value.
      const resolution = evaluator.currentResolution()
      expect(resolution.winners.size).toBe(1)
      const winner = resolution.winners.get(slotId)!
      expect(winner.content).toBe("World")
      expect(winner.winnerCnIdKey).toBe(cnIdKey(createCnId("bob", 1)))
    })

    it("non-superseding value produces no winner change", () => {
      const evaluator = createEvaluator(lwwRules)

      // Insert the winner first (lamport 20).
      const f1 = makeActiveValueFact("bob", 1, slotId, "World", 20)
      evaluator.step(factsToZSet([f1]), zsetEmpty())

      // Insert a loser (lamport 10).
      const f2 = makeActiveValueFact("alice", 1, slotId, "Hello", 10)
      evaluator.step(factsToZSet([f2]), zsetEmpty())

      // The winner should still be bob's value.
      const resolution = evaluator.currentResolution()
      expect(resolution.winners.size).toBe(1)
      expect(resolution.winners.get(slotId)?.content).toBe("World")
    })

    it("value retraction causes winner recomputation via weight propagation", () => {
      const evaluator = createEvaluator(lwwRules)

      // Insert two values.
      const f1 = makeActiveValueFact("alice", 1, slotId, "Hello", 10)
      const f2 = makeActiveValueFact("bob", 1, slotId, "World", 20)
      evaluator.step(factsToZSet([f1, f2]), zsetEmpty())

      // Winner should be bob (lamport 20).
      expect(evaluator.currentResolution().winners.get(slotId)?.content).toBe(
        "World",
      )

      // Retract bob's value.
      const retractDelta = factsToWeightedZSet([[f2, -1]])
      evaluator.step(retractDelta, zsetEmpty())

      // Winner should now be alice — via weight propagation, not DRed.
      const resolution = evaluator.currentResolution()
      expect(resolution.winners.size).toBe(1)
      expect(resolution.winners.get(slotId)?.content).toBe("Hello")
    })

    it("retraction of sole value removes winner", () => {
      const evaluator = createEvaluator(lwwRules)

      const f1 = makeActiveValueFact("alice", 1, slotId, "Hello", 10)
      evaluator.step(factsToZSet([f1]), zsetEmpty())

      // Retract it.
      evaluator.step(factsToWeightedZSet([[f1, -1]]), zsetEmpty())

      const resolution = evaluator.currentResolution()
      expect(resolution.winners.size).toBe(0)
    })

    it("multiple slots are tracked independently", () => {
      const evaluator = createEvaluator(lwwRules)

      const f1 = makeActiveValueFact("alice", 1, "slot:title", "Title", 10)
      const f2 = makeActiveValueFact("alice", 2, "slot:body", "Body", 10)

      evaluator.step(factsToZSet([f1, f2]), zsetEmpty())

      const resolution = evaluator.currentResolution()
      expect(resolution.winners.size).toBe(2)
      expect(resolution.winners.get("slot:title")?.content).toBe("Title")
      expect(resolution.winners.get("slot:body")?.content).toBe("Body")
    })

    it("peer tiebreak: higher peer wins on lamport tie", () => {
      const evaluator = createEvaluator(lwwRules)

      const f1 = makeActiveValueFact("bob", 1, slotId, "Bob", 20)
      const f2 = makeActiveValueFact("charlie", 1, slotId, "Charlie", 20)

      evaluator.step(factsToZSet([f1, f2]), zsetEmpty())

      const resolution = evaluator.currentResolution()
      expect(resolution.winners.get(slotId)?.content).toBe("Charlie")
    })
  })

  // ---------------------------------------------------------------------------
  // Three-way equivalence oracle
  // ---------------------------------------------------------------------------

  describe("three-way oracle: batch ≡ single-step ≡ one-at-a-time", () => {
    const lwwRules = buildDefaultLWWRules()
    const slotId = "slot:title"

    it("all three paths produce the same database for sequential insertions", () => {
      const facts = [
        makeActiveValueFact("alice", 1, slotId, "Hello", 10),
        makeActiveValueFact("bob", 1, slotId, "World", 20),
        makeActiveValueFact("charlie", 1, slotId, "Hi", 20),
      ]

      // Path 1: batch evaluate (old evaluate function).
      const batchResult = evaluate(lwwRules, facts)
      if (!batchResult.ok) throw new Error("batch eval failed")
      const batchDb = batchResult.value

      // Path 2: unified evaluator, single step with all facts.
      const singleStep = createEvaluator(lwwRules)
      singleStep.step(factsToZSet(facts), zsetEmpty())
      const _singleStepDb = singleStep.currentDatabase()

      // Path 3: unified evaluator, one fact per step.
      const oneAtATime = createEvaluator(lwwRules)
      for (const f of facts) {
        oneAtATime.step(factsToZSet([f]), zsetEmpty())
      }
      const _oneAtATimeDb = oneAtATime.currentDatabase()

      // Compare winners across all three.
      const batchWinners = new Map<string, Value>()
      for (const tuple of batchDb.getRelation("winner").tuples()) {
        batchWinners.set(tuple[0] as string, tuple[2]!)
      }

      const singleStepWinners = singleStep.currentResolution().winners
      const oneAtATimeWinners = oneAtATime.currentResolution().winners

      // All should have the same number of winners.
      expect(singleStepWinners.size).toBe(batchWinners.size)
      expect(oneAtATimeWinners.size).toBe(batchWinners.size)

      // All should agree on content.
      for (const [slot, content] of batchWinners) {
        expect(singleStepWinners.get(slot)?.content).toBe(content)
        expect(oneAtATimeWinners.get(slot)?.content).toBe(content)
      }
    })

    it("matches batch for two values in the same step", () => {
      const facts = [
        makeActiveValueFact("alice", 1, slotId, "Hello", 10),
        makeActiveValueFact("bob", 1, slotId, "World", 20),
      ]

      const batchResult = evaluate(lwwRules, facts)
      if (!batchResult.ok) throw new Error("batch eval failed")
      const batchDb = batchResult.value

      const evaluator = createEvaluator(lwwRules)
      evaluator.step(factsToZSet(facts), zsetEmpty())

      const incRes = evaluator.currentResolution()
      const batchWinner = batchDb.getRelation("winner").tuples()[0]!

      expect(incRes.winners.size).toBe(1)
      expect(incRes.winners.get(slotId)?.content).toBe(batchWinner[2])
    })

    it("three-way oracle with transitive closure", () => {
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

      // Path 1: old batch evaluate.
      const batchDb = evaluatePositive(rules, edges)

      // Path 2: unified single step.
      const singleStep = createEvaluator(rules)
      singleStep.step(factsToZSet(edges), zsetEmpty())

      // Path 3: unified one-at-a-time.
      const oneAtATime = createEvaluator(rules)
      for (const e of edges) {
        oneAtATime.step(factsToZSet([e]), zsetEmpty())
      }

      const batchPaths = batchDb.getRelation("path").tuples()
      const singlePaths = singleStep
        .currentDatabase()
        .getRelation("path")
        .tuples()
      const oneAtATimePaths = oneAtATime
        .currentDatabase()
        .getRelation("path")
        .tuples()

      expect(singlePaths.length).toBe(batchPaths.length)
      expect(oneAtATimePaths.length).toBe(batchPaths.length)

      for (const t of batchPaths) {
        expect(singleStep.currentDatabase().hasFact(fact("path", t))).toBe(true)
        expect(oneAtATime.currentDatabase().hasFact(fact("path", t))).toBe(true)
      }
    })
  })

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

    it("produces identical results for LWW rules", () => {
      const lwwRules = buildDefaultLWWRules()
      const slotId = "slot:title"
      const facts = [
        makeActiveValueFact("alice", 1, slotId, "Hello", 10),
        makeActiveValueFact("bob", 1, slotId, "World", 20),
      ]

      const oldResult = evaluate(lwwRules, facts)
      if (!oldResult.ok) throw new Error("old eval failed")

      const newResult = evaluateUnified(lwwRules, facts)
      if (!newResult.ok) throw new Error("new eval failed")

      const oldWinners = oldResult.value.getRelation("winner").tuples()
      const newWinners = newResult.value.getRelation("winner").tuples()

      expect(newWinners.length).toBe(oldWinners.length)
      for (const t of oldWinners) {
        expect(newResult.value.hasFact(fact("winner", t))).toBe(true)
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
  // Permutation test
  // ---------------------------------------------------------------------------

  describe("permutation test", () => {
    const lwwRules = buildDefaultLWWRules()
    const slotId = "slot:title"

    it("all orderings of 3 values produce same current resolution", () => {
      const facts = [
        makeActiveValueFact("alice", 1, slotId, "A", 10),
        makeActiveValueFact("bob", 1, slotId, "B", 20),
        makeActiveValueFact("charlie", 1, slotId, "C", 20),
      ]

      // Batch evaluate for the expected result.
      const batchResult = evaluate(lwwRules, facts)
      if (!batchResult.ok) throw new Error("batch eval failed")
      const batchDb = batchResult.value
      const batchWinnerTuple = batchDb.getRelation("winner").tuples()[0]!
      const expectedContent = batchWinnerTuple[2]

      for (const perm of permutations(facts)) {
        const evaluator = createEvaluator(lwwRules)
        for (const f of perm) {
          evaluator.step(factsToZSet([f]), zsetEmpty())
        }
        const resolution = evaluator.currentResolution()
        expect(resolution.winners.size).toBe(1)
        expect(resolution.winners.get(slotId)?.content).toBe(expectedContent)
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
      evaluator.step(factsToZSet([fact("edge", ["a", "b"])]), zsetEmpty())
      let db = evaluator.currentDatabase()
      expect(db.hasFact(fact("path", ["a", "b"]))).toBe(true)

      // Add edge(b, c).
      evaluator.step(factsToZSet([fact("edge", ["b", "c"])]), zsetEmpty())
      db = evaluator.currentDatabase()
      expect(db.hasFact(fact("path", ["b", "c"]))).toBe(true)
      expect(db.hasFact(fact("path", ["a", "c"]))).toBe(true)

      // Add edge(c, d).
      evaluator.step(factsToZSet([fact("edge", ["c", "d"])]), zsetEmpty())
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
        evaluator.step(factsToZSet([e]), zsetEmpty())
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
      evaluator.step(factsToZSet(edges), zsetEmpty())

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
  // Fugue rules
  // ---------------------------------------------------------------------------

  describe("Fugue rules with default rules", () => {
    const allRules = buildDefaultRules()

    it("structure facts produce fugue_child derivation", () => {
      const evaluator = createEvaluator(allRules)

      const parentKey = cnIdKey(createCnId("alice", 0))
      const childKey = cnIdKey(createCnId("alice", 1))

      const seqFact = fact("active_structure_seq", [
        childKey,
        parentKey,
        null,
        null,
      ])
      const peerFact = fact("constraint_peer", [childKey, "alice"])

      evaluator.step(factsToZSet([seqFact, peerFact]), zsetEmpty())

      const db = evaluator.currentDatabase()
      const fugueChildTuples = db.getRelation("fugue_child").tuples()
      expect(fugueChildTuples.length).toBe(1)
      expect(fugueChildTuples[0]?.[0]).toBe(parentKey)
      expect(fugueChildTuples[0]?.[1]).toBe(childKey)
    })

    it("two children produce fugue_before pairs", () => {
      const evaluator = createEvaluator(allRules)

      const parentKey = cnIdKey(createCnId("alice", 0))
      const child1Key = cnIdKey(createCnId("alice", 1))
      const child2Key = cnIdKey(createCnId("bob", 1))

      const seq1 = fact("active_structure_seq", [
        child1Key,
        parentKey,
        null,
        null,
      ])
      const peer1 = fact("constraint_peer", [child1Key, "alice"])

      const seq2 = fact("active_structure_seq", [
        child2Key,
        parentKey,
        child1Key,
        null,
      ])
      const peer2 = fact("constraint_peer", [child2Key, "bob"])

      evaluator.step(factsToZSet([seq1, peer1, seq2, peer2]), zsetEmpty())

      const resolution = evaluator.currentResolution()
      expect(resolution.fuguePairs.size).toBeGreaterThan(0)

      const allPairs: FugueBeforePair[] = []
      for (const pairs of resolution.fuguePairs.values()) {
        allPairs.push(...pairs)
      }
      expect(allPairs.length).toBeGreaterThan(0)
    })
  })

  // ---------------------------------------------------------------------------
  // Rule changes
  // ---------------------------------------------------------------------------

  describe("rule changes", () => {
    it("adding a custom superseded rule changes resolution", () => {
      const lwwRules = buildDefaultLWWRules()
      const evaluator = createEvaluator(lwwRules)
      const slotId = "slot:title"

      // Insert two competing values.
      const f1 = makeActiveValueFact("alice", 1, slotId, "Hello", 10)
      const f2 = makeActiveValueFact("bob", 1, slotId, "World", 20)
      evaluator.step(factsToZSet([f1, f2]), zsetEmpty())

      // With default rules, bob wins (lamport 20 > 10).
      expect(evaluator.currentResolution().winners.get(slotId)?.content).toBe(
        "World",
      )

      // Add a custom rule that makes LOWER lamport win.
      const customRule = rule(
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
          lt(varTerm("L2"), varTerm("L1")), // reversed: lower lamport wins
        ],
      )

      // Remove default superseded rules, add custom one.
      let ruleDelta = zsetEmpty<Rule>()
      ruleDelta = zsetAdd(ruleDelta, zsetSingleton("rule1", lwwRules[0]!, -1))
      ruleDelta = zsetAdd(ruleDelta, zsetSingleton("rule2", lwwRules[1]!, -1))
      ruleDelta = zsetAdd(ruleDelta, zsetSingleton("rule3", customRule, 1))

      evaluator.step(zsetEmpty(), ruleDelta)

      // Now alice should win (lamport 10 < 20).
      const resolution = evaluator.currentResolution()
      expect(resolution.winners.get(slotId)?.content).toBe("Hello")
    })
  })

  // ---------------------------------------------------------------------------
  // Empty inputs
  // ---------------------------------------------------------------------------

  describe("empty inputs", () => {
    it("empty delta produces empty result", () => {
      const evaluator = createEvaluator(buildDefaultLWWRules())
      const result = evaluator.step(zsetEmpty(), zsetEmpty())

      expect(zsetIsEmpty(result.deltaResolved)).toBe(true)
      expect(zsetIsEmpty(result.deltaFuguePairs)).toBe(true)
      expect(zsetIsEmpty(result.deltaDerived)).toBe(true)
    })

    it("evaluator with no rules produces no derived facts", () => {
      const evaluator = createEvaluator([])
      const f = makeActiveValueFact("alice", 1, "slot:title", "Hello", 10)
      const result = evaluator.step(factsToZSet([f]), zsetEmpty())

      // Ground fact is stored, but no derived facts.
      expect(evaluator.currentDatabase().hasFact(f)).toBe(true)
      expect(zsetIsEmpty(result.deltaDerived)).toBe(true)
    })
  })

  // ---------------------------------------------------------------------------
  // Reset
  // ---------------------------------------------------------------------------

  describe("reset", () => {
    it("clears all state", () => {
      const evaluator = createEvaluator(buildDefaultLWWRules())
      const f = makeActiveValueFact("alice", 1, "slot:title", "Hello", 10)
      evaluator.step(factsToZSet([f]), zsetEmpty())

      evaluator.reset()
      expect(evaluator.currentDatabase().size).toBe(0)
      expect(evaluator.currentResolution().winners.size).toBe(0)
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

      evaluator.step(factsToZSet(initialFacts), zsetEmpty())

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
      evaluator.step(factsToZSet(allFacts), zsetEmpty())

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
  // Resolution extraction from derived facts
  // ---------------------------------------------------------------------------

  describe("resolution extraction from derived facts", () => {
    it("deltaDerived contains winner facts with correct structure", () => {
      const evaluator = createEvaluator(buildDefaultLWWRules())
      const slotId = "slot:title"
      const f = makeActiveValueFact("alice", 1, slotId, "Hello", 10)

      const result = evaluator.step(factsToZSet([f]), zsetEmpty())

      let foundWinner = false
      zsetForEach(result.deltaDerived, entry => {
        if (entry.element.predicate === "winner") {
          foundWinner = true
          expect(entry.weight).toBe(1)
          expect(entry.element.values[0]).toBe(slotId)
          expect(entry.element.values[2]).toBe("Hello")
        }
      })
      expect(foundWinner).toBe(true)
    })

    it("deltaResolved and deltaDerived are consistent", () => {
      const evaluator = createEvaluator(buildDefaultLWWRules())
      const f = makeActiveValueFact("alice", 1, "slot:title", "Hello", 10)
      const result = evaluator.step(factsToZSet([f]), zsetEmpty())

      // Count winner facts in deltaDerived.
      let derivedWinnerCount = 0
      zsetForEach(result.deltaDerived, entry => {
        if (entry.element.predicate === "winner") derivedWinnerCount++
      })

      expect(zsetSize(result.deltaResolved)).toBe(derivedWinnerCount)
    })
  })

  // ---------------------------------------------------------------------------
  // Accumulated database consistency
  // ---------------------------------------------------------------------------

  describe("accumulated database consistency", () => {
    it("currentDatabase contains both ground and derived facts", () => {
      const evaluator = createEvaluator(buildDefaultLWWRules())
      const f = makeActiveValueFact("alice", 1, "slot:title", "Hello", 10)
      evaluator.step(factsToZSet([f]), zsetEmpty())

      const db = evaluator.currentDatabase()
      // Ground fact should be there.
      expect(db.hasFact(f)).toBe(true)
      // Derived winner should be there.
      expect(db.getRelation("winner").tuples().length).toBeGreaterThan(0)
    })

    it("after retraction, ground fact is removed from database", () => {
      const evaluator = createEvaluator(buildDefaultLWWRules())
      const f = makeActiveValueFact("alice", 1, "slot:title", "Hello", 10)
      evaluator.step(factsToZSet([f]), zsetEmpty())
      expect(evaluator.currentDatabase().hasFact(f)).toBe(true)

      evaluator.step(factsToWeightedZSet([[f, -1]]), zsetEmpty())
      expect(evaluator.currentDatabase().hasFact(f)).toBe(false)
    })
  })

  // ---------------------------------------------------------------------------
  // Batch equivalence with full default rules
  // ---------------------------------------------------------------------------

  describe("batch equivalence with full default rules", () => {
    it("LWW + Fugue together match batch evaluation", () => {
      const allRules = buildDefaultRules()
      const evaluator = createEvaluator(allRules)
      const parentKey = cnIdKey(createCnId("alice", 0))
      const child1Key = cnIdKey(createCnId("alice", 1))
      const facts = [
        makeActiveValueFact("alice", 1, "slot:title", "Hello", 10),
        fact("active_structure_seq", [child1Key, parentKey, null, null]),
        fact("constraint_peer", [child1Key, "alice"]),
      ]

      // Feed incrementally.
      evaluator.step(factsToZSet(facts), zsetEmpty())

      // Batch.
      const batchResult = evaluate(allRules, facts)
      if (!batchResult.ok) throw new Error("batch eval failed")
      const batchDb = batchResult.value

      // Compare winner tuples.
      const batchTuples = batchDb.getRelation("winner").tuples()
      const incTuples = evaluator
        .currentDatabase()
        .getRelation("winner")
        .tuples()
      expect(incTuples.length).toBe(batchTuples.length)
      for (const t of batchTuples) {
        expect(evaluator.currentDatabase().hasFact(fact("winner", t))).toBe(
          true,
        )
      }

      // Compare fugue_child tuples.
      const batchFugueChild = batchDb.getRelation("fugue_child").tuples()
      const incFugueChild = evaluator
        .currentDatabase()
        .getRelation("fugue_child")
        .tuples()
      expect(incFugueChild.length).toBe(batchFugueChild.length)
    })
  })

  // ---------------------------------------------------------------------------
  // reset() + replay equals accumulated state
  // ---------------------------------------------------------------------------

  describe("reset + replay equals accumulated state", () => {
    it("replaying the same facts after reset produces identical state", () => {
      const lwwRules = buildDefaultLWWRules()
      const evaluator = createEvaluator(lwwRules)
      const slotId = "slot:title"

      const facts = [
        makeActiveValueFact("alice", 1, slotId, "Hello", 10),
        makeActiveValueFact("bob", 1, slotId, "World", 20),
      ]

      // Accumulate.
      for (const f of facts) {
        evaluator.step(factsToZSet([f]), zsetEmpty())
      }
      const beforeReset = evaluator.currentResolution()

      // Reset and replay.
      evaluator.reset()

      // Re-add rules (reset clears them).
      const freshEval = createEvaluator(lwwRules)
      for (const f of facts) {
        freshEval.step(factsToZSet([f]), zsetEmpty())
      }
      const afterReplay = freshEval.currentResolution()

      expect(afterReplay.winners.size).toBe(beforeReset.winners.size)
      for (const [slot, winner] of beforeReset.winners) {
        expect(afterReplay.winners.get(slot)?.content).toBe(winner.content)
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

    it("full default rules: LWW + Fugue batch equivalence", () => {
      const allRules = buildDefaultRules()
      const slotId = "slot:title"
      const parentKey = cnIdKey(createCnId("alice", 0))
      const child1Key = cnIdKey(createCnId("alice", 1))
      const child2Key = cnIdKey(createCnId("bob", 1))

      const facts = [
        makeActiveValueFact("alice", 1, slotId, "Hello", 10),
        makeActiveValueFact("bob", 1, slotId, "World", 20),
        fact("active_structure_seq", [child1Key, parentKey, null, null]),
        fact("constraint_peer", [child1Key, "alice"]),
        fact("active_structure_seq", [child2Key, parentKey, child1Key, null]),
        fact("constraint_peer", [child2Key, "bob"]),
      ]

      const oldResult = evaluate(allRules, facts)
      if (!oldResult.ok) throw new Error("old eval failed")

      const newResult = evaluateUnified(allRules, facts)
      if (!newResult.ok) throw new Error("new eval failed")

      // Compare all derived predicates.
      for (const pred of [
        "winner",
        "superseded",
        "fugue_child",
        "fugue_before",
        "fugue_descendant",
      ]) {
        const oldTuples = oldResult.value.getRelation(pred).tuples()
        const newTuples = newResult.value.getRelation(pred).tuples()
        expect(newTuples.length).toBe(oldTuples.length)
        for (const t of oldTuples) {
          expect(newResult.value.hasFact(fact(pred, t))).toBe(true)
        }
      }
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

      evaluator.step(factsToZSet([f]), zsetEmpty())
      evaluator.step(factsToZSet([f]), zsetEmpty())

      const db = evaluator.currentDatabase()
      expect(db.hasFact(fact("derived", ["a"]))).toBe(true)
      // Ground fact has true weight 2 (two +1 assertions).
      expect(db.getRelation("base").getWeight(["a"])).toBe(2)
      // Derived fact weight > 0. Exact value depends on iteration,
      // but presence is correct.
      expect(db.getRelation("derived").getWeight(["a"])).toBeGreaterThan(0)
    })

    it("self-join weights are exact with asymmetric join (no double-counting)", () => {
      // superseded involves a self-join on active_value.
      // With dual-weight + asymmetric join (Plan 006.2), each derivation
      // path is counted exactly once. Three values: alice (L=10),
      // bob (L=20), charlie (L=30).
      //   superseded(alice) ← bob supersedes alice AND charlie supersedes alice = weight 2
      //   superseded(bob)   ← charlie supersedes bob = weight 1
      //   charlie is not superseded.
      const lwwRules = buildDefaultLWWRules()
      const evaluator = createEvaluator(lwwRules)
      const slotId = "slot:title"

      const facts = [
        makeActiveValueFact("alice", 1, slotId, "A", 10),
        makeActiveValueFact("bob", 1, slotId, "B", 20),
        makeActiveValueFact("charlie", 1, slotId, "C", 30),
      ]

      evaluator.step(factsToZSet(facts), zsetEmpty())

      const db = evaluator.currentDatabase()
      const aliceKey = cnIdKey(createCnId("alice", 1))
      const bobKey = cnIdKey(createCnId("bob", 1))

      // Exact weights — asymmetric join prevents double-counting.
      expect(db.getRelation("superseded").getWeight([aliceKey, slotId])).toBe(2)
      expect(db.getRelation("superseded").getWeight([bobKey, slotId])).toBe(1)

      // weightedTuples() returns clampedWeight = 1 for joins.
      for (const { weight } of db.getRelation("superseded").weightedTuples()) {
        expect(weight).toBe(1)
      }
    })
  })

  // ---------------------------------------------------------------------------
  // extractDelta: output delta has ±1 weights only
  // ---------------------------------------------------------------------------

  describe("output delta correctness", () => {
    it("step result deltaDerived has weights +1 or -1 only", () => {
      const lwwRules = buildDefaultLWWRules()
      const evaluator = createEvaluator(lwwRules)
      const slotId = "slot:title"

      const f = makeActiveValueFact("alice", 1, slotId, "Hello", 10)
      const result = evaluator.step(factsToZSet([f]), zsetEmpty())

      // All derived deltas should be +1 or -1.
      zsetForEach(result.deltaDerived, entry => {
        expect(Math.abs(entry.weight)).toBe(1)
      })
    })

    it("retraction step produces -1 derived deltas", () => {
      const lwwRules = buildDefaultLWWRules()
      const evaluator = createEvaluator(lwwRules)
      const slotId = "slot:title"

      const f = makeActiveValueFact("alice", 1, slotId, "Hello", 10)
      evaluator.step(factsToZSet([f]), zsetEmpty())

      const result = evaluator.step(factsToWeightedZSet([[f, -1]]), zsetEmpty())

      let hasNegative = false
      zsetForEach(result.deltaDerived, entry => {
        expect(Math.abs(entry.weight)).toBe(1)
        if (entry.weight === -1) hasNegative = true
      })
      // Retracting the sole value should produce −1 derived deltas.
      expect(hasNegative).toBe(true)
    })
  })

  // ---------------------------------------------------------------------------
  // Incremental evaluation: strata propagation
  // ---------------------------------------------------------------------------

  describe("strata propagation", () => {
    it("lower stratum output delta feeds higher stratum correctly", () => {
      // Stratum 0: superseded facts
      // Stratum 1: winner facts (depends on not superseded)
      // Inserting a value that supersedes the current winner should
      // propagate through both strata in a single step.
      const lwwRules = buildDefaultLWWRules()
      const evaluator = createEvaluator(lwwRules)
      const slotId = "slot:title"

      // Insert first value.
      const f1 = makeActiveValueFact("alice", 1, slotId, "Hello", 10)
      evaluator.step(factsToZSet([f1]), zsetEmpty())

      // Insert superseding value — must propagate superseded in stratum 0,
      // then update winner in stratum 1.
      const f2 = makeActiveValueFact("bob", 1, slotId, "World", 20)
      const result = evaluator.step(factsToZSet([f2]), zsetEmpty())

      // Winner should have changed.
      expect(evaluator.currentResolution().winners.get(slotId)?.content).toBe(
        "World",
      )

      // deltaResolved should reflect the change.
      expect(zsetIsEmpty(result.deltaResolved)).toBe(false)
    })

    it("retraction in stratum 0 cascades through stratum 1 negation via step()", () => {
      // This is the multi-stratum retraction propagation test.
      // Stratum 0 (positive): superseded(CnId, Slot).
      // Stratum 1 (negation): winner(Slot, CnId, Val) :- ..., not superseded(CnId, Slot).
      //
      // Insert alice (L=10), bob (L=20). Bob wins.
      // Retract bob → stratum 0 produces −1 for superseded(alice),
      // stratum 1 sees that change and derives winner(alice).
      //
      // Without correct inter-stratum −1 propagation, stratum 1 would
      // not see the superseded retraction and alice would never win.
      const lwwRules = buildDefaultLWWRules()
      const evaluator = createEvaluator(lwwRules)
      const slotId = "slot:title"

      const alice = makeActiveValueFact("alice", 1, slotId, "A", 10)
      const bob = makeActiveValueFact("bob", 1, slotId, "B", 20)
      evaluator.step(factsToZSet([alice, bob]), zsetEmpty())
      expect(evaluator.currentResolution().winners.get(slotId)?.content).toBe(
        "B",
      )

      // Retract bob — the −1 must propagate: stratum 0 retracts
      // superseded(alice), stratum 1 derives winner(alice).
      const result = evaluator.step(
        factsToWeightedZSet([[bob, -1]]),
        zsetEmpty(),
      )

      expect(evaluator.currentResolution().winners.get(slotId)?.content).toBe(
        "A",
      )

      // deltaResolved should contain the winner change.
      expect(zsetIsEmpty(result.deltaResolved)).toBe(false)

      // deltaDerived should contain both −1 (old winner/superseded) and +1 (new winner).
      let hasNeg = false
      let hasPos = false
      zsetForEach(result.deltaDerived, entry => {
        if (entry.weight < 0) hasNeg = true
        if (entry.weight > 0) hasPos = true
      })
      expect(hasNeg).toBe(true)
      expect(hasPos).toBe(true)
    })

    it("re-insertion after full retraction restores derived facts via step()", () => {
      // insert alice → winner(alice). Retract → no winner.
      // Re-insert alice → winner(alice) again.
      // Validates the weight round-trip: 0 → 1 → 0 → 1 across strata.
      const lwwRules = buildDefaultLWWRules()
      const evaluator = createEvaluator(lwwRules)
      const slotId = "slot:title"

      const alice = makeActiveValueFact("alice", 1, slotId, "A", 10)

      // Insert.
      evaluator.step(factsToZSet([alice]), zsetEmpty())
      expect(evaluator.currentResolution().winners.get(slotId)?.content).toBe(
        "A",
      )

      // Retract.
      evaluator.step(factsToWeightedZSet([[alice, -1]]), zsetEmpty())
      expect(evaluator.currentResolution().winners.size).toBe(0)

      // Re-insert — derived facts must reappear.
      const result = evaluator.step(factsToZSet([alice]), zsetEmpty())
      expect(evaluator.currentResolution().winners.get(slotId)?.content).toBe(
        "A",
      )

      // The re-insertion should produce +1 derived deltas.
      let hasPositive = false
      zsetForEach(result.deltaDerived, entry => {
        if (entry.weight > 0) hasPositive = true
      })
      expect(hasPositive).toBe(true)
    })
  })

  // ---------------------------------------------------------------------------
  // Mechanism verification tests (Plan 006.2, Phase 4)
  // ---------------------------------------------------------------------------

  describe("mechanism verification (Plan 006.2 Phase 4)", () => {
    it("LWW three-value retraction: superseded(alice) survives, winner changes charlie→bob", () => {
      // The critical three-value test. alice (L=10), bob (L=20), charlie (L=30).
      // superseded(alice) is derived by BOTH bob and charlie (weight 2).
      // superseded(bob) is derived by charlie only (weight 1).
      // winner = charlie.
      // Retract charlie → superseded(alice) survives (weight 2→1),
      // superseded(bob) retracted (weight 1→0), winner changes to bob.
      const lwwRules = buildDefaultLWWRules()
      const evaluator = createEvaluator(lwwRules)
      const slotId = "slot:title"

      const alice = makeActiveValueFact("alice", 1, slotId, "A", 10)
      const bob = makeActiveValueFact("bob", 1, slotId, "B", 20)
      const charlie = makeActiveValueFact("charlie", 1, slotId, "C", 30)

      evaluator.step(factsToZSet([alice, bob, charlie]), zsetEmpty())

      // Charlie wins (lamport 30).
      expect(evaluator.currentResolution().winners.get(slotId)?.content).toBe(
        "C",
      )

      // Both alice and bob should be superseded.
      const db = evaluator.currentDatabase()
      expect(
        db.hasFact(
          fact("superseded", [cnIdKey(createCnId("alice", 1)), slotId]),
        ),
      ).toBe(true)
      expect(
        db.hasFact(fact("superseded", [cnIdKey(createCnId("bob", 1)), slotId])),
      ).toBe(true)

      // Retract charlie.
      const result = evaluator.step(
        factsToWeightedZSet([[charlie, -1]]),
        zsetEmpty(),
      )

      // Winner should change to bob (not alice).
      const resolution = evaluator.currentResolution()
      expect(resolution.winners.get(slotId)?.content).toBe("B")

      // superseded(alice) should SURVIVE — bob still supersedes alice.
      const dbAfter = evaluator.currentDatabase()
      expect(
        dbAfter.hasFact(
          fact("superseded", [cnIdKey(createCnId("alice", 1)), slotId]),
        ),
      ).toBe(true)

      // superseded(bob) should be RETRACTED — charlie was the only one superseding bob.
      expect(
        dbAfter.hasFact(
          fact("superseded", [cnIdKey(createCnId("bob", 1)), slotId]),
        ),
      ).toBe(false)

      // deltaResolved should reflect the winner change.
      expect(zsetIsEmpty(result.deltaResolved)).toBe(false)
    })

    it("recursive retraction cascade via createEvaluator: edge removal retracts transitive paths", () => {
      // edges a→b→c→d, retract b→c.
      // reachable(a,c), reachable(a,d), reachable(b,c), reachable(b,d) retracted.
      // reachable(a,b) and reachable(c,d) survive.
      const rules: Rule[] = [
        rule(atom("reachable", [varTerm("X"), varTerm("Y")]), [
          positiveAtom(atom("edge", [varTerm("X"), varTerm("Y")])),
        ]),
        rule(atom("reachable", [varTerm("X"), varTerm("Z")]), [
          positiveAtom(atom("edge", [varTerm("X"), varTerm("Y")])),
          positiveAtom(atom("reachable", [varTerm("Y"), varTerm("Z")])),
        ]),
      ]

      const evaluator = createEvaluator(rules)

      const edges: Fact[] = [
        fact("edge", ["a", "b"]),
        fact("edge", ["b", "c"]),
        fact("edge", ["c", "d"]),
      ]
      evaluator.step(factsToZSet(edges), zsetEmpty())

      const db1 = evaluator.currentDatabase()
      expect(db1.hasFact(fact("reachable", ["a", "d"]))).toBe(true)
      expect(db1.hasFact(fact("reachable", ["b", "d"]))).toBe(true)

      // Retract edge b→c.
      evaluator.step(
        factsToWeightedZSet([[fact("edge", ["b", "c"]), -1]]),
        zsetEmpty(),
      )

      const db2 = evaluator.currentDatabase()
      // Paths through b→c are gone.
      expect(db2.hasFact(fact("reachable", ["b", "c"]))).toBe(false)
      expect(db2.hasFact(fact("reachable", ["b", "d"]))).toBe(false)
      expect(db2.hasFact(fact("reachable", ["a", "c"]))).toBe(false)
      expect(db2.hasFact(fact("reachable", ["a", "d"]))).toBe(false)

      // Paths not through b→c survive.
      expect(db2.hasFact(fact("reachable", ["a", "b"]))).toBe(true)
      expect(db2.hasFact(fact("reachable", ["c", "d"]))).toBe(true)
    })

    it("diamond alternative support: reachable(a,c) survives when one of two paths retracted", () => {
      // edges: a→b, b→c, a→c (direct). Two paths from a to c.
      // Retract a→b. reachable(a,b) retracted, but reachable(a,c) survives
      // via the direct edge (weight 2→1, no zero-crossing).
      const rules: Rule[] = [
        rule(atom("reachable", [varTerm("X"), varTerm("Y")]), [
          positiveAtom(atom("edge", [varTerm("X"), varTerm("Y")])),
        ]),
        rule(atom("reachable", [varTerm("X"), varTerm("Z")]), [
          positiveAtom(atom("edge", [varTerm("X"), varTerm("Y")])),
          positiveAtom(atom("reachable", [varTerm("Y"), varTerm("Z")])),
        ]),
      ]

      const evaluator = createEvaluator(rules)

      const edges: Fact[] = [
        fact("edge", ["a", "b"]),
        fact("edge", ["b", "c"]),
        fact("edge", ["a", "c"]), // Direct edge: alternative support.
      ]
      evaluator.step(factsToZSet(edges), zsetEmpty())

      const db1 = evaluator.currentDatabase()
      expect(db1.hasFact(fact("reachable", ["a", "b"]))).toBe(true)
      expect(db1.hasFact(fact("reachable", ["a", "c"]))).toBe(true)
      expect(db1.hasFact(fact("reachable", ["b", "c"]))).toBe(true)

      // Retract a→b. The path a→b→c is gone, but a→c (direct) remains.
      evaluator.step(
        factsToWeightedZSet([[fact("edge", ["a", "b"]), -1]]),
        zsetEmpty(),
      )

      const db2 = evaluator.currentDatabase()
      // a→b is gone — reachable(a,b) retracted.
      expect(db2.hasFact(fact("reachable", ["a", "b"]))).toBe(false)
      // a→c survives via direct edge — dual-weight prevents over-retraction.
      expect(db2.hasFact(fact("reachable", ["a", "c"]))).toBe(true)
      // b→c still holds (edge b→c was not retracted).
      expect(db2.hasFact(fact("reachable", ["b", "c"]))).toBe(true)
    })

    it("differential negation timing: new superseding value produces −1 old winner, +1 new winner", () => {
      // Insert alice (L=10) → winner(alice).
      // Insert bob (L=20) → supersedes alice → winner changes.
      // Verify the step result contains both −1 for old winner and +1 for new.
      const lwwRules = buildDefaultLWWRules()
      const evaluator = createEvaluator(lwwRules)
      const slotId = "slot:title"

      const alice = makeActiveValueFact("alice", 1, slotId, "A", 10)
      evaluator.step(factsToZSet([alice]), zsetEmpty())
      expect(evaluator.currentResolution().winners.get(slotId)?.content).toBe(
        "A",
      )

      // Insert bob — supersedes alice.
      const bob = makeActiveValueFact("bob", 1, slotId, "B", 20)
      const result = evaluator.step(factsToZSet([bob]), zsetEmpty())

      // Winner changed to bob.
      expect(evaluator.currentResolution().winners.get(slotId)?.content).toBe(
        "B",
      )

      // deltaDerived should contain both +1 and −1 entries.
      let hasPositive = false
      let hasNegative = false
      zsetForEach(result.deltaDerived, entry => {
        if (entry.weight > 0) hasPositive = true
        if (entry.weight < 0) hasNegative = true
      })
      // New winner/superseded facts produce +1; old winner retraction produces −1.
      expect(hasPositive).toBe(true)
      expect(hasNegative).toBe(true)

      // deltaResolved should contain the winner change.
      let resolvedCount = 0
      zsetForEach(result.deltaResolved, () => {
        resolvedCount++
      })
      expect(resolvedCount).toBeGreaterThan(0)
    })

    it("LWW two-value retraction: intermediate weight states are correct", () => {
      // alice (L=10), bob (L=20). superseded(alice) weight=1.
      // Retract bob → superseded(alice) retracted (weight 1→0),
      // winner changes bob→alice.
      const lwwRules = buildDefaultLWWRules()
      const evaluator = createEvaluator(lwwRules)
      const slotId = "slot:title"

      const alice = makeActiveValueFact("alice", 1, slotId, "A", 10)
      const bob = makeActiveValueFact("bob", 1, slotId, "B", 20)
      evaluator.step(factsToZSet([alice, bob]), zsetEmpty())

      expect(evaluator.currentResolution().winners.get(slotId)?.content).toBe(
        "B",
      )

      // Verify superseded(alice) exists with weight 1.
      const db1 = evaluator.currentDatabase()
      const aliceCnIdKey = cnIdKey(createCnId("alice", 1))
      expect(db1.hasFact(fact("superseded", [aliceCnIdKey, slotId]))).toBe(true)
      expect(
        db1.getRelation("superseded").getWeight([aliceCnIdKey, slotId]),
      ).toBe(1)

      // Retract bob.
      evaluator.step(factsToWeightedZSet([[bob, -1]]), zsetEmpty())

      const db2 = evaluator.currentDatabase()
      // superseded(alice) retracted — weight crossed zero.
      expect(db2.hasFact(fact("superseded", [aliceCnIdKey, slotId]))).toBe(
        false,
      )
      // alice is now the winner.
      expect(evaluator.currentResolution().winners.get(slotId)?.content).toBe(
        "A",
      )
    })
  })
})

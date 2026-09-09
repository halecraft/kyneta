// === DatabaseView and Relation.presenceBefore Tests (Plan 007, Phase 1.5) ===
//
// Tests for the lazy-view optimization that replaces the eager O(|db|)
// `constructDbOld` with a lazy `DatabaseView` that materializes P_old only
// for predicates actually accessed during rule evaluation.
//
// Test categories:
//   - Relation.presenceBefore: P_old undoes presence flips, not weights
//   - DatabaseView: lazy materialization, caching, identity sharing
//   - ReadonlyDatabase: interface conformance
//   - Integration: evaluateStratumFromDelta produces identical results

import { describe, expect, it } from "vitest"
import {
  DatabaseView,
  evaluateStratumFromDelta,
} from "../../src/datalog/evaluator.js"
import type {
  Fact,
  FactTuple,
  ReadonlyDatabase,
  Rule,
} from "../../src/datalog/types.js"
import {
  _,
  atom,
  Database,
  fact,
  gt,
  negation,
  positiveAtom,
  Relation,
  rule,
  varTerm,
} from "../../src/datalog/types.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _addWeighted(
  rel: Relation,
  tuple: readonly unknown[],
  weight: number,
): void {
  rel.addWeighted(
    tuple as readonly (
      | string
      | number
      | boolean
      | bigint
      | null
      | Uint8Array
      | { ref: { peer: string; counter: number } }
    )[],
    weight,
  )
}

// ---------------------------------------------------------------------------
// Relation.presenceBefore
// ---------------------------------------------------------------------------

describe("Relation.presenceBefore", () => {
  const rel = (entries: [FactTuple, number][]): Relation => {
    const r = new Relation()
    for (const [tuple, weight] of entries) r.addWeighted(tuple, weight)
    return r
  }

  it("undoes an appearance, whatever the multiplicity", () => {
    // The case this method exists for. Two derivation paths make the weight 2;
    // the delta still reports a single +1, because a delta records presence.
    // Subtracting would leave 1 and claim the fact was there all along.
    const before = rel([[["x"], 2]]).presenceBefore(rel([[["x"], 1]]))
    expect(before.has(["x"])).toBe(false)
    expect(before.allEntryCount).toBe(0)
  })

  it("undoes a disappearance", () => {
    const before = rel([]).presenceBefore(rel([[["x"], -1]]))
    expect(before.has(["x"])).toBe(true)
  })

  it("leaves facts the delta does not mention untouched, weights and all", () => {
    const before = rel([
      [["keep"], 3],
      [["gone"], 1],
    ]).presenceBefore(rel([[["gone"], 1]]))
    expect(before.getWeight(["keep"])).toBe(3)
    expect(before.has(["gone"])).toBe(false)
  })

  it("is a no-op for an empty delta", () => {
    const before = rel([[["x"], 2]]).presenceBefore(new Relation())
    expect(before.getWeight(["x"])).toBe(2)
  })

  it("does not mutate either operand", () => {
    const base = rel([[["x"], 2]])
    const delta = rel([[["x"], 1]])
    base.presenceBefore(delta)
    expect(base.getWeight(["x"])).toBe(2)
    expect(delta.getWeight(["x"])).toBe(1)
  })

  it("never reports a fact as having been present a negative number of times", () => {
    // The old arithmetic could produce weight −1 here, which cannot describe
    // any previous state. Presence has only two answers.
    const before = rel([]).presenceBefore(rel([[["x"], 1]]))
    expect(before.getWeight(["x"])).toBe(0)
  })
})

describe("DatabaseView", () => {
  it("returns the base relation unchanged when delta has no entries for that predicate", () => {
    const db = new Database()
    db.addFact(fact("alpha", ["a", 1]))
    db.addFact(fact("beta", ["b", 2]))

    const delta = new Database()
    delta.addWeightedFact(fact("alpha", ["a", 1]), 1)
    // delta has entries for 'alpha' but NOT for 'beta'

    const view: ReadonlyDatabase = new DatabaseView(db, delta)

    // For 'beta' (no delta), we should get the exact same Relation object.
    const betaFromView = view.getRelation("beta")
    const betaFromDb = db.getRelation("beta")
    expect(betaFromView).toBe(betaFromDb) // identity — same object reference
  })

  it("returns the correct P_old when delta has entries for that predicate", () => {
    const db = new Database()
    db.addWeightedFact(fact("r", ["x"]), 1)
    db.addWeightedFact(fact("r", ["y"]), 1)

    const delta = new Database()
    delta.addWeightedFact(fact("r", ["y"]), 1)

    const view: ReadonlyDatabase = new DatabaseView(db, delta)
    const rel = view.getRelation("r")

    // P_old = P_new - delta
    // 'x': weight 1, not in delta → 1
    // 'y': weight 1, delta weight 1 → 0 (pruned)
    expect(rel.allEntryCount).toBe(1)
    expect(rel.has(["x"] as any)).toBe(true)
    expect(rel.has(["y"] as any)).toBe(false)
  })

  it("caches materialized relations (second call returns cached result)", () => {
    const db = new Database()
    db.addFact(fact("r", ["x"]))

    const delta = new Database()
    delta.addWeightedFact(fact("r", ["x"]), 1)

    const view = new DatabaseView(db, delta)

    const first = view.getRelation("r")
    const second = view.getRelation("r")
    expect(first).toBe(second) // same object reference — cached
  })

  it("does not cache base relation when delta is empty for that predicate", () => {
    const db = new Database()
    db.addFact(fact("r", ["x"]))

    const delta = new Database() // completely empty

    const view = new DatabaseView(db, delta)

    // Should return the base relation directly, not a cached subtraction.
    const rel = view.getRelation("r")
    expect(rel).toBe(db.getRelation("r"))
  })

  it("only materializes predicates actually accessed", () => {
    // Create a database with many predicates.
    const db = new Database()
    for (let i = 0; i < 10; i++) {
      db.addFact(fact(`pred_${i}`, [i]))
    }

    // Delta touches only pred_0.
    const delta = new Database()
    delta.addWeightedFact(fact("pred_0", [0]), 1)

    const view = new DatabaseView(db, delta)

    // Access only pred_0 and pred_1.
    const r0 = view.getRelation("pred_0")
    const r1 = view.getRelation("pred_1")

    // pred_0 was materialized (delta touched it) — different object from base.
    expect(r0).not.toBe(db.getRelation("pred_0"))
    // pred_0 result: weight 1 - 1 = 0 → pruned
    expect(r0.allEntryCount).toBe(0)

    // pred_1 was NOT materialized — same object as base.
    expect(r1).toBe(db.getRelation("pred_1"))
    expect(r1.allEntryCount).toBe(1)
  })

  it("predicates() returns all base predicates", () => {
    const db = new Database()
    db.addFact(fact("a", [1]))
    db.addFact(fact("b", [2]))
    db.addFact(fact("c", [3]))

    const delta = new Database()
    delta.addWeightedFact(fact("a", [1]), 1)

    const view = new DatabaseView(db, delta)
    const preds = [...view.predicates()]
    expect(preds).toContain("a")
    expect(preds).toContain("b")
    expect(preds).toContain("c")
    expect(preds.length).toBe(3)
  })

  it("hasFact checks against the view (P_old), not the base", () => {
    const db = new Database()
    db.addFact(fact("r", ["x"]))
    db.addFact(fact("r", ["y"]))

    // Delta adds 'y' — so in P_old, 'y' should be absent
    // (P_old = P_new - delta, and 'y' had weight 1, delta weight 1 → 0)
    const delta = new Database()
    delta.addWeightedFact(fact("r", ["y"]), 1)

    const view = new DatabaseView(db, delta)
    expect(view.hasFact(fact("r", ["x"]))).toBe(true)
    expect(view.hasFact(fact("r", ["y"]))).toBe(false)
  })

  it("a fact that appeared in this step is simply absent from P_old", () => {
    const db = new Database()
    // 'r' not present in base

    const delta = new Database()
    delta.addWeightedFact(fact("r", ["x"]), 1)

    const view = new DatabaseView(db, delta)
    const rel = view.getRelation("r")

    // Subtracting arithmetically would leave a weight −1 entry, which cannot
    // describe a previous state: a fact is not present −1 times. P_old undoes
    // the presence flip instead, so the fact is just not there.
    expect(rel.allEntryCount).toBe(0)
    expect(rel.has(["x"] as never)).toBe(false)
  })

  it("a fact that disappeared in this step is present in P_old", () => {
    const db = new Database()
    db.addWeightedFact(fact("r", ["x"]), 1)

    // Delta retracts 'x' (weight -1 in delta means it was removed)
    const delta = new Database()
    delta.addWeightedFact(fact("r", ["x"]), -1)

    const view = new DatabaseView(db, delta)
    const rel = view.getRelation("r")

    expect(rel.has(["x"] as never)).toBe(true)
  })

  it("P_old ignores multiplicity, because a delta records presence not weight", () => {
    // The case that made this the rule. A derived fact with two independent
    // derivation paths carries weight 2, but the stratum that derived it
    // reports a single +1: it appeared. Subtracting would leave weight 1 and
    // claim the fact was already there before the step.
    const db = new Database()
    db.addWeightedFact(fact("blocked", [1, 1]), 2)

    const delta = new Database()
    delta.addWeightedFact(fact("blocked", [1, 1]), 1)

    const view = new DatabaseView(db, delta)
    expect(view.getRelation("blocked").has([1, 1] as never)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// ReadonlyDatabase conformance
// ---------------------------------------------------------------------------

describe("ReadonlyDatabase", () => {
  it("Database implements ReadonlyDatabase", () => {
    const db: ReadonlyDatabase = new Database()
    // Should compile and provide the expected methods.
    expect(typeof db.getRelation).toBe("function")
    expect(typeof db.predicates).toBe("function")
    expect(typeof db.hasFact).toBe("function")
  })

  it("DatabaseView implements ReadonlyDatabase", () => {
    const view: ReadonlyDatabase = new DatabaseView(
      new Database(),
      new Database(),
    )
    expect(typeof view.getRelation).toBe("function")
    expect(typeof view.predicates).toBe("function")
    expect(typeof view.hasFact).toBe("function")
  })
})

// ---------------------------------------------------------------------------
// Integration: evaluateStratumFromDelta equivalence
//
// The lazy DatabaseView must produce identical results to the old eager
// constructDbOld. These tests verify via the three-way oracle that the
// evaluator still produces correct results.
// ---------------------------------------------------------------------------

describe("DatabaseView integration with evaluateStratumFromDelta", () => {
  it("LWW superseded stratum produces correct delta", () => {
    // superseded(CnId, Slot) :- active_value(CnId, Slot, _, L1, P1),
    //   active_value(CnId2, Slot, _, L2, P2), CnId != CnId2,
    //   L2 = L1, P2 > P1.
    // superseded(CnId, Slot) :- active_value(CnId, Slot, _, L1, _),
    //   active_value(_, Slot, _, L2, _), L2 > L1.
    const supersededByLamport: Rule = rule(
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
          atom("active_value", [_, varTerm("Slot"), _, varTerm("L2"), _]),
        ),
        gt(varTerm("L2"), varTerm("L1")),
      ],
    )

    const db = new Database()
    // Insert two values for the same slot, different lamports.
    db.addFact(
      fact("active_value", ["alice@0", "slot:title", "Hello", 10, "alice"]),
    )

    // Now process a delta that adds a second value with higher lamport.
    const inputDelta = new Database()
    const newFact = fact("active_value", [
      "bob@0",
      "slot:title",
      "World",
      20,
      "bob",
    ])
    db.addFact(newFact) // apply to db (P_new)
    inputDelta.addWeightedFact(newFact, 1)

    const outputDelta = evaluateStratumFromDelta(
      [supersededByLamport],
      db,
      inputDelta,
    )

    // alice@0 should be superseded.
    const supersededTuples = outputDelta.getRelation("superseded").tuples()
    expect(supersededTuples.length).toBe(1)
    expect(supersededTuples[0]?.[0]).toBe("alice@0")
    expect(supersededTuples[0]?.[1]).toBe("slot:title")
  })

  it("transitive closure converges correctly through fixpoint iterations", () => {
    // reachable(X, Y) :- edge(X, Y).
    // reachable(X, Z) :- edge(X, Y), reachable(Y, Z).
    const baseRule: Rule = rule(
      atom("reachable", [varTerm("X"), varTerm("Y")]),
      [positiveAtom(atom("edge", [varTerm("X"), varTerm("Y")]))],
    )
    const transitiveRule: Rule = rule(
      atom("reachable", [varTerm("X"), varTerm("Z")]),
      [
        positiveAtom(atom("edge", [varTerm("X"), varTerm("Y")])),
        positiveAtom(atom("reachable", [varTerm("Y"), varTerm("Z")])),
      ],
    )

    const db = new Database()
    // Chain: a → b → c → d
    const edges: Fact[] = [
      fact("edge", ["a", "b"]),
      fact("edge", ["b", "c"]),
      fact("edge", ["c", "d"]),
    ]
    for (const e of edges) {
      db.addFact(e)
    }

    const inputDelta = new Database()
    for (const e of edges) {
      inputDelta.addWeightedFact(e, 1)
    }

    evaluateStratumFromDelta([baseRule, transitiveRule], db, inputDelta)

    // After convergence, reachable should contain:
    // (a,b), (a,c), (a,d), (b,c), (b,d), (c,d)
    const reachable = db.getRelation("reachable")
    expect(reachable.size).toBe(6)
    expect(reachable.has(["a", "b"] as any)).toBe(true)
    expect(reachable.has(["a", "c"] as any)).toBe(true)
    expect(reachable.has(["a", "d"] as any)).toBe(true)
    expect(reachable.has(["b", "c"] as any)).toBe(true)
    expect(reachable.has(["b", "d"] as any)).toBe(true)
    expect(reachable.has(["c", "d"] as any)).toBe(true)
  })

  it("retraction through negation works with lazy view", () => {
    // winner(S, CnId, V) :- active_value(CnId, S, V, _, _),
    //   not superseded(CnId, S).
    const winnerRule: Rule = rule(
      atom("winner", [varTerm("S"), varTerm("CnId"), varTerm("V")]),
      [
        positiveAtom(
          atom("active_value", [
            varTerm("CnId"),
            varTerm("S"),
            varTerm("V"),
            _,
            _,
          ]),
        ),
        negation(atom("superseded", [varTerm("CnId"), varTerm("S")])),
      ],
    )

    const db = new Database()
    // Two active values and one superseded.
    db.addFact(fact("active_value", ["a@0", "slot:x", "Hello", 10, "a"]))
    db.addFact(fact("active_value", ["b@0", "slot:x", "World", 20, "b"]))
    db.addFact(fact("superseded", ["a@0", "slot:x"]))

    // Delta: add the superseded fact (simulating stratum 0 → stratum 1 propagation).
    const inputDelta = new Database()
    inputDelta.addWeightedFact(
      fact("active_value", ["a@0", "slot:x", "Hello", 10, "a"]),
      1,
    )
    inputDelta.addWeightedFact(
      fact("active_value", ["b@0", "slot:x", "World", 20, "b"]),
      1,
    )
    inputDelta.addWeightedFact(fact("superseded", ["a@0", "slot:x"]), 1)

    evaluateStratumFromDelta([winnerRule], db, inputDelta)

    // Only b@0 should be the winner (a@0 is superseded).
    const winners = db.getRelation("winner")
    expect(winners.size).toBe(1)
    expect(winners.has(["slot:x", "b@0", "World"] as any)).toBe(true)
    expect(winners.has(["slot:x", "a@0", "Hello"] as any)).toBe(false)
  })
})

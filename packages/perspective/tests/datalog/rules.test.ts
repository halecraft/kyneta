// === Rules Validation Tests ===
// Validates that LWW and Fugue rules from §B.4 produce correct results
// against hand-computed expected values. These tests use ad-hoc ground facts
// that simulate kernel-domain relations (e.g., active_value(CnId, Slot, Value, Lamport, Peer)).
// These are test doubles — simple tuples — not real kernel types (which don't
// exist until Phase 2).

import { describe, expect, it } from "vitest"
import { buildDefaultLWWRules } from "../../src/bootstrap.js"
import { evaluateUnified as evaluate } from "../../src/datalog/evaluator.js"
import type { AggregationClause, Fact, Rule } from "../../src/datalog/types.js"
import {
  _,
  aggregation,
  atom,
  fact,
  lt,
  neq,
  positiveAtom,
  rule,
  varTerm,
} from "../../src/datalog/types.js"

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function hasFact(
  db: import("../../src/datalog/types.js").Database,
  predicate: string,
  values: readonly unknown[],
): boolean {
  return db
    .getRelation(predicate)
    .has(
      values as readonly (
        | null
        | boolean
        | number
        | bigint
        | string
        | Uint8Array
        | { readonly ref: { peer: string; counter: number } }
      )[],
    )
}

// ---------------------------------------------------------------------------
// LWW Tests
//
// Uses the canonical default LWW rules from bootstrap.ts (§B.4).
// ---------------------------------------------------------------------------

describe("LWW rules (§B.4)", () => {
  const lwwRules = buildDefaultLWWRules()

  describe("basic conflict resolution by lamport", () => {
    it("higher lamport wins", () => {
      // active_value(CnId, Slot, Value, Lamport, Peer)
      const facts: Fact[] = [
        fact("active_value", ["cn1", "title", "Hello", 1, "alice"]),
        fact("active_value", ["cn2", "title", "World", 3, "bob"]),
        fact("active_value", ["cn3", "title", "Bye", 2, "charlie"]),
      ]

      const result = evaluate(lwwRules, facts)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      const db = result.value

      // cn2 wins (lamport 3 is highest)
      expect(hasFact(db, "winner", ["title", "cn2", "World"])).toBe(true)
      expect(hasFact(db, "winner", ["title", "cn1", "Hello"])).toBe(false)
      expect(hasFact(db, "winner", ["title", "cn3", "Bye"])).toBe(false)

      // cn1 and cn3 are superseded
      expect(hasFact(db, "superseded", ["cn1", "title"])).toBe(true)
      expect(hasFact(db, "superseded", ["cn3", "title"])).toBe(true)
      expect(hasFact(db, "superseded", ["cn2", "title"])).toBe(false)
    })
  })

  describe("tiebreak by peer when lamports are equal", () => {
    it("lexicographically greater peer wins on lamport tie", () => {
      const facts: Fact[] = [
        fact("active_value", ["cn1", "body", "First", 5, "alice"]),
        fact("active_value", ["cn2", "body", "Second", 5, "bob"]),
      ]

      const result = evaluate(lwwRules, facts)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      const db = result.value

      // bob > alice lexicographically → cn2 wins
      expect(hasFact(db, "winner", ["body", "cn2", "Second"])).toBe(true)
      expect(hasFact(db, "winner", ["body", "cn1", "First"])).toBe(false)
      expect(hasFact(db, "superseded", ["cn1", "body"])).toBe(true)
      expect(hasFact(db, "superseded", ["cn2", "body"])).toBe(false)
    })

    it("three-way tie broken by peer", () => {
      const facts: Fact[] = [
        fact("active_value", ["cn1", "color", "red", 10, "alice"]),
        fact("active_value", ["cn2", "color", "green", 10, "charlie"]),
        fact("active_value", ["cn3", "color", "blue", 10, "bob"]),
      ]

      const result = evaluate(lwwRules, facts)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      const db = result.value

      // charlie > bob > alice → cn2 wins
      expect(hasFact(db, "winner", ["color", "cn2", "green"])).toBe(true)
      expect(hasFact(db, "winner", ["color", "cn1", "red"])).toBe(false)
      expect(hasFact(db, "winner", ["color", "cn3", "blue"])).toBe(false)
      expect(hasFact(db, "superseded", ["cn1", "color"])).toBe(true)
      expect(hasFact(db, "superseded", ["cn3", "color"])).toBe(true)
    })
  })

  describe("single write (no conflict)", () => {
    it("single writer always wins", () => {
      const facts: Fact[] = [
        fact("active_value", ["cn1", "title", "Only", 1, "alice"]),
      ]

      const result = evaluate(lwwRules, facts)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      const db = result.value

      expect(hasFact(db, "winner", ["title", "cn1", "Only"])).toBe(true)
      expect(db.getRelation("superseded").size).toBe(0)
    })
  })

  describe("multiple independent slots", () => {
    it("resolves each slot independently", () => {
      const facts: Fact[] = [
        // title: cn2 wins (lamport 3 > 1)
        fact("active_value", ["cn1", "title", "A", 1, "alice"]),
        fact("active_value", ["cn2", "title", "B", 3, "alice"]),
        // body: cn3 wins (only writer)
        fact("active_value", ["cn3", "body", "C", 1, "bob"]),
        // color: cn5 wins (lamport tie, 'charlie' > 'alice')
        fact("active_value", ["cn4", "color", "D", 2, "alice"]),
        fact("active_value", ["cn5", "color", "E", 2, "charlie"]),
      ]

      const result = evaluate(lwwRules, facts)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      const db = result.value

      expect(hasFact(db, "winner", ["title", "cn2", "B"])).toBe(true)
      expect(hasFact(db, "winner", ["body", "cn3", "C"])).toBe(true)
      expect(hasFact(db, "winner", ["color", "cn5", "E"])).toBe(true)

      // Exactly 3 winners
      expect(db.getRelation("winner").size).toBe(3)
    })
  })

  describe("LWW with null values (deletion)", () => {
    it("null write with higher lamport wins (map deletion)", () => {
      const facts: Fact[] = [
        fact("active_value", ["cn1", "key", "value", 1, "alice"]),
        fact("active_value", ["cn2", "key", null, 2, "bob"]), // deletion
      ]

      const result = evaluate(lwwRules, facts)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      const db = result.value

      // cn2 (null) wins because lamport 2 > 1
      expect(hasFact(db, "winner", ["key", "cn2", null])).toBe(true)
      expect(hasFact(db, "winner", ["key", "cn1", "value"])).toBe(false)
    })

    it("non-null write with higher lamport wins over deletion", () => {
      const facts: Fact[] = [
        fact("active_value", ["cn1", "key", null, 1, "alice"]),
        fact("active_value", ["cn2", "key", "restored", 3, "bob"]),
      ]

      const result = evaluate(lwwRules, facts)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      const db = result.value

      expect(hasFact(db, "winner", ["key", "cn2", "restored"])).toBe(true)
      expect(hasFact(db, "winner", ["key", "cn1", null])).toBe(false)
    })
  })

  describe("LWW with numeric values", () => {
    it("resolves number value conflicts", () => {
      const facts: Fact[] = [
        fact("active_value", ["cn1", "score", 100, 1, "alice"]),
        fact("active_value", ["cn2", "score", 200, 2, "bob"]),
      ]

      const result = evaluate(lwwRules, facts)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      const db = result.value

      expect(hasFact(db, "winner", ["score", "cn2", 200])).toBe(true)
    })

    it("resolves bigint value conflicts", () => {
      const facts: Fact[] = [
        fact("active_value", ["cn1", "id", 1000n, 1, "alice"]),
        fact("active_value", ["cn2", "id", 2000n, 2, "bob"]),
      ]

      const result = evaluate(lwwRules, facts)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      const db = result.value

      expect(hasFact(db, "winner", ["id", "cn2", 2000n])).toBe(true)
    })
  })

  describe("LWW with many concurrent writers", () => {
    it("five concurrent writers, all different lamports", () => {
      const facts: Fact[] = [
        fact("active_value", ["cn1", "field", "v1", 5, "alice"]),
        fact("active_value", ["cn2", "field", "v2", 2, "bob"]),
        fact("active_value", ["cn3", "field", "v3", 8, "charlie"]),
        fact("active_value", ["cn4", "field", "v4", 1, "dave"]),
        fact("active_value", ["cn5", "field", "v5", 6, "eve"]),
      ]

      const result = evaluate(lwwRules, facts)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      const db = result.value

      // cn3 wins (lamport 8 is highest)
      expect(hasFact(db, "winner", ["field", "cn3", "v3"])).toBe(true)
      expect(db.getRelation("winner").size).toBe(1)

      // All others are superseded
      expect(hasFact(db, "superseded", ["cn1", "field"])).toBe(true)
      expect(hasFact(db, "superseded", ["cn2", "field"])).toBe(true)
      expect(hasFact(db, "superseded", ["cn4", "field"])).toBe(true)
      expect(hasFact(db, "superseded", ["cn5", "field"])).toBe(true)
      expect(hasFact(db, "superseded", ["cn3", "field"])).toBe(false)
    })

    it("five concurrent writers, all same lamport", () => {
      const facts: Fact[] = [
        fact("active_value", ["cn1", "field", "v1", 10, "alice"]),
        fact("active_value", ["cn2", "field", "v2", 10, "bob"]),
        fact("active_value", ["cn3", "field", "v3", 10, "charlie"]),
        fact("active_value", ["cn4", "field", "v4", 10, "dave"]),
        fact("active_value", ["cn5", "field", "v5", 10, "eve"]),
      ]

      const result = evaluate(lwwRules, facts)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      const db = result.value

      // eve wins (lexicographically greatest peer)
      expect(hasFact(db, "winner", ["field", "cn5", "v5"])).toBe(true)
      expect(db.getRelation("winner").size).toBe(1)
    })
  })

  describe("LWW determinism", () => {
    it("same inputs always produce same output regardless of fact insertion order", () => {
      const baseFacts: Fact[] = [
        fact("active_value", ["cn1", "s", "a", 3, "peer_x"]),
        fact("active_value", ["cn2", "s", "b", 3, "peer_y"]),
        fact("active_value", ["cn3", "s", "c", 1, "peer_z"]),
      ]

      // Evaluate with facts in original order
      const result1 = evaluate(lwwRules, baseFacts)

      // Evaluate with facts in reversed order
      const result2 = evaluate(lwwRules, [...baseFacts].reverse())

      expect(result1.ok).toBe(true)
      expect(result2.ok).toBe(true)
      if (!result1.ok || !result2.ok) return

      // Both should produce the same winner
      // peer_z > peer_y > peer_x, lamport 3 for cn1 and cn2, lamport 1 for cn3
      // cn3 is superseded by both cn1 and cn2 (lamport 1 < 3).
      // Between cn1 (peer_x) and cn2 (peer_y): same lamport 3, peer_y > peer_x → cn2 wins.
      expect(hasFact(result1.value, "winner", ["s", "cn2", "b"])).toBe(true)
      expect(hasFact(result2.value, "winner", ["s", "cn2", "b"])).toBe(true)

      expect(result1.value.getRelation("winner").size).toBe(1)
      expect(result2.value.getRelation("winner").size).toBe(1)
    })
  })
})

// ---------------------------------------------------------------------------
// LWW with aggregation-based approach (alternative encoding)
//
// Instead of superseded/winner with negation, one can use max aggregation:
//   max_lamport(Slot, MaxL) :- max<Lamport> over active_value(_, Slot, _, Lamport, _)
//   winner(Slot, CnId, Value) :- active_value(CnId, Slot, Value, Lamport, _),
//                                 max_lamport(Slot, Lamport).
//
// This is simpler but doesn't handle the peer tiebreak. We test it to
// validate that aggregation-based LWW works for the non-tie case.
// ---------------------------------------------------------------------------

describe("LWW via max aggregation (simplified, no peer tiebreak)", () => {
  function buildAggLWWRules(): Rule[] {
    const aggClause: AggregationClause = {
      fn: "max",
      groupBy: ["Slot"],
      over: "Lamport",
      result: "MaxL",
      source: atom("active_value", [
        _,
        varTerm("Slot"),
        _,
        varTerm("Lamport"),
        _,
      ]),
    }

    const maxRule: Rule = rule(
      atom("max_lamport", [varTerm("Slot"), varTerm("MaxL")]),
      [aggregation(aggClause)],
    )

    const winnerRule: Rule = rule(
      atom("agg_winner", [varTerm("Slot"), varTerm("CnId"), varTerm("Value")]),
      [
        positiveAtom(
          atom("active_value", [
            varTerm("CnId"),
            varTerm("Slot"),
            varTerm("Value"),
            varTerm("Lamport"),
            _,
          ]),
        ),
        positiveAtom(
          atom("max_lamport", [varTerm("Slot"), varTerm("Lamport")]),
        ),
      ],
    )

    return [maxRule, winnerRule]
  }

  it("selects the value with the highest lamport", () => {
    const rules = buildAggLWWRules()
    const facts: Fact[] = [
      fact("active_value", ["cn1", "title", "Old", 1, "alice"]),
      fact("active_value", ["cn2", "title", "New", 5, "bob"]),
      fact("active_value", ["cn3", "title", "Mid", 3, "charlie"]),
    ]

    const result = evaluate(rules, facts)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const db = result.value

    expect(hasFact(db, "max_lamport", ["title", 5])).toBe(true)
    expect(hasFact(db, "agg_winner", ["title", "cn2", "New"])).toBe(true)
    expect(hasFact(db, "agg_winner", ["title", "cn1", "Old"])).toBe(false)
    expect(hasFact(db, "agg_winner", ["title", "cn3", "Mid"])).toBe(false)
  })

  it("handles multiple slots independently", () => {
    const rules = buildAggLWWRules()
    const facts: Fact[] = [
      fact("active_value", ["cn1", "a", "x", 1, "alice"]),
      fact("active_value", ["cn2", "a", "y", 3, "bob"]),
      fact("active_value", ["cn3", "b", "p", 5, "alice"]),
      fact("active_value", ["cn4", "b", "q", 2, "bob"]),
    ]

    const result = evaluate(rules, facts)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const db = result.value

    // Slot 'a': cn2 (lamport 3)
    expect(hasFact(db, "agg_winner", ["a", "cn2", "y"])).toBe(true)
    // Slot 'b': cn3 (lamport 5)
    expect(hasFact(db, "agg_winner", ["b", "cn3", "p"])).toBe(true)
    expect(db.getRelation("agg_winner").size).toBe(2)
  })

  it("produces multiple winners on lamport tie (no peer tiebreak in this encoding)", () => {
    const rules = buildAggLWWRules()
    const facts: Fact[] = [
      fact("active_value", ["cn1", "slot", "A", 5, "alice"]),
      fact("active_value", ["cn2", "slot", "B", 5, "bob"]),
    ]

    const result = evaluate(rules, facts)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const db = result.value

    // Both have max lamport 5, so both are "winners" in this simplified encoding
    expect(hasFact(db, "agg_winner", ["slot", "cn1", "A"])).toBe(true)
    expect(hasFact(db, "agg_winner", ["slot", "cn2", "B"])).toBe(true)
    expect(db.getRelation("agg_winner").size).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Fugue Rules (simplified subset — §B.4 sketch)
//
// The full Fugue tree walk is complex. Here we validate a simplified subset:
// 1. fugue_child relation is correctly derived from structure constraints.
// 2. Basic ordering: tiebreaking by peer when two elements share the same
//    origin_left (both inserted at the same position concurrently).
//
// Phase 4 equivalence tests will validate against the native Fugue solver.
// ---------------------------------------------------------------------------

describe("Fugue rules (simplified subset)", () => {
  // fugue_child(Parent, CnId, OriginLeft, OriginRight, Peer) :-
  //   active_structure_seq(CnId, Parent, OriginLeft, OriginRight),
  //   constraint_peer(CnId, Peer).
  const fugueChildRule: Rule = rule(
    atom("fugue_child", [
      varTerm("Parent"),
      varTerm("CnId"),
      varTerm("OriginLeft"),
      varTerm("OriginRight"),
      varTerm("Peer"),
    ]),
    [
      positiveAtom(
        atom("active_structure_seq", [
          varTerm("CnId"),
          varTerm("Parent"),
          varTerm("OriginLeft"),
          varTerm("OriginRight"),
        ]),
      ),
      positiveAtom(atom("constraint_peer", [varTerm("CnId"), varTerm("Peer")])),
    ],
  )

  // fugue_before(Parent, A, B) :-
  //   fugue_child(Parent, A, OriginLeft, _, PeerA),
  //   fugue_child(Parent, B, OriginLeft, _, PeerB),
  //   A ≠ B, PeerA < PeerB.
  //
  // (Simplified: when two elements share the same origin_left, the one
  // with the lower peer ID goes first — left subtree.)
  const fugueBeforeRule: Rule = rule(
    atom("fugue_before", [varTerm("Parent"), varTerm("A"), varTerm("B")]),
    [
      positiveAtom(
        atom("fugue_child", [
          varTerm("Parent"),
          varTerm("A"),
          varTerm("OriginLeft"),
          _,
          varTerm("PeerA"),
        ]),
      ),
      positiveAtom(
        atom("fugue_child", [
          varTerm("Parent"),
          varTerm("B"),
          varTerm("OriginLeft"),
          _,
          varTerm("PeerB"),
        ]),
      ),
      neq(varTerm("A"), varTerm("B")),
      lt(varTerm("PeerA"), varTerm("PeerB")),
    ],
  )

  const fugueRules = [fugueChildRule, fugueBeforeRule]

  it("derives fugue_child from structure and peer facts", () => {
    const facts: Fact[] = [
      // active_structure_seq(CnId, Parent, OriginLeft, OriginRight)
      fact("active_structure_seq", ["elem1", "root", "none", "none"]),
      fact("active_structure_seq", ["elem2", "root", "elem1", "none"]),
      // constraint_peer(CnId, Peer)
      fact("constraint_peer", ["elem1", "alice"]),
      fact("constraint_peer", ["elem2", "bob"]),
    ]

    const result = evaluate(fugueRules, facts)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const db = result.value

    expect(
      hasFact(db, "fugue_child", ["root", "elem1", "none", "none", "alice"]),
    ).toBe(true)
    expect(
      hasFact(db, "fugue_child", ["root", "elem2", "elem1", "none", "bob"]),
    ).toBe(true)
    expect(db.getRelation("fugue_child").size).toBe(2)
  })

  it("concurrent inserts at same position: lower peer goes first", () => {
    // Both alice and charlie insert after elem0 concurrently.
    // alice < charlie → alice's element goes first.
    const facts: Fact[] = [
      fact("active_structure_seq", ["elem_a", "root", "elem0", "none"]),
      fact("active_structure_seq", ["elem_c", "root", "elem0", "none"]),
      fact("constraint_peer", ["elem_a", "alice"]),
      fact("constraint_peer", ["elem_c", "charlie"]),
    ]

    const result = evaluate(fugueRules, facts)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const db = result.value

    // alice < charlie → elem_a comes before elem_c
    expect(hasFact(db, "fugue_before", ["root", "elem_a", "elem_c"])).toBe(true)
    // elem_c does NOT come before elem_a
    expect(hasFact(db, "fugue_before", ["root", "elem_c", "elem_a"])).toBe(
      false,
    )
  })

  it("three concurrent inserts at same position: transitive ordering via before", () => {
    // alice, bob, charlie all insert after elem0
    // alice < bob < charlie
    const facts: Fact[] = [
      fact("active_structure_seq", ["ea", "root", "elem0", "none"]),
      fact("active_structure_seq", ["eb", "root", "elem0", "none"]),
      fact("active_structure_seq", ["ec", "root", "elem0", "none"]),
      fact("constraint_peer", ["ea", "alice"]),
      fact("constraint_peer", ["eb", "bob"]),
      fact("constraint_peer", ["ec", "charlie"]),
    ]

    const result = evaluate(fugueRules, facts)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const db = result.value

    // alice < bob
    expect(hasFact(db, "fugue_before", ["root", "ea", "eb"])).toBe(true)
    // alice < charlie
    expect(hasFact(db, "fugue_before", ["root", "ea", "ec"])).toBe(true)
    // bob < charlie
    expect(hasFact(db, "fugue_before", ["root", "eb", "ec"])).toBe(true)

    // Reverses should not hold
    expect(hasFact(db, "fugue_before", ["root", "eb", "ea"])).toBe(false)
    expect(hasFact(db, "fugue_before", ["root", "ec", "ea"])).toBe(false)
    expect(hasFact(db, "fugue_before", ["root", "ec", "eb"])).toBe(false)

    // 3 before relationships (all C(3,2) = 3)
    expect(db.getRelation("fugue_before").size).toBe(3)
  })

  it("inserts at different positions do not produce before relationships", () => {
    // elem_a is inserted after elem0, elem_b is inserted after elem1
    // Different origin_left → no fugue_before between them from this rule
    const facts: Fact[] = [
      fact("active_structure_seq", ["elem_a", "root", "elem0", "none"]),
      fact("active_structure_seq", ["elem_b", "root", "elem1", "none"]),
      fact("constraint_peer", ["elem_a", "alice"]),
      fact("constraint_peer", ["elem_b", "bob"]),
    ]

    const result = evaluate(fugueRules, facts)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const db = result.value

    // No before relationships (different origin_left)
    expect(db.getRelation("fugue_before").size).toBe(0)
  })

  it("empty sequence produces no children or orderings", () => {
    const result = evaluate(fugueRules, [])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const db = result.value

    expect(db.getRelation("fugue_child").size).toBe(0)
    expect(db.getRelation("fugue_before").size).toBe(0)
  })

  it("single element produces a child but no ordering", () => {
    const facts: Fact[] = [
      fact("active_structure_seq", ["elem1", "root", "none", "none"]),
      fact("constraint_peer", ["elem1", "alice"]),
    ]

    const result = evaluate(fugueRules, facts)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const db = result.value

    expect(db.getRelation("fugue_child").size).toBe(1)
    expect(db.getRelation("fugue_before").size).toBe(0)
  })

  it("multiple parents keep orderings separate", () => {
    // Two different parents, each with concurrent inserts
    const facts: Fact[] = [
      // Parent: list1
      fact("active_structure_seq", ["a1", "list1", "origin", "none"]),
      fact("active_structure_seq", ["a2", "list1", "origin", "none"]),
      // Parent: list2
      fact("active_structure_seq", ["b1", "list2", "origin", "none"]),
      fact("active_structure_seq", ["b2", "list2", "origin", "none"]),
      // Peers
      fact("constraint_peer", ["a1", "alice"]),
      fact("constraint_peer", ["a2", "bob"]),
      fact("constraint_peer", ["b1", "charlie"]),
      fact("constraint_peer", ["b2", "alice"]),
    ]

    const result = evaluate(fugueRules, facts)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const db = result.value

    // list1: alice < bob → a1 before a2
    expect(hasFact(db, "fugue_before", ["list1", "a1", "a2"])).toBe(true)
    // list2: alice < charlie → b2 before b1
    expect(hasFact(db, "fugue_before", ["list2", "b2", "b1"])).toBe(true)

    // No cross-parent ordering
    expect(hasFact(db, "fugue_before", ["list1", "a1", "b1"])).toBe(false)
    expect(hasFact(db, "fugue_before", ["list2", "a1", "b1"])).toBe(false)
  })

  it("deterministic ordering: same inputs → same results regardless of fact order", () => {
    const baseFacts: Fact[] = [
      fact("active_structure_seq", ["x", "root", "o", "none"]),
      fact("active_structure_seq", ["y", "root", "o", "none"]),
      fact("active_structure_seq", ["z", "root", "o", "none"]),
      fact("constraint_peer", ["x", "peer_c"]),
      fact("constraint_peer", ["y", "peer_a"]),
      fact("constraint_peer", ["z", "peer_b"]),
    ]

    const result1 = evaluate(fugueRules, baseFacts)
    const result2 = evaluate(fugueRules, [...baseFacts].reverse())

    expect(result1.ok).toBe(true)
    expect(result2.ok).toBe(true)
    if (!result1.ok || !result2.ok) return

    // peer_a < peer_b < peer_c → y before z before x
    expect(hasFact(result1.value, "fugue_before", ["root", "y", "z"])).toBe(
      true,
    )
    expect(hasFact(result1.value, "fugue_before", ["root", "y", "x"])).toBe(
      true,
    )
    expect(hasFact(result1.value, "fugue_before", ["root", "z", "x"])).toBe(
      true,
    )

    expect(hasFact(result2.value, "fugue_before", ["root", "y", "z"])).toBe(
      true,
    )
    expect(hasFact(result2.value, "fugue_before", ["root", "y", "x"])).toBe(
      true,
    )
    expect(hasFact(result2.value, "fugue_before", ["root", "z", "x"])).toBe(
      true,
    )

    expect(result1.value.getRelation("fugue_before").size).toBe(3)
    expect(result2.value.getRelation("fugue_before").size).toBe(3)
  })
})

// === The default LWW rules (§B.4) ===
// The three rules `buildDefaultLWWRules()` puts in every new reality, checked
// against hand-computed answers: higher Lamport wins, peer id breaks a tie,
// null is a value like any other, and the winner is the same whatever order the
// facts arrive in.
//
// Facts here are ad-hoc tuples in the shape `kernel/projection.ts` emits —
// `active_value(CnId, Slot, Value, Lamport, Peer)` — built directly rather than
// projected, because what is under test is the rules.

import type { Database, Fact, Value } from "@kyneta/datalog"
import { evaluate, fact } from "@kyneta/datalog"
import { describe, expect, it } from "vitest"
import { buildDefaultLWWRules } from "../../src/bootstrap.js"

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function hasFact(
  db: Database,
  predicate: string,
  values: readonly Value[],
): boolean {
  return db.getRelation(predicate).has(values)
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

// === Unification Tests ===
// Tests for variable binding, substitution application, and term matching
// against facts.

import { describe, expect, it } from "vitest"
import type { Substitution, Value } from "../../src/datalog/types.js"
import {
  atom,
  compareValues,
  constTerm,
  serializeValue,
  valuesEqual,
  varTerm,
} from "../../src/datalog/types.js"
import {
  EMPTY_SUBSTITUTION,
  extendSubstitution,
  groundAtom,
  matchAtomAgainstRelation,
  matchAtomWithTuple,
  resolveTerm,
  unifyTermWithValue,
} from "../../src/datalog/unify.js"

// ---------------------------------------------------------------------------
// Value equality (foundation for everything else)
// ---------------------------------------------------------------------------

describe("valuesEqual", () => {
  it("null equals null", () => {
    expect(valuesEqual(null, null)).toBe(true)
  })

  it("null does not equal other types", () => {
    expect(valuesEqual(null, 0)).toBe(false)
    expect(valuesEqual(null, "")).toBe(false)
    expect(valuesEqual(null, false)).toBe(false)
    expect(valuesEqual(null, 0n)).toBe(false)
  })

  it("booleans compare correctly", () => {
    expect(valuesEqual(true, true)).toBe(true)
    expect(valuesEqual(false, false)).toBe(true)
    expect(valuesEqual(true, false)).toBe(false)
  })

  it("numbers compare correctly", () => {
    expect(valuesEqual(3, 3)).toBe(true)
    expect(valuesEqual(3.14, 3.14)).toBe(true)
    expect(valuesEqual(3, 4)).toBe(false)
    expect(valuesEqual(0, -0)).toBe(false) // Object.is semantics
    expect(valuesEqual(NaN, NaN)).toBe(true) // Object.is semantics
  })

  it("bigints compare correctly", () => {
    expect(valuesEqual(3n, 3n)).toBe(true)
    expect(valuesEqual(3n, 4n)).toBe(false)
  })

  it("number and bigint are NEVER equal (§3)", () => {
    // This is the critical spec requirement: int(3) ≠ float(3.0)
    expect(valuesEqual(3, 3n)).toBe(false)
    expect(valuesEqual(0, 0n)).toBe(false)
  })

  it("strings compare correctly", () => {
    expect(valuesEqual("hello", "hello")).toBe(true)
    expect(valuesEqual("hello", "world")).toBe(false)
    expect(valuesEqual("", "")).toBe(true)
  })

  it("Uint8Array compares by content", () => {
    expect(
      valuesEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3])),
    ).toBe(true)
    expect(
      valuesEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4])),
    ).toBe(false)
    expect(valuesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(
      false,
    )
    expect(valuesEqual(new Uint8Array([]), new Uint8Array([]))).toBe(true)
  })

  it("ref compares structurally", () => {
    const ref1 = { ref: { peer: "alice", counter: 1 } }
    const ref2 = { ref: { peer: "alice", counter: 1 } }
    const ref3 = { ref: { peer: "bob", counter: 1 } }
    const ref4 = { ref: { peer: "alice", counter: 2 } }
    expect(valuesEqual(ref1, ref2)).toBe(true)
    expect(valuesEqual(ref1, ref3)).toBe(false)
    expect(valuesEqual(ref1, ref4)).toBe(false)
  })

  it("different types are never equal", () => {
    expect(valuesEqual(0, "0")).toBe(false)
    expect(valuesEqual(true, 1)).toBe(false)
    expect(valuesEqual("", false)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// serializeValue (injective serialization for set membership)
// ---------------------------------------------------------------------------

describe("serializeValue", () => {
  it("number(3) and bigint(3n) produce different keys", () => {
    expect(serializeValue(3)).not.toBe(serializeValue(3n))
  })

  it("null serializes uniquely", () => {
    expect(serializeValue(null)).toBe("N")
  })

  it("boolean serializes uniquely", () => {
    expect(serializeValue(true)).toBe("T")
    expect(serializeValue(false)).toBe("F")
  })

  it("-0 and +0 serialize differently", () => {
    expect(serializeValue(-0)).not.toBe(serializeValue(0))
  })

  it("strings with different lengths but shared prefixes serialize differently", () => {
    expect(serializeValue("ab")).not.toBe(serializeValue("a"))
  })
})

// ---------------------------------------------------------------------------
// compareValues
// ---------------------------------------------------------------------------

describe("compareValues", () => {
  it("compares numbers", () => {
    expect(compareValues(1, 2)).toBeLessThan(0)
    expect(compareValues(2, 1)).toBeGreaterThan(0)
    expect(compareValues(3, 3)).toBe(0)
  })

  it("compares bigints", () => {
    expect(compareValues(1n, 2n)).toBeLessThan(0)
    expect(compareValues(2n, 1n)).toBeGreaterThan(0)
    expect(compareValues(3n, 3n)).toBe(0)
  })

  it("compares strings", () => {
    expect(compareValues("a", "b")).toBeLessThan(0)
    expect(compareValues("b", "a")).toBeGreaterThan(0)
    expect(compareValues("x", "x")).toBe(0)
  })

  it("returns NaN for number vs bigint", () => {
    expect(compareValues(3, 3n)).toBeNaN()
    expect(compareValues(3n, 3)).toBeNaN()
  })

  it("returns NaN for incompatible types", () => {
    expect(compareValues(3, "three")).toBeNaN()
    expect(compareValues(null, 0)).toBeNaN()
    expect(compareValues(true, 1)).toBeNaN()
  })

  it("compares null to null", () => {
    expect(compareValues(null, null)).toBe(0)
  })

  it("compares booleans", () => {
    expect(compareValues(false, true)).toBeLessThan(0)
    expect(compareValues(true, false)).toBeGreaterThan(0)
    expect(compareValues(true, true)).toBe(0)
  })

  it("compares Uint8Array lexicographically", () => {
    expect(
      compareValues(new Uint8Array([1, 2]), new Uint8Array([1, 3])),
    ).toBeLessThan(0)
    expect(compareValues(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(
      0,
    )
    expect(
      compareValues(new Uint8Array([1]), new Uint8Array([1, 2])),
    ).toBeLessThan(0)
  })

  it("compares refs by (peer, counter)", () => {
    const r1 = { ref: { peer: "alice", counter: 1 } }
    const r2 = { ref: { peer: "alice", counter: 2 } }
    const r3 = { ref: { peer: "bob", counter: 1 } }
    expect(compareValues(r1, r2)).toBeLessThan(0)
    expect(compareValues(r1, r3)).toBeLessThan(0) // 'alice' < 'bob'
    expect(compareValues(r1, r1)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Substitution helpers
// ---------------------------------------------------------------------------

describe("substitution helpers", () => {
  it("EMPTY_SUBSTITUTION has no bindings", () => {
    expect(EMPTY_SUBSTITUTION.bindings.size).toBe(0)
    expect(EMPTY_SUBSTITUTION.weight).toBe(1)
  })

  it("extendSubstitution adds a binding without mutating original", () => {
    const s1 = EMPTY_SUBSTITUTION
    const s2 = extendSubstitution(s1, "X", 42)
    expect(s1.bindings.size).toBe(0)
    expect(s2.bindings.size).toBe(1)
    expect(s2.bindings.get("X")).toBe(42)
    expect(s2.weight).toBe(1)
  })

  it("extendSubstitution can bind to null", () => {
    const s = extendSubstitution(EMPTY_SUBSTITUTION, "X", null)
    expect(s.bindings.has("X")).toBe(true)
    expect(s.bindings.get("X")).toBe(null)
  })

  it("extendSubstitution can chain bindings", () => {
    const s1 = extendSubstitution(EMPTY_SUBSTITUTION, "X", 1)
    const s2 = extendSubstitution(s1, "Y", 2)
    expect(s2.bindings.size).toBe(2)
    expect(s2.bindings.get("X")).toBe(1)
    expect(s2.bindings.get("Y")).toBe(2)
  })

  it("extendSubstitution preserves weight", () => {
    const s1: Substitution = { bindings: new Map(), weight: 3 }
    const s2 = extendSubstitution(s1, "X", 42)
    expect(s2.weight).toBe(3)
    expect(s2.bindings.get("X")).toBe(42)
  })
})

// ---------------------------------------------------------------------------
// resolveTerm
// ---------------------------------------------------------------------------

describe("resolveTerm", () => {
  it("resolves constant terms directly", () => {
    expect(resolveTerm(constTerm(42), EMPTY_SUBSTITUTION)).toBe(42)
    expect(resolveTerm(constTerm("hello"), EMPTY_SUBSTITUTION)).toBe("hello")
    expect(resolveTerm(constTerm(null), EMPTY_SUBSTITUTION)).toBe(null)
  })

  it("resolves bound variables", () => {
    const sub = extendSubstitution(EMPTY_SUBSTITUTION, "X", 99)
    expect(resolveTerm(varTerm("X"), sub)).toBe(99)
  })

  it("returns undefined for unbound variables", () => {
    expect(resolveTerm(varTerm("X"), EMPTY_SUBSTITUTION)).toBeUndefined()
  })

  it("resolves variable bound to null", () => {
    const sub = extendSubstitution(EMPTY_SUBSTITUTION, "X", null)
    expect(resolveTerm(varTerm("X"), sub)).toBe(null)
  })
})

// ---------------------------------------------------------------------------
// unifyTermWithValue
// ---------------------------------------------------------------------------

describe("unifyTermWithValue", () => {
  it("constant term unifies with equal value", () => {
    const result = unifyTermWithValue(constTerm(42), 42, EMPTY_SUBSTITUTION)
    expect(result).not.toBeNull()
  })

  it("constant term fails to unify with different value", () => {
    const result = unifyTermWithValue(constTerm(42), 43, EMPTY_SUBSTITUTION)
    expect(result).toBeNull()
  })

  it("number constant does NOT unify with equal bigint (§3)", () => {
    const result = unifyTermWithValue(constTerm(3), 3n, EMPTY_SUBSTITUTION)
    expect(result).toBeNull()
  })

  it("unbound variable unifies by binding", () => {
    const result = unifyTermWithValue(varTerm("X"), 42, EMPTY_SUBSTITUTION)
    expect(result).not.toBeNull()
    expect(result?.bindings.get("X")).toBe(42)
  })

  it("bound variable unifies if value matches", () => {
    const sub = extendSubstitution(EMPTY_SUBSTITUTION, "X", 42)
    const result = unifyTermWithValue(varTerm("X"), 42, sub)
    expect(result).not.toBeNull()
  })

  it("bound variable fails if value differs", () => {
    const sub = extendSubstitution(EMPTY_SUBSTITUTION, "X", 42)
    const result = unifyTermWithValue(varTerm("X"), 99, sub)
    expect(result).toBeNull()
  })

  it("variable can be bound to null", () => {
    const result = unifyTermWithValue(varTerm("X"), null, EMPTY_SUBSTITUTION)
    expect(result).not.toBeNull()
    expect(result?.bindings.has("X")).toBe(true)
    expect(result?.bindings.get("X")).toBe(null)
  })

  it("Uint8Array unifies by content", () => {
    const a = new Uint8Array([1, 2, 3])
    const b = new Uint8Array([1, 2, 3])
    const result = unifyTermWithValue(constTerm(a), b, EMPTY_SUBSTITUTION)
    expect(result).not.toBeNull()
  })

  it("ref unifies structurally", () => {
    const ref1 = { ref: { peer: "alice", counter: 1 } }
    const ref2 = { ref: { peer: "alice", counter: 1 } }
    const result = unifyTermWithValue(constTerm(ref1), ref2, EMPTY_SUBSTITUTION)
    expect(result).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// matchAtomWithTuple
// ---------------------------------------------------------------------------

describe("matchAtomWithTuple", () => {
  it("matches all constants", () => {
    const a = atom("edge", [constTerm("a"), constTerm("b")])
    const result = matchAtomWithTuple(a, ["a", "b"], EMPTY_SUBSTITUTION)
    expect(result).not.toBeNull()
  })

  it("fails on arity mismatch", () => {
    const a = atom("edge", [constTerm("a"), constTerm("b")])
    const result = matchAtomWithTuple(a, ["a", "b", "c"], EMPTY_SUBSTITUTION)
    expect(result).toBeNull()
  })

  it("binds variables to tuple values", () => {
    const a = atom("edge", [varTerm("X"), varTerm("Y")])
    const result = matchAtomWithTuple(a, ["a", "b"], EMPTY_SUBSTITUTION)
    expect(result).not.toBeNull()
    expect(result?.bindings.get("X")).toBe("a")
    expect(result?.bindings.get("Y")).toBe("b")
  })

  it("enforces consistent variable bindings", () => {
    // X must have the same value in both positions
    const a = atom("self_loop", [varTerm("X"), varTerm("X")])
    expect(matchAtomWithTuple(a, ["a", "a"], EMPTY_SUBSTITUTION)).not.toBeNull()
    expect(matchAtomWithTuple(a, ["a", "b"], EMPTY_SUBSTITUTION)).toBeNull()
  })

  it("extends an existing substitution", () => {
    const sub = extendSubstitution(EMPTY_SUBSTITUTION, "X", "a")
    const a = atom("edge", [varTerm("X"), varTerm("Y")])
    const result = matchAtomWithTuple(a, ["a", "b"], sub)
    expect(result).not.toBeNull()
    expect(result?.bindings.get("Y")).toBe("b")
  })

  it("fails if existing substitution conflicts", () => {
    const sub = extendSubstitution(EMPTY_SUBSTITUTION, "X", "z")
    const a = atom("edge", [varTerm("X"), varTerm("Y")])
    const result = matchAtomWithTuple(a, ["a", "b"], sub)
    expect(result).toBeNull()
  })

  it("mixes constants and variables", () => {
    const a = atom("edge", [constTerm("a"), varTerm("Y")])
    expect(matchAtomWithTuple(a, ["a", "b"], EMPTY_SUBSTITUTION)).not.toBeNull()
    expect(matchAtomWithTuple(a, ["z", "b"], EMPTY_SUBSTITUTION)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// groundAtom
// ---------------------------------------------------------------------------

describe("groundAtom", () => {
  it("grounds an atom with all constants", () => {
    const a = atom("edge", [constTerm("a"), constTerm("b")])
    const result = groundAtom(a, EMPTY_SUBSTITUTION)
    expect(result).toEqual(["a", "b"])
  })

  it("grounds an atom using substitution", () => {
    const a = atom("edge", [varTerm("X"), varTerm("Y")])
    const sub: Substitution = {
      bindings: new Map<string, Value>([
        ["X", "a"],
        ["Y", "b"],
      ]),
      weight: 1,
    }
    const result = groundAtom(a, sub)
    expect(result).toEqual(["a", "b"])
  })

  it("returns null if a variable is unbound", () => {
    const a = atom("edge", [varTerm("X"), varTerm("Y")])
    const sub = extendSubstitution(EMPTY_SUBSTITUTION, "X", "a")
    const result = groundAtom(a, sub)
    expect(result).toBeNull()
  })

  it("handles null-bound variables", () => {
    const a = atom("test", [varTerm("X")])
    const sub = extendSubstitution(EMPTY_SUBSTITUTION, "X", null)
    const result = groundAtom(a, sub)
    expect(result).toEqual([null])
  })
})

// ---------------------------------------------------------------------------
// matchAtomAgainstRelation
// ---------------------------------------------------------------------------

describe("matchAtomAgainstRelation", () => {
  it("matches against multiple tuples", () => {
    const a = atom("edge", [constTerm("a"), varTerm("Y")])
    const tuples: Value[][] = [
      ["a", "b"],
      ["a", "c"],
      ["b", "c"],
    ]
    const results = matchAtomAgainstRelation(a, tuples, EMPTY_SUBSTITUTION)
    expect(results).toHaveLength(2) // only the 'a' rows
    expect(results[0]?.bindings.get("Y")).toBe("b")
    expect(results[1]?.bindings.get("Y")).toBe("c")
  })

  it("returns empty for no matches", () => {
    const a = atom("edge", [constTerm("z"), varTerm("Y")])
    const tuples: Value[][] = [
      ["a", "b"],
      ["c", "d"],
    ]
    const results = matchAtomAgainstRelation(a, tuples, EMPTY_SUBSTITUTION)
    expect(results).toHaveLength(0)
  })

  it("returns empty for empty relation", () => {
    const a = atom("edge", [varTerm("X"), varTerm("Y")])
    const results = matchAtomAgainstRelation(a, [], EMPTY_SUBSTITUTION)
    expect(results).toHaveLength(0)
  })

  it("properly constrains across multiple matches", () => {
    const a = atom("edge", [varTerm("X"), varTerm("X")]) // self-loop
    const tuples: Value[][] = [
      ["a", "a"],
      ["a", "b"],
      ["b", "b"],
    ]
    const results = matchAtomAgainstRelation(a, tuples, EMPTY_SUBSTITUTION)
    expect(results).toHaveLength(2) // 'a','a' and 'b','b'
  })
})

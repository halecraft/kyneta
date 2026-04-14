// === CnId Tests ===
// Tests for CnId creation, equality, comparison, and string serialization.

import { describe, expect, it } from "vitest"
import {
  cnIdCompare,
  cnIdEquals,
  cnIdFromString,
  cnIdKey,
  cnIdNullableEquals,
  cnIdToString,
  createCnId,
} from "../../src/kernel/cnid.js"

describe("CnId", () => {
  // -------------------------------------------------------------------------
  // Creation
  // -------------------------------------------------------------------------

  describe("createCnId", () => {
    it("creates a CnId with the given peer and counter", () => {
      const id = createCnId("alice", 0)
      expect(id.peer).toBe("alice")
      expect(id.counter).toBe(0)
    })

    it("creates a CnId with a high counter", () => {
      const id = createCnId("bob", 999999)
      expect(id.peer).toBe("bob")
      expect(id.counter).toBe(999999)
    })

    it("creates a CnId with an empty peer string", () => {
      const id = createCnId("", 0)
      expect(id.peer).toBe("")
      expect(id.counter).toBe(0)
    })
  })

  // -------------------------------------------------------------------------
  // Equality
  // -------------------------------------------------------------------------

  describe("cnIdEquals", () => {
    it("returns true for identical CnIds", () => {
      const a = createCnId("alice", 5)
      const b = createCnId("alice", 5)
      expect(cnIdEquals(a, b)).toBe(true)
    })

    it("returns false for different peers", () => {
      const a = createCnId("alice", 5)
      const b = createCnId("bob", 5)
      expect(cnIdEquals(a, b)).toBe(false)
    })

    it("returns false for different counters", () => {
      const a = createCnId("alice", 5)
      const b = createCnId("alice", 6)
      expect(cnIdEquals(a, b)).toBe(false)
    })

    it("returns false for completely different CnIds", () => {
      const a = createCnId("alice", 0)
      const b = createCnId("bob", 1)
      expect(cnIdEquals(a, b)).toBe(false)
    })

    it("is reflexive", () => {
      const a = createCnId("alice", 3)
      expect(cnIdEquals(a, a)).toBe(true)
    })

    it("is symmetric", () => {
      const a = createCnId("alice", 3)
      const b = createCnId("alice", 3)
      expect(cnIdEquals(a, b)).toBe(cnIdEquals(b, a))
    })
  })

  describe("cnIdNullableEquals", () => {
    it("returns true for two nulls", () => {
      expect(cnIdNullableEquals(null, null)).toBe(true)
    })

    it("returns false for null vs non-null", () => {
      const a = createCnId("alice", 0)
      expect(cnIdNullableEquals(a, null)).toBe(false)
      expect(cnIdNullableEquals(null, a)).toBe(false)
    })

    it("returns true for equal non-null CnIds", () => {
      const a = createCnId("alice", 5)
      const b = createCnId("alice", 5)
      expect(cnIdNullableEquals(a, b)).toBe(true)
    })

    it("returns false for unequal non-null CnIds", () => {
      const a = createCnId("alice", 5)
      const b = createCnId("bob", 5)
      expect(cnIdNullableEquals(a, b)).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // Comparison / Ordering
  // -------------------------------------------------------------------------

  describe("cnIdCompare", () => {
    it("returns 0 for equal CnIds", () => {
      const a = createCnId("alice", 5)
      const b = createCnId("alice", 5)
      expect(cnIdCompare(a, b)).toBe(0)
    })

    it("orders by peer lexicographically first", () => {
      const alice = createCnId("alice", 100)
      const bob = createCnId("bob", 0)
      expect(cnIdCompare(alice, bob)).toBeLessThan(0)
      expect(cnIdCompare(bob, alice)).toBeGreaterThan(0)
    })

    it("orders by counter numerically when peers are equal", () => {
      const a = createCnId("alice", 3)
      const b = createCnId("alice", 7)
      expect(cnIdCompare(a, b)).toBeLessThan(0)
      expect(cnIdCompare(b, a)).toBeGreaterThan(0)
    })

    it("peer ordering takes precedence over counter", () => {
      const a = createCnId("alice", 1000)
      const b = createCnId("bob", 0)
      // 'alice' < 'bob' lexicographically, so a < b regardless of counter
      expect(cnIdCompare(a, b)).toBeLessThan(0)
    })

    it("produces a total order on a mixed set", () => {
      const ids = [
        createCnId("charlie", 2),
        createCnId("alice", 1),
        createCnId("bob", 0),
        createCnId("alice", 0),
        createCnId("bob", 3),
        createCnId("alice", 2),
      ]

      const sorted = [...ids].sort(cnIdCompare)

      expect(sorted.map(id => `${id.peer}@${id.counter}`)).toEqual([
        "alice@0",
        "alice@1",
        "alice@2",
        "bob@0",
        "bob@3",
        "charlie@2",
      ])
    })

    it("is antisymmetric: if compare(a,b) < 0 then compare(b,a) > 0", () => {
      const a = createCnId("alice", 1)
      const b = createCnId("bob", 2)
      const ab = cnIdCompare(a, b)
      const ba = cnIdCompare(b, a)
      expect(ab).toBeLessThan(0)
      expect(ba).toBeGreaterThan(0)
    })

    it("is transitive", () => {
      const a = createCnId("alice", 0)
      const b = createCnId("alice", 1)
      const c = createCnId("bob", 0)
      expect(cnIdCompare(a, b)).toBeLessThan(0)
      expect(cnIdCompare(b, c)).toBeLessThan(0)
      expect(cnIdCompare(a, c)).toBeLessThan(0)
    })
  })

  // -------------------------------------------------------------------------
  // String Serialization
  // -------------------------------------------------------------------------

  describe("cnIdToString", () => {
    it('formats as "peer@counter"', () => {
      expect(cnIdToString(createCnId("alice", 5))).toBe("alice@5")
    })

    it("handles counter 0", () => {
      expect(cnIdToString(createCnId("bob", 0))).toBe("bob@0")
    })

    it("handles large counters", () => {
      expect(cnIdToString(createCnId("alice", 1234567))).toBe("alice@1234567")
    })

    it("handles peers with special characters", () => {
      expect(cnIdToString(createCnId("peer-1", 3))).toBe("peer-1@3")
    })
  })

  describe("cnIdFromString", () => {
    it('parses a valid "peer@counter" string', () => {
      const id = cnIdFromString("alice@5")
      expect(id.peer).toBe("alice")
      expect(id.counter).toBe(5)
    })

    it("parses counter 0", () => {
      const id = cnIdFromString("bob@0")
      expect(id.peer).toBe("bob")
      expect(id.counter).toBe(0)
    })

    it("handles peers with @ in the name (uses lastIndexOf)", () => {
      const id = cnIdFromString("user@example.com@42")
      expect(id.peer).toBe("user@example.com")
      expect(id.counter).toBe(42)
    })

    it("roundtrips with cnIdToString", () => {
      const original = createCnId("alice", 99)
      const roundtripped = cnIdFromString(cnIdToString(original))
      expect(cnIdEquals(original, roundtripped)).toBe(true)
    })

    it("throws on missing @", () => {
      expect(() => cnIdFromString("alice5")).toThrow("Invalid CnId string")
    })

    it("throws on non-numeric counter", () => {
      expect(() => cnIdFromString("alice@abc")).toThrow("Invalid CnId counter")
    })
  })

  describe("cnIdKey", () => {
    it("produces the same string as cnIdToString", () => {
      const id = createCnId("alice", 7)
      expect(cnIdKey(id)).toBe(cnIdToString(id))
    })

    it("produces distinct keys for distinct CnIds", () => {
      const a = cnIdKey(createCnId("alice", 0))
      const b = cnIdKey(createCnId("alice", 1))
      const c = cnIdKey(createCnId("bob", 0))
      expect(a).not.toBe(b)
      expect(a).not.toBe(c)
      expect(b).not.toBe(c)
    })

    it("produces equal keys for equal CnIds", () => {
      const a = cnIdKey(createCnId("alice", 5))
      const b = cnIdKey(createCnId("alice", 5))
      expect(a).toBe(b)
    })
  })
})

// === Z-Set Algebra Tests ===
// Tests for the DBSP Z-set type and algebraic operations.
//
// Covers:
// - Construction (empty, singleton, fromEntries)
// - Core algebra (add, negate) with algebraic properties
// - Queries (isEmpty, size, get, has, positive, negative)
// - Iteration (forEach, map, filter)
// - Convenience (elements, keys)

import { describe, expect, it } from "vitest"
import {
  type ZSet,
  type ZSetEntry,
  zsetAdd,
  zsetElements,
  zsetEmpty,
  zsetFilter,
  zsetForEach,
  zsetFromEntries,
  zsetGet,
  zsetHas,
  zsetIsEmpty,
  zsetKeys,
  zsetMap,
  zsetNegate,
  zsetNegative,
  zsetPositive,
  zsetSingleton,
  zsetSize,
} from "../../src/base/zset.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a simple Z-set from an object of { key: weight } for testing. */
function fromWeights<T extends string>(obj: Record<T, number>): ZSet<T> {
  const entries: [string, ZSetEntry<T>][] = []
  for (const [key, weight] of Object.entries(obj) as [T, number][]) {
    entries.push([key, { element: key, weight }])
  }
  return zsetFromEntries(entries)
}

/** Extract weights as a plain object for easy assertion. */
function toWeights<T>(zs: ZSet<T>): Record<string, number> {
  const result: Record<string, number> = {}
  for (const [key, entry] of zs) {
    result[key] = entry.weight
  }
  return result
}

/** Assert two Z-sets have identical keys and weights. */
function expectSameWeights<T>(a: ZSet<T>, b: ZSet<T>): void {
  expect(toWeights(a)).toEqual(toWeights(b))
}

// ===========================================================================
// Construction
// ===========================================================================

describe("Z-Set construction", () => {
  describe("zsetEmpty", () => {
    it("creates an empty Z-set", () => {
      const zs = zsetEmpty<string>()
      expect(zsetIsEmpty(zs)).toBe(true)
      expect(zsetSize(zs)).toBe(0)
    })

    it("returns the same object on repeated calls (shared singleton)", () => {
      const a = zsetEmpty<string>()
      const b = zsetEmpty<number>()
      // They are the same empty Map instance (safe because readonly)
      expect(a).toBe(b)
    })
  })

  describe("zsetSingleton", () => {
    it("creates a single-entry Z-set with default weight +1", () => {
      const zs = zsetSingleton("a", "alice")
      expect(zsetSize(zs)).toBe(1)
      expect(zsetGet(zs, "a")).toEqual({ element: "alice", weight: 1 })
    })

    it("creates a single-entry Z-set with explicit weight", () => {
      const zs = zsetSingleton("a", "alice", -1)
      expect(zsetSize(zs)).toBe(1)
      expect(zsetGet(zs, "a")).toEqual({ element: "alice", weight: -1 })
    })

    it("creates a single-entry Z-set with weight > 1", () => {
      const zs = zsetSingleton("a", "alice", 3)
      expect(zsetGet(zs, "a")).toEqual({ element: "alice", weight: 3 })
    })

    it("returns empty Z-set when weight is 0", () => {
      const zs = zsetSingleton("a", "alice", 0)
      expect(zsetIsEmpty(zs)).toBe(true)
    })
  })

  describe("zsetFromEntries", () => {
    it("creates a Z-set from entries", () => {
      const zs = zsetFromEntries<string>([
        ["a", { element: "alice", weight: 1 }],
        ["b", { element: "bob", weight: -1 }],
      ])
      expect(zsetSize(zs)).toBe(2)
      expect(zsetGet(zs, "a")).toEqual({ element: "alice", weight: 1 })
      expect(zsetGet(zs, "b")).toEqual({ element: "bob", weight: -1 })
    })

    it("prunes zero-weight entries", () => {
      const zs = zsetFromEntries<string>([
        ["a", { element: "alice", weight: 0 }],
        ["b", { element: "bob", weight: 1 }],
      ])
      expect(zsetSize(zs)).toBe(1)
      expect(zsetHas(zs, "a")).toBe(false)
    })

    it("sums duplicate keys and prunes if zero", () => {
      const zs = zsetFromEntries<string>([
        ["a", { element: "alice", weight: 1 }],
        ["a", { element: "alice2", weight: -1 }],
      ])
      expect(zsetIsEmpty(zs)).toBe(true)
    })

    it("sums duplicate keys and keeps if non-zero", () => {
      const zs = zsetFromEntries<string>([
        ["a", { element: "alice", weight: 1 }],
        ["a", { element: "alice2", weight: 1 }],
      ])
      expect(zsetSize(zs)).toBe(1)
      expect(zsetGet(zs, "a")?.weight).toBe(2)
    })

    it("returns empty Z-set for empty input", () => {
      const zs = zsetFromEntries<string>([])
      expect(zsetIsEmpty(zs)).toBe(true)
    })

    it("returns empty Z-set when all entries cancel", () => {
      const zs = zsetFromEntries<string>([
        ["a", { element: "alice", weight: 1 }],
        ["b", { element: "bob", weight: -1 }],
        ["a", { element: "alice", weight: -1 }],
        ["b", { element: "bob", weight: 1 }],
      ])
      expect(zsetIsEmpty(zs)).toBe(true)
    })
  })
})

// ===========================================================================
// Core Algebra
// ===========================================================================

describe("Z-Set algebra", () => {
  describe("zsetAdd", () => {
    it("adding empty to anything returns that thing", () => {
      const a = fromWeights({ x: 1, y: -1 })
      const empty = zsetEmpty<string>()

      // a + 0 = a
      expect(zsetAdd(a, empty)).toBe(a)
      // 0 + a = a
      expect(zsetAdd(empty, a)).toBe(a)
    })

    it("adds disjoint Z-sets (union)", () => {
      const a = fromWeights({ x: 1 })
      const b = fromWeights({ y: -1 })
      const sum = zsetAdd(a, b)
      expect(toWeights(sum)).toEqual({ x: 1, y: -1 })
    })

    it("sums overlapping weights", () => {
      const a = fromWeights({ x: 1, y: 2 })
      const b = fromWeights({ x: 3, y: -1 })
      const sum = zsetAdd(a, b)
      expect(toWeights(sum)).toEqual({ x: 4, y: 1 })
    })

    it("prunes entries that cancel to zero", () => {
      const a = fromWeights({ x: 1, y: 2 })
      const b = fromWeights({ x: -1, y: 3 })
      const sum = zsetAdd(a, b)
      expect(toWeights(sum)).toEqual({ y: 5 })
      expect(zsetHas(sum, "x")).toBe(false)
    })

    it("returns empty when everything cancels", () => {
      const a = fromWeights({ x: 1, y: -2 })
      const b = fromWeights({ x: -1, y: 2 })
      const sum = zsetAdd(a, b)
      expect(zsetIsEmpty(sum)).toBe(true)
    })

    // --- Algebraic properties ---

    it("is commutative: add(a, b) has same weights as add(b, a)", () => {
      const a = fromWeights({ x: 1, y: -2, z: 3 })
      const b = fromWeights({ x: -1, w: 4, z: 1 })
      expectSameWeights(zsetAdd(a, b), zsetAdd(b, a))
    })

    it("is associative: add(add(a, b), c) equals add(a, add(b, c))", () => {
      const a = fromWeights({ x: 1, y: -1 })
      const b = fromWeights({ y: 2, z: -3 })
      const c = fromWeights({ x: -1, z: 3, w: 1 })

      expectSameWeights(zsetAdd(zsetAdd(a, b), c), zsetAdd(a, zsetAdd(b, c)))
    })

    it("identity: add(a, empty) equals a", () => {
      const a = fromWeights({ x: 1, y: -1 })
      expectSameWeights(zsetAdd(a, zsetEmpty()), a)
    })

    it("inverse: add(a, negate(a)) equals empty", () => {
      const a = fromWeights({ x: 1, y: -2, z: 3 })
      const sum = zsetAdd(a, zsetNegate(a))
      expect(zsetIsEmpty(sum)).toBe(true)
    })

    it("handles large Z-sets (many entries)", () => {
      const entries: [string, ZSetEntry<number>][] = []
      for (let i = 0; i < 100; i++) {
        entries.push([`k${i}`, { element: i, weight: i % 2 === 0 ? 1 : -1 }])
      }
      const a = zsetFromEntries(entries)
      const negA = zsetNegate(a)
      const sum = zsetAdd(a, negA)
      expect(zsetIsEmpty(sum)).toBe(true)
    })
  })

  describe("zsetNegate", () => {
    it("flips all weights", () => {
      const a = fromWeights({ x: 1, y: -2, z: 3 })
      const neg = zsetNegate(a)
      expect(toWeights(neg)).toEqual({ x: -1, y: 2, z: -3 })
    })

    it("negating empty returns empty", () => {
      const neg = zsetNegate(zsetEmpty<string>())
      expect(zsetIsEmpty(neg)).toBe(true)
    })

    it("double negation preserves weights", () => {
      const a = fromWeights({ x: 1, y: -2, z: 3 })
      expectSameWeights(zsetNegate(zsetNegate(a)), a)
    })

    it("preserves elements", () => {
      const zs = zsetSingleton("a", { name: "alice" }, 1)
      const neg = zsetNegate(zs)
      expect(zsetGet(neg, "a")?.element).toEqual({ name: "alice" })
      expect(zsetGet(neg, "a")?.weight).toBe(-1)
    })
  })
})

// ===========================================================================
// Queries
// ===========================================================================

describe("Z-Set queries", () => {
  describe("zsetIsEmpty / zsetSize", () => {
    it("empty Z-set has size 0 and isEmpty true", () => {
      expect(zsetIsEmpty(zsetEmpty())).toBe(true)
      expect(zsetSize(zsetEmpty())).toBe(0)
    })

    it("non-empty Z-set has correct size and isEmpty false", () => {
      const zs = fromWeights({ a: 1, b: -1, c: 2 })
      expect(zsetIsEmpty(zs)).toBe(false)
      expect(zsetSize(zs)).toBe(3)
    })
  })

  describe("zsetGet / zsetHas", () => {
    it("returns entry for existing key", () => {
      const zs = zsetSingleton("a", "alice", -1)
      expect(zsetHas(zs, "a")).toBe(true)
      expect(zsetGet(zs, "a")).toEqual({ element: "alice", weight: -1 })
    })

    it("returns undefined for missing key", () => {
      const zs = zsetSingleton("a", "alice")
      expect(zsetHas(zs, "b")).toBe(false)
      expect(zsetGet(zs, "b")).toBeUndefined()
    })
  })

  describe("zsetPositive", () => {
    it("extracts only positive-weight entries", () => {
      const zs = fromWeights({ a: 1, b: -1, c: 3, d: -2 })
      const pos = zsetPositive(zs)
      expect(toWeights(pos)).toEqual({ a: 1, c: 3 })
    })

    it("returns empty for all-negative Z-set", () => {
      const zs = fromWeights({ a: -1, b: -2 })
      expect(zsetIsEmpty(zsetPositive(zs))).toBe(true)
    })

    it("returns same Z-set for all-positive Z-set", () => {
      const zs = fromWeights({ a: 1, b: 2 })
      const pos = zsetPositive(zs)
      expect(toWeights(pos)).toEqual({ a: 1, b: 2 })
    })

    it("returns empty for empty Z-set", () => {
      expect(zsetIsEmpty(zsetPositive(zsetEmpty()))).toBe(true)
    })
  })

  describe("zsetNegative", () => {
    it("extracts only negative-weight entries", () => {
      const zs = fromWeights({ a: 1, b: -1, c: 3, d: -2 })
      const neg = zsetNegative(zs)
      expect(toWeights(neg)).toEqual({ b: -1, d: -2 })
    })

    it("returns empty for all-positive Z-set", () => {
      const zs = fromWeights({ a: 1, b: 2 })
      expect(zsetIsEmpty(zsetNegative(zs))).toBe(true)
    })

    it("returns same weights for all-negative Z-set", () => {
      const zs = fromWeights({ a: -1, b: -2 })
      const neg = zsetNegative(zs)
      expect(toWeights(neg)).toEqual({ a: -1, b: -2 })
    })

    it("returns empty for empty Z-set", () => {
      expect(zsetIsEmpty(zsetNegative(zsetEmpty()))).toBe(true)
    })
  })

  describe("positive + negative partition", () => {
    it("positive and negative are disjoint and their sum reconstructs the original", () => {
      const zs = fromWeights({ a: 1, b: -1, c: 3, d: -2, e: 1 })
      const pos = zsetPositive(zs)
      const neg = zsetNegative(zs)

      // Disjoint: no key appears in both
      for (const key of pos.keys()) {
        expect(neg.has(key)).toBe(false)
      }

      // Sum reconstructs original
      const reconstructed = zsetAdd(pos, neg)
      expectSameWeights(reconstructed, zs)
    })
  })
})

// ===========================================================================
// Iteration & Transformation
// ===========================================================================

describe("Z-Set iteration", () => {
  describe("zsetForEach", () => {
    it("visits every entry", () => {
      const zs = fromWeights({ a: 1, b: -1, c: 2 })
      const visited: [string, number][] = []
      zsetForEach(zs, (entry, key) => {
        visited.push([key, entry.weight])
      })
      expect(visited.sort()).toEqual(
        [
          ["a", 1],
          ["b", -1],
          ["c", 2],
        ].sort(),
      )
    })

    it("does nothing for empty Z-set", () => {
      let count = 0
      zsetForEach(zsetEmpty(), () => {
        count++
      })
      expect(count).toBe(0)
    })
  })

  describe("zsetMap", () => {
    it("transforms elements and re-keys", () => {
      const zs = zsetFromEntries<number>([
        ["k1", { element: 10, weight: 1 }],
        ["k2", { element: 20, weight: -1 }],
      ])

      // Double each number, re-key by the new value
      const mapped = zsetMap(
        zs,
        (n: number) => `v${n}`,
        (n: number) => n * 2,
      )

      expect(zsetSize(mapped)).toBe(2)
      expect(zsetGet(mapped, "v20")).toEqual({ element: 20, weight: 1 })
      expect(zsetGet(mapped, "v40")).toEqual({ element: 40, weight: -1 })
    })

    it("merges entries that map to the same key", () => {
      const zs = zsetFromEntries<number>([
        ["k1", { element: 1, weight: 1 }],
        ["k2", { element: 2, weight: 1 }],
      ])

      // Map both to the same key
      const mapped = zsetMap(
        zs,
        () => "same",
        (n: number) => n * 10,
      )

      expect(zsetSize(mapped)).toBe(1)
      expect(zsetGet(mapped, "same")?.weight).toBe(2)
    })

    it("prunes entries that cancel after merging", () => {
      const zs = zsetFromEntries<number>([
        ["k1", { element: 1, weight: 1 }],
        ["k2", { element: 2, weight: -1 }],
      ])

      // Map both to the same key — weights cancel
      const mapped = zsetMap(
        zs,
        () => "same",
        (n: number) => n,
      )

      expect(zsetIsEmpty(mapped)).toBe(true)
    })

    it("preserves weights", () => {
      const zs = zsetSingleton("a", "hello", 3)
      const mapped = zsetMap(
        zs,
        (s: string) => s,
        (s: string) => s.toUpperCase(),
      )
      expect(zsetGet(mapped, "HELLO")).toEqual({ element: "HELLO", weight: 3 })
    })

    it("returns empty for empty input", () => {
      const mapped = zsetMap(
        zsetEmpty<number>(),
        (n: number) => `${n}`,
        (n: number) => n,
      )
      expect(zsetIsEmpty(mapped)).toBe(true)
    })
  })

  describe("zsetFilter", () => {
    it("keeps entries matching predicate", () => {
      const zs = fromWeights({ a: 1, b: -1, c: 3, d: -2 })
      const filtered = zsetFilter(zs, entry => entry.weight > 0)
      expect(toWeights(filtered)).toEqual({ a: 1, c: 3 })
    })

    it("returns empty when nothing matches", () => {
      const zs = fromWeights({ a: 1, b: 2 })
      const filtered = zsetFilter(zs, entry => entry.weight < 0)
      expect(zsetIsEmpty(filtered)).toBe(true)
    })

    it("returns same Z-set when everything matches", () => {
      const zs = fromWeights({ a: 1, b: 2 })
      const filtered = zsetFilter(zs, () => true)
      // Should be the same object (optimization)
      expect(filtered).toBe(zs)
    })

    it("can filter by key", () => {
      const zs = fromWeights({ apple: 1, banana: -1, avocado: 2 })
      const filtered = zsetFilter(zs, (_entry, key) => key.startsWith("a"))
      expect(toWeights(filtered)).toEqual({ apple: 1, avocado: 2 })
    })

    it("returns empty for empty input", () => {
      const filtered = zsetFilter(zsetEmpty(), () => true)
      expect(zsetIsEmpty(filtered)).toBe(true)
    })
  })
})

// ===========================================================================
// Convenience
// ===========================================================================

describe("Z-Set convenience", () => {
  describe("zsetElements", () => {
    it("extracts all elements", () => {
      const zs = zsetFromEntries<string>([
        ["a", { element: "alice", weight: 1 }],
        ["b", { element: "bob", weight: -1 }],
      ])
      const elements = zsetElements(zs)
      expect(elements.sort()).toEqual(["alice", "bob"])
    })

    it("returns empty array for empty Z-set", () => {
      expect(zsetElements(zsetEmpty())).toEqual([])
    })
  })

  describe("zsetKeys", () => {
    it("extracts all keys", () => {
      const zs = fromWeights({ x: 1, y: -1, z: 2 })
      expect(zsetKeys(zs).sort()).toEqual(["x", "y", "z"])
    })

    it("returns empty array for empty Z-set", () => {
      expect(zsetKeys(zsetEmpty())).toEqual([])
    })
  })
})

// ===========================================================================
// Edge cases and integration
// ===========================================================================

describe("Z-Set edge cases", () => {
  it("handles weights beyond ±1 (multiset)", () => {
    const a = zsetSingleton("x", "val", 5)
    const b = zsetSingleton("x", "val", -3)
    const sum = zsetAdd(a, b)
    expect(zsetGet(sum, "x")?.weight).toBe(2)
  })

  it("chained additions produce correct accumulated result", () => {
    // Simulate incremental insertions: +1, +1, -1, +1
    let acc = zsetEmpty<string>()
    acc = zsetAdd(acc, zsetSingleton("a", "a", 1))
    acc = zsetAdd(acc, zsetSingleton("b", "b", 1))
    acc = zsetAdd(acc, zsetSingleton("a", "a", -1)) // retract a
    acc = zsetAdd(acc, zsetSingleton("c", "c", 1))

    expect(toWeights(acc)).toEqual({ b: 1, c: 1 })
  })

  it("negate then add produces inverse delta", () => {
    const state = fromWeights({ a: 1, b: 1, c: 1 })
    const removal = zsetNegate(zsetSingleton("b", "b", 1))
    const newState = zsetAdd(state, removal)
    expect(toWeights(newState)).toEqual({ a: 1, c: 1 })
  })

  it("complex scenario: retraction cascade as Z-set operations", () => {
    // Simulate: V is active (+1), R retracts V (V: -1, R: +1),
    // U undoes R (R: -1, V: +1, U: +1)
    let active = zsetEmpty<string>()

    // V arrives
    active = zsetAdd(active, zsetSingleton("V", "value", 1))
    expect(toWeights(active)).toEqual({ V: 1 })

    // R retracts V: V becomes dominated, R is active
    const retractDelta = zsetFromEntries<string>([
      ["V", { element: "value", weight: -1 }],
      ["R", { element: "retract", weight: 1 }],
    ])
    active = zsetAdd(active, retractDelta)
    expect(toWeights(active)).toEqual({ R: 1 })

    // U undoes R: R becomes dominated, V re-activates, U is active
    const undoDelta = zsetFromEntries<string>([
      ["R", { element: "retract", weight: -1 }],
      ["V", { element: "value", weight: 1 }],
      ["U", { element: "undo", weight: 1 }],
    ])
    active = zsetAdd(active, undoDelta)
    expect(toWeights(active)).toEqual({ V: 1, U: 1 })
  })

  it("add preserves element from b (the delta) on overlap", () => {
    // When two Z-sets share a key and weights don't cancel,
    // the element from b (the second argument) should be preserved.
    const a = zsetSingleton("k", { version: 1 }, 1)
    const b = zsetSingleton("k", { version: 2 }, 1)
    const sum = zsetAdd(a, b)
    expect(zsetGet(sum, "k")?.element).toEqual({ version: 2 })
    expect(zsetGet(sum, "k")?.weight).toBe(2)
  })

  it("fromEntries accepts generator/iterator", () => {
    function* gen(): Generator<[string, ZSetEntry<string>]> {
      yield ["a", { element: "alice", weight: 1 }]
      yield ["b", { element: "bob", weight: -1 }]
    }
    const zs = zsetFromEntries(gen())
    expect(zsetSize(zs)).toBe(2)
  })
})

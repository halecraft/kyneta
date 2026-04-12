import { describe, expect, it } from "vitest"
import {
  add,
  entries,
  fromKeys,
  isEmpty,
  negate,
  positive,
  single,
  toAdded,
  toRemoved,
  zero,
} from "../zset.js"

describe("ZSet — abelian group", () => {
  // Group axioms
  it("zero() returns an empty map", () => {
    expect(isEmpty(zero())).toBe(true)
    expect(zero().size).toBe(0)
  })

  it("single(key) creates a singleton with weight 1", () => {
    const z = single("a")
    expect(z.get("a")).toBe(1)
    expect(z.size).toBe(1)
  })

  it("single(key, weight) creates a singleton with given weight", () => {
    const z = single("a", 3)
    expect(z.get("a")).toBe(3)
  })

  it("single(key, 0) returns zero", () => {
    expect(isEmpty(single("a", 0))).toBe(true)
  })

  // Identity: add(a, zero()) = a
  it("add(a, zero()) = a (right identity)", () => {
    const a = single("x", 2)
    const result = add(a, zero())
    expect(result).toBe(a) // same reference — fast path
  })

  it("add(zero(), a) = a (left identity)", () => {
    const a = single("x", 2)
    const result = add(zero(), a)
    expect(result).toBe(a)
  })

  // Inverse: add(a, negate(a)) = zero()
  it("add(a, negate(a)) = zero()", () => {
    const a = fromKeys(["x", "y", "z"])
    const result = add(a, negate(a))
    expect(isEmpty(result)).toBe(true)
  })

  // Commutativity: add(a, b) = add(b, a)
  it("add is commutative", () => {
    const a = single("x", 2)
    const b = single("y", 3)
    const ab = add(a, b)
    const ba = add(b, a)
    expect([...ab].sort()).toEqual([...ba].sort())
  })

  // Associativity: add(add(a, b), c) = add(a, add(b, c))
  it("add is associative", () => {
    const a = single("x", 1)
    const b = single("y", 2)
    const c = single("x", -1) // cancels with a

    const lhs = add(add(a, b), c)
    const rhs = add(a, add(b, c))

    expect(lhs.size).toBe(rhs.size)
    for (const [key, w] of lhs) {
      expect(rhs.get(key)).toBe(w)
    }
  })

  // Cancellation
  it("adding opposite weights cancels out (entry removed from map)", () => {
    const a = single("k", 1)
    const b = single("k", -1)
    const result = add(a, b)
    expect(isEmpty(result)).toBe(true)
    expect(result.has("k")).toBe(false)
  })

  it("partial cancellation preserves remaining weight", () => {
    const a = single("k", 3)
    const b = single("k", -1)
    const result = add(a, b)
    expect(result.get("k")).toBe(2)
  })

  // negate
  it("negate flips all weights", () => {
    const a = fromKeys(["a", "b"])
    const neg = negate(a)
    expect(neg.get("a")).toBe(-1)
    expect(neg.get("b")).toBe(-1)
  })

  it("negate(zero()) = zero()", () => {
    expect(isEmpty(negate(zero()))).toBe(true)
  })

  // isEmpty
  it("isEmpty returns true for zero()", () => {
    expect(isEmpty(zero())).toBe(true)
  })

  it("isEmpty returns false for non-empty", () => {
    expect(isEmpty(single("a"))).toBe(false)
  })

  // positive (distinct)
  it("positive clamps positive weights to 1", () => {
    const z = single("a", 5)
    const p = positive(z)
    expect(p.get("a")).toBe(1)
  })

  it("positive discards non-positive weights", () => {
    const z = add(single("a", 1), single("b", -1))
    const p = positive(z)
    expect(p.size).toBe(1)
    expect(p.get("a")).toBe(1)
    expect(p.has("b")).toBe(false)
  })

  it("positive(zero()) = zero()", () => {
    expect(isEmpty(positive(zero()))).toBe(true)
  })

  // fromKeys
  it("fromKeys creates +1 for each key", () => {
    const z = fromKeys(["a", "b", "c"])
    expect(z.size).toBe(3)
    expect(z.get("a")).toBe(1)
    expect(z.get("b")).toBe(1)
    expect(z.get("c")).toBe(1)
  })

  it("fromKeys handles duplicate keys by summing", () => {
    const z = fromKeys(["a", "a", "b"])
    expect(z.get("a")).toBe(2)
    expect(z.get("b")).toBe(1)
  })

  it("fromKeys([]) returns zero()", () => {
    expect(isEmpty(fromKeys([]))).toBe(true)
  })

  // entries
  it("entries iterates all non-zero entries", () => {
    const z = add(single("a", 1), single("b", -2))
    const e = [...entries(z)].sort(([a], [b]) => a.localeCompare(b))
    expect(e).toEqual([
      ["a", 1],
      ["b", -2],
    ])
  })

  // toAdded / toRemoved
  it("toAdded returns keys with positive weight", () => {
    const z = add(single("a", 1), single("b", -1))
    expect(toAdded(z).sort()).toEqual(["a"])
  })

  it("toRemoved returns keys with negative weight", () => {
    const z = add(single("a", 1), single("b", -1))
    expect(toRemoved(z).sort()).toEqual(["b"])
  })

  it("toAdded and toRemoved are disjoint and cover all entries", () => {
    const z = add(add(single("a", 2), single("b", -3)), single("c", 1))
    const added = toAdded(z)
    const removed = toRemoved(z)
    expect(added.sort()).toEqual(["a", "c"])
    expect(removed.sort()).toEqual(["b"])
  })

  // Multi-key add
  it("add merges two multi-key ℤ-sets correctly", () => {
    const a = fromKeys(["x", "y"]) // x→1, y→1
    const b = add(single("y", -1), single("z", 1)) // y→-1, z→1
    const result = add(a, b)
    expect(result.get("x")).toBe(1)
    expect(result.has("y")).toBe(false) // cancelled
    expect(result.get("z")).toBe(1)
    expect(result.size).toBe(2)
  })
})

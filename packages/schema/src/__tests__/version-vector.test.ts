import { describe, expect, it } from "vitest"
import { versionVectorCompare, versionVectorMeet } from "../version-vector.js"

describe("versionVectorMeet", () => {
  it("returns component-wise minimum for overlapping keys", () => {
    const a = new Map([
      ["A", 5],
      ["B", 3],
    ])
    const b = new Map([
      ["A", 2],
      ["B", 7],
    ])
    const result = versionVectorMeet(a, b)
    expect(result).toEqual(
      new Map([
        ["A", 2],
        ["B", 3],
      ]),
    )
  })

  it("omits keys only present in one map (absent defaults to 0)", () => {
    const a = new Map([["A", 5]])
    const b = new Map([["B", 3]])
    const result = versionVectorMeet(a, b)
    expect(result.size).toBe(0)
  })

  it("empty map is the lattice bottom", () => {
    const a = new Map([
      ["A", 5],
      ["B", 3],
    ])
    const b = new Map<string, number>()
    expect(versionVectorMeet(a, b).size).toBe(0)
    expect(versionVectorMeet(b, a).size).toBe(0)
  })

  it("is idempotent", () => {
    const m = new Map([
      ["X", 3],
      ["Y", 7],
    ])
    expect(versionVectorMeet(m, m)).toEqual(m)
  })

  it("is commutative", () => {
    const a = new Map([
      ["A", 5],
      ["B", 3],
      ["C", 1],
    ])
    const b = new Map([
      ["A", 2],
      ["B", 7],
      ["D", 4],
    ])
    expect(versionVectorMeet(a, b)).toEqual(versionVectorMeet(b, a))
  })

  it("is associative", () => {
    const a = new Map([
      ["X", 5],
      ["Y", 3],
    ])
    const b = new Map([
      ["X", 2],
      ["Y", 7],
    ])
    const c = new Map([
      ["X", 4],
      ["Y", 1],
    ])
    const ab_c = versionVectorMeet(versionVectorMeet(a, b), c)
    const a_bc = versionVectorMeet(a, versionVectorMeet(b, c))
    expect(ab_c).toEqual(a_bc)
  })

  it("works with numeric keys (Yjs clientID)", () => {
    const a = new Map([
      [1, 10],
      [2, 20],
    ])
    const b = new Map([
      [1, 5],
      [3, 15],
    ])
    const result = versionVectorMeet(a, b)
    expect(result).toEqual(new Map([[1, 5]]))
  })
})

describe("versionVectorCompare", () => {
  it("returns 'equal' for identical maps", () => {
    const a = new Map([
      ["A", 5],
      ["B", 3],
    ])
    expect(versionVectorCompare(a, a)).toBe("equal")
  })

  it("returns 'equal' for two empty maps", () => {
    const a = new Map<string, number>()
    const b = new Map<string, number>()
    expect(versionVectorCompare(a, b)).toBe("equal")
  })

  it("returns 'behind' when all components ≤ and at least one strictly less", () => {
    const a = new Map([
      ["A", 2],
      ["B", 3],
    ])
    const b = new Map([
      ["A", 5],
      ["B", 3],
    ])
    expect(versionVectorCompare(a, b)).toBe("behind")
  })

  it("returns 'ahead' when all components ≥ and at least one strictly greater", () => {
    const a = new Map([
      ["A", 5],
      ["B", 7],
    ])
    const b = new Map([
      ["A", 5],
      ["B", 3],
    ])
    expect(versionVectorCompare(a, b)).toBe("ahead")
  })

  it("returns 'concurrent' when some less and some greater", () => {
    const a = new Map([
      ["A", 2],
      ["B", 7],
    ])
    const b = new Map([
      ["A", 5],
      ["B", 3],
    ])
    expect(versionVectorCompare(a, b)).toBe("concurrent")
  })

  it("returns 'concurrent' for disjoint keys", () => {
    const a = new Map([["A", 5]])
    const b = new Map([["B", 3]])
    expect(versionVectorCompare(a, b)).toBe("concurrent")
  })

  it("returns 'behind' when empty vs non-empty", () => {
    const a = new Map<string, number>()
    const b = new Map([["A", 5]])
    expect(versionVectorCompare(a, b)).toBe("behind")
  })

  it("returns 'ahead' when non-empty vs empty", () => {
    const a = new Map([["A", 5]])
    const b = new Map<string, number>()
    expect(versionVectorCompare(a, b)).toBe("ahead")
  })

  it("is reflexive: compare(a, a) = 'equal'", () => {
    const a = new Map([
      ["X", 3],
      ["Y", 7],
      ["Z", 1],
    ])
    expect(versionVectorCompare(a, a)).toBe("equal")
  })

  it("is antisymmetric: behind ↔ ahead", () => {
    const a = new Map([
      ["A", 2],
      ["B", 3],
    ])
    const b = new Map([
      ["A", 5],
      ["B", 7],
    ])
    expect(versionVectorCompare(a, b)).toBe("behind")
    expect(versionVectorCompare(b, a)).toBe("ahead")
  })

  it("works with numeric keys (Yjs clientID)", () => {
    const a = new Map([
      [1, 10],
      [2, 5],
    ])
    const b = new Map([
      [1, 10],
      [2, 20],
    ])
    expect(versionVectorCompare(a, b)).toBe("behind")
  })
})

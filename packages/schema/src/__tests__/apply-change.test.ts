// apply-change — σ is advanced copy-on-write: a write copies exactly the
// frozen nodes on its path, and changes everything else in place.
import { describe, expect, it, vi } from "vitest"
import { mapChange, replaceChange, trustAsOwned } from "../change.js"
import { freezeTree, isDeeplyFrozen } from "../clone.js"
import { RawPath } from "../path.js"
import { applyChange, type StateCell } from "../reader.js"

const at = (...keys: string[]) =>
  keys.reduce((path, key) => path.field(key), RawPath.empty)

function state() {
  return {
    a: { b: { c: 1 }, sibling: { d: 2 } },
    other: { e: 3 },
  }
}

describe("applyChange", () => {
  it("a write under a frozen node copies exactly the frozen nodes on its spine", () => {
    const root = freezeTree(state())
    const cell: StateCell = { current: root }
    applyChange(cell, at("a", "b", "c"), replaceChange(9))

    const next = cell.current as ReturnType<typeof state>
    expect(next).not.toBe(root)
    expect(next.a).not.toBe(root.a)
    expect(next.a.b).not.toBe(root.a.b)
    expect(next.a.b.c).toBe(9)
    expect(next.a.sibling).toBe(root.a.sibling)
    expect(next.other).toBe(root.other)
    expect(root.a.b.c).toBe(1)
  })

  it("a write where nothing is frozen copies nothing", () => {
    const root = state()
    const { a } = root
    const { b } = a
    const cell: StateCell = { current: root }
    applyChange(cell, at("a", "b", "c"), replaceChange(9))
    expect(cell.current).toBe(root)
    expect(root.a).toBe(a)
    expect(root.a.b).toBe(b)
    expect(b.c).toBe(9)
  })

  it("copies only where a read froze: a frozen leaf container under unfrozen parents", () => {
    const root = state()
    freezeTree(root.a.b)
    const { a } = root
    const cell: StateCell = { current: root }
    applyChange(cell, at("a", "b"), mapChange(trustAsOwned({ c: 5 })))
    expect(cell.current).toBe(root)
    expect(root.a).toBe(a)
    expect(root.a.b).toEqual({ c: 5 })
    expect(Object.isFrozen(root.a.b)).toBe(false)
  })

  it("a frozen root is replaced in the cell", () => {
    const root = freezeTree(state())
    const cell: StateCell = { current: root }
    applyChange(cell, at("other"), mapChange(trustAsOwned({ f: 4 })))
    expect(cell.current).not.toBe(root)
    expect(cell.current.other).toEqual({ e: 3, f: 4 })
    expect(cell.current.a).toBe(root.a)
  })

  it("a write at the root of a frozen document replaces it", () => {
    const root = freezeTree(state())
    const cell: StateCell = { current: root }
    applyChange(cell, RawPath.empty, mapChange(undefined, ["other"]))
    expect(cell.current).not.toBe(root)
    expect(Object.keys(cell.current)).toEqual(["a"])
    expect(Object.keys(root)).toEqual(["a", "other"])
  })

  it("a write into a tree node's data under a frozen forest copies the array, the node and the data", () => {
    const forest = [
      { id: "n1", parent: null, index: 0, data: { label: "a" } },
      { id: "n2", parent: null, index: 1, data: { label: "b" } },
    ]
    const root = freezeTree({ tree: forest })
    const cell: StateCell = { current: root }
    applyChange(
      cell,
      RawPath.empty.field("tree").entry("n1").field("label"),
      replaceChange("A"),
    )
    const next = cell.current.tree as typeof forest
    expect(next).not.toBe(forest)
    expect(next[0]).not.toBe(forest[0])
    expect(next[0]?.data).toEqual({ label: "A" })
    expect(next[1]).toBe(forest[1])
    expect(forest[0]?.data.label).toBe("a")
  })

  it("a missing intermediate container is created", () => {
    const cell: StateCell = { current: {} }
    applyChange(cell, at("x", "y"), replaceChange(1))
    expect(cell.current).toEqual({ x: { y: 1 } })
  })
})

describe("freezeTree", () => {
  it("freezes everything below, and returns its argument", () => {
    const value = { a: [{ b: 1 }] }
    expect(freezeTree(value)).toBe(value)
    expect(isDeeplyFrozen(value)).toBe(true)
  })

  it("stops at a node already frozen", () => {
    const frozen = freezeTree({ deep: { deeper: [1, 2] } })
    const value = { fresh: {}, frozen }
    const spy = vi.spyOn(Object, "freeze")
    try {
      freezeTree(value)
      const frozenArgs = spy.mock.calls.map(([arg]) => arg)
      expect(frozenArgs).toContain(value)
      expect(frozenArgs).toContain(value.fresh)
      expect(frozenArgs).not.toContain(frozen)
      expect(frozenArgs).not.toContain(frozen.deep)
      expect(frozenArgs).toHaveLength(2)
    } finally {
      spy.mockRestore()
    }
  })

  it("leaves a byte array as it is", () => {
    const bytes = new Uint8Array([1, 2])
    const value = freezeTree({ bytes })
    expect(value.bytes).toBe(bytes)
    bytes[0] = 7
    expect(value.bytes[0]).toBe(7)
  })
})

describe("isDeeplyFrozen", () => {
  it("is true for primitives and for a value frozen all the way down", () => {
    expect(isDeeplyFrozen(1)).toBe(true)
    expect(isDeeplyFrozen(null)).toBe(true)
    expect(isDeeplyFrozen(freezeTree({ a: [{ b: 1 }] }))).toBe(true)
  })

  it("is false for a shallow-frozen object with a mutable child", () => {
    expect(isDeeplyFrozen(Object.freeze({ a: { b: 1 } }))).toBe(false)
  })

  it("is false at a byte array", () => {
    expect(isDeeplyFrozen(new Uint8Array([1]))).toBe(false)
    expect(isDeeplyFrozen(freezeTree({ b: new Uint8Array([1]) }))).toBe(false)
  })
})

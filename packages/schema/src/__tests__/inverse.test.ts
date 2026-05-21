// inverse.test — pin the groupoid identity law for every change constructor.
//
// The change algebra `⟨State, Change, step⟩` is extended into a groupoid
// by `invert`: every `(state, change)` pair has a reverse arrow such that
//
//   step(step(state, change), invert(state, change)) = state
//
// — the groupoid identity law `c ∘ c⁻¹ = id` in coordinates. This file
// table-tests that law for every change constructor. The whole abort
// story rests on it.

import { describe, expect, it } from "vitest"
import {
  incrementChange,
  mapChange,
  replaceChange,
  richTextChange,
  sequenceChange,
  setOpChange,
  textChange,
  treeChange,
} from "../change.js"
import { invert } from "../inverse.js"
import { step } from "../step.js"

describe("inverse: groupoid identity — replace", () => {
  it("scalar string", () => {
    const pre = "hello"
    const c = replaceChange("world")
    const next = step(pre, c)
    const inv = invert(pre, c)
    expect(step(next, inv)).toEqual(pre)
  })

  it("scalar number", () => {
    const pre = 42
    const c = replaceChange(99)
    expect(step(step(pre, c), invert(pre, c))).toEqual(pre)
  })

  it("object replace", () => {
    const pre = { a: 1, b: [1, 2] }
    const c = replaceChange({ a: 2 })
    expect(step(step(pre, c), invert(pre, c))).toEqual(pre)
  })

  it("array replace", () => {
    const pre = [1, 2, 3]
    const c = replaceChange([4, 5])
    expect(step(step(pre, c), invert(pre, c))).toEqual(pre)
  })

  it("undefined → value", () => {
    const pre = undefined
    const c = replaceChange("now defined")
    expect(step(step(pre, c), invert(pre, c))).toEqual(pre)
  })

  it("value → undefined", () => {
    const pre = "had value"
    const c = replaceChange(undefined)
    expect(step(step(pre, c), invert(pre, c))).toEqual(pre)
  })
})

describe("inverse: groupoid identity — increment", () => {
  it("positive amount", () => {
    const pre = 10
    const c = incrementChange(5)
    expect(step(step(pre, c), invert(pre, c))).toEqual(pre)
  })

  it("negative amount", () => {
    const pre = 100
    const c = incrementChange(-30)
    expect(step(step(pre, c), invert(pre, c))).toEqual(pre)
  })

  it("zero round-trips trivially", () => {
    const pre = 7
    const c = incrementChange(0)
    expect(step(step(pre, c), invert(pre, c))).toEqual(pre)
  })
})

describe("inverse: groupoid identity — text", () => {
  it("pure retain", () => {
    const pre = "hello"
    const c = textChange([{ retain: 5 }])
    expect(step(step(pre, c), invert(pre, c))).toEqual(pre)
  })

  it("insert at start", () => {
    const pre = "world"
    const c = textChange([{ insert: "hello " }])
    expect(step(step(pre, c), invert(pre, c))).toEqual(pre)
  })

  it("insert at end", () => {
    const pre = "hello"
    const c = textChange([{ retain: 5 }, { insert: " world" }])
    expect(step(step(pre, c), invert(pre, c))).toEqual(pre)
  })

  it("delete from middle", () => {
    const pre = "abcdef"
    const c = textChange([{ retain: 2 }, { delete: 2 }])
    expect(step(step(pre, c), invert(pre, c))).toEqual(pre)
  })

  it("mixed insert and delete", () => {
    const pre = "Hello World"
    const c = textChange([{ retain: 6 }, { delete: 5 }, { insert: "Kyneta" }])
    expect(step(step(pre, c), invert(pre, c))).toEqual(pre)
  })

  it("delete then insert at same position", () => {
    const pre = "alpha"
    const c = textChange([{ delete: 5 }, { insert: "beta" }])
    expect(step(step(pre, c), invert(pre, c))).toEqual(pre)
  })
})

describe("inverse: groupoid identity — sequence", () => {
  it("push", () => {
    const pre = [1, 2, 3]
    const c = sequenceChange([{ retain: 3 }, { insert: [4, 5] }])
    expect(step(step(pre, c), invert(pre, c))).toEqual(pre)
  })

  it("insert at index 0", () => {
    const pre = [1, 2, 3]
    const c = sequenceChange([{ insert: [0] }])
    expect(step(step(pre, c), invert(pre, c))).toEqual(pre)
  })

  it("insert at index 1", () => {
    const pre = [1, 2, 3]
    const c = sequenceChange([{ retain: 1 }, { insert: [99] }])
    expect(step(step(pre, c), invert(pre, c))).toEqual(pre)
  })

  it("delete range", () => {
    const pre = [10, 20, 30, 40, 50]
    const c = sequenceChange([{ retain: 1 }, { delete: 2 }])
    expect(step(step(pre, c), invert(pre, c))).toEqual(pre)
  })

  it("delete with deep-cloned items (object items)", () => {
    const pre = [{ a: 1 }, { b: 2 }]
    const c = sequenceChange([{ delete: 1 }])
    // Verify the round-trip
    expect(step(step(pre, c), invert(pre, c))).toEqual(pre)
    // Verify the inverse deep-clones — mutating an item in `pre`
    // after computing inverse shouldn't corrupt the inverse.
    const inv = invert(pre, c)
    ;(pre[0] as any).a = 999
    const restored = step(step([{ a: 1 }, { b: 2 }], c), inv)
    expect((restored[0] as any).a).toBe(1)
  })

  it("mixed insert and delete", () => {
    const pre = ["a", "b", "c", "d"]
    const c = sequenceChange([
      { retain: 1 },
      { delete: 1 },
      { insert: ["X", "Y"] },
    ])
    expect(step(step(pre, c), invert(pre, c))).toEqual(pre)
  })
})

describe("inverse: groupoid identity — map", () => {
  it("set new key", () => {
    const pre = { a: 1 }
    const c = mapChange({ b: 2 })
    expect(step(step(pre, c), invert(pre, c))).toEqual(pre)
  })

  it("set existing key (overwrite)", () => {
    const pre = { a: 1, b: 2 }
    const c = mapChange({ a: 99 })
    expect(step(step(pre, c), invert(pre, c))).toEqual(pre)
  })

  it("delete existing key", () => {
    const pre = { a: 1, b: 2 }
    const c = mapChange(undefined, ["a"])
    expect(step(step(pre, c), invert(pre, c))).toEqual(pre)
  })

  it("delete non-existent key (no-op forward; no-op inverse)", () => {
    const pre = { a: 1 }
    const c = mapChange(undefined, ["nonexistent"])
    expect(step(step(pre, c), invert(pre, c))).toEqual(pre)
  })

  it("mixed set + delete", () => {
    const pre = { a: 1, b: 2, c: 3 }
    const c = mapChange({ a: 99, d: 4 }, ["b"])
    expect(step(step(pre, c), invert(pre, c))).toEqual(pre)
  })

  it("nested-value set deep-clones the pre-state", () => {
    const pre = { obj: { x: 1 } }
    const c = mapChange({ obj: { x: 2 } })
    const inv = invert(pre, c)
    // Mutate pre — inverse should be unaffected
    ;(pre.obj as any).x = 999
    const restored = step(step({ obj: { x: 1 } }, c), inv)
    expect((restored.obj as any).x).toBe(1)
  })
})

describe("inverse: groupoid identity — set (membership equality, not order)", () => {
  // Sets are unordered: round-trip preserves *membership* but not insertion
  // order (a re-added member lands at the end, not its original index).
  // The groupoid identity holds modulo set permutation. Tests compare
  // sorted arrays.
  const sortedMembers = (arr: readonly string[]): string[] => [...arr].sort()

  it("add new value", () => {
    const pre: string[] = ["a"]
    const c = setOpChange<string>(["b"])
    expect(sortedMembers(step(step(pre, c), invert(pre, c)))).toEqual(
      sortedMembers(pre),
    )
  })

  it("remove existing value", () => {
    const pre: string[] = ["a", "b"]
    const c = setOpChange<string>(undefined, ["a"])
    expect(sortedMembers(step(step(pre, c), invert(pre, c)))).toEqual(
      sortedMembers(pre),
    )
  })

  it("mixed add + remove", () => {
    const pre: string[] = ["a", "b"]
    const c = setOpChange<string>(["c"], ["a"])
    expect(sortedMembers(step(step(pre, c), invert(pre, c)))).toEqual(
      sortedMembers(pre),
    )
  })
})

describe("inverse: groupoid identity — tree", () => {
  it("create", () => {
    const pre: unknown[] = []
    const c = treeChange([
      { action: "create", target: "n1", parent: null, index: 0 },
    ])
    expect(step(step(pre, c), invert(pre, c))).toEqual(pre)
  })

  it("delete", () => {
    const pre: unknown[] = [{ id: "n1", parent: null, index: 0, data: {} }]
    const c = treeChange([{ action: "delete", target: "n1" }])
    expect(step(step(pre, c), invert(pre, c))).toEqual(pre)
  })

  it("move", () => {
    const pre: unknown[] = [
      { id: "n1", parent: null, index: 0, data: {} },
      { id: "n2", parent: "n1", index: 0, data: {} },
    ]
    const c = treeChange([
      { action: "move", target: "n2", parent: null, index: 1 },
    ])
    expect(step(step(pre, c), invert(pre, c))).toEqual(pre)
  })

  it("create then move in one change", () => {
    const pre: unknown[] = [{ id: "n1", parent: null, index: 0, data: {} }]
    const c = treeChange([
      { action: "create", target: "n2", parent: null, index: 1 },
      { action: "move", target: "n2", parent: "n1", index: 0 },
    ])
    expect(step(step(pre, c), invert(pre, c))).toEqual(pre)
  })

  it("throws on delete of non-existent node", () => {
    const pre: unknown[] = []
    const c = treeChange([{ action: "delete", target: "ghost" }])
    expect(() => invert(pre, c)).toThrow(/non-existent node/)
  })
})

describe("inverse: groupoid identity — richtext", () => {
  it("insert with no marks", () => {
    const pre: import("../change.js").RichTextDelta = []
    const c = richTextChange([{ insert: "hello" }])
    expect(step(step(pre, c), invert(pre, c))).toEqual(pre)
  })

  it("insert with marks", () => {
    const pre: import("../change.js").RichTextDelta = []
    const c = richTextChange([{ insert: "bold", marks: { bold: true } }])
    expect(step(step(pre, c), invert(pre, c))).toEqual(pre)
  })

  it("delete spans the entire content", () => {
    const pre: import("../change.js").RichTextDelta = [{ text: "hello" }]
    const c = richTextChange([{ delete: 5 }])
    expect(step(step(pre, c), invert(pre, c))).toEqual(pre)
  })

  it("retain", () => {
    const pre: import("../change.js").RichTextDelta = [{ text: "hello" }]
    const c = richTextChange([{ retain: 5 }])
    expect(step(step(pre, c), invert(pre, c))).toEqual(pre)
  })
})

describe("inverse: top-level dispatcher", () => {
  it("throws on unknown change type", () => {
    expect(() => invert("anything", { type: "made-up-type" } as any)).toThrow(
      /unknown change type/,
    )
  })
})

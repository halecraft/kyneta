import { describe, expect, it } from "vitest"
import {
  incrementChange,
  isSameSetMember,
  mapChange,
  replaceChange,
  sequenceChange,
  setOpChange,
  step,
  stepIncrement,
  stepMap,
  stepReplace,
  stepSequence,
  stepSet,
  stepText,
  textChange,
} from "../index.js"

describe("stepText", () => {
  it("inserts at the beginning", () => {
    expect(stepText("World", textChange([{ insert: "Hello " }]))).toBe(
      "Hello World",
    )
  })

  it("inserts at a cursor position via retain", () => {
    expect(
      stepText("Hello", textChange([{ retain: 5 }, { insert: " World" }])),
    ).toBe("Hello World")
  })

  it("deletes characters", () => {
    expect(
      stepText("Hello World", textChange([{ retain: 5 }, { delete: 6 }])),
    ).toBe("Hello")
  })

  it("handles retain + delete + insert in one pass", () => {
    expect(
      stepText(
        "abcdef",
        textChange([{ retain: 2 }, { delete: 2 }, { insert: "XY" }]),
      ),
    ).toBe("abXYef")
  })

  it("appends remaining characters after last op", () => {
    expect(stepText("abcdef", textChange([{ retain: 3 }]))).toBe("abcdef")
  })

  it("handles empty string", () => {
    expect(stepText("", textChange([{ insert: "hi" }]))).toBe("hi")
  })

  it("handles empty ops", () => {
    expect(stepText("unchanged", textChange([]))).toBe("unchanged")
  })

  it("delete all then insert (full replacement)", () => {
    expect(
      stepText("old", textChange([{ delete: 3 }, { insert: "new" }])),
    ).toBe("new")
  })
})

describe("stepSequence", () => {
  it("inserts at the beginning", () => {
    expect(stepSequence([1, 2, 3], sequenceChange([{ insert: [0] }]))).toEqual([
      0, 1, 2, 3,
    ])
  })

  it("retains then inserts", () => {
    expect(
      stepSequence(
        [1, 2, 3],
        sequenceChange([{ retain: 1 }, { insert: [10, 20] }]),
      ),
    ).toEqual([1, 10, 20, 2, 3])
  })

  it("retains then deletes", () => {
    expect(
      stepSequence([1, 2, 3], sequenceChange([{ retain: 1 }, { delete: 1 }])),
    ).toEqual([1, 3])
  })

  it("retain + insert + delete combined", () => {
    expect(
      stepSequence(
        [1, 2, 3],
        sequenceChange([{ retain: 1 }, { insert: [10, 20] }, { delete: 1 }]),
      ),
    ).toEqual([1, 10, 20, 3])
  })

  it("handles empty array", () => {
    expect(stepSequence([], sequenceChange([{ insert: ["a", "b"] }]))).toEqual([
      "a",
      "b",
    ])
  })

  it("handles empty ops (passthrough)", () => {
    expect(stepSequence([1, 2], sequenceChange([]))).toEqual([1, 2])
  })

  it("appends remaining items after last op", () => {
    expect(stepSequence([1, 2, 3, 4], sequenceChange([{ retain: 2 }]))).toEqual(
      [1, 2, 3, 4],
    )
  })
})

describe("stepMap", () => {
  it("sets keys", () => {
    expect(stepMap({ a: 1 }, mapChange({ b: 2 }))).toEqual({ a: 1, b: 2 })
  })

  it("deletes keys", () => {
    expect(stepMap({ a: 1, b: 2 }, mapChange(undefined, ["b"]))).toEqual({
      a: 1,
    })
  })

  it("sets and deletes in one action (delete first, then set)", () => {
    expect(stepMap({ a: 1, b: 2 }, mapChange({ a: 10 }, ["b"]))).toEqual({
      a: 10,
    })
  })

  it("set wins when key is in both set and delete", () => {
    expect(stepMap({ a: 1 }, mapChange({ a: 99 }, ["a"]))).toEqual({ a: 99 })
  })

  it("handles empty object", () => {
    expect(stepMap({}, mapChange({ x: 1 }))).toEqual({ x: 1 })
  })
})

describe("stepReplace", () => {
  it("replaces a number", () => {
    expect(stepReplace(42, replaceChange(99))).toBe(99)
  })

  it("replaces a string", () => {
    expect(stepReplace("old", replaceChange("new"))).toBe("new")
  })

  it("replaces with a different type", () => {
    expect(stepReplace(42 as unknown, replaceChange("now a string"))).toBe(
      "now a string",
    )
  })
})

describe("stepIncrement", () => {
  it("increments", () => {
    expect(stepIncrement(10, incrementChange(5))).toBe(15)
  })

  it("decrements via negative amount", () => {
    expect(stepIncrement(10, incrementChange(-3))).toBe(7)
  })

  it("handles zero", () => {
    expect(stepIncrement(10, incrementChange(0))).toBe(10)
  })
})

describe("step (generic dispatcher)", () => {
  it("dispatches text actions", () => {
    expect(step("Hello", textChange([{ retain: 5 }, { insert: "!" }]))).toBe(
      "Hello!",
    )
  })

  it("dispatches sequence actions", () => {
    expect(step([1, 2], sequenceChange([{ insert: [0] }]))).toEqual([0, 1, 2])
  })

  it("dispatches map actions", () => {
    expect(step({ x: 1 }, mapChange({ y: 2 }))).toEqual({ x: 1, y: 2 })
  })

  it("dispatches replace actions", () => {
    expect(step("old", replaceChange("new"))).toBe("new")
  })

  it("dispatches increment actions", () => {
    expect(step(100, incrementChange(-20))).toBe(80)
  })

  it("throws on unknown action type", () => {
    expect(() => step("x", { type: "unknown" })).toThrow(
      'step: unknown action type "unknown"',
    )
  })
})

describe("step: multi-action folding", () => {
  it("applies a sequence of text actions to build up a document", () => {
    let state = ""
    state = step(state, textChange([{ insert: "Hello" }]))
    state = step(state, textChange([{ retain: 5 }, { insert: " World" }]))
    state = step(state, textChange([{ retain: 5 }, { delete: 6 }]))
    state = step(state, textChange([{ retain: 5 }, { insert: "!" }]))
    expect(state).toBe("Hello!")
  })

  it("applies a sequence of list mutations", () => {
    let state: unknown[] = []
    state = step(state, sequenceChange([{ insert: ["a", "b", "c"] }]))
    state = step(state, sequenceChange([{ retain: 1 }, { delete: 1 }]))
    state = step(state, sequenceChange([{ retain: 1 }, { insert: ["x"] }]))
    expect(state).toEqual(["a", "x", "c"])
  })
})

// ---------------------------------------------------------------------------
// stepSet — value-addressed add/remove with normalized output
// ---------------------------------------------------------------------------

describe("stepSet", () => {
  it("add-only over empty state", () => {
    expect(stepSet<string>([], setOpChange(["a", "b"]))).toEqual(["a", "b"])
  })

  it("add-only over non-empty state appends in add[] order", () => {
    expect(stepSet<string>(["a"], setOpChange(["b", "c"]))).toEqual([
      "a",
      "b",
      "c",
    ])
  })

  it("remove-only of present members", () => {
    expect(
      stepSet<string>(["a", "b", "c"], setOpChange(undefined, ["b"])),
    ).toEqual(["a", "c"])
  })

  it("remove of an absent member is a no-op", () => {
    expect(stepSet<string>(["a"], setOpChange(undefined, ["b"]))).toEqual(["a"])
  })

  it("add + remove disjoint applies both", () => {
    expect(stepSet<string>(["a"], setOpChange(["b"], ["a"]))).toEqual(["b"])
  })

  it("overlap → remove-wins", () => {
    // "x" appears in both add and remove — remove wins.
    expect(stepSet<string>(["a"], setOpChange(["x"], ["x"]))).toEqual(["a"])
  })

  it("duplicates within add[] are idempotent", () => {
    expect(stepSet<string>([], setOpChange(["a", "a", "b"]))).toEqual([
      "a",
      "b",
    ])
  })

  it("duplicates within remove[] are idempotent", () => {
    expect(
      stepSet<string>(["a", "b"], setOpChange(undefined, ["a", "a"])),
    ).toEqual(["b"])
  })

  it("add of an existing member is a no-op (preserves position)", () => {
    // "a" already exists; re-adding does NOT re-append to the end.
    expect(stepSet<string>(["a", "b"], setOpChange(["a"]))).toEqual(["a", "b"])
  })

  it("undefined add → no-op", () => {
    expect(stepSet<string>(["a"], setOpChange(undefined, undefined))).toEqual([
      "a",
    ])
  })

  it("both fields undefined → no-op", () => {
    expect(stepSet<string>(["a"], setOpChange())).toEqual(["a"])
  })

  it("existing members retain relative order", () => {
    expect(stepSet<string>(["b", "a", "c"], setOpChange(["d"], ["a"]))).toEqual(
      ["b", "c", "d"],
    )
  })

  it("dispatches through step() via case 'set-op'", () => {
    expect(step<string[]>(["a"], setOpChange(["b"]))).toEqual(["a", "b"])
  })
})

// ---------------------------------------------------------------------------
// isSameSetMember — content equality for set membership
// ---------------------------------------------------------------------------

describe("isSameSetMember", () => {
  it("primitives via Object.is (NaN === NaN)", () => {
    expect(isSameSetMember(1, 1)).toBe(true)
    expect(isSameSetMember("a", "a")).toBe(true)
    expect(isSameSetMember(NaN, NaN)).toBe(true)
    expect(isSameSetMember(null, null)).toBe(true)
    expect(isSameSetMember(undefined, undefined)).toBe(true)
  })

  it("distinct primitives", () => {
    expect(isSameSetMember(1, 2)).toBe(false)
    expect(isSameSetMember("a", "b")).toBe(false)
    expect(isSameSetMember(1, "1")).toBe(false)
  })

  it("shallow object equality", () => {
    expect(isSameSetMember({ a: 1 }, { a: 1 })).toBe(true)
    expect(isSameSetMember({ a: 1 }, { a: 2 })).toBe(false)
    expect(isSameSetMember({ a: 1 }, { a: 1, b: 2 })).toBe(false)
  })

  it("nested object equality", () => {
    expect(
      isSameSetMember({ a: { b: { c: 1 } } }, { a: { b: { c: 1 } } }),
    ).toBe(true)
    expect(
      isSameSetMember({ a: { b: { c: 1 } } }, { a: { b: { c: 2 } } }),
    ).toBe(false)
  })

  it("array equality", () => {
    expect(isSameSetMember([1, 2, 3], [1, 2, 3])).toBe(true)
    expect(isSameSetMember([1, 2], [1, 2, 3])).toBe(false)
    expect(isSameSetMember([1, 2, 3], [1, 3, 2])).toBe(false) // order matters
  })

  it("mixed types are not equal", () => {
    expect(isSameSetMember([1, 2], { 0: 1, 1: 2 })).toBe(false)
    expect(isSameSetMember(null, undefined)).toBe(false)
    expect(isSameSetMember(null, {})).toBe(false)
  })
})

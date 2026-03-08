import { describe, expect, it } from "vitest"
import {
  stepText,
  stepSequence,
  stepMap,
  stepReplace,
  stepIncrement,
  step,
  textAction,
  sequenceAction,
  mapAction,
  replaceAction,
  incrementAction,
} from "../index.js"

describe("stepText", () => {
  it("inserts at the beginning", () => {
    expect(stepText("World", textAction([{ insert: "Hello " }]))).toBe(
      "Hello World",
    )
  })

  it("inserts at a cursor position via retain", () => {
    expect(
      stepText("Hello", textAction([{ retain: 5 }, { insert: " World" }])),
    ).toBe("Hello World")
  })

  it("deletes characters", () => {
    expect(
      stepText("Hello World", textAction([{ retain: 5 }, { delete: 6 }])),
    ).toBe("Hello")
  })

  it("handles retain + delete + insert in one pass", () => {
    expect(
      stepText(
        "abcdef",
        textAction([{ retain: 2 }, { delete: 2 }, { insert: "XY" }]),
      ),
    ).toBe("abXYef")
  })

  it("appends remaining characters after last op", () => {
    expect(stepText("abcdef", textAction([{ retain: 3 }]))).toBe("abcdef")
  })

  it("handles empty string", () => {
    expect(stepText("", textAction([{ insert: "hi" }]))).toBe("hi")
  })

  it("handles empty ops", () => {
    expect(stepText("unchanged", textAction([]))).toBe("unchanged")
  })

  it("delete all then insert (full replacement)", () => {
    expect(
      stepText("old", textAction([{ delete: 3 }, { insert: "new" }])),
    ).toBe("new")
  })
})

describe("stepSequence", () => {
  it("inserts at the beginning", () => {
    expect(
      stepSequence([1, 2, 3], sequenceAction([{ insert: [0] }])),
    ).toEqual([0, 1, 2, 3])
  })

  it("retains then inserts", () => {
    expect(
      stepSequence(
        [1, 2, 3],
        sequenceAction([{ retain: 1 }, { insert: [10, 20] }]),
      ),
    ).toEqual([1, 10, 20, 2, 3])
  })

  it("retains then deletes", () => {
    expect(
      stepSequence(
        [1, 2, 3],
        sequenceAction([{ retain: 1 }, { delete: 1 }]),
      ),
    ).toEqual([1, 3])
  })

  it("retain + insert + delete combined", () => {
    expect(
      stepSequence(
        [1, 2, 3],
        sequenceAction([{ retain: 1 }, { insert: [10, 20] }, { delete: 1 }]),
      ),
    ).toEqual([1, 10, 20, 3])
  })

  it("handles empty array", () => {
    expect(
      stepSequence([], sequenceAction([{ insert: ["a", "b"] }])),
    ).toEqual(["a", "b"])
  })

  it("handles empty ops (passthrough)", () => {
    expect(stepSequence([1, 2], sequenceAction([]))).toEqual([1, 2])
  })

  it("appends remaining items after last op", () => {
    expect(
      stepSequence([1, 2, 3, 4], sequenceAction([{ retain: 2 }])),
    ).toEqual([1, 2, 3, 4])
  })
})

describe("stepMap", () => {
  it("sets keys", () => {
    expect(stepMap({ a: 1 }, mapAction({ b: 2 }))).toEqual({ a: 1, b: 2 })
  })

  it("deletes keys", () => {
    expect(stepMap({ a: 1, b: 2 }, mapAction(undefined, ["b"]))).toEqual({
      a: 1,
    })
  })

  it("sets and deletes in one action (delete first, then set)", () => {
    expect(stepMap({ a: 1, b: 2 }, mapAction({ a: 10 }, ["b"]))).toEqual({
      a: 10,
    })
  })

  it("set wins when key is in both set and delete", () => {
    expect(stepMap({ a: 1 }, mapAction({ a: 99 }, ["a"]))).toEqual({ a: 99 })
  })

  it("handles empty object", () => {
    expect(stepMap({}, mapAction({ x: 1 }))).toEqual({ x: 1 })
  })
})

describe("stepReplace", () => {
  it("replaces a number", () => {
    expect(stepReplace(42, replaceAction(99))).toBe(99)
  })

  it("replaces a string", () => {
    expect(stepReplace("old", replaceAction("new"))).toBe("new")
  })

  it("replaces with a different type", () => {
    expect(stepReplace(42 as unknown, replaceAction("now a string"))).toBe(
      "now a string",
    )
  })
})

describe("stepIncrement", () => {
  it("increments", () => {
    expect(stepIncrement(10, incrementAction(5))).toBe(15)
  })

  it("decrements via negative amount", () => {
    expect(stepIncrement(10, incrementAction(-3))).toBe(7)
  })

  it("handles zero", () => {
    expect(stepIncrement(10, incrementAction(0))).toBe(10)
  })
})

describe("step (generic dispatcher)", () => {
  it("dispatches text actions", () => {
    expect(step("Hello", textAction([{ retain: 5 }, { insert: "!" }]))).toBe(
      "Hello!",
    )
  })

  it("dispatches sequence actions", () => {
    expect(step([1, 2], sequenceAction([{ insert: [0] }]))).toEqual([
      0, 1, 2,
    ])
  })

  it("dispatches map actions", () => {
    expect(step({ x: 1 }, mapAction({ y: 2 }))).toEqual({ x: 1, y: 2 })
  })

  it("dispatches replace actions", () => {
    expect(step("old", replaceAction("new"))).toBe("new")
  })

  it("dispatches increment actions", () => {
    expect(step(100, incrementAction(-20))).toBe(80)
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
    state = step(state, textAction([{ insert: "Hello" }]))
    state = step(state, textAction([{ retain: 5 }, { insert: " World" }]))
    state = step(state, textAction([{ retain: 5 }, { delete: 6 }]))
    state = step(state, textAction([{ retain: 5 }, { insert: "!" }]))
    expect(state).toBe("Hello!")
  })

  it("applies a sequence of list mutations", () => {
    let state: unknown[] = []
    state = step(state, sequenceAction([{ insert: ["a", "b", "c"] }]))
    state = step(state, sequenceAction([{ retain: 1 }, { delete: 1 }]))
    state = step(state, sequenceAction([{ retain: 1 }, { insert: ["x"] }]))
    expect(state).toEqual(["a", "x", "c"])
  })
})
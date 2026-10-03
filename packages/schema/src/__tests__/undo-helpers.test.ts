import { describe, expect, it } from "vitest"
import { singleEdit, textChange } from "../change.js"
import { RawPath } from "../path.js"
import { planValueRestores } from "../restore.js"
import { continuesStep, type Edit, editOf } from "../typing.js"
import {
  addTally,
  EMPTY_TALLY,
  howMuchStands,
  settleStep,
  type Tally,
} from "../undo-step.js"

describe("singleEdit", () => {
  it.each([
    [
      [{ retain: 2 }, { insert: "ab" }],
      { index: 2, inserted: "ab", deleted: 0 },
    ],
    [[{ retain: 2 }, { delete: 3 }], { index: 2, inserted: "", deleted: 3 }],
    [
      [{ retain: 1 }, { delete: 2 }, { insert: "z" }],
      { index: 1, inserted: "z", deleted: 2 },
    ],
    [[{ insert: "a" }, { retain: 1 }, { insert: "b" }], undefined],
    [[], undefined],
  ] as const)("%j → %j", (instructions, expected) => {
    expect(singleEdit(instructions)).toEqual(expected)
  })
})

describe("planValueRestores", () => {
  it("keeps exactly the values that still hold what the step wrote", () => {
    const kept = planValueRestores([
      { key: "a", wrote: "column", previous: "drawer", current: "column" },
      { key: "b", wrote: "column", previous: "drawer", current: "queue" },
      { key: "c", wrote: { x: [1] }, previous: undefined, current: { x: [1] } },
    ])
    expect(kept.map(p => p.key)).toEqual(["a", "c"])
  })
})

describe("editOf", () => {
  it("reads one contiguous edit from a text op", () => {
    const op = {
      path: RawPath.empty.field("title"),
      change: textChange([{ retain: 3 }, { insert: "x" }]),
    }
    expect(editOf(op, 10)).toEqual({
      path: op.path.key,
      at: 10,
      index: 3,
      inserted: "x",
      deleted: 0,
    })
  })
})

describe("continuesStep", () => {
  const edit = (e: Partial<Edit>): Edit => ({
    path: "title",
    at: 0,
    index: 0,
    inserted: "",
    deleted: 0,
    ...e,
  })
  it.each([
    [
      "typing on",
      edit({ inserted: "a" }),
      edit({ at: 100, index: 1, inserted: "b" }),
      true,
    ],
    [
      "a pause",
      edit({ inserted: "a" }),
      edit({ at: 1000, index: 1, inserted: "b" }),
      false,
    ],
    [
      "another text",
      edit({ inserted: "a" }),
      edit({ path: "body", index: 1, inserted: "b" }),
      false,
    ],
    [
      "a caret jump",
      edit({ inserted: "a" }),
      edit({ index: 5, inserted: "b" }),
      false,
    ],
    [
      "a word after a space",
      edit({ inserted: " " }),
      edit({ index: 1, inserted: "b" }),
      false,
    ],
    [
      "a space after a word",
      edit({ inserted: "a" }),
      edit({ index: 1, inserted: " " }),
      true,
    ],
    [
      "backspace on",
      edit({ index: 5, deleted: 1 }),
      edit({ index: 4, deleted: 1 }),
      true,
    ],
    [
      "forward delete on",
      edit({ index: 5, deleted: 1 }),
      edit({ index: 5, deleted: 1 }),
      true,
    ],
    [
      "typing after deleting",
      edit({ index: 5, deleted: 1 }),
      edit({ index: 4, inserted: "x" }),
      false,
    ],
    [
      "a replacement",
      edit({ inserted: "a" }),
      edit({ index: 1, inserted: "b", deleted: 1 }),
      false,
    ],
  ])("%s → %s", (_name, previous, next, expected) => {
    expect(continuesStep(previous, next)).toBe(expected)
  })
})

describe("tallies", () => {
  const t = (kept: number, total: number): Tally => ({ kept, total })

  it.each([
    [t(0, 3), "none"],
    [t(1, 3), "part"],
    [t(3, 3), "whole"],
    [EMPTY_TALLY, "whole"],
  ] as const)("howMuchStands(%j) is %s", (tally, standing) => {
    expect(howMuchStands(tally)).toBe(standing)
  })

  it("adds, with EMPTY_TALLY as its identity, so a part naming nothing never lifts a dead step", () => {
    expect(addTally(EMPTY_TALLY, t(2, 5))).toEqual(t(2, 5))
    expect(addTally(t(1, 2), t(3, 4))).toEqual(t(4, 6))
    expect(howMuchStands(addTally(EMPTY_TALLY, t(0, 3)))).toBe("none")
  })

  it.each([
    [[t(2, 2), EMPTY_TALLY], false, "undone"],
    [[t(1, 2), t(0, 1)], false, "undone"],
    [[t(0, 2), t(0, 1)], false, "dropped"],
    [[EMPTY_TALLY, t(0, 2)], false, "dropped"],
    [[EMPTY_TALLY], false, "undone"],
    [[t(2, 2), EMPTY_TALLY], true, "undone"],
    [[t(2, 2), t(0, 1)], true, "refused"],
    [[t(0, 2)], true, "refused"],
    [[], true, "undone"],
  ] as const)("settleStep(%j, whole: %s) is %s", (tallies, whole, outcome) => {
    expect(settleStep(tallies, whole)).toBe(outcome)
  })
})

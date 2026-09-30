import { describe, expect, it } from "vitest"
import { singleEdit, textChange } from "../change.js"
import { RawPath } from "../path.js"
import { planValueRestores } from "../restore.js"
import { revertStep } from "../revert-step.js"
import { continuesStep, type Edit, editOf } from "../typing.js"

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

describe("revertStep", () => {
  it("reverts last first, and rewrites what waits and what is done through each remap", () => {
    const order: string[] = []
    const { redo, remaps } = revertStep(
      ["a", "b", "c"],
      part => {
        order.push(part)
        // "b" stands no more; "c" re-creates what "a" names.
        if (part === "b") return null
        return {
          redo: `redo(${part})`,
          remap: new Map(part === "c" ? [["a", "a'"]] : []),
        }
      },
      (part, _by, remap) => remap.get(part) ?? part,
    )
    expect(order).toEqual(["c", "b", "a'"])
    expect(redo).toEqual(["redo(c)", "redo(a')"])
    expect(remaps.map(r => r.by)).toEqual(["c", "a'"])
  })
})

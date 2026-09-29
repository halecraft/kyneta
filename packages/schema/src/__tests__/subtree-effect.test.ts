// planSubtreeEffect — what a change may have rewritten below its path.
import { describe, expect, it } from "vitest"
import type { ChangeBase } from "../change.js"
import {
  incrementChange,
  mapChange,
  mapClearChange,
  own,
  replaceChange,
  richTextChange,
  sequenceChange,
  setOpChange,
  textChange,
  treeChange,
} from "../change.js"
import { planSubtreeEffect, type SubtreeEffect } from "../subtree-effect.js"

const table: readonly [string, ChangeBase, SubtreeEffect][] = [
  ["replace", replaceChange(own({ a: 1 })), "all"],
  ["map clear", mapClearChange(), "all"],
  ["map clear with set", mapClearChange(own({ a: 1 })), "all"],
  ["map set and delete", mapChange(own({ a: 1 }), ["b"]), { keys: ["a", "b"] }],
  [
    "map key named in both delete and set is named once",
    mapChange(own({ a: 1 }), ["a"]),
    { keys: ["a"] },
  ],
  ["empty map change", mapChange(), "none"],
  [
    "tree deletes",
    treeChange([
      { action: "delete", target: "c" },
      { action: "delete", target: "p" },
    ]),
    { keys: ["c", "p"] },
  ],
  [
    "tree create and move",
    treeChange([
      { action: "create", target: "n", parent: null, index: 0 },
      { action: "move", target: "n", parent: null, index: 1 },
    ]),
    "none",
  ],
  [
    "sequence edit",
    sequenceChange([{ retain: 1 }, { delete: 1 }, { insert: [own(1)] }]),
    "none",
  ],
  ["text", textChange([{ insert: "x" }]), "none"],
  ["counter", incrementChange(2), "none"],
  ["rich text", richTextChange([{ insert: "x" }]), "none"],
  ["set op", setOpChange([own("a")], ["b"]), "none"],
  ["an unknown change type", { type: "custom" }, "none"],
]

describe("planSubtreeEffect", () => {
  for (const [name, change, effect] of table) {
    it(name, () => {
      expect(planSubtreeEffect(change)).toEqual(effect)
    })
  }
})

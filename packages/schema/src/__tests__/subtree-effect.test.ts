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
import { RawPath, type Segment } from "../path.js"
import {
  planSubtreeEffect,
  projectChange,
  type SubtreeEffect,
} from "../subtree-effect.js"

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

describe("projectChange", () => {
  const at = (...keys: (string | number)[]) =>
    keys.reduce<RawPath>(
      (path, key) =>
        typeof key === "number"
          ? path.item(key)
          : key.startsWith("#")
            ? path.entry(key.slice(1))
            : path.field(key),
      RawPath.empty,
    ).segments

  const table: readonly [string, ChangeBase, readonly Segment[], ChangeBase][] =
    [
      [
        "a replace, read along the path",
        replaceChange(own({ a: { b: 1 } })),
        at("a", "b"),
        replaceChange(1),
      ],
      [
        "a replace that lacks the path",
        replaceChange(own({ a: {} })),
        at("a", "b"),
        replaceChange(undefined),
      ],
      [
        "a replace, through a list item",
        replaceChange(own({ items: [{ x: 1 }] })),
        at("items", 0, "x"),
        replaceChange(undefined),
      ],
      [
        "a map set, at the key",
        mapChange(own({ k: { n: 2 } })),
        at("#k"),
        replaceChange(own({ n: 2 })),
      ],
      [
        "a map set, below the key",
        mapChange(own({ k: { n: 2 } })),
        at("#k", "n"),
        replaceChange(2),
      ],
      [
        "a map delete",
        mapChange(undefined, ["k"]),
        at("#k", "n"),
        replaceChange(undefined),
      ],
      [
        "a key named in both delete and set is set",
        mapChange(own({ k: 3 }), ["k"]),
        at("#k"),
        replaceChange(3),
      ],
      ["a clear", mapClearChange(), at("#k"), replaceChange(undefined)],
      [
        "a tree delete, at the node",
        treeChange([{ action: "delete", target: "n" }]),
        at("#n"),
        treeChange([{ action: "delete", target: "n" }]),
      ],
      [
        "a tree delete, below the node",
        treeChange([{ action: "delete", target: "n" }]),
        at("#n", "label"),
        replaceChange(undefined),
      ],
      [
        "a tree forest replaced whole, read by node id",
        replaceChange(
          own([{ id: "n", parent: null, index: 0, data: { label: "x" } }]),
        ),
        at("#n", "label"),
        replaceChange("x"),
      ],
    ]

  for (const [name, change, relative, expected] of table) {
    it(name, () => {
      expect(projectChange(change, relative)).toEqual(expected)
    })
  }

  it("the empty relative path is the change itself", () => {
    const change = replaceChange(1)
    expect(projectChange(change, [])).toBe(change)
  })
})

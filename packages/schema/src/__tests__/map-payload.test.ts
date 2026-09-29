// mapPayload — the one definition of "the values a change carries".
import { describe, expect, it } from "vitest"
import type { ChangeBase } from "../change.js"
import {
  incrementChange,
  mapChange,
  mapClearChange,
  mapPayload,
  replaceChange,
  richTextChange,
  sequenceChange,
  setOpChange,
  textChange,
  treeChange,
  trustAsOwned,
} from "../change.js"

// Each builtin change, and the values it carries, in the order `mapPayload`
// visits them.
const table: readonly {
  readonly name: string
  readonly change: ChangeBase
  readonly carried: readonly unknown[]
}[] = [
  { name: "replace", change: replaceChange(trustAsOwned("v")), carried: ["v"] },
  {
    name: "sequence inserts",
    change: sequenceChange([
      { insert: trustAsOwned(["a", "b"]) },
      { retain: 1 },
      { delete: 1 },
      { insert: trustAsOwned(["c"]) },
    ]),
    carried: ["a", "b", "c"],
  },
  {
    name: "map set values, not deleted keys",
    change: mapChange(trustAsOwned({ x: "a", y: "b" }), ["z"]),
    carried: ["a", "b"],
  },
  {
    name: "map clear with set",
    change: mapClearChange(trustAsOwned({ x: "a" })),
    carried: ["a"],
  },
  {
    name: "set-op adds, not removes",
    change: setOpChange(trustAsOwned(["a"]), ["b"]),
    carried: ["a"],
  },
  {
    name: "rich-text marks on inserts and formats",
    change: richTextChange([
      { insert: "hi", marks: trustAsOwned({ bold: true }) },
      { insert: "plain" },
      { format: 2, marks: trustAsOwned({ bold: null }) },
    ]),
    carried: [{ bold: true }, { bold: null }],
  },
  { name: "text", change: textChange([{ insert: "x" }]), carried: [] },
  { name: "increment", change: incrementChange(1), carried: [] },
  {
    name: "tree",
    change: treeChange([{ action: "delete", target: "n" }]),
    carried: [],
  },
]

describe("mapPayload", () => {
  for (const { name, change, carried } of table) {
    it(`${name}: visits exactly the carried values`, () => {
      const seen: unknown[] = []
      mapPayload(change, value => {
        seen.push(value)
        return value
      })
      expect(seen).toEqual(carried)
    })

    it(`${name}: returns the change itself when nothing changed`, () => {
      expect(mapPayload(change, value => value)).toBe(change)
    })

    it(`${name}: replaces each carried value, and nothing else`, () => {
      const out = mapPayload(change, value => ({ wrapped: value }))
      if (carried.length === 0) {
        expect(out).toBe(change)
        return
      }
      const seen: unknown[] = []
      mapPayload(out, value => {
        seen.push(value)
        return value
      })
      expect(seen).toEqual(carried.map(value => ({ wrapped: value })))
      // The input is untouched.
      const before: unknown[] = []
      mapPayload(change, value => {
        before.push(value)
        return value
      })
      expect(before).toEqual(carried)
    })
  }
})

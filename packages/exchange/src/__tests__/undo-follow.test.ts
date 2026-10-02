// undo-follow — which documents an undo stack listens to as
// `exchange.documents` changes: the open ones a change names, and no others.

import { describe, expect, it } from "vitest"
import { followChanges } from "../undo/stack.js"

describe("followChanges", () => {
  const open = new Set(["a", "b"])
  const isOpen = (docId: string) => open.has(docId)
  const cases: readonly [
    string,
    readonly string[],
    { attach: string[]; detach: string[] },
  ][] = [
    ["nothing named, nothing to do", [], { attach: [], detach: [] }],
    ["a created document is listened to", ["a"], { attach: ["a"], detach: [] }],
    [
      "a removed document is let go",
      ["gone"],
      { attach: [], detach: ["gone"] },
    ],
    [
      "each document once, however many changes name it",
      ["a", "gone", "a", "b", "gone"],
      { attach: ["a", "b"], detach: ["gone"] },
    ],
  ]
  for (const [name, docIds, expected] of cases) {
    it(name, () => {
      expect(followChanges(docIds, isOpen)).toEqual(expected)
    })
  }
})

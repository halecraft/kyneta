import { textChange } from "@kyneta/schema"
import { describe, expect, it } from "vitest"
import { composeEdits, type DeletedRun } from "../revertible.js"

const run = (text: string): DeletedRun => ({
  container: [{ field: "title" }],
  ids: [],
  anchor: null,
  content: { kind: "text", text },
  nested: [],
})

describe("composeEdits", () => {
  it("deletes, restores and places each restored run", () => {
    // "aXbc": delete X (index 1), restore "yz" before b (gap 2), and "!" at
    // the end (gap 4).
    const first = run("yz")
    const second = run("!")
    const { change, placed } = composeEdits("text", 4, [
      { kind: "delete", index: 1 },
      { kind: "insert", gap: 2, content: first.content, restores: first },
      { kind: "insert", gap: 4, content: second.content, restores: second },
    ])
    expect(change).toEqual(
      textChange([
        { retain: 1 },
        { delete: 1 },
        { insert: "yz" },
        { retain: 2 },
        { insert: "!" },
      ]),
    )
    // "ayzbc!": the first run starts at 1, the second at 5.
    expect(placed.map(p => p.at)).toEqual([1, 5])
  })
})

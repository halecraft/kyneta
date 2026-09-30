import { describe, expect, it } from "vitest"
import { textChange } from "../change.js"
import { RawPath } from "../path.js"
import {
  type PlainRecord,
  planPlainRevert,
  rewritePlainRecord,
  settlePlainRevert,
} from "../substrates/plain-revertible.js"

const title = RawPath.empty.field("title")
const record: PlainRecord = {
  before: "L:1",
  after: "L:2",
  ops: [{ path: title, change: textChange([{ insert: "a" }]) }],
  inverses: [{ path: title, change: textChange([{ delete: 1 }]) }],
}

describe("plain undo, pure", () => {
  it("reverts only where the step left the document", () => {
    expect(planPlainRevert(record, "L:2")).toEqual(record.inverses)
    expect(planPlainRevert(record, "L:3")).toBeNull()
  })

  it("names the new head as the position before the step, for the step below", () => {
    const { redo, remap } = settlePlainRevert(record, "L:2", "L:3")
    expect([...remap]).toEqual([["L:1", "L:3"]])
    expect(redo).toEqual({
      before: "L:2",
      after: "L:3",
      ops: record.inverses,
      inverses: record.ops,
    })
    const below: PlainRecord = { ...record, before: "L:0", after: "L:1" }
    expect(rewritePlainRecord(below, remap).after).toBe("L:3")
  })
})

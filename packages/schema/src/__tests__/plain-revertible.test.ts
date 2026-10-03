import { describe, expect, it } from "vitest"
import { textChange } from "../change.js"
import { RawPath } from "../path.js"
import {
  composePlainRecords,
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
  it("reverts, whole, only where the step left the document", () => {
    expect(planPlainRevert(record, "L:2")).toEqual({
      tally: { kept: 1, total: 1 },
      changes: record.inverses,
    })
    expect(planPlainRevert(record, "L:3")).toEqual({
      tally: { kept: 0, total: 1 },
      changes: undefined,
    })
  })

  it("composes two records back to back, the first's ops first", () => {
    const next: PlainRecord = { ...record, before: "L:2", after: "L:3" }
    expect(composePlainRecords(record, next)).toEqual({
      before: "L:1",
      after: "L:3",
      ops: [...record.ops, ...next.ops],
      inverses: [...record.inverses, ...next.inverses],
    })
    expect(composePlainRecords(record, { ...next, before: "L:9" })).toBeNull()
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

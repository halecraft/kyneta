import { describe, expect, test } from "vitest"
import { ephemeral } from "../bind.js"
import { createDoc } from "../create-doc.js"
import { Schema } from "../schema.js"
import { lastUpdated } from "./last-updated.js"

describe("lastUpdated", () => {
  test("returns timestamp for leaf fields and max timestamp for containers", () => {
    const s = Schema.struct({
      server: Schema.struct({
        peerId: Schema.string(),
        appShellAttached: Schema.boolean(),
      }),
    })

    const doc = createDoc(ephemeral.bind(s))

    // Nothing has been written, so there is no timestamp to report. The tree
    // holds only written state; the zeros a read returns come from the
    // projection.
    expect(lastUpdated(doc.server)).toBeNull()
    expect(lastUpdated(doc.server.peerId)).toBeNull()

    // update one field
    doc.server.peerId.set("peer-1")
    const ts1 = lastUpdated(doc.server.peerId) as number
    expect(ts1).toBeTypeOf("number")

    // container timestamp should be the same as the only updated field
    expect(lastUpdated(doc.server)).toBe(ts1)

    while (Date.now() === ts1) {}

    // update another field
    doc.server.appShellAttached.set(true)
    const ts2 = lastUpdated(doc.server.appShellAttached) as number
    expect(ts2).toBeTypeOf("number")
    expect(ts2).toBeGreaterThan(ts1)

    // container timestamp should be the max (which is ts2)
    expect(lastUpdated(doc.server)).toBe(ts2)
  })
})

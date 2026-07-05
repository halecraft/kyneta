import { describe, expect, test } from "vitest"
import { state } from "../bind.js"
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

    const doc = createDoc(state.bind(s))

    // initially they might be 0 due to structural zero initialization in state tree
    const initialTs = lastUpdated(doc.server)
    const ts0 = initialTs as number
    expect(ts0).toBeTypeOf("number")

    // wait a bit for timestamps to advance
    const start = Date.now()
    while (Date.now() === start) {}

    // update one field
    doc.server.peerId.set("peer-1")
    const ts1 = lastUpdated(doc.server.peerId) as number
    expect(ts1).toBeTypeOf("number")
    expect(ts1).toBeGreaterThan(ts0)

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

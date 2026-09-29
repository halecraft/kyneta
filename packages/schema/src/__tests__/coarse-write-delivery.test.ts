// A coarse write reaches every subscriber in the part of the tree it rewrote,
// with the change projected onto it, and populates that part.

import type { Changeset } from "@kyneta/changefeed"
import { describe, expect, it } from "vitest"
import {
  batch,
  createDoc,
  Schema,
  subscribe,
  subscribeNode,
} from "../basic/index.js"
import type { Op } from "../index.js"
import { populated, populatedFeed } from "../index.js"

const Doc = Schema.struct({
  settings: Schema.struct({ dark: Schema.boolean(), font: Schema.number() }),
  roster: Schema.record(Schema.struct({ cursor: Schema.number() })),
})

function fixture() {
  const doc: any = createDoc(Doc)
  batch(doc, (d: any) => {
    d.roster.set("alice", { cursor: 1 })
    d.roster.set("bob", { cursor: 1 })
  })
  return doc
}

describe("a coarse write reaches the subscribers below it", () => {
  it("a record entry set whole reaches its fields' subscribers, and not a sibling's", () => {
    const doc = fixture()
    const own: unknown[] = []
    const deep: Changeset<Op>[] = []
    subscribeNode(doc.roster.at("alice").cursor, cs => own.push(...cs.changes))
    subscribe(doc.roster.at("alice").cursor, cs => deep.push(cs))
    let bob = 0
    subscribe(doc.roster.at("bob").cursor, () => {
      bob++
    })

    doc.roster.set("alice", { cursor: 5 })

    expect(own).toEqual([{ type: "replace", value: 5 }])
    expect(deep).toHaveLength(1)
    expect(deep[0]?.changes[0]?.path.format()).toBe("root")
    expect(bob).toBe(0)
  })

  it("a struct set reaches its fields", () => {
    const doc = fixture()
    const heard: unknown[] = []
    subscribeNode(doc.settings.dark, cs => heard.push(...cs.changes))

    doc.settings.set({ dark: true, font: 12 })

    expect(heard).toEqual([{ type: "replace", value: true }])
  })

  it("a deleted key's subscribers hear it go", () => {
    const doc = fixture()
    const heard: unknown[] = []
    subscribeNode(doc.roster.at("alice").cursor, cs =>
      heard.push(...cs.changes),
    )

    doc.roster.delete("alice")

    expect(heard).toEqual([{ type: "replace", value: undefined }])
  })

  it("one batch still reaches each subscriber once, in dispatch order", () => {
    const doc = fixture()
    const deep: Changeset<Op>[] = []
    subscribe(doc.roster.at("alice"), cs => deep.push(cs))

    batch(doc, (d: any) => {
      d.roster.at("alice").cursor.set(2)
      d.roster.set("alice", { cursor: 3 })
    })

    expect(deep).toHaveLength(1)
    expect(deep[0]?.changes.map(op => op.path.format())).toEqual([
      "cursor",
      "root",
    ])
  })
})

describe("a coarse write populates the part of the tree it rewrote", () => {
  it("fields below a struct set are populated, and their listeners fire", async () => {
    const doc: any = createDoc(Doc)
    expect(populated(doc.settings.dark)).toBe(false)
    const fired: unknown[] = []
    subscribe(populatedFeed(doc.settings.dark), cs => fired.push(cs))

    doc.settings.set({ dark: true, font: 12 })

    expect(populated(doc.settings.dark)).toBe(true)
    expect(populated(doc.settings.font)).toBe(true)
    expect(fired).toHaveLength(1)
  })

  it("a coordinate navigated to after the rewrite reads as populated", () => {
    const doc: any = createDoc(Doc)
    doc.roster.set("carol", { cursor: 1 })
    expect(populated(doc.roster.at("carol").cursor)).toBe(true)
    expect(populated(doc.settings)).toBe(false)
  })
})

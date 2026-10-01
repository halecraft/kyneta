// flags — the two ref flags, `[POPULATED]` and `[DELETED]`, follow one
// protocol (`flag`, `ref/observe.ts`): a value reader, and a feed reader that
// passes `null` and `undefined` through and throws for any other non-ref.
import type { Feed } from "@kyneta/changefeed"
import { CHANGEFEED, hasChangefeed } from "@kyneta/changefeed"
import { describe, expect, it } from "vitest"
import { batch, createDoc, Schema } from "../basic/index.js"
import {
  deleted,
  deletedFeed,
  hasDeleted,
  hasPopulated,
  populated,
  populatedFeed,
  type Ref,
} from "../index.js"

const Doc = Schema.struct({ rows: Schema.record(Schema.number()) })

function fixture(): any {
  const doc: any = createDoc(Doc)
  batch(doc, (d: any) => d.rows.set("k", 1))
  return doc
}

const flags = [
  {
    name: "populatedFeed",
    has: hasPopulated,
    value: populated,
    feed: populatedFeed,
    // A row that was written is populated.
    expected: true,
  },
  {
    name: "deletedFeed",
    has: hasDeleted,
    value: deleted,
    feed: deletedFeed,
    // A row that is there is not deleted.
    expected: false,
  },
] as const

describe.each(flags)("$name", ({ name, has, value, feed, expected }) => {
  it("the value is false for anything that is not a ref, and the ref's boolean for a ref", () => {
    const row = fixture().rows.at("k")
    for (const notARef of [null, undefined, 1, {}, () => true]) {
      expect(has(notARef)).toBe(false)
      expect(value(notARef)).toBe(false)
    }
    expect(has(row)).toBe(true)
    expect(value(row)).toBe(expected)
  })

  it("the feed passes null and undefined through, and throws for any other non-ref", () => {
    expect(feed(null)).toBe(null)
    expect(feed(undefined)).toBe(undefined)
    for (const notARef of [1, {}, () => true]) {
      expect(() => feed(notARef)).toThrow(`${name}() requires`)
    }
  })

  it("a ref's feed reads its boolean, carries [CHANGEFEED], and is kept", () => {
    const row = fixture().rows.at("k")
    const rowFeed = feed(row)
    expect(rowFeed()).toBe(expected)
    expect(hasChangefeed(rowFeed)).toBe(true)
    expect(rowFeed[CHANGEFEED].current).toBe(expected)
    expect(feed(row)).toBe(rowFeed)
  })
})

describe("the root", () => {
  it("is populated like any ref, and has no deletion flag", () => {
    const doc = fixture()
    expect(populatedFeed(doc)()).toBe(true)
    expect(deleted(doc)).toBe(false)
    expect(() => deletedFeed(doc)).toThrow("deletedFeed() requires")
  })
})

describe("types", () => {
  it("a definite ref's feed is a feed; a ref that may be absent's may be absent", () => {
    const doc = createDoc(Doc)
    doc.rows.set("k", 1)
    const definite = deletedFeed(doc.rows) satisfies Feed<boolean>
    const maybe = deletedFeed(doc.rows.at("k")) satisfies
      | Feed<boolean>
      | undefined
    const absent = (row: Ref<typeof Doc> | undefined) =>
      populatedFeed(row) satisfies Feed<boolean> | undefined
    expect(definite()).toBe(false)
    expect(maybe?.()).toBe(false)
    expect(absent(undefined)).toBe(undefined)
  })
})

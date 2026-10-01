// footprint — where an undo record's ops landed, at the document's storage
// grain, and when two footprints overlap.

import { describe, expect, it } from "vitest"
import {
  mapChange,
  mapClearChange,
  replaceChange,
  textChange,
  treeChange,
  trustAsOwned,
} from "../change.js"
import type { Op } from "../changefeed.js"
import {
  type Footprint,
  footprintOf,
  footprintsOverlap,
  footprintUnion,
  WHOLE_DOCUMENT,
} from "../footprint.js"
import { RawPath } from "../path.js"
import { Schema } from "../schema.js"

const Doc = Schema.struct({
  title: Schema.text(),
  items: Schema.record(Schema.string()),
  cards: Schema.list(Schema.struct({ name: Schema.text() })),
  meta: Schema.struct.json({ a: Schema.string(), b: Schema.string() }),
  tree: Schema.tree(Schema.struct({ label: Schema.string() })),
})

const at = RawPath.empty
const op = (path: RawPath, change: Op["change"]): Op => ({ path, change })
const owned = <T>(value: T) => trustAsOwned(value)

describe("footprintOf", () => {
  it.each<[string, readonly Op[], Footprint]>([
    [
      "a text edit is its text",
      [op(at.field("title"), textChange([{ insert: "hi" }]))],
      [["title"]],
    ],
    [
      "a record write is one path per key",
      [op(at.field("items"), mapChange(owned({ a: "1" }), ["c"]))],
      [
        ["items", "a"],
        ["items", "c"],
      ],
    ],
    [
      "a clear is the record",
      [op(at.field("items"), mapClearChange())],
      [["items"]],
    ],
    [
      "a path is cut before its first list index",
      [
        op(
          at.field("cards").item(2).field("name"),
          textChange([{ delete: 1 }]),
        ),
      ],
      [["cards"]],
    ],
    [
      "a write inside a .json() value is the whole value",
      [op(at.field("meta").field("a"), replaceChange(owned("x")))],
      [["meta"]],
    ],
    [
      "a tree change is the tree",
      [op(at.field("tree"), treeChange([{ action: "delete", target: "n1" }]))],
      [["tree"]],
    ],
    [
      "the result is normalized",
      [
        op(at.field("items"), mapChange(owned({ a: "1" }))),
        op(at.field("title"), textChange([{ insert: "a" }])),
        op(at.field("title"), textChange([{ insert: "b" }])),
        op(at.field("items"), mapClearChange()),
      ],
      [["title"], ["items"]],
    ],
  ])("%s", (_, ops, expected) => {
    expect(footprintOf(Doc, ops)).toEqual(expected)
  })
})

describe("footprintsOverlap", () => {
  it.each<[string, Footprint, Footprint, boolean]>([
    ["a prefix overlaps", [["items"]], [["items", "a"]], true],
    ["the other way round too", [["items", "a"]], [["items"]], true],
    ["sibling keys do not", [["items", "a"]], [["items", "c"]], false],
    ["the whole document overlaps anything", WHOLE_DOCUMENT, [["title"]], true],
    ["nothing overlaps nothing", [], WHOLE_DOCUMENT, false],
  ])("%s", (_, a, b, expected) => {
    expect(footprintsOverlap(a, b)).toBe(expected)
  })
})

describe("footprintUnion", () => {
  it("drops duplicates and covered paths, and keeps first order", () => {
    expect(
      footprintUnion(
        [["title"], ["items", "a"]],
        [["cards"], ["items"], ["title"]],
      ),
    ).toEqual([["title"], ["cards"], ["items"]])
  })
})

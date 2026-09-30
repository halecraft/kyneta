// revert-plan — a Yjs revert's decisions, on hand-built gathered state.

import {
  isRichTextChange,
  RawPath,
  type RichTextChange,
  replaceChange,
  textChange,
  trustAsOwned,
} from "@kyneta/schema"
import { describe, expect, it } from "vitest"
import {
  composeEdits,
  type GatheredContainer,
  planYjsRevert,
  remapOfLanded,
  type YjsGathered,
} from "../undo/plan.js"
import type { DeletedRun, YjsRecord } from "../undo/record.js"

const title = RawPath.empty.field("title")
const container = (length: number, marks: Record<string, unknown>[] = []) =>
  new Map<string, GatheredContainer>([
    [title.key, { path: title, kind: "text", length, marks }],
  ])

const run = (text: string, clock = 10): DeletedRun => ({
  container: [{ field: "title" }],
  ids: [{ client: 1, clock, length: text.length }],
  after: null,
  content: { kind: "text", text },
  nested: [],
})

const record = (r: Partial<YjsRecord>): YjsRecord => ({
  inserted: [],
  deleted: [],
  values: [],
  marks: [],
  ...r,
})

const gathered = (g: Partial<YjsGathered>): YjsGathered => ({
  containers: container(0),
  inserted: [],
  deleted: [],
  marks: [],
  values: [],
  ...g,
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

describe("planYjsRevert", () => {
  it("deletes my inserts still there and restores what I deleted, unless it is back", () => {
    const deleted = run("lo")
    const back = run("zz", 20)
    const plan = planYjsRevert(
      record({
        inserted: [{ container: [{ field: "title" }], ids: [] }],
        deleted: [deleted, back],
      }),
      gathered({
        containers: container(6),
        inserted: [{ container: title.key, indices: [3, 4] }],
        deleted: [
          { container: title.key, back: false, gap: 1 },
          { container: title.key, back: true, gap: 1 },
        ],
      }),
    )
    expect(plan?.ops).toEqual([
      {
        path: title,
        change: textChange([
          { retain: 1 },
          { insert: "lo" },
          { retain: 2 },
          { delete: 2 },
        ]),
      },
    ])
    expect(plan?.placed.map(p => [p.run, p.at])).toEqual([[deleted, 1]])
  })

  it("restores a value only while it holds what I wrote", () => {
    const place = RawPath.empty.field("place")
    const write = {
      path: [{ field: "place" }],
      wrote: { value: "column" },
      previous: { value: "drawer" },
    }
    const plan = (current: string) =>
      planYjsRevert(
        record({ values: [write] }),
        gathered({ values: [{ path: place, current: { value: current } }] }),
      )
    expect(plan("column")?.ops).toEqual([
      { path: place, change: replaceChange(trustAsOwned("drawer")) },
    ])
    expect(plan("queue")).toBeNull()
  })

  it("unmarks only characters that still hold my mark", () => {
    const plan = planYjsRevert(
      record({
        marks: [
          {
            container: [{ field: "title" }],
            ids: [],
            key: "bold",
            wrote: true,
            previous: null,
          },
        ],
      }),
      gathered({
        containers: new Map([
          [
            title.key,
            {
              path: title,
              kind: "richtext",
              length: 3,
              marks: [{ bold: true }, { bold: "other" }, { bold: true }],
            },
          ],
        ]),
        marks: [{ container: title.key, indices: [0, 1, 2] }],
      }),
    )
    const change = plan?.ops[0]?.change
    expect(change !== undefined && isRichTextChange(change)).toBe(true)
    expect((change as RichTextChange).instructions).toEqual([
      { format: 1, marks: { bold: null } },
      { retain: 1 },
      { format: 1, marks: { bold: null } },
    ])
  })

  it("is null when nothing of the record still stands", () => {
    expect(
      planYjsRevert(
        record({ deleted: [run("x")] }),
        gathered({ deleted: [{ container: null, back: false, gap: null }] }),
      ),
    ).toBeNull()
  })
})

describe("remapOfLanded", () => {
  it("pairs a restored run's old ids with its new ones, where the counts agree", () => {
    const remap = remapOfLanded([
      {
        run: run("ab", 10),
        fresh: [
          { client: 2, clock: 0 },
          { client: 2, clock: 1 },
        ],
        nested: [],
      },
      { run: run("cd", 20), fresh: [{ client: 2, clock: 5 }], nested: [] },
    ])
    expect([...remap]).toEqual([
      ["1:10", "2:0"],
      ["1:11", "2:1"],
    ])
  })
})

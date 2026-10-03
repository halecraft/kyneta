// normal — a Yjs record's normal form, on hand-built records.

import { describe, expect, it } from "vitest"
import {
  composeYjsRecords,
  normalForm,
  normalizeYjsRecord,
} from "../undo/normal.js"
import type {
  DeletedRun,
  Id,
  IdRun,
  StablePath,
  YjsRecord,
} from "../undo/record.js"

const id = (clock: number): Id => ({ client: 1, clock })
const ids = (clock: number, length = 1): IdRun[] => [
  { client: 1, clock, length },
]
const tags: StablePath = [{ field: "tags" }]
const body: StablePath = [{ field: "body" }]
const cards: StablePath = [{ field: "cards" }]
const inCard = (item: number, ...rest: StablePath): StablePath => [
  ...cards,
  { item: id(item) },
  ...rest,
]

const record = (r: Partial<YjsRecord>): YjsRecord => ({
  inserted: [],
  deleted: [],
  values: [],
  marks: [],
  ...r,
})

const listRun = (
  container: StablePath,
  clock: number,
  items: unknown[],
  after: Id | null,
): DeletedRun => ({
  container,
  ids: ids(clock, items.length),
  after,
  content: { kind: "sequence", items },
  nested: [],
})

describe("N1: an id both inserted and deleted is neither", () => {
  it("cancels it from both, splitting a run and its content by position", () => {
    const normal = normalizeYjsRecord(
      record({
        inserted: [{ container: tags, ids: ids(11) }],
        deleted: [
          {
            container: tags,
            ids: ids(10, 3),
            after: null,
            content: { kind: "sequence", items: ["a", "y", "b"] },
            nested: [],
          },
        ],
      }),
    )
    expect(normal).toEqual(
      record({
        deleted: [
          {
            container: tags,
            ids: ids(10).concat(ids(12)),
            after: null,
            content: { kind: "sequence", items: ["a", "b"] },
            nested: [],
          },
        ],
      }),
    )
  })

  it("leaves nothing of an item added, then deleted", () => {
    expect(
      normalizeYjsRecord(
        record({
          inserted: [{ container: tags, ids: ids(20) }],
          deleted: [listRun(tags, 20, ["x"], id(5))],
        }),
      ),
    ).toEqual(record({}))
  })
})

describe("N2: nothing inside, or on, what the record inserts", () => {
  it("drops writes inside an added item, and a mark on added characters", () => {
    const normal = normalizeYjsRecord(
      record({
        inserted: [
          { container: cards, ids: ids(20) },
          { container: inCard(20, { field: "name" }), ids: ids(21) },
          { container: body, ids: ids(30, 3) },
        ],
        values: [
          {
            path: inCard(20, { field: "done" }),
            wrote: { value: true },
            previous: { value: false },
          },
        ],
        marks: [
          {
            container: body,
            ids: ids(30, 5),
            key: "bold",
            wrote: true,
            previous: null,
          },
        ],
      }),
    )
    expect(normal).toEqual(
      record({
        inserted: [
          { container: cards, ids: ids(20) },
          { container: body, ids: ids(30, 3) },
        ],
        marks: [
          {
            container: body,
            ids: ids(33, 2),
            key: "bold",
            wrote: true,
            previous: null,
          },
        ],
      }),
    )
  })
})

describe("N3: what lies inside, or on, what the record deletes", () => {
  it("reverts a value, a text, a list and a mark inside a deleted item onto its content", () => {
    const card: DeletedRun = {
      container: cards,
      ids: ids(50),
      after: null,
      content: {
        kind: "sequence",
        items: [
          {
            name: "a!",
            done: true,
            notes: ["n", "m"],
            blurb: [{ text: "hi", marks: { bold: true } }],
          },
        ],
      },
      nested: [
        { item: 0, path: [{ field: "name" }], kind: "text", ids: ids(60, 2) },
        {
          item: 0,
          path: [{ field: "notes" }],
          kind: "sequence",
          ids: ids(70, 2),
        },
        {
          item: 0,
          path: [{ field: "blurb" }],
          kind: "richtext",
          ids: ids(80, 2),
        },
      ],
    }
    const normal = normalForm(
      record({
        inserted: [
          { container: inCard(50, { field: "name" }), ids: ids(61) },
          { container: inCard(50, { field: "notes" }), ids: ids(71) },
        ],
        // A note deleted before the card was, after "n".
        deleted: [
          listRun(inCard(50, { field: "notes" }), 72, ["k"], id(70)),
          card,
        ],
        values: [
          {
            path: inCard(50, { field: "done" }),
            wrote: { value: true },
            previous: { value: false },
          },
        ],
        marks: [
          {
            container: inCard(50, { field: "blurb" }),
            ids: ids(80, 2),
            key: "bold",
            wrote: true,
            previous: null,
          },
        ],
      }),
    )
    expect(normal.complete).toBe(true)
    expect(normal.record).toEqual(
      record({
        deleted: [
          {
            ...card,
            content: {
              kind: "sequence",
              items: [
                {
                  name: "a",
                  done: false,
                  notes: ["n", "k"],
                  blurb: [{ text: "hi" }],
                },
              ],
            },
            nested: [
              {
                item: 0,
                path: [{ field: "name" }],
                kind: "text",
                ids: ids(60),
              },
              {
                item: 0,
                path: [{ field: "notes" }],
                kind: "sequence",
                ids: ids(70).concat(ids(72)),
              },
              {
                item: 0,
                path: [{ field: "blurb" }],
                kind: "richtext",
                ids: ids(80, 2),
              },
            ],
          },
        ],
      }),
    )
  })

  it("reverts a mark on a deleted text run's characters onto its spans", () => {
    expect(
      normalizeYjsRecord(
        record({
          deleted: [
            {
              container: body,
              ids: ids(90, 5),
              after: null,
              content: {
                kind: "richtext",
                spans: [{ text: "hel", marks: { bold: true } }, { text: "lo" }],
              },
              nested: [],
            },
          ],
          marks: [
            {
              container: body,
              ids: ids(89, 4),
              key: "bold",
              wrote: true,
              previous: null,
            },
          ],
        }),
      ),
    ).toEqual(
      record({
        deleted: [
          {
            container: body,
            ids: ids(90, 5),
            after: null,
            content: { kind: "richtext", spans: [{ text: "hello" }] },
            nested: [],
          },
        ],
        // The character the run does not hold keeps its mark write.
        marks: [
          {
            container: body,
            ids: ids(89),
            key: "bold",
            wrote: true,
            previous: null,
          },
        ],
      }),
    )
  })

  it("does not reach normal form when the content no longer holds what was written", () => {
    const normal = normalForm(
      record({
        deleted: [listRun(cards, 50, [{ done: "theirs" }], null)],
        values: [
          {
            path: inCard(50, { field: "done" }),
            wrote: { value: "mine" },
            previous: { value: "" },
          },
        ],
      }),
    )
    expect(normal.complete).toBe(false)
    expect(normal.record.values).toHaveLength(1)
  })
})

describe("N4: adjacent runs", () => {
  it("splices a run anchored on an item another run holds into it", () => {
    // "a b c d", deleted right to left: d, then c, then b.
    expect(
      normalizeYjsRecord(
        record({
          deleted: [
            listRun(tags, 4, ["d"], id(3)),
            listRun(tags, 3, ["c"], id(2)),
            listRun(tags, 2, ["b"], id(1)),
          ],
        }),
      ),
    ).toEqual(
      record({
        deleted: [
          {
            container: tags,
            ids: ids(2, 3),
            after: id(1),
            content: { kind: "sequence", items: ["b", "c", "d"] },
            nested: [],
          },
        ],
      }),
    )
  })
})

describe("runs without ids", () => {
  it("are left as they are, and keep the record from normal form", () => {
    const blind: DeletedRun = {
      container: tags,
      ids: [],
      after: null,
      content: { kind: "sequence", items: ["x"] },
      nested: [],
    }
    const made = record({
      inserted: [{ container: tags, ids: ids(100) }],
      deleted: [blind],
    })
    const normal = normalForm(made)
    expect(normal.record).toEqual(made)
    expect(normal.complete).toBe(false)
  })
})

describe("merging writes", () => {
  it("keeps the first previous and the last wrote, and drops a write that ends where it began", () => {
    const place: StablePath = [{ field: "place" }]
    const meta: StablePath = [{ field: "meta" }]
    expect(
      normalizeYjsRecord(
        record({
          values: [
            { path: place, wrote: { value: "b" }, previous: { value: "a" } },
            { path: meta, wrote: { value: 1 }, previous: null },
            { path: place, wrote: { value: "c" }, previous: { value: "b" } },
            { path: meta, wrote: null, previous: { value: 1 } },
          ],
        }),
      ),
    ).toEqual(
      record({
        values: [
          { path: place, wrote: { value: "c" }, previous: { value: "a" } },
        ],
      }),
    )
  })
})

describe("composeYjsRecords", () => {
  const place: StablePath = [{ field: "place" }]

  it("is null when a value's chain breaks between the two", () => {
    expect(
      composeYjsRecords(
        record({
          values: [
            { path: place, wrote: { value: "a" }, previous: { value: "" } },
          ],
        }),
        record({
          values: [
            { path: place, wrote: { value: "b" }, previous: { value: "q" } },
          ],
        }),
      ),
    ).toBeNull()
  })

  it("is null when a mark's chain breaks on a shared character", () => {
    const mark = (wrote: unknown, previous: unknown) => ({
      container: body,
      ids: ids(1, 2),
      key: "bold",
      wrote,
      previous,
    })
    expect(
      composeYjsRecords(
        record({ marks: [mark(true, null)] }),
        record({ marks: [mark(null, "theirs")] }),
      ),
    ).toBeNull()
  })

  it("composes an insert, a mark on it and its delete into a record naming nothing", () => {
    const composed = [
      record({ inserted: [{ container: body, ids: ids(1, 3) }] }),
      record({
        marks: [
          {
            container: body,
            ids: ids(1, 3),
            key: "bold",
            wrote: true,
            previous: null,
          },
        ],
      }),
      record({
        deleted: [
          {
            container: body,
            ids: ids(1, 3),
            after: null,
            content: {
              kind: "richtext",
              spans: [{ text: "abc", marks: { bold: true } }],
            },
            nested: [],
          },
        ],
      }),
    ].reduce<YjsRecord | null>(
      (a, b) => (a === null ? null : composeYjsRecords(a, b)),
      record({}),
    )
    expect(composed).toEqual(record({}))
  })
})

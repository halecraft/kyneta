// diffOps — the ops a local writer would have produced to turn one state into
// another. Each case also checks the law that makes it an announcement:
// applying the ops to `before` yields `after`.
import { describe, expect, it } from "vitest"
import type { ChangeBase, ReplaceChange } from "../change.js"
import {
  incrementChange,
  mapChange,
  own,
  replaceChange,
  sequenceChange,
  textChange,
} from "../change.js"
import { deepClonePlain } from "../clone.js"
import { diffOps } from "../diff-ops.js"
import { RawPath } from "../path.js"
import { applyChange } from "../reader.js"
import { Schema } from "../schema.js"

const Doc = Schema.struct({
  title: Schema.text(),
  count: Schema.counter(),
  flag: Schema.boolean(),
  settings: Schema.struct({ dark: Schema.boolean(), font: Schema.number() }),
  peers: Schema.record(
    Schema.struct({ cursor: Schema.number(), name: Schema.string() }),
  ),
  mode: Schema.discriminatedUnion("type", [
    Schema.struct({ type: Schema.string("a"), a: Schema.number() }),
    Schema.struct({ type: Schema.string("b"), b: Schema.string() }),
  ]),
  blob: Schema.struct.json({ x: Schema.number() }),
  items: Schema.list(Schema.number()),
  tags: Schema.set(Schema.string()),
})

const base = {
  title: "hello",
  count: 3,
  flag: false,
  settings: { dark: false, font: 12 },
  peers: { alice: { cursor: 1, name: "A" }, bob: { cursor: 2, name: "B" } },
  mode: { type: "a", a: 1 },
  blob: { x: 1 },
  items: [1, 2],
  tags: ["t"],
}

/** The ops' paths and changes, in a comparable form. */
function described(before: unknown, after: unknown) {
  return diffOps(Doc, before, after).map(op => [op.path.format(), op.change])
}

/** `before` with the ops applied, on a copy. */
function applied(before: Record<string, unknown>, after: unknown) {
  const state = { current: deepClonePlain(before) }
  for (const op of diffOps(Doc, before, after)) {
    applyChange(state, op.path, op.change)
  }
  return state.current
}

function expectLaw(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
) {
  expect(applied(before, after)).toEqual(after)
}

describe("diffOps", () => {
  it("equal states produce no ops", () => {
    expect(diffOps(Doc, base, deepClonePlain(base))).toEqual([])
  })

  it("a declared field recurses to the leaf that moved", () => {
    const after = { ...base, settings: { dark: true, font: 12 } }
    expect(described(base, after)).toEqual([
      ["settings.dark", replaceChange(true)],
    ])
    expectLaw(base, after)
  })

  it("an absent declared field reads as its zero", () => {
    const { settings: _, ...partial } = base
    expect(described(partial, base)).toEqual([
      ["settings.font", replaceChange(12)],
    ])
    const after = { ...base, settings: { dark: false, font: 0 } }
    expect(described(base, { ...base, settings: { dark: false } })).toEqual(
      described(base, after),
    )
  })

  it("a record sets arrivals, deletes departures, and recurses into kept keys", () => {
    const after = {
      ...base,
      peers: {
        alice: { cursor: 5, name: "A" },
        carol: { cursor: 0, name: "C" },
      },
    }
    expect(described(base, after)).toEqual([
      ["peers", mapChange(own({ carol: { cursor: 0, name: "C" } }), ["bob"])],
      ["peers.alice.cursor", replaceChange(5)],
    ])
    expectLaw(base, after)
  })

  it("a register (a sum, a .json() node) is one replace", () => {
    const after = { ...base, mode: { type: "b", b: "x" }, blob: { x: 2 } }
    expect(described(base, after)).toEqual([
      ["mode", replaceChange(own({ type: "b", b: "x" }))],
      ["blob", replaceChange(own({ x: 2 }))],
    ])
    expectLaw(base, after)
  })

  it("a set is one replace", () => {
    const after = { ...base, tags: ["t", "u"] }
    expect(described(base, after)).toEqual([
      ["tags", replaceChange(own(["t", "u"]))],
    ])
    expectLaw(base, after)
  })

  describe("a list diffs by position", () => {
    const withItems = (items: number[]) => ({ ...base, items })

    it("an insert retains the prefix and inserts only the new items", () => {
      const before = withItems([1, 2, 3, 4])
      const after = withItems([1, 2, 9, 3, 4])
      expect(described(before, after)).toEqual([
        ["items", sequenceChange([{ retain: 2 }, { insert: [own(9)] }])],
      ])
      expectLaw(before, after)
    })

    it("a delete retains the prefix and deletes only the items that left", () => {
      const before = withItems([1, 2, 3, 4])
      const after = withItems([1, 4])
      expect(described(before, after)).toEqual([
        ["items", sequenceChange([{ retain: 1 }, { delete: 2 }])],
      ])
      expectLaw(before, after)
    })

    it("a middle replacement deletes and inserts the window between the differences", () => {
      const before = withItems([1, 2, 3, 4, 5])
      const after = withItems([1, 7, 3, 8, 5])
      expect(described(before, after)).toEqual([
        [
          "items",
          sequenceChange([
            { retain: 1 },
            { delete: 3 },
            { insert: [own(7), own(3), own(8)] },
          ]),
        ],
      ])
      expectLaw(before, after)
    })

    it("an unchanged list gives nothing", () => {
      expect(described(base, withItems([1, 2]))).toEqual([])
    })

    it("a .json() list is one replace", () => {
      const schema = Schema.struct({ tags: Schema.list.json(Schema.number()) })
      const ops = diffOps(schema, { tags: [1, 2] }, { tags: [1, 2, 3] })
      expect(ops.map(op => [op.path.format(), op.change])).toEqual([
        ["tags", replaceChange(own([1, 2, 3]))],
      ])
    })
  })

  describe("restricted to named entries", () => {
    const peers = RawPath.empty.field("peers")

    it("a record reports only the named keys that arrived or left, and recurses into kept ones", () => {
      const before = {
        alice: { cursor: 1, name: "A" },
        bob: { cursor: 2, name: "B" },
        dave: { cursor: 4, name: "D" },
      }
      const after = {
        alice: { cursor: 5, name: "A" },
        carol: { cursor: 3, name: "C" },
        erin: { cursor: 6, name: "E" },
      }
      const ops = diffOps(Doc.fields.peers, before, after, peers, [
        "alice",
        "bob",
        "carol",
      ])
      expect(ops.map(op => [op.path.format(), op.change])).toEqual([
        ["peers", mapChange(own({ carol: { cursor: 3, name: "C" } }), ["bob"])],
        ["peers.alice.cursor", replaceChange(5)],
      ])
    })

    it("names entries only of a record", () => {
      expect(() =>
        diffOps(Doc, { flag: false }, { flag: true }, RawPath.empty, ["flag"]),
      ).toThrow(/entries of a record/)
    })
  })

  it("text becomes the minimal contiguous edit, and a counter an increment", () => {
    const after = { ...base, title: "hello world", count: 1 }
    const expected: [string, ChangeBase][] = [
      ["title", textChange([{ retain: 5 }, { insert: " world" }])],
      ["count", incrementChange(-2)],
    ]
    expect(described(base, after)).toEqual(expected)
    expectLaw(base, after)
  })

  it("a scalar is a replace", () => {
    const after = { ...base, flag: true }
    expect(described(base, after)).toEqual([["flag", replaceChange(true)]])
    expectLaw(base, after)
  })

  it("payloads share nothing with `after`", () => {
    const after = { ...base, blob: { x: 9 } }
    const [op] = diffOps(Doc, base, after)
    expect((op?.change as ReplaceChange | undefined)?.value).not.toBe(
      after.blob,
    )
  })

  it("roots its paths at the path it is given", () => {
    const at = RawPath.empty.field("settings")
    const ops = diffOps(
      Doc.fields.settings,
      base.settings,
      { dark: true, font: 12 },
      at,
    )
    expect(ops.map(op => op.path.format())).toEqual(["settings.dark"])
  })
})

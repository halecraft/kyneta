// coordinateExists — whether a coordinate still exists, from its parent's
// schema and σ.
import { describe, expect, it } from "vitest"
import { childSchema, coordinateExists } from "../coordinate-exists.js"
import { RawPath, rawEntry, rawField, rawIndex } from "../path.js"
import { plainReader } from "../reader.js"
import { Schema } from "../schema.js"

const Mode = Schema.discriminatedUnion("type", [
  Schema.struct({ type: Schema.string("a"), a: Schema.number() }),
  Schema.struct({ type: Schema.string("b"), b: Schema.number() }),
])
const Opt = Schema.struct({ x: Schema.number() }).nullable()
const Plain = Schema.struct({ p: Schema.number() })
const Record = Schema.record(Schema.number())
const Tree = Schema.tree(Schema.struct({ label: Schema.string() }))

const state = {
  mode: { type: "a", a: 1 },
  nothing: null,
  something: { x: 1 },
  partial: {},
  record: { k: 1 },
  tree: [{ id: "n1", parent: null, index: 0, data: { label: "x" } }],
}
const reader = plainReader({ current: state })
const at = (key: string) => RawPath.empty.field(key)

describe("coordinateExists", () => {
  const table: [string, Parameters<typeof coordinateExists>, boolean][] = [
    ["a declared field", [Plain, reader, at("partial"), rawField("p")], true],
    [
      "an undeclared field",
      [Plain, reader, at("partial"), rawField("q")],
      false,
    ],
    [
      "an active variant's field",
      [Mode, reader, at("mode"), rawField("a")],
      true,
    ],
    [
      "an inactive variant's field",
      [Mode, reader, at("mode"), rawField("b")],
      false,
    ],
    [
      "a null nullable's field",
      [Opt, reader, at("nothing"), rawField("x")],
      false,
    ],
    [
      "a present nullable's field",
      [Opt, reader, at("something"), rawField("x")],
      true,
    ],
    ["a present map key", [Record, reader, at("record"), rawEntry("k")], true],
    ["an absent map key", [Record, reader, at("record"), rawEntry("j")], false],
    [
      "a tree node in the forest",
      [Tree, reader, at("tree"), rawEntry("n1")],
      true,
    ],
    [
      "a tree node not in it",
      [Tree, reader, at("tree"), rawEntry("n2")],
      false,
    ],
    [
      "a list item is never asked",
      [Schema.list(Plain), reader, at("x"), rawIndex(9)],
      true,
    ],
  ]
  for (const [name, args, expected] of table) {
    it(name, () => {
      expect(coordinateExists(...args)).toBe(expected)
    })
  }
})

describe("childSchema", () => {
  it("resolves a sum from σ before choosing the child", () => {
    expect(childSchema(Mode, reader, at("mode"), rawField("a"))).toBe(
      Mode.variantMap.a.fields.a,
    )
    expect(childSchema(Mode, reader, at("mode"), rawField("b"))).toBeUndefined()
    expect(childSchema(Record, reader, at("record"), rawEntry("k"))).toBe(
      Record.item,
    )
    expect(childSchema(Tree, reader, at("tree"), rawEntry("n1"))).toBe(
      Tree.item,
    )
  })
})

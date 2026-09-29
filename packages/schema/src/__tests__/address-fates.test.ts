// planAddressFates — which coordinates a change killed, dropped or revived.
import { describe, expect, it } from "vitest"
import {
  type AddressFates,
  planAddressFates,
  type RegisteredCoordinate,
} from "../address-fates.js"
import { CoordinateTrie } from "../coordinate-trie.js"
import type { AddressedPath } from "../path.js"
import { Schema, type Schema as SchemaNode } from "../schema.js"

const Entry = Schema.struct({
  n: Schema.number(),
  tags: Schema.list(Schema.string()),
})
const Doc = Schema.struct({
  m: Schema.record(Entry),
  tree: Schema.tree(Schema.struct({ label: Schema.string() })),
})

const trie = new CoordinateTrie()
const m = trie.root.field("m")
const k = m.entry("k")
const kn = k.field("n")
const ktags = k.field("tags")
const kitem = ktags.item(0)
const tree = trie.root.field("tree")
const node = tree.entry("id")
const label = node.field("label")

const at = (path: AddressedPath, schema?: SchemaNode, dead = false) =>
  ({
    path,
    segment: path.segments[path.length - 1],
    schema,
    dead,
  }) as RegisteredCoordinate

/** Paths' keys in each list, for comparison. */
const keys = (fates: AddressFates) => ({
  die: fates.die.map(p => p.key),
  drop: fates.drop.map(p => p.key),
  revive: fates.revive.map(p => p.key),
  rekind: fates.rekind.map(p => p.key),
})

const childSchema = (
  parent: SchemaNode,
  _: AddressedPath,
  segment: { coord(): string | number; role: string },
) => {
  const p = parent as unknown as {
    fields?: Record<string, SchemaNode>
    item?: SchemaNode
  }
  return segment.role === "field" ? p.fields?.[String(segment.coord())] : p.item
}

describe("planAddressFates", () => {
  const mScope = [
    at(k, Entry),
    at(kn, Entry.fields.n),
    at(ktags, Entry.fields.tags),
    at(kitem, Schema.string()),
  ]

  it("a key that is gone dies, and everything below it dies: fields and entries kept, items dropped", () => {
    const fates = planAddressFates(
      { path: m, schema: Doc.fields.m, dead: false },
      mScope,
      () => false,
      childSchema,
    )
    expect(keys(fates)).toEqual({
      die: [k.key, kn.key, ktags.key],
      drop: [kitem.key],
      revive: [],
      rekind: [],
    })
  })

  it("a key that exists again revives with what was kept below it, and list items in scope are dropped", () => {
    const fates = planAddressFates(
      { path: m, schema: Doc.fields.m, dead: false },
      [
        at(k, Entry, true),
        at(kn, Entry.fields.n, true),
        at(ktags, Entry.fields.tags, true),
        at(kitem, Schema.string()),
      ],
      () => true,
      childSchema,
    )
    expect(keys(fates)).toEqual({
      die: [],
      drop: [kitem.key],
      revive: [k.key, kn.key, ktags.key],
      rekind: [],
    })
    expect(fates.schemas.get(k)).toBe(Entry)
  })

  it("a tree node that is gone is dropped, not kept", () => {
    const fates = planAddressFates(
      { path: tree, schema: Doc.fields.tree, dead: false },
      [at(node, Doc.fields.tree.item), at(label, Schema.string())],
      () => false,
      childSchema,
    )
    expect(keys(fates)).toEqual({
      die: [],
      drop: [node.key],
      revive: [],
      rekind: [],
    })
  })

  it("under a dead parent everything dies, whatever exists", () => {
    const fates = planAddressFates(
      { path: m, schema: Doc.fields.m, dead: true },
      mScope,
      () => true,
      childSchema,
    )
    expect(keys(fates).die).toEqual([k.key, kn.key, ktags.key])
    expect(keys(fates).drop).toEqual([kitem.key])
  })

  it("a coordinate whose schema changed kind lives, and everything below it dies", () => {
    const Other = Schema.record(Schema.number())
    const fates = planAddressFates(
      { path: m, schema: Doc.fields.m, dead: false },
      mScope,
      () => true,
      (_parent, _path, segment) =>
        segment.coord() === "tags" ? Other : Entry.fields.n,
    )
    // `k` derives as a number here: a change of kind from the struct it was.
    expect(keys(fates).rekind).toEqual([k.key])
    expect(keys(fates).die).toEqual([kn.key, ktags.key])
    expect(keys(fates).drop).toEqual([kitem.key])
  })
})

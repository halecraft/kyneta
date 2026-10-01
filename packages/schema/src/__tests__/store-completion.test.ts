// store-completion — every value that enters σ has its schema's shape.
//
// A write may carry a partial value (an untyped write, an older peer's entry,
// a `tree.create` with some of its data), and the store completes it on the
// way in: an absent declared field is its `Zero.structural`, an undeclared key
// is dropped, and a sum holds the variant `dispatchSum` picks. So every read,
// every peer and every substrate see the same value.

import { describe, expect, it } from "vitest"
import { completeChange, completeValue } from "../complete.js"
// Everything from one entrypoint: binding compares schema identity, and
// `../basic/index.js` is a separate module instance whose schemas this
// entrypoint's binder does not recognise.
import type { MaterializeResolver, Op, Schema as SchemaNode } from "../index.js"
import {
  batch,
  createDoc,
  createMaterializeInterpreter,
  exportEntirety,
  exportSince,
  interpret,
  json,
  Migration,
  mapChange,
  materializeContextFromResolver,
  merge,
  NATIVE,
  plainResolution,
  replaceChange,
  Schema,
  sequenceChange,
  subscribe,
  textChange,
  trustAsOwned,
  version,
} from "../index.js"
import type { Path } from "../path.js"
import { plainReader } from "../reader.js"

// ---------------------------------------------------------------------------
// completeValue — pure
// ---------------------------------------------------------------------------

const Shape = Schema.discriminatedUnion("kind", [
  Schema.struct({ kind: Schema.string("circle"), radius: Schema.number() }),
  Schema.struct({ kind: Schema.string("square"), side: Schema.number() }),
])

const Point = Schema.struct({ x: Schema.number(), y: Schema.number() })

/** Each case's schema is a struct with one field, `v`, under test. */
const cases: readonly {
  readonly name: string
  readonly field: SchemaNode
  readonly value: Record<string, unknown>
  readonly expected: Record<string, unknown>
}[] = [
  {
    name: "an absent scalar",
    field: Schema.number(),
    value: {},
    expected: { v: 0 },
  },
  {
    name: "an absent constrained scalar",
    field: Schema.string("a", "b"),
    value: {},
    expected: { v: "a" },
  },
  {
    name: "an absent struct",
    field: Point,
    value: {},
    expected: { v: { x: 0, y: 0 } },
  },
  {
    name: "an absent list",
    field: Schema.list(Schema.string()),
    value: {},
    expected: { v: [] },
  },
  {
    name: "an absent record",
    field: Schema.record(Schema.number()),
    value: {},
    expected: { v: {} },
  },
  {
    name: "an absent text",
    field: Schema.text(),
    value: {},
    expected: { v: "" },
  },
  {
    name: "an absent counter",
    field: Schema.counter(),
    value: {},
    expected: { v: 0 },
  },
  {
    name: "an undeclared key at the top level",
    field: Schema.number(),
    value: { v: 1, extra: true },
    expected: { v: 1 },
  },
  {
    name: "an undeclared key nested",
    field: Point,
    value: { v: { x: 1, y: 2, z: 3 } },
    expected: { v: { x: 1, y: 2 } },
  },
  {
    name: "a nullable that is undefined",
    field: Point.nullable(),
    value: {},
    expected: { v: null },
  },
  {
    name: "a nullable holding a partial struct",
    field: Point.nullable(),
    value: { v: { x: 1 } },
    expected: { v: { x: 1, y: 0 } },
  },
  {
    name: "a discriminated sum missing a variant field",
    field: Shape,
    value: { v: { kind: "square" } },
    expected: { v: { kind: "square", side: 0 } },
  },
  {
    name: "a discriminated sum that is absent",
    field: Shape,
    value: {},
    expected: { v: { kind: "circle", radius: 0 } },
  },
  {
    name: "an unknown discriminant, as the first variant",
    field: Shape,
    value: { v: { kind: "hexagon" } },
    expected: { v: { kind: "hexagon", radius: 0 } },
  },
  {
    name: "a .json() struct missing a field",
    field: Schema.struct.json({ a: Schema.string(), b: Schema.number() }),
    value: { v: { a: "x" } },
    expected: { v: { a: "x", b: 0 } },
  },
  {
    name: "record entries missing fields",
    field: Schema.record(Point),
    value: { v: { p: { x: 1 }, q: { y: 2 } } },
    expected: { v: { p: { x: 1, y: 0 }, q: { x: 0, y: 2 } } },
  },
  {
    name: "list items missing fields",
    field: Schema.list(Point),
    value: { v: [{ x: 1 }, { x: 1, y: 1 }] },
    expected: {
      v: [
        { x: 1, y: 0 },
        { x: 1, y: 1 },
      ],
    },
  },
  {
    name: "set members missing fields",
    field: Schema.set(Point),
    value: { v: [{ x: 1 }] },
    expected: { v: [{ x: 1, y: 0 }] },
  },
  {
    name: "tree node data missing fields",
    field: Schema.tree(
      Schema.struct({ label: Schema.string(), done: Schema.boolean() }),
    ),
    value: {
      v: [{ id: "n", parent: null, index: 0, data: { label: "a" } }],
    },
    expected: {
      v: [
        { id: "n", parent: null, index: 0, data: { label: "a", done: false } },
      ],
    },
  },
]

/** A resolver over a plain value, as a backend answers for a register's interior. */
function plainValueResolver(
  state: Record<string, unknown>,
): MaterializeResolver {
  const at = (path: Path) => path.read(state)
  const reader = plainReader(state)
  return {
    resolveValue: at,
    resolveText: path => plainResolution.text(at(path)),
    resolveCounter: path => plainResolution.counter(at(path)),
    resolveRichText: path => plainResolution.richText(at(path)),
    resolveLength: path => plainResolution.length(at(path)),
    resolveKeys: path => plainResolution.keys(at(path)),
    resolveForest: path => reader.forestTopology(path),
  }
}

function materialize(
  schema: SchemaNode,
  state: Record<string, unknown>,
): unknown {
  const resolver = plainValueResolver(state)
  return interpret(
    schema,
    createMaterializeInterpreter(resolver),
    materializeContextFromResolver(resolver),
  )
}

describe("completeValue", () => {
  for (const { name, field, value, expected } of cases) {
    const schema = Schema.struct({ v: field })

    it(`completes ${name}`, () => {
      expect(completeValue(schema, value)).toEqual(expected)
    })

    it(`agrees with the materializer on ${name}`, () => {
      expect(completeValue(schema, value)).toEqual(materialize(schema, value))
    })
  }

  it("returns an `any` object as itself", () => {
    const schema = Schema.struct({ v: Schema.any() })
    const blob = { anything: { at: "all" } }
    const value = { v: blob }
    expect(completeValue(schema, value)).toBe(value)
  })

  it("returns a complete value as itself", () => {
    const schema = Schema.struct({
      p: Point,
      rows: Schema.record(Point),
      items: Schema.list(Point),
      shape: Shape,
      opt: Point.nullable(),
    })
    const value = {
      p: { x: 1, y: 2 },
      rows: { a: { x: 0, y: 0 } },
      items: [{ x: 3, y: 4 }],
      shape: { kind: "square", side: 2 },
      opt: null,
    }
    expect(completeValue(schema, value)).toBe(value)
  })

  it("rebuilds only the path to what it completes", () => {
    const schema = Schema.struct({ a: Point, b: Point })
    const value = { a: { x: 1, y: 1 }, b: { x: 1 } }
    const out = completeValue(schema, value) as typeof value
    expect(out.a).toBe(value.a)
    expect(out.b).toEqual({ x: 1, y: 0 })
  })

  it("passes a value of the wrong kind through", () => {
    expect(completeValue(Point, 3)).toBe(3)
    expect(completeValue(Schema.list(Point), "no")).toBe("no")
  })
})

// ---------------------------------------------------------------------------
// completeChange — pure
// ---------------------------------------------------------------------------

describe("completeChange", () => {
  it("returns a change that carries nothing as itself", () => {
    const change = textChange([{ insert: "x" }])
    expect(completeChange(Schema.text(), change)).toBe(change)
  })

  it("completes a map set on a struct per field, leaving undeclared keys", () => {
    const schema = Schema.struct({ p: Point, n: Schema.number() })
    const change = mapChange(trustAsOwned({ p: { x: 1 }, other: { y: 1 } }))
    expect(completeChange(schema, change)).toEqual(
      mapChange(trustAsOwned({ p: { x: 1, y: 0 }, other: { y: 1 } })),
    )
  })

  it("completes a map set on a record per entry", () => {
    const change = mapChange(trustAsOwned({ a: { x: 1 }, b: { y: 1 } }))
    expect(completeChange(Schema.record(Point), change)).toEqual(
      mapChange(
        trustAsOwned({
          a: { x: 1, y: 0 },
          b: { x: 0, y: 1 },
        }),
      ),
    )
  })

  it("completes a replace at a nullable as its inner struct", () => {
    const change = replaceChange(trustAsOwned({ y: 2 }))
    expect(completeChange(Point.nullable(), change)).toEqual(
      replaceChange(trustAsOwned({ x: 0, y: 2 })),
    )
  })

  it("completes each item a sequence inserts", () => {
    const change = sequenceChange([
      { retain: 1 },
      { insert: [trustAsOwned({ x: 1 }), trustAsOwned({ y: 1 })] },
    ])
    expect(completeChange(Schema.list(Point), change)).toEqual(
      sequenceChange([
        { retain: 1 },
        {
          insert: [trustAsOwned({ x: 1, y: 0 }), trustAsOwned({ x: 0, y: 1 })],
        },
      ]),
    )
  })
})

// ---------------------------------------------------------------------------
// Older-schema entries
// ---------------------------------------------------------------------------

const RowsV1 = Schema.struct({
  rows: Schema.record(Schema.struct({ title: Schema.string() })),
})

const RowsV2 = Schema.struct({
  rows: Schema.record(
    Schema.struct({
      title: Schema.string(),
      tags: Schema.list(Schema.string()),
      n: Schema.number(),
    }),
  ),
})

const completeRow = { title: "a", tags: [], n: 0 }

/** A V1 doc holding one entry, and the version it started at. */
function v1WithEntry() {
  const v1: any = createDoc(json.bind(RowsV1))
  const genesis = version(v1)
  batch(v1, (d: any) => d.rows.set("a", { title: "a" }))
  return { v1, genesis }
}

describe("an entry written under an older schema is stored complete", () => {
  it("through a whole-document merge", () => {
    const { v1 } = v1WithEntry()
    const v2: any = createDoc(json.bind(RowsV2))
    merge(v2, exportEntirety(v1))
    expect(v2.rows()).toEqual({ a: completeRow })
    expect(v2[NATIVE]).toEqual({ rows: { a: completeRow } })
  })

  it("through a delta merge", () => {
    const { v1, genesis } = v1WithEntry()
    const v2: any = createDoc(json.bind(RowsV2))
    const delta = exportSince(v1, genesis)
    expect(delta).not.toBeNull()
    if (delta === null) return
    merge(v2, delta)
    expect(v2.rows()).toEqual({ a: completeRow })
    expect(v2[NATIVE]).toEqual({ rows: { a: completeRow } })
  })
})

// ---------------------------------------------------------------------------
// Tree nodes
// ---------------------------------------------------------------------------

const Forest = Schema.struct({
  tree: Schema.tree(
    Schema.struct({
      label: Schema.string(),
      done: Schema.boolean(),
      tags: Schema.list(Schema.string()),
    }),
  ),
})

/** The data σ holds for tree node `id`. */
function storedNode(doc: any, id: string): unknown {
  const nodes = doc[NATIVE].tree as { id: string; data: unknown }[]
  return nodes.find(node => node.id === id)?.data
}

describe("a tree node is created complete", () => {
  it("with partial data", () => {
    const doc: any = createDoc(json.bind(Forest))
    const id: string = doc.tree.create({ data: { label: "a" } })
    const complete = { label: "a", done: false, tags: [] }
    expect(doc.tree.node(id)()).toEqual(complete)
    expect(storedNode(doc, id)).toEqual(complete)
  })

  it("with no data", () => {
    const doc: any = createDoc(json.bind(Forest))
    const id: string = doc.tree.create()
    const complete = { label: "", done: false, tags: [] }
    expect(doc.tree.node(id)()).toEqual(complete)
    expect(storedNode(doc, id)).toEqual(complete)
  })
})

// ---------------------------------------------------------------------------
// The delivered op is the stored value
// ---------------------------------------------------------------------------

describe("the op delivered, the op logged and σ carry one completed value", () => {
  it("for an untyped partial set", () => {
    const doc: any = createDoc(json.bind(RowsV2))
    const genesis = version(doc)
    const delivered: Op[] = []
    subscribe(doc, (cs: any) => delivered.push(...cs.changes))

    batch(doc, (d: any) => d.rows.set("a", { title: "a", extra: true }))

    expect(delivered).toHaveLength(1)
    expect(delivered[0]?.change).toMatchObject({ set: { a: completeRow } })

    const logged = exportSince(doc, genesis)
    expect(logged).not.toBeNull()
    if (logged === null) return
    const body = JSON.parse(logged.data as string) as {
      batches: { change: unknown }[][]
    }
    expect(body.batches[0]?.[0]?.change).toEqual({
      type: "map",
      set: { a: completeRow },
    })

    expect(doc[NATIVE]).toEqual({ rows: { a: completeRow } })
  })
})

// ---------------------------------------------------------------------------
// A change at a sum's path
// ---------------------------------------------------------------------------

describe("a change at a sum's path lands at the variant σ holds", () => {
  it("a partial item pushed onto a nullable list is stored complete", () => {
    const doc: any = createDoc(
      json.bind(Schema.struct({ items: Schema.list(Point).nullable() })),
    )
    doc.items.set([])
    doc.items.push({ x: 1 })
    expect(doc.items()).toEqual([{ x: 1, y: 0 }])
    expect(doc[NATIVE]).toEqual({ items: [{ x: 1, y: 0 }] })
  })

  it("a partial entry set on a nullable record is stored complete", () => {
    const doc: any = createDoc(
      json.bind(Schema.struct({ rows: Schema.record(Point).nullable() })),
    )
    doc.rows.set({})
    doc.rows.set("a", { y: 2 })
    expect(doc.rows()).toEqual({ a: { x: 0, y: 2 } })
    expect(doc[NATIVE]).toEqual({ rows: { a: { x: 0, y: 2 } } })
  })
})

// ---------------------------------------------------------------------------
// The plain log keeps merged batches as sent
// ---------------------------------------------------------------------------

describe("a merged batch", () => {
  it("is logged as sent, while σ holds its completion", () => {
    const { v1, genesis } = v1WithEntry()
    const v2: any = createDoc(json.bind(RowsV2))
    const v2Genesis = version(v2)
    const sent = exportSince(v1, genesis)
    expect(sent).not.toBeNull()
    if (sent === null) return
    merge(v2, sent)

    const relayed = exportSince(v2, v2Genesis)
    expect(relayed).not.toBeNull()
    if (relayed === null) return
    const batchesOf = (payload: { data: unknown }) =>
      (JSON.parse(payload.data as string) as { batches: unknown }).batches
    expect(batchesOf(relayed)).toEqual(batchesOf(sent))
    expect(v2[NATIVE]).toEqual({ rows: { a: completeRow } })
  })
})

// ---------------------------------------------------------------------------
// Rename on json documents
// ---------------------------------------------------------------------------

const AddressV1 = Schema.struct({ name: Schema.string(), zip: Schema.string() })
const AddressV2 = Schema.struct({
  name: Schema.string(),
  postalCode: Schema.string(),
}).migrated(Migration.rename("zip", "postalCode"))

describe("a rename on json documents", () => {
  it("V2 advertises support for V1, so the exchange syncs the two", () => {
    const v1 = json.bind(AddressV1)
    const v2 = json.bind(AddressV2)
    expect([...v2.supportedHashes].includes(v1.schemaHash)).toBe(true)
  })

  // The plain substrate keys σ by field name, so a renamed field is a
  // different key to each peer.
  it.fails("keeps the value on both peers", () => {
    const alice: any = createDoc(json.bind(AddressV1))
    batch(alice, (d: any) => {
      d.name.set("alice")
      d.zip.set("94110")
    })

    const bob: any = createDoc(json.bind(AddressV2))
    merge(bob, exportEntirety(alice))
    expect(bob.postalCode()).toBe("94110")

    batch(bob, (d: any) => d.name.set("bob"))
    merge(alice, exportEntirety(bob))
    expect(alice.zip()).toBe("94110")
  })
})

// map-clear: `MapChange.clear`, outside the ephemeral substrate.
//
// A clear is intent: "every key goes, seen or not". What it reaches is the
// substrate's merge law to decide, so every consumer that applies map changes
// key by key reads it through `mapChangeEffects`, against the keys it holds.
// Observed-remove is exactly that: a clear expanded against local keys. The
// ephemeral substrate is the one reader that does not expand it, and its
// behaviour is pinned in `ephemeral-deletion` and `tests/conformance`.

import { describe, expect, it } from "vitest"
import {
  batch,
  createDoc,
  expandMapOpsToLeaves,
  exportSince,
  invert,
  json,
  mapChange,
  mapChangeEffects,
  mapClearChange,
  merge,
  own,
  Schema,
  step,
  version,
} from "../index.js"
import { RawPath } from "../path.js"
import { defined } from "../testing/index.js"

describe("mapChangeEffects", () => {
  it("expands a clear against the keys held", () => {
    expect(mapChangeEffects(mapClearChange(), ["a", "b"])).toEqual({
      set: {},
      remove: ["a", "b"],
    })
  })

  it("keeps what the clear sets", () => {
    expect(mapChangeEffects(mapClearChange(own({ a: 1 })), ["a", "b"])).toEqual(
      {
        set: { a: 1 },
        remove: ["b"],
      },
    )
  })

  it("removes nothing held when the change is not a clear", () => {
    expect(mapChangeEffects(mapChange(undefined, ["x"]), ["a", "b"])).toEqual({
      set: {},
      remove: ["x"],
    })
  })

  it("sets a key named in both lists", () => {
    expect(mapChangeEffects(mapChange(own({ a: 1 }), ["a"]), [])).toEqual({
      set: { a: 1 },
      remove: [],
    })
  })
})

describe("a clear in the plain algebra", () => {
  it("step leaves only what the clear sets", () => {
    expect(step({ a: 1, b: 2 }, mapClearChange(own({ c: 3 })))).toEqual({
      c: 3,
    })
  })

  it("its inverse restores every entry held before it", () => {
    const pre = { a: 1, b: 2 }
    const change = mapClearChange(own({ b: 9, c: 3 }))
    const inverse = defined(invert(pre, change), "the inverse")
    expect(step(step(pre, change), inverse)).toEqual(pre)
  })
})

describe("expandMapOpsToLeaves", () => {
  const Doc = Schema.struct({
    point: Schema.struct({ x: Schema.number(), y: Schema.number() }),
  })
  const point = RawPath.empty.field("point")

  it("refuses a clear at a product path", () => {
    expect(() =>
      expandMapOpsToLeaves([{ path: point, change: mapClearChange() }], Doc),
    ).toThrow(/only a record can be cleared/)
  })

  it("expands a field named in both lists to its set value, as step does", () => {
    const ops = expandMapOpsToLeaves(
      [{ path: point, change: mapChange(own({ x: 5 }), ["x"]) }],
      Doc,
    )
    expect(
      ops.map(op => ({
        at: op.path.segments.map(segment => segment.resolve()),
        change: op.change,
      })),
    ).toEqual([{ at: ["point", "x"], change: { type: "replace", value: 5 } }])
  })
})

describe("a clear on the plain substrate", () => {
  it("replays on a second peer", () => {
    const Roster = json.bind(
      Schema.struct({ peers: Schema.record(Schema.number()) }),
    )
    const a: any = createDoc(Roster)
    const b: any = createDoc(Roster)
    const since = version(b)

    batch(a, (d: any) => {
      d.peers.set("alice", 1)
      d.peers.set("bob", 2)
    })
    batch(a, (d: any) => d.peers.clear())
    merge(b, defined(exportSince(a, since), "a delta"))

    expect(a.peers()).toEqual({})
    expect(b.peers()).toEqual({})
  })
})

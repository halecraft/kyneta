// changeset-batching.test — pin criterion #4:
//
// `batch(doc, fn)` with N helper calls delivers exactly one Changeset
// per affected subscriber path. Inner runBatch frames (auto-commit
// dispatch outside, nested batch() inside, etc.) push/pop without
// sealing — only the outermost frame's release seals a batch.
//
// This contract was implicit in the pre-refactor buffer model and is
// load-bearing under the depth-aware dispatch redesign.

import type { Changeset } from "@kyneta/changefeed"
import { CHANGEFEED } from "@kyneta/changefeed"
import { describe, expect, it } from "vitest"
import type { Op } from "../index.js"
import {
  applyChanges,
  batch,
  interpret,
  observation,
  plainContext,
  readable,
  Schema,
  writable,
} from "../index.js"
import { RawPath } from "../path.js"

function buildDoc<S extends ReturnType<typeof Schema.struct>>(
  schema: S,
  seed: Record<string, unknown>,
) {
  const store = { ...seed }
  const ctx = plainContext(store)
  const doc = interpret(schema, ctx)
    .with(readable)
    .with(writable)
    .with(observation)
    .done() as any
  return { store, ctx, doc }
}

describe("changeset batching: criterion #4", () => {
  it("batch() with N helpers on same path → one Changeset with N changes", () => {
    const schema = Schema.struct({ count: Schema.number() })
    const { doc } = buildDoc(schema, { count: 0 })

    const seen: Changeset[] = []
    doc.count[CHANGEFEED].subscribe((cs: Changeset) => seen.push(cs))

    batch(doc, d => {
      d.count.set(1)
      d.count.set(2)
      d.count.set(3)
    })

    expect(seen).toHaveLength(1)
    expect(seen[0]?.changes).toHaveLength(3)
  })

  it("batch() with N helpers across distinct paths → one Changeset per path", () => {
    const schema = Schema.struct({
      x: Schema.number(),
      y: Schema.number(),
    })
    const { doc } = buildDoc(schema, { x: 0, y: 0 })

    const xs: Changeset[] = []
    const ys: Changeset[] = []
    doc.x[CHANGEFEED].subscribe((cs: Changeset) => xs.push(cs))
    doc.y[CHANGEFEED].subscribe((cs: Changeset) => ys.push(cs))

    batch(doc, d => {
      d.x.set(10)
      d.y.set(20)
      d.x.set(30)
    })

    expect(xs).toHaveLength(1)
    expect(xs[0]?.changes).toHaveLength(2)
    expect(ys).toHaveLength(1)
    expect(ys[0]?.changes).toHaveLength(1)
  })

  it("nested batch() inside batch() collapses into outermost block — one Changeset", () => {
    const schema = Schema.struct({ count: Schema.number() })
    const { doc } = buildDoc(schema, { count: 0 })

    const seen: Changeset[] = []
    doc.count[CHANGEFEED].subscribe((cs: Changeset) => seen.push(cs))

    batch(doc, d => {
      d.count.set(1)
      batch(d, dd => {
        dd.count.set(2)
        dd.count.set(3)
      })
      d.count.set(4)
    })

    // Inner batch() opens a nested runBatch frame but does NOT flush —
    // only the outermost's depth-0 release flushes. All four sets land
    // in one Changeset.
    expect(seen).toHaveLength(1)
    expect(seen[0]?.changes).toHaveLength(4)
  })

  it("batch() re-entrant from a subscriber → outer Changeset first, inner in sub-tick", () => {
    const schema = Schema.struct({
      a: Schema.string(),
      b: Schema.string(),
    })
    const { doc } = buildDoc(schema, { a: "", b: "" })

    const ordering: string[] = []

    doc.a[CHANGEFEED].subscribe((cs: Changeset) => {
      ordering.push(`a:${cs.changes.length}`)
      // First time we fire, re-enter
      if (doc.b() === "") {
        batch(doc, d => d.b.set("written-from-subscriber"))
      }
    })
    doc.b[CHANGEFEED].subscribe((cs: Changeset) => {
      ordering.push(`b:${cs.changes.length}`)
    })

    batch(doc, d => d.a.set("outer"))

    // Outer fired first, then inner in a fresh sub-tick of the same
    // drain. Two changesets total, deterministic order.
    expect(ordering).toEqual(["a:1", "b:1"])
  })

  it("auto-commit helper outside any batch() block → one runBatch + one Changeset", () => {
    const schema = Schema.struct({ count: Schema.number() })
    const { doc } = buildDoc(schema, { count: 0 })

    const seen: Changeset[] = []
    doc.count[CHANGEFEED].subscribe((cs: Changeset) => seen.push(cs))

    doc.count.set(42)

    expect(seen).toHaveLength(1)
    expect(seen[0]?.changes).toHaveLength(1)
  })

  it("applyChanges → one Changeset per affected path", () => {
    const schema = Schema.struct({ count: Schema.number() })
    const { doc } = buildDoc(schema, { count: 0 })

    const seen: Changeset[] = []
    doc.count[CHANGEFEED].subscribe((cs: Changeset) => seen.push(cs))

    const ops: Op[] = [
      {
        path: RawPath.empty.field("count"),
        change: { type: "replace", value: 1 } as any,
      },
      {
        path: RawPath.empty.field("count"),
        change: { type: "replace", value: 2 } as any,
      },
    ]
    applyChanges(doc, ops)

    expect(seen).toHaveLength(1)
    expect(seen[0]?.changes).toHaveLength(2)
  })
})

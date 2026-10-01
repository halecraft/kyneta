// delivery-after-commit — changesets are delivered after Loro's commit.
//
// Each outermost block is its own Loro commit with its own origin, a batch's
// changeset holds only that batch's ops, and a commit a raw listener makes in
// reaction to ours is announced after ours.

import { batch, createRef, Schema, subscribe, unwrap } from "@kyneta/schema"
import type { LoroDoc } from "loro-crdt"
import { describe, expect, it } from "vitest"
import { loroSubstrateFactory } from "../substrate.js"

function build<S extends ReturnType<typeof Schema.struct>>(schema: S) {
  const substrate = loroSubstrateFactory.create(schema)
  const doc = createRef(schema, substrate) as any
  const seen: { replay: boolean | undefined; n: number }[] = []
  subscribe(doc, cs => seen.push({ replay: cs.replay, n: cs.changes.length }))
  return { substrate, doc, native: unwrap(doc) as LoroDoc, seen }
}

describe("Loro: delivery after the commit", () => {
  it("a re-entrant batch() is its own commit, with its own origin and ops", () => {
    const { doc, native } = build(
      Schema.struct({ a: Schema.string(), b: Schema.string() }),
    )
    subscribe(doc.a, () => {
      if (doc.b() === "")
        batch(doc, (d: any) => d.b.set("inner"), { origin: "inner" })
    })
    const commits: unknown[] = []
    native.subscribe(e => {
      if (e.by === "local")
        commits.push({
          origin: e.origin,
          a: doc.a(),
          b: doc.b(),
          events: e.events.length,
        })
    })

    batch(doc, (d: any) => d.a.set("outer"), { origin: "outer" })

    expect(commits).toEqual([
      { origin: "outer", a: "outer", b: "", events: 1 },
      { origin: "inner", a: "outer", b: "inner", events: 1 },
    ])
  })

  it("a re-entrant batch() of coalesced map writes is delivered once", () => {
    const { doc, seen } = build(
      Schema.struct({
        title: Schema.text(),
        meta: Schema.struct({ a: Schema.number(), b: Schema.number() }),
      }),
    )
    let once = false
    subscribe(doc.title, () => {
      if (once) return
      once = true
      batch(doc, (d: any) => {
        d.meta.a.set(1)
        d.meta.b.set(2)
      })
    })

    batch(doc, (d: any) => d.title.insert(0, "x"))

    expect(seen).toEqual([
      { replay: false, n: 1 },
      { replay: false, n: 2 },
    ])
  })

  it("a raw listener's commit in reaction to ours is announced after ours, as a local write", () => {
    const { doc, native, seen } = build(Schema.struct({ title: Schema.text() }))
    let fired = false
    native.subscribe(() => {
      if (fired) return
      fired = true
      native.getText("title").insert(0, "ext")
      native.commit()
    })

    batch(doc, (d: any) => d.title.insert(0, "x"))

    expect(seen).toEqual([
      { replay: false, n: 1 },
      { replay: false, n: 1 },
    ])
  })

  it("exports inside a batch() body do not split the batch", () => {
    const { substrate, doc, seen } = build(
      Schema.struct({ title: Schema.text() }),
    )
    const v0 = substrate.version()

    // Each export commits the pending ops implicitly. Every one of those
    // commits is the batch's own, not just the first.
    batch(doc, (d: any) => {
      d.title.insert(0, "a")
      substrate.exportSince(v0)
      d.title.insert(1, "b")
      substrate.exportSince(v0)
      d.title.insert(2, "c")
    })

    expect(seen).toEqual([{ replay: false, n: 3 }])
    expect(doc.title()).toBe("abc")
  })

  it("an aborted batch() is committed under its own origin", () => {
    const { doc, native } = build(Schema.struct({ title: Schema.text() }))
    const commits: unknown[] = []
    native.subscribe(e => {
      if (e.by === "local") commits.push(e.origin)
    })

    expect(() =>
      batch(
        doc,
        (d: any) => {
          d.title.insert(0, "x")
          throw new Error("abort")
        },
        { origin: "aborted" },
      ),
    ).toThrow("abort")
    batch(doc, (d: any) => d.title.insert(0, "y"), { origin: "next" })

    expect(commits).toEqual(["aborted", "next"])
    expect(doc.title()).toBe("y")
  })
})

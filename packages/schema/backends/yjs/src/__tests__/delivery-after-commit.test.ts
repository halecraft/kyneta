// delivery-after-commit — changesets are delivered after the Yjs transaction.
//
// Each outermost block is its own transaction with its own origin, a batch's
// changeset holds only that batch's ops, and a transaction a raw listener
// opens in reaction to ours is announced after ours.

import { batch, createRef, Schema, subscribe, unwrap } from "@kyneta/schema"
import { describe, expect, it } from "vitest"
import type * as Y from "yjs"
import { yjsSubstrateFactory } from "../substrate.js"

function build<S extends ReturnType<typeof Schema.struct>>(schema: S) {
  const substrate = yjsSubstrateFactory.create(schema)
  const doc = createRef(schema, substrate) as any
  const seen: { replay: boolean | undefined; n: number }[] = []
  subscribe(doc, cs => seen.push({ replay: cs.replay, n: cs.changes.length }))
  return { doc, native: unwrap(doc) as Y.Doc, seen }
}

describe("Yjs: delivery after the transaction", () => {
  it("a re-entrant batch() is its own transaction, with its own origin and ops", () => {
    const { doc, native } = build(
      Schema.struct({ a: Schema.string(), b: Schema.string() }),
    )
    subscribe(doc.a, () => {
      if (doc.b() === "")
        batch(doc, (d: any) => d.b.set("inner"), { origin: "inner" })
    })
    const transactions: unknown[] = []
    native.on("afterTransaction", (tr: Y.Transaction) => {
      transactions.push({ origin: tr.origin, a: doc.a(), b: doc.b() })
    })

    batch(doc, (d: any) => d.a.set("outer"), { origin: "outer" })

    expect(transactions).toEqual([
      { origin: "outer", a: "outer", b: "" },
      { origin: "inner", a: "outer", b: "inner" },
    ])
  })

  it("a re-entrant batch() of several writes is delivered once", () => {
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

  it("a raw listener's transaction in reaction to ours is announced after ours, as a local write", () => {
    const { doc, native, seen } = build(Schema.struct({ title: Schema.text() }))
    let fired = false
    native.on("afterTransaction", () => {
      if (fired) return
      fired = true
      ;(unwrap(doc.title) as Y.Text).insert(0, "ext")
    })

    batch(doc, (d: any) => d.title.insert(0, "x"))

    expect(seen).toEqual([
      { replay: false, n: 1 },
      { replay: false, n: 1 },
    ])
  })
})

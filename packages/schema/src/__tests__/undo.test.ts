// undo.test — the plain substrate's undo: the shared suite, and the strict
// stack only a single writer has.

import { describe, expect, it } from "vitest"
import { createRef } from "../create-doc.js"
import { batch } from "../facade/batch.js"
import { createSubstrate } from "../substrate.js"
import { plainSubstrateFactory } from "../substrates/plain.js"
import {
  UndoFixture,
  type UndoPeer,
  undoConformance,
} from "../testing/index.js"

function create(): UndoPeer {
  const substrate = createSubstrate(plainSubstrateFactory, UndoFixture)
  return { substrate, doc: createRef(UndoFixture, substrate) }
}

function reload(peer: UndoPeer): UndoPeer {
  const substrate = createSubstrate(plainSubstrateFactory, UndoFixture)
  substrate.merge(peer.substrate.exportEntirety())
  return { substrate, doc: createRef(UndoFixture, substrate) }
}

undoConformance({ create, reload }, { label: "plain" })

describe("plain undo is a strict stack", () => {
  it("a write outside the stack ends undo past it", () => {
    const peer = create()
    const revertible = peer.substrate.revertible
    if (revertible === undefined) throw new Error("not revertible")
    const records: unknown[] = []
    revertible.subscribeCommits(c => records.push(c.record))
    batch(peer.doc, (d: any) => d.title.insert(0, "abc"))
    const [record] = records
    batch(peer.doc, (d: any) => d.place.set("elsewhere"))
    const plan = revertible.plan(record)
    expect(plan).toEqual({ tally: { kept: 0, total: 1 }, apply: undefined })
    expect(peer.doc.title()).toBe("abc")
  })

  it("two commits compose only when the second starts where the first ended", () => {
    const peer = create()
    const revertible = peer.substrate.revertible
    if (revertible === undefined) throw new Error("not revertible")
    const records: unknown[] = []
    const stop = revertible.subscribeCommits(c => records.push(c.record))
    batch(peer.doc, (d: any) => d.title.insert(0, "a"))
    batch(peer.doc, (d: any) => d.title.insert(1, "b"))
    stop()
    // Unrecorded: a write outside the stack.
    batch(peer.doc, (d: any) => d.place.set("elsewhere"))
    revertible.subscribeCommits(c => records.push(c.record))
    batch(peer.doc, (d: any) => d.title.insert(2, "c"))
    const [a, b, c] = records
    const ab = revertible.compose(a, b)
    expect(ab).not.toBeNull()
    expect(revertible.compose(ab, c)).toBeNull()
    expect(revertible.compose(b, a)).toBeNull()
  })
})

describe("a plain undo record", () => {
  it("names each op where it wrote, though a later op in its batch moved the item", () => {
    const peer = create()
    const revertible = peer.substrate.revertible
    if (revertible === undefined) throw new Error("not revertible")
    batch(peer.doc, (d: any) =>
      d.cards.push({ name: "a", done: false }, { name: "b", done: false }),
    )
    const records: any[] = []
    revertible.subscribeCommits(c => records.push(c.record))
    batch(peer.doc, (d: any) => {
      d.cards.at(1).done.set(true)
      d.cards.insert(0, { name: "new", done: false })
    })
    const [record] = records
    const formats = (ops: readonly { path: { format(): string } }[]) =>
      ops.map(op => op.path.format())
    expect(formats(record.ops)).toEqual(["cards[1].done", "cards"])
    expect(formats(record.inverses)).toEqual(["cards[1].done", "cards"])
  })
})

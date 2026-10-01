// undo.test — the plain substrate's undo: the shared suite, and the strict
// stack only a single writer has.

import { describe, expect, it } from "vitest"
import { createRef } from "../create-doc.js"
import { batch } from "../facade/batch.js"
import { plainSubstrateFactory } from "../substrates/plain.js"
import {
  UndoFixture,
  type UndoPeer,
  undoConformance,
} from "../testing/index.js"

function create(): UndoPeer {
  const substrate = plainSubstrateFactory.create(UndoFixture)
  return { substrate, doc: createRef(UndoFixture, substrate) }
}

function reload(peer: UndoPeer): UndoPeer {
  const substrate = plainSubstrateFactory.create(UndoFixture)
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
    expect(revertible.revert(record, {})).toBeNull()
    expect(peer.doc.title()).toBe("abc")
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

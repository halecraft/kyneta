// undo.test — the Yjs substrate's undo, through the shared suite.

import { batch, createRef, createSubstrate, unwrap } from "@kyneta/schema"
import {
  UndoFixture,
  type UndoPeer,
  undoConformance,
} from "@kyneta/schema/testing"
import { describe, expect, it } from "vitest"
import type * as Y from "yjs"
import { yjs } from "../bind-yjs.js"

const bound = yjs.bind(UndoFixture)
let next = 0

function build(peerId: string): UndoPeer {
  const substrate = createSubstrate(
    bound.factory({ peerId, binding: bound.identityBinding }),
    UndoFixture,
  )
  const doc = createRef(UndoFixture, substrate)
  Object.defineProperty(doc, PEER, { value: peerId })
  return { substrate, doc }
}

const PEER = Symbol("peer")

function peerOf(peer: UndoPeer): string {
  return (peer.doc as { [PEER]: string })[PEER]
}

undoConformance(
  {
    create: () => build(`peer-${++next}`),
    reload(peer) {
      const fresh = build(peerOf(peer))
      fresh.substrate.merge(peer.substrate.exportEntirety())
      return fresh
    },
    sync(a, b) {
      b.substrate.merge(
        a.substrate.exportSince(b.substrate.version()) ??
          a.substrate.exportEntirety(),
      )
      a.substrate.merge(
        b.substrate.exportSince(a.substrate.version()) ??
          b.substrate.exportEntirety(),
      )
    },
    nativeInsert(peer, index, text) {
      const ydoc = unwrap(peer.doc) as Y.Doc
      const title = unwrap(peer.doc.title) as Y.Text
      ydoc.transact(() => title.insert(index, text))
    },
  },
  { label: "yjs" },
)

describe("yjs undo records compose", () => {
  it("across a peer's typing between two keystrokes, and delete exactly mine", () => {
    const mine = build("compose-mine")
    const theirs = build("compose-theirs")
    const revertible = mine.substrate.revertible
    if (revertible === undefined) throw new Error("not revertible")
    const sync = () => {
      theirs.substrate.merge(mine.substrate.exportEntirety())
      mine.substrate.merge(theirs.substrate.exportEntirety())
    }
    const records: unknown[] = []
    revertible.subscribeCommits(c => records.push(c.record))
    batch(mine.doc, (d: any) => d.title.insert(0, "a"))
    sync()
    batch(theirs.doc, (d: any) => d.title.insert(1, "X"))
    sync()
    batch(mine.doc, (d: any) => d.title.insert(2, "b"))
    expect(mine.doc.title()).toBe("aXb")
    const [a, b] = records
    const ab = revertible.compose(a, b)
    if (ab === null) throw new Error("expected the two to compose")
    const plan = revertible.plan(ab)
    expect(plan.tally).toEqual({ kept: 2, total: 2 })
    plan.apply?.({})
    expect(mine.doc.title()).toBe("X")
  })
})

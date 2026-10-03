// undo.test — the Loro substrate's undo: the shared suite, and what only
// Loro has (a shallow snapshot, and moving a tree node back).

import {
  batch,
  createRef,
  createSubstrate,
  type Revertible,
  Schema,
  unwrap,
} from "@kyneta/schema"
import {
  UndoFixture,
  type UndoPeer,
  undoConformance,
} from "@kyneta/schema/testing"
import type { LoroDoc, LoroText } from "loro-crdt"
import { describe, expect, it } from "vitest"
import { loro } from "../bind-loro.js"

const bound = loro.bind(UndoFixture)
const peers = new WeakMap<object, string>()
let next = 0

function build(peerId: string): UndoPeer {
  const substrate = createSubstrate(
    bound.factory({ peerId, binding: bound.identityBinding }),
    UndoFixture,
  )
  const doc = createRef(UndoFixture, substrate)
  peers.set(doc, peerId)
  return { substrate, doc }
}

undoConformance(
  {
    create: () => build(`peer-${++next}`),
    reload(peer) {
      const fresh = build(peers.get(peer.doc) ?? "lost")
      fresh.substrate.merge(peer.substrate.exportEntirety())
      return fresh
    },
    sync(a, b) {
      b.substrate.merge(a.substrate.exportEntirety())
      a.substrate.merge(b.substrate.exportEntirety())
    },
    nativeInsert(peer, index, text) {
      const doc = unwrap(peer.doc) as LoroDoc
      const title = unwrap(peer.doc.title) as LoroText
      title.insert(index, text)
      doc.commit()
    },
  },
  { label: "loro" },
)

describe("loro undo", () => {
  it("a record older than a shallow snapshot stands not at all", () => {
    const peer = build("shallow")
    const revertible = peer.substrate.revertible
    if (revertible === undefined) throw new Error("not revertible")
    const records: unknown[] = []
    revertible.subscribeCommits(c => records.push(c.record))
    batch(peer.doc, (d: any) => d.title.insert(0, "one"))
    batch(peer.doc, (d: any) => d.title.insert(3, " two"))
    const native = unwrap(peer.doc) as LoroDoc
    const shallow = build("shallow")
    shallow.substrate.merge({
      kind: "entirety",
      encoding: "binary",
      data: native.export({
        mode: "shallow-snapshot",
        frontiers: native.frontiers(),
      }),
    })
    const [first] = records
    expect(shallow.substrate.revertible?.plan(first)).toEqual({
      tally: { kept: 0, total: 1 },
      apply: undefined,
    })
  })
})

describe("loro undo records compose", () => {
  it("only back to back: a merge between two commits stops it", () => {
    const mine = build("compose-mine")
    const theirs = build("compose-theirs")
    const revertible = mine.substrate.revertible
    if (revertible === undefined) throw new Error("not revertible")
    const records: unknown[] = []
    revertible.subscribeCommits(c => records.push(c.record))
    batch(mine.doc, (d: any) => d.title.insert(0, "a"))
    batch(mine.doc, (d: any) => d.title.insert(1, "b"))
    batch(theirs.doc, (d: any) => d.place.set("there"))
    mine.substrate.merge(theirs.substrate.exportEntirety())
    batch(mine.doc, (d: any) => d.title.insert(2, "c"))
    const [a, b, c] = records
    const ab = revertible.compose(a, b)
    expect(ab).not.toBeNull()
    expect(revertible.compose(ab, c)).toBeNull()
    expect(revertible.compose(b, a)).toBeNull()
  })
})

describe("loro undo of a tree", () => {
  const Outline = Schema.struct({
    tree: Schema.tree(Schema.struct({ label: Schema.string() })),
  })
  const outline = loro.bind(Outline)

  /** Undo steps last first, each revert's remap rewriting the rest. */
  function undoAll(revertible: Revertible, steps: unknown[][], count: number) {
    for (let n = 0; n < count; n++) {
      const step = steps.pop() ?? []
      for (let record = step.pop(); record !== undefined; record = step.pop()) {
        const { apply } = revertible.plan(record)
        if (apply === undefined) continue
        const result = apply({})
        const rewrite = (s: unknown[]) =>
          s.splice(
            0,
            s.length,
            ...s.map(r => revertible.rewrite(r, result.remap)),
          )
        rewrite(step)
        for (const s of steps) rewrite(s)
      }
    }
  }

  it("a node moved, then deleted, comes back where it was before the move", () => {
    const substrate = createSubstrate(
      outline.factory({ peerId: "tree", binding: outline.identityBinding }),
      Outline,
    )
    const doc: any = createRef(Outline, substrate)
    const revertible = substrate.revertible
    if (revertible === undefined) throw new Error("not revertible")
    let p1 = ""
    let p2 = ""
    let n = ""
    batch(doc, (d: any) => {
      p1 = d.tree.create({ data: { label: "p1" } })
      p2 = d.tree.create({ data: { label: "p2" } })
      n = d.tree.create({ parent: p1, data: { label: "n" } })
    })
    const steps: unknown[][] = []
    const step = (fn: () => void) => {
      const records: unknown[] = []
      const stop = revertible.subscribeCommits(c => records.push(c.record))
      fn()
      stop()
      steps.push(records)
    }
    step(() => batch(doc, (d: any) => d.tree.node(n).label.set("renamed")))
    step(() => batch(doc, (d: any) => d.tree.move(n, { parent: p2, index: 0 })))
    step(() => batch(doc, (d: any) => d.tree.delete(n)))

    undoAll(revertible, steps, 3)
    const forest = doc.tree() as {
      id: string
      parent: string | null
      data: { label: string }
    }[]
    const restored = forest.find(node => node.data.label === "n")
    expect(restored?.parent).toBe(p1)
    expect(forest).toHaveLength(3)
  })
})

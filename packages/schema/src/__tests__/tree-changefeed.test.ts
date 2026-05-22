// tree-changefeed.test.ts — integration tests for `Schema.tree` reactive
// observation through the plain substrate.
//
// `with-changefeed.ts` is substrate-agnostic; the plain substrate
// surfaces the wiring without any backend interference. A single
// cross-substrate parity check lives in
// `packages/schema/backends/loro/src/__tests__/tree.test.ts`.

import type { Changeset } from "@kyneta/changefeed"
import { describe, expect, it } from "vitest"
import type { Op } from "../basic/index.js"
import { change, createDoc, Schema, subscribe } from "../basic/index.js"

const Outline = Schema.struct({
  tree: Schema.tree(Schema.struct({ label: Schema.string() })),
})

function collectOps(changesets: readonly Changeset<Op>[]): readonly Op[] {
  return changesets.flatMap(cs => cs.changes)
}

function isTreeOp(op: Op): op is Op & {
  change: { type: "tree"; instructions: { action: string; target: string }[] }
} {
  return op.change.type === "tree"
}

function isMapOp(op: Op): op is Op & { change: { type: "map" } } {
  return op.change.type === "map"
}

function isReplaceOp(
  op: Op,
): op is Op & { change: { type: "replace"; value: unknown } } {
  return op.change.type === "replace"
}

// ---------------------------------------------------------------------------
// Doc-level subscriber
// ---------------------------------------------------------------------------

describe("subscribe(doc) on a doc with Schema.tree", () => {
  it("receives the TreeChange.create AND the initial-data MapChange in one flush", () => {
    const doc = createDoc(Outline)
    const changesets: Changeset<Op>[] = []
    subscribe(doc as any, cs => changesets.push(cs))

    let id = ""
    change(doc as any, (d: any) => {
      id = d.tree.create({ data: { label: "x" } })
    })

    // Multiple paths affected → potentially multiple changesets, but
    // both ops must appear across them.
    const ops = collectOps(changesets)
    const treeOps = ops.filter(isTreeOp)
    expect(treeOps).toHaveLength(1)
    expect(treeOps[0].change.instructions[0]).toMatchObject({
      action: "create",
      target: id,
    })

    // MapChange (initial data) or expanded ReplaceChange — accept either
    // shape (expansion is governed by `expandMapOpsToLeaves`).
    const dataOps = ops.filter(
      op => isMapOp(op) || (isReplaceOp(op) && op.change.value === "x"),
    )
    expect(dataOps.length).toBeGreaterThanOrEqual(1)
  })

  it("receives writes to per-node fields (subscribe-after-create symmetry)", () => {
    const doc = createDoc(Outline)
    let id = ""
    change(doc as any, (d: any) => {
      id = d.tree.create({ data: { label: "initial" } })
    })

    const changesets: Changeset<Op>[] = []
    subscribe(doc as any, cs => changesets.push(cs))

    change(doc as any, (d: any) => {
      d.tree.node(id).label.set("updated")
    })

    const ops = collectOps(changesets)
    const labelOp = ops.find(
      op => isReplaceOp(op) && op.change.value === "updated",
    )
    expect(labelOp).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Per-node subscriber
// ---------------------------------------------------------------------------

describe("subscribe(d.tree.node(id))", () => {
  it("fires on writes at descendant paths under the node", () => {
    const doc = createDoc(Outline)
    let id = ""
    change(doc as any, (d: any) => {
      id = d.tree.create({ data: { label: "n" } })
    })

    const changesets: Changeset<Op>[] = []
    subscribe((doc as any).tree.node(id), cs => changesets.push(cs))

    change(doc as any, (d: any) => {
      d.tree.node(id).label.set("renamed")
    })

    const ops = collectOps(changesets)
    const labelOp = ops.find(
      op => isReplaceOp(op) && op.change.value === "renamed",
    )
    expect(labelOp).toBeDefined()
  })

  it("does not fire for writes to a sibling node", () => {
    const doc = createDoc(Outline)
    let a = ""
    let b = ""
    change(doc as any, (d: any) => {
      a = d.tree.create({ data: { label: "A" } })
      b = d.tree.create({ data: { label: "B" } })
    })

    const aChangesets: Changeset<Op>[] = []
    subscribe((doc as any).tree.node(a), cs => aChangesets.push(cs))

    change(doc as any, (d: any) => {
      d.tree.node(b).label.set("B-updated")
    })

    const ops = collectOps(aChangesets)
    expect(ops).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Same-batch create + data invariant (planNotifications iteration order)
// ---------------------------------------------------------------------------

describe("same-batch create + data write", () => {
  it("doc-level subscriber sees BOTH the topology op and the data op", () => {
    const doc = createDoc(Outline)
    const changesets: Changeset<Op>[] = []
    subscribe(doc as any, cs => changesets.push(cs))

    change(doc as any, (d: any) => {
      d.tree.create({ data: { label: "z" } })
    })

    const ops = collectOps(changesets)
    const hasTreeCreate = ops.some(
      op => isTreeOp(op) && op.change.instructions[0]?.action === "create",
    )
    const hasDataWrite = ops.some(
      op => (isMapOp(op) || isReplaceOp(op)) && op.path.length >= 2,
    )
    expect(hasTreeCreate).toBe(true)
    expect(hasDataWrite).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Terminal-on-delete
// ---------------------------------------------------------------------------

describe("terminal event on delete", () => {
  it("per-node subscriber's last received changeset is a synthesized tree-delete", () => {
    const doc = createDoc(Outline)
    let id = ""
    change(doc as any, (d: any) => {
      id = d.tree.create({ data: { label: "doomed" } })
    })

    const changesets: Changeset<Op>[] = []
    subscribe((doc as any).tree.node(id), cs => changesets.push(cs))

    change(doc as any, (d: any) => {
      d.tree.delete(id)
    })

    expect(changesets.length).toBeGreaterThanOrEqual(1)
    const last = changesets[changesets.length - 1]
    expect(last.changes).toHaveLength(1)
    const terminalOp = last.changes[0]
    expect(isTreeOp(terminalOp)).toBe(true)
    if (!isTreeOp(terminalOp)) return
    expect(terminalOp.change.instructions[0]).toMatchObject({
      action: "delete",
      target: id,
    })
  })

  it("no further deliveries after the terminal", () => {
    const doc = createDoc(Outline)
    let id = ""
    change(doc as any, (d: any) => {
      id = d.tree.create({ data: { label: "doomed" } })
    })

    const changesets: Changeset<Op>[] = []
    subscribe((doc as any).tree.node(id), cs => changesets.push(cs))

    change(doc as any, (d: any) => {
      d.tree.delete(id)
    })

    const lengthAfterDelete = changesets.length

    // Any subsequent writes (to other nodes) must not deliver to this
    // already-terminal subscriber.
    change(doc as any, (d: any) => {
      d.tree.create({ data: { label: "new" } })
    })

    expect(changesets.length).toBe(lengthAfterDelete)
  })

  it("doc-level subscriber does NOT receive the synthesized terminal (channels are disjoint)", () => {
    const doc = createDoc(Outline)
    let id = ""
    change(doc as any, (d: any) => {
      id = d.tree.create({ data: { label: "doomed" } })
    })

    const docChangesets: Changeset<Op>[] = []
    subscribe(doc as any, cs => docChangesets.push(cs))

    change(doc as any, (d: any) => {
      d.tree.delete(id)
    })

    // The doc-level subscriber sees the TreeChange.delete via the
    // tree's own-path delivery (path starts with `field("tree")`), not
    // via a synthesized terminal at the per-node path.
    const ops = collectOps(docChangesets).filter(isTreeOp)
    const deleteOps = ops.filter(
      op => op.change.instructions[0]?.action === "delete",
    )
    // Exactly one delete op, delivered at the tree's path (1 segment),
    // not at the node's path (2 segments).
    expect(deleteOps).toHaveLength(1)
    expect(deleteOps[0].path.length).toBe(1)
  })

  it("cascade delete fires a terminal on every subscribed descendant", () => {
    // Deleting an ancestor cascades to all descendants. Every per-node
    // subscriber on an affected node must receive its own terminal,
    // each carrying the correct target id.
    const doc = createDoc(Outline)
    let root = ""
    let child = ""
    let grandchild = ""
    change(doc as any, (d: any) => {
      root = d.tree.create({ data: { label: "R" } })
      child = d.tree.create({ parent: root, data: { label: "C" } })
      grandchild = d.tree.create({ parent: child, data: { label: "G" } })
    })

    const childChangesets: Changeset<Op>[] = []
    const grandchildChangesets: Changeset<Op>[] = []
    subscribe((doc as any).tree.node(child), cs => childChangesets.push(cs))
    subscribe((doc as any).tree.node(grandchild), cs =>
      grandchildChangesets.push(cs),
    )

    change(doc as any, (d: any) => {
      d.tree.delete(root)
    })

    const childTerminal = childChangesets[childChangesets.length - 1]
    const gcTerminal = grandchildChangesets[grandchildChangesets.length - 1]
    expect(childTerminal).toBeDefined()
    expect(gcTerminal).toBeDefined()
    const childOp = childTerminal.changes[0]
    const gcOp = gcTerminal.changes[0]
    expect(isTreeOp(childOp) && childOp.change.instructions[0]).toMatchObject({
      action: "delete",
      target: child,
    })
    expect(isTreeOp(gcOp) && gcOp.change.instructions[0]).toMatchObject({
      action: "delete",
      target: grandchild,
    })
  })
})

// ---------------------------------------------------------------------------
// Move preserves TreeID identity — no spurious forwarder churn
// ---------------------------------------------------------------------------

describe("move preserves identity", () => {
  it("per-node subscriber remains live across a move; subsequent data writes still delivered", () => {
    const doc = createDoc(Outline)
    let a = ""
    let b = ""
    let c = ""
    change(doc as any, (d: any) => {
      a = d.tree.create({ data: { label: "A" } })
      b = d.tree.create({ data: { label: "B" } })
      c = d.tree.create({ parent: a, data: { label: "C" } })
    })

    const changesets: Changeset<Op>[] = []
    subscribe((doc as any).tree.node(c), cs => changesets.push(cs))

    change(doc as any, (d: any) => {
      d.tree.move(c, { parent: b, index: 0 })
    })

    // No terminal-style delete event for C.
    const terminals = collectOps(changesets).filter(
      op =>
        isTreeOp(op) &&
        op.change.instructions[0]?.action === "delete" &&
        op.change.instructions[0]?.target === c,
    )
    expect(terminals).toHaveLength(0)

    // Subsequent data write on C is still delivered.
    change(doc as any, (d: any) => {
      d.tree.node(c).label.set("C-moved")
    })

    const labelOp = collectOps(changesets).find(
      op => isReplaceOp(op) && op.change.value === "C-moved",
    )
    expect(labelOp).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Unsubscribe / resubscribe cleanup invariants
// ---------------------------------------------------------------------------

describe("unsubscribe and resubscribe", () => {
  it("unsubscribed callback receives nothing after unsubscribe", () => {
    const doc = createDoc(Outline)
    const changesets: Changeset<Op>[] = []
    const unsub = subscribe(doc as any, cs => changesets.push(cs))
    unsub()

    change(doc as any, (d: any) => {
      d.tree.create({ data: { label: "x" } })
    })

    expect(changesets).toHaveLength(0)
  })

  it("resubscribe on a still-live node receives no synthesized terminal (teardown vs delete)", () => {
    const doc = createDoc(Outline)
    let id = ""
    change(doc as any, (d: any) => {
      id = d.tree.create({ data: { label: "n" } })
    })

    // First subscriber + unsubscribe (last-subscriber teardown path).
    const firstChangesets: Changeset<Op>[] = []
    const firstUnsub = subscribe((doc as any).tree.node(id), cs =>
      firstChangesets.push(cs),
    )
    firstUnsub()

    // No phantom terminal emitted to the first subscriber.
    const phantoms = collectOps(firstChangesets).filter(
      op =>
        isTreeOp(op) &&
        op.change.instructions[0]?.action === "delete" &&
        op.change.instructions[0]?.target === id,
    )
    expect(phantoms).toHaveLength(0)

    // Second subscriber on the same still-live node also sees no phantom.
    const secondChangesets: Changeset<Op>[] = []
    subscribe((doc as any).tree.node(id), cs => secondChangesets.push(cs))

    // Write something to confirm liveness.
    change(doc as any, (d: any) => {
      d.tree.node(id).label.set("still-here")
    })

    const phantoms2 = collectOps(secondChangesets).filter(
      op =>
        isTreeOp(op) &&
        op.change.instructions[0]?.action === "delete" &&
        op.change.instructions[0]?.target === id,
    )
    expect(phantoms2).toHaveLength(0)

    const labelOp = collectOps(secondChangesets).find(
      op => isReplaceOp(op) && op.change.value === "still-here",
    )
    expect(labelOp).toBeDefined()
  })
})

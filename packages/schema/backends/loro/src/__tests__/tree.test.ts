// tree.test.ts — end-to-end Schema.tree write/read against the Loro substrate.
//
// Pins the Phase 1 fix (stepFromContainer Tree case returns node.data),
// the Phase 2 contract (treeChangeToDiff is accepted by Loro WASM as-is),
// and the Phase 5 round-trip symmetry of treeDiffToChange.
//
// Mirrors `packages/schema/src/__tests__/tree-ref.test.ts` so the test
// surface is symmetric across substrates.

import {
  change,
  createDoc,
  exportEntirety,
  exportSince,
  loro,
  merge,
  Schema,
  unwrap,
  version,
} from "../index.js"
import { describe, expect, it } from "vitest"

const Outline = Schema.struct({
  tree: Schema.tree(Schema.struct({ label: Schema.string() })),
})

const bound = loro.bind(Outline)

// ===========================================================================
// Phase 4 — write/read end-to-end
// ===========================================================================

describe("Schema.tree on Loro: create + read", () => {
  it("creates a root and reads its data through doc.tree()", () => {
    const doc = createDoc(bound)
    let rootId = ""
    change(doc, (d: any) => {
      rootId = d.tree.create({ data: { label: "Root" } })
    })
    expect(typeof rootId).toBe("string")
    expect((doc.tree as any).size).toBe(1)
    expect((doc.tree as any).node(rootId).label()).toBe("Root")

    const forest = doc.tree() as ReadonlyArray<{
      id: string
      parent: string | null
      data: { label: string }
    }>
    expect(forest).toHaveLength(1)
    expect(forest[0]?.id).toBe(rootId)
    expect(forest[0]?.parent).toBeNull()
    expect(forest[0]?.data).toEqual({ label: "Root" })
  })

  it("attaches a child under a parent", () => {
    const doc = createDoc(bound)
    let rootId = ""
    let childId = ""
    change(doc, (d: any) => {
      rootId = d.tree.create({ data: { label: "Root" } })
      childId = d.tree.create({ parent: rootId, data: { label: "Child" } })
    })
    const roots = (doc.tree as any).roots
    expect(roots).toHaveLength(1)
    expect(roots[0].id).toBe(rootId)
    expect(roots[0].children).toHaveLength(1)
    expect(roots[0].children[0].id).toBe(childId)
    // `.roots[i].children[j].data` is the per-node ref; `.label()` lives on it.
    expect(roots[0].children[0].data.label()).toBe("Child")
  })
})

describe("Schema.tree on Loro: materialize after binary import", () => {
  it("snapshot-imported doc materializes per-node data via .data LoroMap reads", () => {
    // Verifies the Phase 1 fix on the read path: materializeLoroShadow
    // walks `path.node(id).label` through stepFromContainer's Tree case;
    // the old behavior returned LoroTreeNode, after which hasKind === false
    // short-circuited the next step to undefined and `data.label` was lost.
    const docA = createDoc(bound)
    let rootId = ""
    let childId = ""
    change(docA, (d: any) => {
      rootId = d.tree.create({ data: { label: "Root" } })
      childId = d.tree.create({ parent: rootId, data: { label: "Child" } })
    })
    const snapshot = exportEntirety(docA)
    const docB = createDoc(bound, snapshot)

    expect(docB.tree()).toEqual(docA.tree())
    expect((docB.tree as any).node(rootId).label()).toBe("Root")
    expect((docB.tree as any).node(childId).label()).toBe("Child")
  })
})

describe("Schema.tree on Loro: delete + move", () => {
  it("deletes a subtree", () => {
    const doc = createDoc(bound)
    let rootId = ""
    let childId = ""
    change(doc, (d: any) => {
      rootId = d.tree.create({ data: { label: "Root" } })
      childId = d.tree.create({ parent: rootId, data: { label: "Child" } })
      d.tree.create({ parent: childId, data: { label: "Grandchild" } })
    })
    change(doc, (d: any) => {
      d.tree.delete(childId)
    })
    expect((doc.tree as any).size).toBe(1)
    expect((doc.tree as any).has(rootId)).toBe(true)
    expect((doc.tree as any).has(childId)).toBe(false)
  })

  it("records descendants before the target on delete (post-order)", () => {
    const doc = createDoc(bound)
    let rootId = ""
    let childId = ""
    let grandchildId = ""
    change(doc, (d: any) => {
      rootId = d.tree.create({ data: { label: "Root" } })
      childId = d.tree.create({ parent: rootId, data: { label: "C" } })
      grandchildId = d.tree.create({
        parent: childId,
        data: { label: "GC" },
      })
    })
    const ops = change(doc, (d: any) => {
      d.tree.delete(rootId)
    })
    const targets = ops
      .filter((o: any) => o.change.type === "tree")
      .flatMap((o: any) =>
        o.change.instructions.map((i: any) => i.target as string),
      )
    expect(targets[0]).toBe(grandchildId)
    expect(targets[targets.length - 1]).toBe(rootId)
  })

  it("moves a node under a new parent", () => {
    const doc = createDoc(bound)
    let a = ""
    let b = ""
    let target = ""
    change(doc, (d: any) => {
      a = d.tree.create({ data: { label: "A" } })
      b = d.tree.create({ data: { label: "B" } })
      target = d.tree.create({ parent: a, data: { label: "Target" } })
    })
    change(doc, (d: any) => {
      d.tree.move(target, { parent: b, index: 0 })
    })
    const roots = (doc.tree as any).roots
    const aNode = roots.find((n: any) => n.id === a)
    const bNode = roots.find((n: any) => n.id === b)
    expect(aNode.children).toHaveLength(0)
    expect(bNode.children[0].id).toBe(target)
  })
})

// ===========================================================================
// Phase 4 — peer sync via Loro's binary sync (exportSince / merge)
//
// Tree topology does NOT travel through the kyneta `Op`-replay path on
// Loro: `TreeID`s are peer-stamped and Loro rejects `applyDiff` creates
// for foreign TreeIDs (panics in `handler.rs:236` with a locking-order
// violation). The local-prepare path positions nodes natively via
// `TREE_NODE_ALLOCATE → LoroTree.createNode(parent, index)` and the
// matching `create` diff item is filtered. For peer replay the only
// supported path is Loro's own binary sync — `exportSince` / `merge`.
// See the docstring on `treeChangeToDiff` in `change-mapping.ts`.
// ===========================================================================

describe("Schema.tree on Loro: peer sync via binary updates", () => {
  it("docA's tree replicates to docB via exportSince + merge", () => {
    const docA = createDoc(bound)
    const docB = createDoc(bound)
    const v0 = version(docB)

    let rootId = ""
    let childId = ""
    change(docA, (d: any) => {
      rootId = d.tree.create({ data: { label: "A" } })
      childId = d.tree.create({ parent: rootId, data: { label: "B" } })
    })

    const delta = exportSince(docA, v0)
    expect(delta).not.toBeNull()
    merge(docB, delta!, { origin: "sync" })

    expect(docB.tree()).toEqual(docA.tree())
    expect((docB.tree as any).has(rootId)).toBe(true)
    expect((docB.tree as any).has(childId)).toBe(true)
    expect((docB.tree as any).node(childId).label()).toBe("B")
  })
})

// ===========================================================================
// Phase 4 — concurrent move (Loro `tree-move` semantics)
// ===========================================================================

describe("Schema.tree on Loro: concurrent move convergence", () => {
  it("two peers concurrently moving the other's root under their own converge", () => {
    // Loro's `tree-move` rule decides the winner deterministically;
    // we assert convergence (both peers agree), not the specific winner.
    const docA = createDoc(bound)
    const docB = createDoc(bound)

    let rootA = ""
    let rootB = ""
    change(docA, (d: any) => {
      rootA = d.tree.create({ data: { label: "A" } })
    })
    change(docB, (d: any) => {
      rootB = d.tree.create({ data: { label: "B" } })
    })

    // Sync both ways so each peer knows about both roots.
    const vBeforeMerge = version(docB)
    const vBeforeMergeA = version(docA)
    merge(docB, exportSince(docA, vBeforeMerge)!, { origin: "sync" })
    merge(docA, exportSince(docB, vBeforeMergeA)!, { origin: "sync" })

    // Concurrent moves: each peer reparents the other's root under its own.
    change(docA, (d: any) => {
      d.tree.move(rootB, { parent: rootA, index: 0 })
    })
    change(docB, (d: any) => {
      d.tree.move(rootA, { parent: rootB, index: 0 })
    })

    // Cross-merge.
    const vA2 = version(docA)
    const vB2 = version(docB)
    merge(docB, exportSince(docA, vBeforeMergeA)!, { origin: "sync" })
    merge(docA, exportSince(docB, vBeforeMerge)!, { origin: "sync" })
    // Re-merge to a quiescent state (each side may have advanced again).
    merge(docB, exportSince(docA, vA2)!, { origin: "sync" })
    merge(docA, exportSince(docB, vB2)!, { origin: "sync" })

    // Both peers converge to the same topology, whichever Loro picks.
    expect(docB.tree()).toEqual(docA.tree())
  })
})

// ===========================================================================
// Phase 4 — Phase 1 contract pins (deleted-node read, unwrap semantics)
// ===========================================================================

describe("Schema.tree on Loro: deleted-node read", () => {
  it("reads through a deleted node either return undefined or omit the node", () => {
    // Pins the post-Phase-1 behavior for the dead-TreeID branch:
    // `stepFromContainer` returns `node?.data`, so a deleted node should
    // either disappear from `getNodeByID` (→ undefined data → clean
    // short-circuit) or its stale `.data` LoroMap may still be readable.
    // Either outcome is acceptable; we record which one we got so a
    // future regression is visible.
    const doc = createDoc(bound)
    let rootId = ""
    change(doc, (d: any) => {
      rootId = d.tree.create({ data: { label: "Ghost" } })
    })
    change(doc, (d: any) => {
      d.tree.delete(rootId)
    })

    // Tree-level read: deleted node must not appear.
    expect((doc.tree as any).has(rootId)).toBe(false)
    expect((doc.tree as any).node(rootId)).toBeUndefined()
    expect(doc.tree()).toEqual([])
  })
})

describe("Schema.tree on Loro: unwrap semantics", () => {
  it("unwrap on the tree ref returns the Loro LoroTree container", () => {
    const doc = createDoc(bound)
    change(doc, (d: any) => {
      d.tree.create({ data: { label: "Root" } })
    })
    const native = unwrap(doc.tree as any) as any
    expect(typeof native.kind).toBe("function")
    expect(native.kind()).toBe("Tree")
  })

  it("unwrap on a node ref returns the per-node LoroMap (post-Phase-1 contract)", () => {
    // Phase 1 changed `stepFromContainer` Tree-case to return `node.data`.
    // Therefore `unwrap(d.tree.node(id))` resolves to a LoroMap (with
    // .kind() === "Map"), not a LoroTreeNode (which has no .kind()).
    const doc = createDoc(bound)
    let rootId = ""
    change(doc, (d: any) => {
      rootId = d.tree.create({ data: { label: "Root" } })
    })
    const nodeNative = unwrap((doc.tree as any).node(rootId)) as any
    expect(typeof nodeNative.kind).toBe("function")
    expect(nodeNative.kind()).toBe("Map")
  })
})

// ===========================================================================
// Phase 5 — treeDiffToChange round-trip symmetry
// ===========================================================================

describe("Schema.tree on Loro: round-trip via binary sync (Phase 5)", () => {
  it("move round-trips to an equivalent topology after binary sync", () => {
    // `treeDiffToChange` discards `fractionalIndex` and
    // `oldParent/oldIndex`; the resulting `TreeChange` carries only
    // `(action, target, parent, index)`. After two-way binary sync,
    // both peers converge to the same topology — Loro may stamp a
    // different fractional index but `doc.tree()` snapshots match.
    const docA = createDoc(bound)
    const docB = createDoc(bound)
    const vB0 = version(docB)

    let a = ""
    let b = ""
    let target = ""
    change(docA, (d: any) => {
      a = d.tree.create({ data: { label: "A" } })
      b = d.tree.create({ data: { label: "B" } })
      target = d.tree.create({ parent: a, data: { label: "T" } })
    })
    change(docA, (d: any) => {
      d.tree.move(target, { parent: b, index: 0 })
    })

    merge(docB, exportSince(docA, vB0)!, { origin: "sync" })

    expect(docB.tree()).toEqual(docA.tree())
  })

  it("delete propagates over binary sync even though kyneta drops oldParent/oldIndex", () => {
    // kyneta's TreeInstruction.delete carries only `target`. The native
    // sync path doesn't depend on that anyway — Loro's own delete op
    // carries the metadata it needs. This test verifies that the kyneta
    // round-trip (write → Loro → binary sync → read) is consistent.
    const docA = createDoc(bound)
    const docB = createDoc(bound)
    const vB0 = version(docB)

    let root = ""
    let child = ""
    change(docA, (d: any) => {
      root = d.tree.create({ data: { label: "R" } })
      child = d.tree.create({ parent: root, data: { label: "C" } })
    })
    change(docA, (d: any) => {
      d.tree.delete(child)
    })

    merge(docB, exportSince(docA, vB0)!, { origin: "sync" })

    expect(docB.tree()).toEqual(docA.tree())
    expect((docB.tree as any).has(root)).toBe(true)
    expect((docB.tree as any).has(child)).toBe(false)
  })
})

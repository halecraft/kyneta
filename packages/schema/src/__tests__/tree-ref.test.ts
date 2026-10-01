// tree-ref.test.ts — read + write surface for `Schema.tree`.

import { describe, expect, it } from "vitest"
import { applyChanges, batch, createDoc, Schema } from "../basic/index.js"

const TodoSchema = Schema.struct({
  outline: Schema.tree(
    Schema.struct({
      label: Schema.string(),
    }),
  ),
})

// ===========================================================================
// Read surface
// ===========================================================================

describe("ReadableTreeRef", () => {
  it("a fresh tree exposes zero-size, empty accessors", () => {
    const doc = createDoc(TodoSchema)
    const ref = doc.outline
    expect(doc.outline()).toEqual([])
    expect(ref.size).toBe(0)
    expect(ref.ids()).toEqual([])
    expect(ref.has("anything")).toBe(false)
    expect(ref.node("anything")).toBeUndefined()
    expect(ref.roots).toEqual([])
    expect([...ref]).toEqual([])
  })
})

// ===========================================================================
// Write surface
// ===========================================================================

describe("WritableTreeRef", () => {
  it(".create returns a fresh id and exposes the node via .node(id)", () => {
    const doc = createDoc(TodoSchema)
    let rootId = ""
    batch(doc, (d: any) => {
      rootId = d.outline.create({ data: { label: "Root" } })
    })
    expect(typeof rootId).toBe("string")
    expect(doc.outline.size).toBe(1)
    expect(doc.outline.node(rootId)?.label()).toBe("Root")
  })

  it(".create attaches children under a parent in .roots", () => {
    const doc = createDoc(TodoSchema)
    let rootId = ""
    let childId = ""
    batch(doc, (d: any) => {
      rootId = d.outline.create({ data: { label: "Root" } })
      childId = d.outline.create({ parent: rootId, data: { label: "Child" } })
    })
    const roots = doc.outline.roots
    expect(roots).toHaveLength(1)
    expect(roots[0].id).toBe(rootId)
    expect(roots[0].children).toHaveLength(1)
    expect(roots[0].children[0].id).toBe(childId)
  })

  it(".delete removes a node and its descendants", () => {
    const doc = createDoc(TodoSchema)
    let rootId = ""
    let childId = ""
    batch(doc, (d: any) => {
      rootId = d.outline.create({ data: { label: "Root" } })
      childId = d.outline.create({ parent: rootId, data: { label: "Child" } })
      d.outline.create({ parent: childId, data: { label: "Grandchild" } })
    })
    batch(doc, (d: any) => {
      d.outline.delete(childId)
    })
    expect(doc.outline.size).toBe(1)
    expect(doc.outline.has(rootId)).toBe(true)
    expect(doc.outline.has(childId)).toBe(false)
  })

  it(".delete records descendants before the target (post-order)", () => {
    // Peers that apply incrementally must never observe a parent
    // referencing a not-yet-deleted descendant. Post-order keeps the
    // intermediate state coherent.
    const doc = createDoc(TodoSchema)
    let rootId = ""
    let childId = ""
    let grandchildId = ""
    batch(doc, (d: any) => {
      rootId = d.outline.create({ data: { label: "Root" } })
      childId = d.outline.create({ parent: rootId, data: { label: "C" } })
      grandchildId = d.outline.create({
        parent: childId,
        data: { label: "GC" },
      })
    })
    const ops = batch(doc, (d: any) => {
      d.outline.delete(rootId)
    })
    const targets = ops
      .filter((o: any) => o.change.type === "tree")
      .flatMap((o: any) =>
        o.change.instructions.map((i: any) => i.target as string),
      )
    // First-deleted must be a descendant of last-deleted.
    expect(targets[0]).toBe(grandchildId)
    expect(targets[targets.length - 1]).toBe(rootId)
  })

  it(".move reparents a node", () => {
    const doc = createDoc(TodoSchema)
    let a = ""
    let b = ""
    let target = ""
    batch(doc, (d: any) => {
      a = d.outline.create({ data: { label: "A" } })
      b = d.outline.create({ data: { label: "B" } })
      target = d.outline.create({ parent: a, data: { label: "Target" } })
    })
    batch(doc, (d: any) => {
      d.outline.move(target, { parent: b, index: 0 })
    })
    const roots = doc.outline.roots
    const aNode = roots.find(n => n.id === a)
    const bNode = roots.find(n => n.id === b)
    expect(aNode?.children).toHaveLength(0)
    expect(bNode?.children[0]?.id).toBe(target)
  })
})

// ===========================================================================
// Ops captured by `batch()` replay deterministically
// ===========================================================================

describe("tree ops replay", () => {
  it("a sequence of create/move/delete ops replays to an identical state", () => {
    // Protects four-layer agreement: algebra arg / change vocabulary /
    // shadow / Plain shape. If any layer drifts, replay diverges.
    const docA = createDoc(TodoSchema)
    let aId = ""
    let bId = ""
    let cId = ""
    const ops1 = batch(docA, (d: any) => {
      aId = d.outline.create({ data: { label: "A" } })
      bId = d.outline.create({ parent: aId, data: { label: "B" } })
      cId = d.outline.create({ parent: aId, data: { label: "C" } })
    })
    const ops2 = batch(docA, (d: any) => {
      d.outline.move(cId, { parent: bId, index: 0 })
    })
    const ops3 = batch(docA, (d: any) => {
      d.outline.delete(bId) // removes B and C (now under B)
    })
    const docB = createDoc(TodoSchema)
    applyChanges(docB, [...ops1, ...ops2, ...ops3])
    expect(docB.outline()).toEqual(docA.outline())
    // Only A remains in both.
    expect(docB.outline.size).toBe(1)
    expect(docB.outline.has(aId)).toBe(true)
  })
})

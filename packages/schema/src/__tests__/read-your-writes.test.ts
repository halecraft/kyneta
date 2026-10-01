// read-your-writes.test — pin the σ-eager semantic inside batch() blocks.
//
// Pre-refactor: σ didn't advance until commit, so two pushes in one block
// silently reordered. Post-refactor: σ advances on every prepare, so
// length-derived helpers read consistent state.

import { describe, expect, it } from "vitest"
import { batch, Schema } from "../index.js"
import { contextOver, refOver } from "./stack.js"

function buildDoc<S extends ReturnType<typeof Schema.struct>>(
  schema: S,
  seed: Record<string, unknown>,
) {
  const store = { ...seed }
  const ctx = contextOver(schema, store)
  const doc = refOver(schema, ctx) as any
  return { store, ctx, doc }
}

describe("read-your-writes: σ advances eagerly inside batch()", () => {
  it("two pushes in one block append in order (the canonical two-push gotcha resolved)", () => {
    const schema = Schema.struct({
      todos: Schema.list(Schema.string()),
    })
    const { doc } = buildDoc(schema, { todos: [] })

    batch(doc, d => {
      d.todos.push("a")
      d.todos.push("b")
    })

    expect(doc.todos()).toEqual(["a", "b"])
  })

  it("scalar reads inside batch() reflect prior writes", () => {
    const schema = Schema.struct({ count: Schema.number() })
    const { doc } = buildDoc(schema, { count: 0 })

    batch(doc, d => {
      d.count.set(5)
      expect(doc.count()).toBe(5)
      d.count.set(10)
      expect(doc.count()).toBe(10)
    })
    expect(doc.count()).toBe(10)
  })

  it("state-substitution: one block vs two blocks ends at the same state", () => {
    const schema = Schema.struct({
      todos: Schema.list(Schema.string()),
      count: Schema.number(),
    })
    const docOne = buildDoc(schema, { todos: [], count: 0 })
    const docTwo = buildDoc(schema, { todos: [], count: 0 })

    // One block
    batch(docOne.doc, d => {
      d.todos.push("a")
      d.todos.push("b")
      d.count.set(2)
    })

    // Two blocks
    batch(docTwo.doc, d => {
      d.todos.push("a")
    })
    batch(docTwo.doc, d => {
      d.todos.push("b")
      d.count.set(2)
    })

    expect(docOne.doc.todos()).toEqual(docTwo.doc.todos())
    expect(docOne.doc.count()).toBe(docTwo.doc.count())
  })

  it("subscriber-visibility substitution does NOT hold (one block → one Changeset; two blocks → two)", () => {
    const schema = Schema.struct({ count: Schema.number() })
    const docOne = buildDoc(schema, { count: 0 })
    const docTwo = buildDoc(schema, { count: 0 })

    const oneFires: number[] = []
    docOne.doc.count[Symbol.for("kyneta:changefeed") as any].subscribe(
      (cs: any) => oneFires.push(cs.changes.length),
    )
    const twoFires: number[] = []
    docTwo.doc.count[Symbol.for("kyneta:changefeed") as any].subscribe(
      (cs: any) => twoFires.push(cs.changes.length),
    )

    batch(docOne.doc, d => {
      d.count.set(1)
      d.count.set(2)
    })

    batch(docTwo.doc, d => d.count.set(1))
    batch(docTwo.doc, d => d.count.set(2))

    expect(oneFires).toEqual([2])
    expect(twoFires).toEqual([1, 1])
  })
})

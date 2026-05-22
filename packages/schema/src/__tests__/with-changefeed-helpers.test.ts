// Pure-helper unit tests for the tree-changefeed factory's Functional Core.
//
// `planTreeMembershipUpdate` and `synthesizeTreeDeleteTerminal` are
// extracted as exported pure helpers in `with-changefeed.ts` precisely
// so they can be table-tested without spinning up a doc.

import type { ChangeBase, Changeset } from "@kyneta/changefeed"
import { describe, expect, it } from "vitest"
import { treeChange } from "../change.js"
import {
  planTreeMembershipUpdate,
  synthesizeTreeDeleteTerminal,
} from "../interpreters/with-changefeed.js"

// ---------------------------------------------------------------------------
// planTreeMembershipUpdate — table tests
// ---------------------------------------------------------------------------

function cs(...changes: ChangeBase[]): Changeset<ChangeBase> {
  return { changes }
}

describe("planTreeMembershipUpdate", () => {
  it("empty Changeset → empty deltas", () => {
    const result = planTreeMembershipUpdate(cs(), new Set())
    expect(result.created).toEqual([])
    expect(result.deleted).toEqual([])
  })

  it("lone create → created has the id", () => {
    const change = treeChange([
      { action: "create", target: "n1", parent: null, index: 0 },
    ])
    const result = planTreeMembershipUpdate(cs(change), new Set())
    expect(result.created).toEqual(["n1"])
    expect(result.deleted).toEqual([])
  })

  it("lone delete against wired id → deleted has the id", () => {
    const change = treeChange([{ action: "delete", target: "n1" }])
    const result = planTreeMembershipUpdate(cs(change), new Set(["n1"]))
    expect(result.created).toEqual([])
    expect(result.deleted).toEqual(["n1"])
  })

  it("lone delete against unwired id → no deltas (defensive)", () => {
    const change = treeChange([{ action: "delete", target: "ghost" }])
    const result = planTreeMembershipUpdate(cs(change), new Set())
    expect(result.created).toEqual([])
    expect(result.deleted).toEqual([])
  })

  it("lone move → no membership change (identity preserved)", () => {
    const change = treeChange([
      { action: "move", target: "n1", parent: "n2", index: 0 },
    ])
    const result = planTreeMembershipUpdate(cs(change), new Set(["n1", "n2"]))
    expect(result.created).toEqual([])
    expect(result.deleted).toEqual([])
  })

  it("create + delete of different ids → both deltas", () => {
    const change = treeChange([
      { action: "create", target: "new", parent: null, index: 0 },
      { action: "delete", target: "old" },
    ])
    const result = planTreeMembershipUpdate(cs(change), new Set(["old"]))
    expect(result.created).toEqual(["new"])
    expect(result.deleted).toEqual(["old"])
  })

  it("create + delete of same id within one Changeset → cancels out", () => {
    const change = treeChange([
      { action: "create", target: "transient", parent: null, index: 0 },
      { action: "delete", target: "transient" },
    ])
    const result = planTreeMembershipUpdate(cs(change), new Set())
    expect(result.created).toEqual([])
    expect(result.deleted).toEqual([])
  })

  it("accumulates deltas across instructions and across multiple TreeChanges", () => {
    const result = planTreeMembershipUpdate(
      cs(
        treeChange([
          { action: "create", target: "a", parent: null, index: 0 },
          { action: "create", target: "b", parent: null, index: 1 },
          { action: "move", target: "a", parent: "b", index: 0 },
        ]),
        treeChange([{ action: "delete", target: "c" }]),
      ),
      new Set(["c"]),
    )
    expect([...result.created].sort()).toEqual(["a", "b"])
    expect(result.deleted).toEqual(["c"])
  })

  it("non-tree changes are ignored", () => {
    const result = planTreeMembershipUpdate(
      cs(
        { type: "map", set: { key: "value" } } as ChangeBase,
        { type: "replace", value: 1 } as ChangeBase,
      ),
      new Set(),
    )
    expect(result.created).toEqual([])
    expect(result.deleted).toEqual([])
  })

  it("mixed tree + non-tree changes → tree changes only contribute", () => {
    const result = planTreeMembershipUpdate(
      cs(
        { type: "map", set: { key: "value" } } as ChangeBase,
        treeChange([{ action: "create", target: "a", parent: null, index: 0 }]),
      ),
      new Set(),
    )
    expect(result.created).toEqual(["a"])
    expect(result.deleted).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// synthesizeTreeDeleteTerminal — wire-shape pin
// ---------------------------------------------------------------------------

describe("synthesizeTreeDeleteTerminal", () => {
  it("returns a Changeset with one tree-delete change carrying the id", () => {
    const result = synthesizeTreeDeleteTerminal("n1")

    expect(result.changes).toHaveLength(1)
    const change = result.changes[0]
    expect(change.type).toBe("tree")
    const insts = (
      change as unknown as {
        instructions: { action: string; target: string }[]
      }
    ).instructions
    expect(insts).toHaveLength(1)
    expect(insts[0].action).toBe("delete")
    expect(insts[0].target).toBe("n1")
  })

  it("does not carry origin / source / replay markers (terminal is synthetic)", () => {
    const result = synthesizeTreeDeleteTerminal("nX")
    expect(result.origin).toBeUndefined()
    expect(result.source).toBeUndefined()
    expect(result.replay).toBeUndefined()
    expect(result.aborted).toBeUndefined()
  })
})

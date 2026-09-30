// undo-edits — a stack's transitions, and the ops that write them: as large
// as what changed.

import { RawPath, step as stepChange } from "@kyneta/schema"
import { describe, expect, it } from "vitest"
import type { Part, Step } from "../undo/schema.js"
import {
  moveStep,
  pushStep,
  type StoredStack,
  stackOps,
} from "../undo/stack.js"

const part = (docId: string, record: string): Part => ({
  docId,
  schemaHash: "h",
  replicaType: ["yjs", 1, 0],
  syncMode: { writerModel: "concurrent", durability: "persistent" },
  record,
})
const step = (id: string, ...parts: Part[]): Step => ({ id, parts })

/** `stack` with `ops` applied, as the document would. */
function written(stack: StoredStack, after: StoredStack): StoredStack {
  let state: unknown = stack
  for (const op of stackOps(RawPath.empty, stack, after)) {
    const [segment] = op.path.segments
    const field = segment?.resolve() as keyof StoredStack
    const next = stepChange((state as StoredStack)[field], op.change)
    state = { ...(state as StoredStack), [field]: next }
  }
  return state as StoredStack
}

describe("pushStep", () => {
  it("pushes, clears redo and trims to depth", () => {
    const stack: StoredStack = {
      undo: [step("a"), step("b")],
      redo: [step("r")],
      pending: null,
    }
    const after = pushStep(stack, step("c"), 2)
    expect(after).toEqual({
      undo: [step("b"), step("c")],
      redo: [],
      pending: null,
    })
    expect(written(stack, after)).toEqual(after)
  })

  it("writes only the new step, not the stack", () => {
    const stack: StoredStack = {
      undo: [step("a"), step("b")],
      redo: [],
      pending: null,
    }
    const ops = stackOps(RawPath.empty, stack, pushStep(stack, step("c"), 10))
    expect(ops.map(op => [op.path.format(), op.change])).toEqual([
      [
        "undo",
        {
          type: "sequence",
          instructions: [{ retain: 2 }, { insert: [step("c")] }],
        },
      ],
    ])
  })
})

describe("moveStep", () => {
  it("moves the step, rewrites the steps left, and clears the note", () => {
    const stack: StoredStack = {
      undo: [step("a", part("x", "1")), step("b", part("y", "2")), step("top")],
      redo: [],
      pending: { step: "top", direction: "undo", positions: {} },
    }
    const rewrite = (p: Part) => (p.docId === "x" ? { ...p, record: "1'" } : p)
    const after = moveStep(
      stack,
      "undo",
      step("top"),
      step("top", part("z", "3")),
      rewrite,
    )
    expect(after).toEqual({
      undo: [step("a", part("x", "1'")), step("b", part("y", "2"))],
      redo: [step("top", part("z", "3"))],
      pending: null,
    })
    expect(written(stack, after)).toEqual(after)
    // The untouched step "b" is retained, not written again.
    const [undoOp] = stackOps(RawPath.empty, stack, after)
    expect(JSON.stringify(undoOp)).not.toContain('"b"')
  })

  it("drops a step nothing of which applied", () => {
    const stack: StoredStack = { undo: [step("top")], redo: [], pending: null }
    expect(moveStep(stack, "undo", step("top"), undefined, p => p)).toEqual({
      undo: [],
      redo: [],
      pending: null,
    })
  })
})

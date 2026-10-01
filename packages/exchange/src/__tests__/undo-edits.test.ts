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
  topStep,
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
  it("pushes, and clears the redo steps that write a document it writes", () => {
    const stack: StoredStack = {
      undo: [step("a", part("x", "1"))],
      redo: [
        step("rx", part("x", "2")),
        step("ry", part("y", "3")),
        // Across documents: cleared by a push on either.
        step("rxz", part("x", "4"), part("z", "5")),
      ],
      pending: null,
    }
    const after = pushStep(stack, step("b", part("x", "6")), 10)
    expect(after).toEqual({
      undo: [step("a", part("x", "1")), step("b", part("x", "6"))],
      redo: [step("ry", part("y", "3"))],
      pending: null,
    })
    expect(written(stack, after)).toEqual(after)
  })

  it("trims each list to depth", () => {
    const stack: StoredStack = {
      undo: [step("a", part("x", "1")), step("b", part("x", "2"))],
      redo: [step("r1", part("y", "3")), step("r2", part("y", "4"))],
      pending: null,
    }
    const after = pushStep(stack, step("c", part("x", "5")), 1)
    expect(after.undo.map(s => s.id)).toEqual(["c"])
    expect(after.redo.map(s => s.id)).toEqual(["r2"])
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
      10,
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
    expect(moveStep(stack, "undo", step("top"), undefined, p => p, 10)).toEqual(
      {
        undo: [],
        redo: [],
        pending: null,
      },
    )
  })
})

describe("moving a step under the top", () => {
  it("removes only that step", () => {
    const stack: StoredStack = {
      undo: [step("sx", part("x", "1")), step("sy", part("y", "2"))],
      redo: [],
      pending: null,
    }
    const after = moveStep(
      stack,
      "undo",
      step("sx", part("x", "1")),
      step("sx", part("x", "1'")),
      p => p,
      10,
    )
    expect(after.undo).toEqual([step("sy", part("y", "2"))])
    expect(written(stack, after)).toEqual(after)
    const [undoOp] = stackOps(RawPath.empty, stack, after)
    expect(JSON.stringify(undoOp)).not.toContain('"sy"')
  })

  it("keeps the list it moves onto to depth", () => {
    const stack: StoredStack = {
      undo: [step("a", part("x", "1"))],
      redo: [step("r", part("y", "2"))],
      pending: null,
    }
    const after = moveStep(
      stack,
      "redo",
      step("r", part("y", "2")),
      step("r", part("y", "2'")),
      p => p,
      1,
    )
    expect(after.undo).toEqual([step("r", part("y", "2'"))])
  })
})

describe("topStep", () => {
  const steps = [
    step("x", part("x", "1")),
    step("xy", part("x", "2"), part("y", "3")),
    step("z", part("z", "4")),
  ]

  it("takes the newest step that writes a document asked for", () => {
    expect(topStep(steps, ["x"])?.id).toBe("xy")
    expect(topStep(steps, ["y", "z"])?.id).toBe("z")
  })

  it("takes the newest step when no documents are named, and none for none", () => {
    expect(topStep(steps, undefined)?.id).toBe("z")
    expect(topStep(steps, [])).toBeUndefined()
  })
})

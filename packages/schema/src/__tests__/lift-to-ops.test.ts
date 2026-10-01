// lift-to-ops — the shape-grammar helper that raises a leaf-shaped
// `Changeset<C>` to a tree-shaped `Changeset<Op<C>>` at a constant path.
//
// Split out of plan-notifications (which became plan-delivery) because it is a
// separate concern: `liftToOps` does not plan anything, it reshapes one
// changeset. It only ever lived beside the planner by proximity.
//
// The metadata cases below are the load-bearing ones. Every field of
// BatchMetadata has a consumer that breaks silently if the lift drops it —
// see the comments on each.

import type { ChangeBase, Changeset } from "@kyneta/changefeed"
import { describe, expect, it } from "vitest"
import { liftToOps } from "../delivery.js"
import { RawPath } from "../path.js"

// ---------------------------------------------------------------------------
// liftToOps: shape grammar — raise Changeset<C> to Changeset<Op<C>>
// ---------------------------------------------------------------------------

describe("liftToOps: wraps each change with the given path", () => {
  it("empty changeset → empty result, origin preserved", () => {
    const changeset: Changeset<ChangeBase> = {
      changes: [],
      origin: "populated",
    }
    const lifted = liftToOps(changeset, RawPath.empty)
    expect(lifted.changes).toHaveLength(0)
    expect(lifted.origin).toBe("populated")
  })

  it("single-change changeset → one Op with the supplied path", () => {
    const path = RawPath.empty.field("title")
    const changeset: Changeset<ChangeBase> = { changes: [{ type: "text" }] }
    const lifted = liftToOps(changeset, path)
    expect(lifted.changes).toHaveLength(1)
    expect(lifted.changes[0]?.path).toBe(path)
    expect(lifted.changes[0]?.change.type).toBe("text")
  })

  it("multi-change changeset → N Ops, all sharing the path", () => {
    const path = RawPath.empty.field("counter")
    const changeset: Changeset<ChangeBase> = {
      changes: [
        { type: "increment" },
        { type: "increment" },
        { type: "replace" },
      ],
    }
    const lifted = liftToOps(changeset, path)
    expect(lifted.changes).toHaveLength(3)
    for (const op of lifted.changes) {
      expect(op.path).toBe(path)
    }
    expect(lifted.changes.map(op => op.change.type)).toEqual([
      "increment",
      "increment",
      "replace",
    ])
  })

  it("origin is preserved across the lift", () => {
    const changeset: Changeset<ChangeBase> = {
      changes: [{ type: "replace" }],
      origin: "test-origin",
    }
    const lifted = liftToOps(changeset, RawPath.empty.field("x"))
    expect(lifted.origin).toBe("test-origin")
  })

  // The exchange's auto-subscribe filter reads `replay` off the tree-
  // subscriber changeset; if this strips it, foreign-origin merges echo.
  it("replay is preserved across the lift", () => {
    const changeset: Changeset<ChangeBase> = {
      changes: [{ type: "replace" }],
      origin: "external",
      replay: true,
    }
    const lifted = liftToOps(changeset, RawPath.empty.field("x"))
    expect(lifted.replay).toBe(true)
  })

  // Echo-token discriminator (jj:wpvtoxmw): if the lift strips source,
  // subscribers that own a tree-level view of a leaf can't recognize
  // their own writes.
  it("source identity is preserved across the lift", () => {
    const tok = Symbol("test-source")
    const changeset: Changeset<ChangeBase> = {
      changes: [{ type: "replace" }],
      source: tok,
    }
    const lifted = liftToOps(changeset, RawPath.empty.field("x"))
    expect(lifted.source).toBe(tok)
  })
})

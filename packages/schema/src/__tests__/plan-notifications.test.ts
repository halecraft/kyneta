import type { ChangeBase, Changeset } from "@kyneta/changefeed"
import { describe, expect, it } from "vitest"
import type { Op } from "../index.js"
import { planNotifications } from "../index.js"
import { liftToOps } from "../interpreters/with-changefeed.js"
import type { Path } from "../path.js"
import { RawPath } from "../path.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a Op from a path and change type string. */
function pc(path: Path, type: string): Op {
  return { path, change: { type } }
}

// ---------------------------------------------------------------------------
// Table-driven tests — mirrors the planCacheUpdate pattern
// ---------------------------------------------------------------------------

describe("planNotifications: grouping", () => {
  it("empty pending → empty grouped map", () => {
    const plan = planNotifications([])
    expect(plan.grouped.size).toBe(0)
  })

  it("single change → single group with 1 entry", () => {
    const path = RawPath.empty.field("title")
    const plan = planNotifications([pc(path, "text")])

    expect(plan.grouped.size).toBe(1)
    expect(plan.grouped.get(path.key)).toEqual([{ type: "text" }])
  })

  it("two changes at the same path → single group with 2 entries", () => {
    const path = RawPath.empty.field("x")
    const plan = planNotifications([pc(path, "replace"), pc(path, "replace")])

    expect(plan.grouped.size).toBe(1)
    const changes = plan.grouped.get(path.key) as any
    expect(changes).toHaveLength(2)
    expect(changes[0]?.type).toBe("replace")
    expect(changes[1]?.type).toBe("replace")
  })

  it("three changes at two paths → two groups", () => {
    const pathX = RawPath.empty.field("x")
    const pathY = RawPath.empty.field("y")
    const plan = planNotifications([
      pc(pathX, "replace"),
      pc(pathY, "replace"),
      pc(pathX, "replace"),
    ])

    expect(plan.grouped.size).toBe(2)
    expect(plan.grouped.get(pathX.key)).toHaveLength(2)
    expect(plan.grouped.get(pathY.key)).toHaveLength(1)
  })

  it("preserves change ordering within a group", () => {
    const path = RawPath.empty.field("counter")
    const plan = planNotifications([
      pc(path, "increment"),
      pc(path, "replace"),
      pc(path, "increment"),
    ])

    const changes = plan.grouped.get(path.key) as any
    expect(changes).toHaveLength(3)
    expect(changes[0]?.type).toBe("increment")
    expect(changes[1]?.type).toBe("replace")
    expect(changes[2]?.type).toBe("increment")
  })

  it("nested paths are grouped independently", () => {
    const settingsPath = RawPath.empty.field("settings")
    const darkModePath = RawPath.empty.field("settings").field("darkMode")
    const fontSizePath = RawPath.empty.field("settings").field("fontSize")

    const plan = planNotifications([
      pc(darkModePath, "replace"),
      pc(fontSizePath, "replace"),
      pc(settingsPath, "map"),
    ])

    expect(plan.grouped.size).toBe(3)
    expect(plan.grouped.get(settingsPath.key)).toHaveLength(1)
    expect(plan.grouped.get(darkModePath.key)).toHaveLength(1)
    expect(plan.grouped.get(fontSizePath.key)).toHaveLength(1)
  })

  it("index path segments produce distinct keys", () => {
    const path0 = RawPath.empty.field("items").item(0)
    const path1 = RawPath.empty.field("items").item(1)

    const plan = planNotifications([
      pc(path0, "replace"),
      pc(path1, "replace"),
      pc(path0, "replace"),
    ])

    expect(plan.grouped.size).toBe(2)
    expect(plan.grouped.get(path0.key)).toHaveLength(2)
    expect(plan.grouped.get(path1.key)).toHaveLength(1)
  })

  it("root path (empty) is a valid group key", () => {
    const rootPath = RawPath.empty
    const childPath = RawPath.empty.field("x")

    const plan = planNotifications([
      pc(rootPath, "map"),
      pc(childPath, "replace"),
    ])

    expect(plan.grouped.size).toBe(2)
    expect(plan.grouped.get(rootPath.key)).toHaveLength(1)
    expect(plan.grouped.get(childPath.key)).toHaveLength(1)
  })

  it("many changes to many paths group correctly", () => {
    const paths = Array.from({ length: 5 }, (_, i) =>
      RawPath.empty.field(`field${i}`),
    )
    const pending: Op[] = []
    // 3 changes per path = 15 total
    for (let round = 0; round < 3; round++) {
      for (const path of paths) {
        pending.push(pc(path, "replace"))
      }
    }

    const plan = planNotifications(pending)
    expect(plan.grouped.size).toBe(5)
    for (const path of paths) {
      expect(plan.grouped.get(path.key)).toHaveLength(3)
    }
  })
})

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

describe("planNotifications: immutability", () => {
  it("does not mutate the input array", () => {
    const path = RawPath.empty.field("x")
    const input: Op[] = [pc(path, "replace")]
    const copy = [...input]

    planNotifications(input)

    expect(input).toEqual(copy)
  })

  it("returns a new map each time", () => {
    const path = RawPath.empty.field("x")
    const input = [pc(path, "replace")]

    const plan1 = planNotifications(input)
    const plan2 = planNotifications(input)

    expect(plan1.grouped).not.toBe(plan2.grouped)
  })
})

describe("planNotifications: change data integrity", () => {
  it("preserves full change objects (not just type)", () => {
    const path = RawPath.empty.field("items")
    const change = {
      type: "sequence" as const,
      ops: [{ retain: 2 }, { insert: ["a", "b"] }],
    }
    const plan = planNotifications([{ path, change }])

    const changes = plan.grouped.get(path.key) as any
    expect(changes).toHaveLength(1)
    expect(changes[0]).toBe(change) // Same reference — no cloning
  })
})

import { describe, expect, it } from "vitest"
import { planNotifications } from "../index.js"
import type { PendingChange } from "../index.js"
import { pathKey } from "../store.js"
import type { Path } from "../interpret.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Shorthand for a key path segment. */
const key = (k: string): Path[number] => ({ type: "key" as const, key: k })

/** Shorthand for an index path segment. */
const idx = (i: number): Path[number] => ({ type: "index" as const, index: i })

/** Build a PendingChange from a path and change type string. */
function pc(path: Path, type: string): PendingChange {
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
    const path: Path = [key("title")]
    const plan = planNotifications([pc(path, "text")])

    expect(plan.grouped.size).toBe(1)
    const k = pathKey(path)
    expect(plan.grouped.get(k)).toEqual([{ type: "text" }])
  })

  it("two changes at the same path → single group with 2 entries", () => {
    const path: Path = [key("x")]
    const plan = planNotifications([
      pc(path, "replace"),
      pc(path, "replace"),
    ])

    expect(plan.grouped.size).toBe(1)
    const k = pathKey(path)
    const changes = plan.grouped.get(k)!
    expect(changes).toHaveLength(2)
    expect(changes[0]!.type).toBe("replace")
    expect(changes[1]!.type).toBe("replace")
  })

  it("three changes at two paths → two groups", () => {
    const pathX: Path = [key("x")]
    const pathY: Path = [key("y")]
    const plan = planNotifications([
      pc(pathX, "replace"),
      pc(pathY, "replace"),
      pc(pathX, "replace"),
    ])

    expect(plan.grouped.size).toBe(2)
    expect(plan.grouped.get(pathKey(pathX))).toHaveLength(2)
    expect(plan.grouped.get(pathKey(pathY))).toHaveLength(1)
  })

  it("preserves change ordering within a group", () => {
    const path: Path = [key("counter")]
    const plan = planNotifications([
      pc(path, "increment"),
      pc(path, "replace"),
      pc(path, "increment"),
    ])

    const changes = plan.grouped.get(pathKey(path))!
    expect(changes).toHaveLength(3)
    expect(changes[0]!.type).toBe("increment")
    expect(changes[1]!.type).toBe("replace")
    expect(changes[2]!.type).toBe("increment")
  })

  it("nested paths are grouped independently", () => {
    const settingsPath: Path = [key("settings")]
    const darkModePath: Path = [key("settings"), key("darkMode")]
    const fontSizePath: Path = [key("settings"), key("fontSize")]

    const plan = planNotifications([
      pc(darkModePath, "replace"),
      pc(fontSizePath, "replace"),
      pc(settingsPath, "map"),
    ])

    expect(plan.grouped.size).toBe(3)
    expect(plan.grouped.get(pathKey(settingsPath))).toHaveLength(1)
    expect(plan.grouped.get(pathKey(darkModePath))).toHaveLength(1)
    expect(plan.grouped.get(pathKey(fontSizePath))).toHaveLength(1)
  })

  it("index path segments produce distinct keys", () => {
    const path0: Path = [key("items"), idx(0)]
    const path1: Path = [key("items"), idx(1)]

    const plan = planNotifications([
      pc(path0, "replace"),
      pc(path1, "replace"),
      pc(path0, "replace"),
    ])

    expect(plan.grouped.size).toBe(2)
    expect(plan.grouped.get(pathKey(path0))).toHaveLength(2)
    expect(plan.grouped.get(pathKey(path1))).toHaveLength(1)
  })

  it("root path (empty) is a valid group key", () => {
    const rootPath: Path = []
    const childPath: Path = [key("x")]

    const plan = planNotifications([
      pc(rootPath, "map"),
      pc(childPath, "replace"),
    ])

    expect(plan.grouped.size).toBe(2)
    expect(plan.grouped.get(pathKey(rootPath))).toHaveLength(1)
    expect(plan.grouped.get(pathKey(childPath))).toHaveLength(1)
  })

  it("many changes to many paths group correctly", () => {
    const paths = Array.from({ length: 5 }, (_, i) => [key(`field${i}`)] as Path)
    const pending: PendingChange[] = []
    // 3 changes per path = 15 total
    for (let round = 0; round < 3; round++) {
      for (const path of paths) {
        pending.push(pc(path, "replace"))
      }
    }

    const plan = planNotifications(pending)
    expect(plan.grouped.size).toBe(5)
    for (const path of paths) {
      expect(plan.grouped.get(pathKey(path))).toHaveLength(3)
    }
  })
})

describe("planNotifications: immutability", () => {
  it("does not mutate the input array", () => {
    const path: Path = [key("x")]
    const input: PendingChange[] = [pc(path, "replace")]
    const copy = [...input]

    planNotifications(input)

    expect(input).toEqual(copy)
  })

  it("returns a new map each time", () => {
    const path: Path = [key("x")]
    const input = [pc(path, "replace")]

    const plan1 = planNotifications(input)
    const plan2 = planNotifications(input)

    expect(plan1.grouped).not.toBe(plan2.grouped)
  })
})

describe("planNotifications: change data integrity", () => {
  it("preserves full change objects (not just type)", () => {
    const path: Path = [key("items")]
    const change = {
      type: "sequence" as const,
      ops: [{ retain: 2 }, { insert: ["a", "b"] }],
    }
    const plan = planNotifications([{ path, change }])

    const changes = plan.grouped.get(pathKey(path))!
    expect(changes).toHaveLength(1)
    expect(changes[0]).toBe(change) // Same reference — no cloning
  })
})
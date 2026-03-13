import { describe, expect, it } from "vitest"
import {
  planCacheUpdate,
  applyCacheOps,
} from "../interpreters/with-caching.js"
import type { CacheOp } from "../interpreters/with-caching.js"
import {
  sequenceChange,
  mapChange,
  replaceChange,
} from "../change.js"

// ===========================================================================
// planCacheUpdate — table-driven tests
// ===========================================================================

describe("planCacheUpdate: sequence", () => {
  it("insert-at-middle: [retain 2, insert 1] → shift from 2 by +1", () => {
    const change = sequenceChange([{ retain: 2 }, { insert: ["x"] }])
    const ops = planCacheUpdate(change, "sequence")
    expect(ops).toEqual([{ type: "shift", from: 2, delta: 1 }])
  })

  it("insert-at-start: [insert 2] → shift from 0 by +2", () => {
    const change = sequenceChange([{ insert: ["a", "b"] }])
    const ops = planCacheUpdate(change, "sequence")
    expect(ops).toEqual([{ type: "shift", from: 0, delta: 2 }])
  })

  it("delete: [retain 1, delete 1] → delete [1], shift from 2 by -1", () => {
    const change = sequenceChange([{ retain: 1 }, { delete: 1 }])
    const ops = planCacheUpdate(change, "sequence")
    expect(ops).toEqual([
      { type: "delete", keys: [1] },
      { type: "shift", from: 2, delta: -1 },
    ])
  })

  it("delete multiple: [retain 1, delete 3] → delete [1,2,3], shift from 4 by -3", () => {
    const change = sequenceChange([{ retain: 1 }, { delete: 3 }])
    const ops = planCacheUpdate(change, "sequence")
    expect(ops).toEqual([
      { type: "delete", keys: [1, 2, 3] },
      { type: "shift", from: 4, delta: -3 },
    ])
  })

  it("delete-at-start: [delete 1] → delete [0], shift from 1 by -1", () => {
    const change = sequenceChange([{ delete: 1 }])
    const ops = planCacheUpdate(change, "sequence")
    expect(ops).toEqual([
      { type: "delete", keys: [0] },
      { type: "shift", from: 1, delta: -1 },
    ])
  })

  it("append: [retain N, insert items] → shift from N (no-op in practice)", () => {
    // When inserting at the end, the shift targets indices >= N,
    // but no existing cache entries are at those indices. So the
    // shift is structurally emitted but has no practical effect.
    const change = sequenceChange([{ retain: 5 }, { insert: ["x", "y"] }])
    const ops = planCacheUpdate(change, "sequence")
    expect(ops).toEqual([{ type: "shift", from: 5, delta: 2 }])
  })

  it("replace on sequence → clear", () => {
    const change = replaceChange([1, 2, 3])
    const ops = planCacheUpdate(change, "sequence")
    expect(ops).toEqual([{ type: "clear" }])
  })

  it("empty ops list → no cache operations", () => {
    const change = sequenceChange([])
    const ops = planCacheUpdate(change, "sequence")
    expect(ops).toEqual([])
  })

  it("retain-only → no cache operations", () => {
    const change = sequenceChange([{ retain: 10 }])
    const ops = planCacheUpdate(change, "sequence")
    expect(ops).toEqual([])
  })

  it("insert then delete: [insert 1, retain 2, delete 1]", () => {
    const change = sequenceChange([
      { insert: ["new"] },
      { retain: 2 },
      { delete: 1 },
    ])
    const ops = planCacheUpdate(change, "sequence")
    // insert at cursor 0: shift from 0 by +1 (cursor stays at 0 — inserts don't consume)
    // retain 2: cursor moves to 2
    // delete at cursor 2: delete [2], shift from 3 by -1
    expect(ops).toEqual([
      { type: "shift", from: 0, delta: 1 },
      { type: "delete", keys: [2] },
      { type: "shift", from: 3, delta: -1 },
    ])
  })
})

describe("planCacheUpdate: map", () => {
  it("delete keys → delete ops", () => {
    const change = mapChange(undefined, ["k"])
    const ops = planCacheUpdate(change, "map")
    expect(ops).toEqual([{ type: "delete", keys: ["k"] }])
  })

  it("delete multiple keys → delete ops with all keys", () => {
    const change = mapChange(undefined, ["a", "b", "c"])
    const ops = planCacheUpdate(change, "map")
    expect(ops).toEqual([{ type: "delete", keys: ["a", "b", "c"] }])
  })

  it("set keys → delete ops (evict stale cached refs)", () => {
    const change = mapChange({ x: 1, y: 2 })
    const ops = planCacheUpdate(change, "map")
    expect(ops).toEqual([{ type: "delete", keys: ["x", "y"] }])
  })

  it("set and delete → both evict", () => {
    const change = mapChange({ x: 1 }, ["y"])
    const ops = planCacheUpdate(change, "map")
    expect(ops).toEqual([
      { type: "delete", keys: ["y"] },
      { type: "delete", keys: ["x"] },
    ])
  })

  it("empty map change → no ops", () => {
    const change = mapChange()
    const ops = planCacheUpdate(change, "map")
    expect(ops).toEqual([])
  })

  it("replace on map → clear", () => {
    const change = replaceChange({ a: 1 })
    const ops = planCacheUpdate(change, "map")
    expect(ops).toEqual([{ type: "clear" }])
  })
})

describe("planCacheUpdate: product", () => {
  it("replace → clear", () => {
    const change = replaceChange({ name: "new" })
    const ops = planCacheUpdate(change, "product")
    expect(ops).toEqual([{ type: "clear" }])
  })

  it("unrecognized change on product → clear (safe fallback)", () => {
    const change = { type: "unknown-thing" }
    const ops = planCacheUpdate(change, "product")
    expect(ops).toEqual([{ type: "clear" }])
  })
})

describe("planCacheUpdate: unrecognized change type", () => {
  it("unknown change on sequence → clear", () => {
    const change = { type: "custom-backend-change" }
    const ops = planCacheUpdate(change, "sequence")
    expect(ops).toEqual([{ type: "clear" }])
  })

  it("unknown change on map → clear", () => {
    const change = { type: "custom-backend-change" }
    const ops = planCacheUpdate(change, "map")
    expect(ops).toEqual([{ type: "clear" }])
  })
})

// ===========================================================================
// applyCacheOps — unit tests
// ===========================================================================

describe("applyCacheOps", () => {
  it("clear empties the cache", () => {
    const cache = new Map<number, string>([
      [0, "a"],
      [1, "b"],
      [2, "c"],
    ])
    applyCacheOps(cache, [{ type: "clear" }])
    expect(cache.size).toBe(0)
  })

  it("delete removes specific keys", () => {
    const cache = new Map<number, string>([
      [0, "a"],
      [1, "b"],
      [2, "c"],
    ])
    applyCacheOps(cache, [{ type: "delete", keys: [1] }])
    expect(cache.size).toBe(2)
    expect(cache.has(0)).toBe(true)
    expect(cache.has(1)).toBe(false)
    expect(cache.has(2)).toBe(true)
  })

  it("delete multiple keys", () => {
    const cache = new Map<string, number>([
      ["a", 1],
      ["b", 2],
      ["c", 3],
    ])
    applyCacheOps(cache, [{ type: "delete", keys: ["a", "c"] }])
    expect(cache.size).toBe(1)
    expect(cache.has("b")).toBe(true)
  })

  it("shift moves entries forward (positive delta)", () => {
    const cache = new Map<number, string>([
      [0, "a"],
      [1, "b"],
      [2, "c"],
    ])
    // Shift entries at index >= 1 by +2
    applyCacheOps(cache, [{ type: "shift", from: 1, delta: 2 }])
    expect(cache.size).toBe(3)
    expect(cache.get(0)).toBe("a") // unchanged
    expect(cache.get(3)).toBe("b") // 1 → 3
    expect(cache.get(4)).toBe("c") // 2 → 4
    expect(cache.has(1)).toBe(false)
    expect(cache.has(2)).toBe(false)
  })

  it("shift moves entries backward (negative delta)", () => {
    const cache = new Map<number, string>([
      [0, "a"],
      [2, "b"],
      [3, "c"],
    ])
    // Shift entries at index >= 2 by -1
    applyCacheOps(cache, [{ type: "shift", from: 2, delta: -1 }])
    expect(cache.size).toBe(3)
    expect(cache.get(0)).toBe("a") // unchanged
    expect(cache.get(1)).toBe("b") // 2 → 1
    expect(cache.get(2)).toBe("c") // 3 → 2
  })

  it("shift drops entries that would go negative", () => {
    const cache = new Map<number, string>([
      [0, "a"],
      [1, "b"],
    ])
    // Shift entries at index >= 0 by -1: index 0 would become -1 (dropped)
    applyCacheOps(cache, [{ type: "shift", from: 0, delta: -1 }])
    expect(cache.size).toBe(1)
    expect(cache.get(0)).toBe("b") // 1 → 0
    expect(cache.has(-1 as any)).toBe(false)
  })

  it("combined delete + shift (simulates sequence delete)", () => {
    const cache = new Map<number, string>([
      [0, "a"],
      [1, "b"],
      [2, "c"],
      [3, "d"],
    ])
    // Delete index 1, then shift indices >= 2 by -1
    applyCacheOps(cache, [
      { type: "delete", keys: [1] },
      { type: "shift", from: 2, delta: -1 },
    ])
    expect(cache.size).toBe(3)
    expect(cache.get(0)).toBe("a") // unchanged
    expect(cache.get(1)).toBe("c") // was at 2, shifted to 1
    expect(cache.get(2)).toBe("d") // was at 3, shifted to 2
    expect(cache.has(3)).toBe(false)
  })

  it("combined shift (simulates sequence insert at middle)", () => {
    const cache = new Map<number, string>([
      [0, "a"],
      [1, "b"],
      [2, "c"],
    ])
    // Insert at index 1: shift entries >= 1 by +1
    applyCacheOps(cache, [{ type: "shift", from: 1, delta: 1 }])
    expect(cache.size).toBe(3)
    expect(cache.get(0)).toBe("a") // unchanged
    expect(cache.get(2)).toBe("b") // was at 1, shifted to 2
    expect(cache.get(3)).toBe("c") // was at 2, shifted to 3
    expect(cache.has(1)).toBe(false) // slot 1 is now empty (for the new item)
  })

  it("shift on empty cache is a no-op", () => {
    const cache = new Map<number, string>()
    applyCacheOps(cache, [{ type: "shift", from: 0, delta: 5 }])
    expect(cache.size).toBe(0)
  })

  it("shift with string keys is ignored (only numeric keys shift)", () => {
    const cache = new Map<string, number>([
      ["a", 1],
      ["b", 2],
    ])
    // shift is designed for numeric indices; string keys don't match
    applyCacheOps(cache, [{ type: "shift", from: "a" as any, delta: 1 }])
    expect(cache.size).toBe(2)
    expect(cache.get("a")).toBe(1)
    expect(cache.get("b")).toBe(2)
  })

  it("no ops → no changes", () => {
    const cache = new Map<number, string>([[0, "a"]])
    applyCacheOps(cache, [])
    expect(cache.size).toBe(1)
    expect(cache.get(0)).toBe("a")
  })
})
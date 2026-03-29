import { describe, expect, it } from "vitest"
import { mapChange, replaceChange, sequenceChange } from "../change.js"
import { applyCacheOps, planCacheUpdate } from "../interpreters/with-caching.js"

// ===========================================================================
// planCacheUpdate — table-driven tests
// ===========================================================================

describe("planCacheUpdate: sequence", () => {
  it("insert-at-middle: [retain 2, insert 1] → evictFrom 2", () => {
    const change = sequenceChange([{ retain: 2 }, { insert: ["x"] }])
    const ops = planCacheUpdate(change, "sequence")
    expect(ops).toEqual([{ type: "evictFrom", start: 2 }])
  })

  it("insert-at-start: [insert 2] → evictFrom 0", () => {
    const change = sequenceChange([{ insert: ["a", "b"] }])
    const ops = planCacheUpdate(change, "sequence")
    expect(ops).toEqual([{ type: "evictFrom", start: 0 }])
  })

  it("delete: [retain 1, delete 1] → delete [1], evictFrom 1", () => {
    const change = sequenceChange([{ retain: 1 }, { delete: 1 }])
    const ops = planCacheUpdate(change, "sequence")
    expect(ops).toEqual([
      { type: "delete", keys: [1] },
      { type: "evictFrom", start: 1 },
    ])
  })

  it("delete multiple: [retain 1, delete 3] → delete [1,2,3], evictFrom 1", () => {
    const change = sequenceChange([{ retain: 1 }, { delete: 3 }])
    const ops = planCacheUpdate(change, "sequence")
    expect(ops).toEqual([
      { type: "delete", keys: [1, 2, 3] },
      { type: "evictFrom", start: 1 },
    ])
  })

  it("delete-at-start: [delete 1] → delete [0], evictFrom 0", () => {
    const change = sequenceChange([{ delete: 1 }])
    const ops = planCacheUpdate(change, "sequence")
    expect(ops).toEqual([
      { type: "delete", keys: [0] },
      { type: "evictFrom", start: 0 },
    ])
  })

  it("append: [retain N, insert items] → evictFrom N (no-op in practice)", () => {
    // When inserting at the end, evictFrom targets indices >= N,
    // but no existing cache entries are at those indices. So the
    // evictFrom is structurally emitted but has no practical effect.
    const change = sequenceChange([{ retain: 5 }, { insert: ["x", "y"] }])
    const ops = planCacheUpdate(change, "sequence")
    expect(ops).toEqual([{ type: "evictFrom", start: 5 }])
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
    // insert at cursor 0: evictFrom 0
    // retain 2: cursor moves to 2
    // delete at cursor 2: delete [2], evictFrom 2
    expect(ops).toEqual([
      { type: "evictFrom", start: 0 },
      { type: "delete", keys: [2] },
      { type: "evictFrom", start: 2 },
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

  it("evictFrom removes all entries at or above start index", () => {
    const cache = new Map<number, string>([
      [0, "a"],
      [1, "b"],
      [2, "c"],
      [3, "d"],
    ])
    applyCacheOps(cache, [{ type: "evictFrom", start: 2 }])
    expect(cache.size).toBe(2)
    expect(cache.get(0)).toBe("a")
    expect(cache.get(1)).toBe("b")
    expect(cache.has(2)).toBe(false)
    expect(cache.has(3)).toBe(false)
  })

  it("evictFrom at 0 clears all numeric entries", () => {
    const cache = new Map<number, string>([
      [0, "a"],
      [1, "b"],
      [2, "c"],
    ])
    applyCacheOps(cache, [{ type: "evictFrom", start: 0 }])
    expect(cache.size).toBe(0)
  })

  it("evictFrom beyond cache range is a no-op", () => {
    const cache = new Map<number, string>([
      [0, "a"],
      [1, "b"],
    ])
    applyCacheOps(cache, [{ type: "evictFrom", start: 5 }])
    expect(cache.size).toBe(2)
    expect(cache.get(0)).toBe("a")
    expect(cache.get(1)).toBe("b")
  })

  it("evictFrom ignores string keys", () => {
    const cache = new Map<string | number, string>([
      ["a", "alpha"],
      [0, "zero"],
      [1, "one"],
      [2, "two"],
    ] as [string | number, string][])
    applyCacheOps(cache as Map<number, unknown>, [{ type: "evictFrom", start: 1 }])
    expect(cache.size).toBe(2)
    expect(cache.get("a")).toBe("alpha")
    expect(cache.get(0)).toBe("zero")
    expect(cache.has(1)).toBe(false)
    expect(cache.has(2)).toBe(false)
  })

  it("combined delete + evictFrom (simulates sequence delete)", () => {
    const cache = new Map<number, string>([
      [0, "a"],
      [1, "b"],
      [2, "c"],
      [3, "d"],
    ])
    // Delete index 1, then evict all indices >= 1
    applyCacheOps(cache, [
      { type: "delete", keys: [1] },
      { type: "evictFrom", start: 1 },
    ])
    expect(cache.size).toBe(1)
    expect(cache.get(0)).toBe("a")
    expect(cache.has(1)).toBe(false)
    expect(cache.has(2)).toBe(false)
    expect(cache.has(3)).toBe(false)
  })

  it("combined evictFrom (simulates sequence insert at middle)", () => {
    const cache = new Map<number, string>([
      [0, "a"],
      [1, "b"],
      [2, "c"],
    ])
    // Insert at index 1: evict entries >= 1
    applyCacheOps(cache, [{ type: "evictFrom", start: 1 }])
    expect(cache.size).toBe(1)
    expect(cache.get(0)).toBe("a")
    expect(cache.has(1)).toBe(false)
    expect(cache.has(2)).toBe(false)
  })

  it("evictFrom on empty cache is a no-op", () => {
    const cache = new Map<number, string>()
    applyCacheOps(cache, [{ type: "evictFrom", start: 0 }])
    expect(cache.size).toBe(0)
  })

  it("no ops → no changes", () => {
    const cache = new Map<number, string>([[0, "a"]])
    applyCacheOps(cache, [])
    expect(cache.size).toBe(1)
    expect(cache.get(0)).toBe("a")
  })
})
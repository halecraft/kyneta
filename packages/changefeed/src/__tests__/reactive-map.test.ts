// ReactiveMap — unit tests for the reactive map combinator.

import { describe, expect, it, vi } from "vitest"
import {
  type CallableChangefeed,
  type ChangeBase,
  type Changeset,
  createReactiveMap,
  hasChangefeed,
} from "../index.js"

// ---------------------------------------------------------------------------
// Test change type
// ---------------------------------------------------------------------------

interface TestChange extends ChangeBase {
  readonly type: "set" | "delete"
  readonly key: string
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

describe("createReactiveMap", () => {
  it("returns a tuple of [ReactiveMap, ReactiveMapHandle]", () => {
    const [map, handle] = createReactiveMap<string, number, TestChange>()
    expect(typeof map).toBe("function")
    expect(handle).toBeDefined()
    expect(typeof handle.set).toBe("function")
    expect(typeof handle.delete).toBe("function")
    expect(typeof handle.clear).toBe("function")
    expect(typeof handle.emit).toBe("function")
  })

  it("starts empty", () => {
    const [map] = createReactiveMap<string, number, TestChange>()
    expect(map.size).toBe(0)
    expect([...map]).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Call signature
// ---------------------------------------------------------------------------

describe("call signature", () => {
  it("calling the map returns a ReadonlyMap snapshot", () => {
    const [map, handle] = createReactiveMap<string, number, TestChange>()
    handle.set("a", 1)
    const snapshot = map()
    expect(snapshot).toBeInstanceOf(Map)
    expect(snapshot.get("a")).toBe(1)
  })

  it(".current returns the same map as calling", () => {
    const [map, handle] = createReactiveMap<string, number, TestChange>()
    handle.set("x", 42)
    expect(map.current).toBe(map())
  })
})

// ---------------------------------------------------------------------------
// Lifted collection accessors
// ---------------------------------------------------------------------------

describe("collection accessors", () => {
  it(".get() delegates to the internal map", () => {
    const [map, handle] = createReactiveMap<string, number, TestChange>()
    expect(map.get("missing")).toBeUndefined()
    handle.set("a", 1)
    expect(map.get("a")).toBe(1)
  })

  it(".has() delegates to the internal map", () => {
    const [map, handle] = createReactiveMap<string, number, TestChange>()
    expect(map.has("a")).toBe(false)
    handle.set("a", 1)
    expect(map.has("a")).toBe(true)
  })

  it(".keys() yields all keys", () => {
    const [map, handle] = createReactiveMap<string, number, TestChange>()
    handle.set("a", 1)
    handle.set("b", 2)
    expect([...map.keys()]).toEqual(["a", "b"])
  })

  it(".size reflects the number of entries", () => {
    const [map, handle] = createReactiveMap<string, number, TestChange>()
    expect(map.size).toBe(0)
    handle.set("a", 1)
    expect(map.size).toBe(1)
    handle.set("b", 2)
    expect(map.size).toBe(2)
    handle.delete("a")
    expect(map.size).toBe(1)
  })

  it("[Symbol.iterator] yields [key, value] pairs", () => {
    const [map, handle] = createReactiveMap<string, number, TestChange>()
    handle.set("x", 10)
    handle.set("y", 20)
    const entries = [...map]
    expect(entries).toEqual([
      ["x", 10],
      ["y", 20],
    ])
  })
})

// ---------------------------------------------------------------------------
// Handle mutations
// ---------------------------------------------------------------------------

describe("ReactiveMapHandle", () => {
  it("set() inserts entries visible via the map", () => {
    const [map, handle] = createReactiveMap<string, number, TestChange>()
    handle.set("a", 1)
    handle.set("b", 2)
    expect(map.get("a")).toBe(1)
    expect(map.get("b")).toBe(2)
  })

  it("set() overwrites existing entries", () => {
    const [map, handle] = createReactiveMap<string, number, TestChange>()
    handle.set("a", 1)
    handle.set("a", 99)
    expect(map.get("a")).toBe(99)
    expect(map.size).toBe(1)
  })

  it("delete() removes an entry and returns true", () => {
    const [map, handle] = createReactiveMap<string, number, TestChange>()
    handle.set("a", 1)
    const result = handle.delete("a")
    expect(result).toBe(true)
    expect(map.has("a")).toBe(false)
    expect(map.size).toBe(0)
  })

  it("delete() returns false for missing key", () => {
    const [, handle] = createReactiveMap<string, number, TestChange>()
    expect(handle.delete("nope")).toBe(false)
  })

  it("clear() removes all entries", () => {
    const [map, handle] = createReactiveMap<string, number, TestChange>()
    handle.set("a", 1)
    handle.set("b", 2)
    handle.set("c", 3)
    handle.clear()
    expect(map.size).toBe(0)
    expect([...map]).toEqual([])
  })

  it("mutations do NOT automatically emit", () => {
    const [map, handle] = createReactiveMap<string, number, TestChange>()
    const cb = vi.fn()
    map.subscribe(cb)

    handle.set("a", 1)
    handle.delete("a")
    handle.clear()

    expect(cb).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Changefeed protocol — subscribe / emit
// ---------------------------------------------------------------------------

describe("changefeed protocol", () => {
  it("emit() delivers changeset to subscribers", () => {
    const [map, handle] = createReactiveMap<string, number, TestChange>()
    const received: Changeset<TestChange>[] = []
    map.subscribe(cs => received.push(cs))

    handle.set("a", 1)
    handle.emit({ changes: [{ type: "set", key: "a" }] })

    expect(received).toHaveLength(1)
    expect(received[0].changes).toEqual([{ type: "set", key: "a" }])
  })

  it("multiple subscribers all receive the changeset", () => {
    const [map, handle] = createReactiveMap<string, number, TestChange>()
    const cb1 = vi.fn()
    const cb2 = vi.fn()
    map.subscribe(cb1)
    map.subscribe(cb2)

    handle.emit({ changes: [{ type: "set", key: "x" }] })

    expect(cb1).toHaveBeenCalledTimes(1)
    expect(cb2).toHaveBeenCalledTimes(1)
  })

  it("unsubscribe stops delivery", () => {
    const [map, handle] = createReactiveMap<string, number, TestChange>()
    const cb = vi.fn()
    const unsub = map.subscribe(cb)

    handle.emit({ changes: [{ type: "set", key: "a" }] })
    expect(cb).toHaveBeenCalledTimes(1)

    unsub()

    handle.emit({ changes: [{ type: "set", key: "b" }] })
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it("changeset preserves origin", () => {
    const [map, handle] = createReactiveMap<string, number, TestChange>()
    const received: Changeset<TestChange>[] = []
    map.subscribe(cs => received.push(cs))

    handle.emit({
      changes: [{ type: "set", key: "a" }],
      origin: "sync",
    })

    expect(received[0].origin).toBe("sync")
  })

  it("subscriber sees current state at time of emit", () => {
    const [map, handle] = createReactiveMap<string, number, TestChange>()
    let snapshotSize = -1
    map.subscribe(() => {
      snapshotSize = map.size
    })

    handle.set("a", 1)
    handle.set("b", 2)
    handle.emit({
      changes: [
        { type: "set", key: "a" },
        { type: "set", key: "b" },
      ],
    })

    expect(snapshotSize).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// hasChangefeed type guard
// ---------------------------------------------------------------------------

describe("hasChangefeed", () => {
  it("returns true for a ReactiveMap", () => {
    const [map] = createReactiveMap<string, number, TestChange>()
    expect(hasChangefeed(map)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Backward compatibility — assignable to CallableChangefeed
// ---------------------------------------------------------------------------

describe("backward compatibility", () => {
  it("ReactiveMap is assignable to CallableChangefeed", () => {
    const [map] = createReactiveMap<string, number, TestChange>()

    // Type-level test: assign to CallableChangefeed
    const callable: CallableChangefeed<
      ReadonlyMap<string, number>,
      TestChange
    > = map

    // Runtime: callable still works
    expect(callable()).toBeInstanceOf(Map)
    expect(callable.current).toBeInstanceOf(Map)
    expect(typeof callable.subscribe).toBe("function")
  })
})

// ---------------------------------------------------------------------------
// Wholesale rebuild pattern (exchange.peers use case)
// ---------------------------------------------------------------------------

describe("wholesale rebuild pattern", () => {
  it("clear → set × N → emit rebuilds and notifies", () => {
    const [map, handle] = createReactiveMap<string, number, TestChange>()

    // Initial state
    handle.set("a", 1)
    handle.set("b", 2)
    handle.emit({
      changes: [
        { type: "set", key: "a" },
        { type: "set", key: "b" },
      ],
    })

    const received: Changeset<TestChange>[] = []
    map.subscribe(cs => received.push(cs))

    // Wholesale rebuild
    handle.clear()
    handle.set("c", 3)
    handle.set("d", 4)
    handle.emit({
      changes: [
        { type: "delete", key: "a" },
        { type: "delete", key: "b" },
        { type: "set", key: "c" },
        { type: "set", key: "d" },
      ],
    })

    // One changeset with all changes
    expect(received).toHaveLength(1)
    expect(received[0].changes).toHaveLength(4)

    // Map reflects new state
    expect(map.size).toBe(2)
    expect(map.has("a")).toBe(false)
    expect(map.has("b")).toBe(false)
    expect(map.get("c")).toBe(3)
    expect(map.get("d")).toBe(4)
  })
})

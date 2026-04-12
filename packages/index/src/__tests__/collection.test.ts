import { describe, expect, it } from "vitest"
import { hasChangefeed } from "@kyneta/changefeed"
import { Source } from "../source.js"
import { Collection } from "../collection.js"
import type { CollectionChange } from "../collection.js"

describe("Collection.from", () => {
  it("bootstraps from source snapshot", () => {
    const [source, handle] = Source.create<number>()
    handle.set("a", 1)
    handle.set("b", 2)

    const coll = Collection.from(source)

    expect(coll.size).toBe(2)
    expect(coll.get("a")).toBe(1)
    expect(coll.get("b")).toBe(2)
  })

  it("has(), keys(), size work", () => {
    const [source, handle] = Source.create<string>()
    handle.set("x", "hello")
    handle.set("y", "world")

    const coll = Collection.from(source)

    expect(coll.has("x")).toBe(true)
    expect(coll.has("z")).toBe(false)
    expect([...coll.keys()].sort()).toEqual(["x", "y"])
    expect(coll.size).toBe(2)
  })

  it("iteration yields [key, value] pairs", () => {
    const [source, handle] = Source.create<number>()
    handle.set("a", 10)
    handle.set("b", 20)

    const coll = Collection.from(source)

    const entries = [...coll].sort(([a], [b]) => a.localeCompare(b))
    expect(entries).toEqual([
      ["a", 10],
      ["b", 20],
    ])
  })

  it("hasChangefeed(collection) returns true", () => {
    const [source] = Source.create<number>()
    const coll = Collection.from(source)
    expect(hasChangefeed(coll)).toBe(true)
  })

  it(".current returns the map", () => {
    const [source, handle] = Source.create<number>()
    handle.set("a", 1)

    const coll = Collection.from(source)
    const current = coll.current

    expect(current).toBeInstanceOf(Map)
    expect(current.get("a")).toBe(1)
  })

  it("adding an entry via source emits 'added' via changefeed", () => {
    const [source, handle] = Source.create<number>()
    const coll = Collection.from(source)

    const changes: CollectionChange[] = []
    coll.subscribe(cs => {
      changes.push(...cs.changes)
    })

    handle.set("a", 42)

    expect(changes).toEqual([{ type: "added", key: "a" }])
    expect(coll.get("a")).toBe(42)
    expect(coll.size).toBe(1)
  })

  it("removing an entry via source emits 'removed' via changefeed", () => {
    const [source, handle] = Source.create<number>()
    handle.set("a", 42)

    const coll = Collection.from(source)

    const changes: CollectionChange[] = []
    coll.subscribe(cs => {
      changes.push(...cs.changes)
    })

    handle.delete("a")

    expect(changes).toEqual([{ type: "removed", key: "a" }])
    expect(coll.has("a")).toBe(false)
    expect(coll.size).toBe(0)
  })

  it("replacing a value (set on existing key) does not emit", () => {
    const [source, handle] = Source.create<number>()
    handle.set("a", 1)

    const coll = Collection.from(source)

    const changes: CollectionChange[] = []
    coll.subscribe(cs => {
      changes.push(...cs.changes)
    })

    handle.set("a", 99) // silent replace — Source.create doesn't emit for existing key

    expect(changes).toHaveLength(0)
    expect(coll.get("a")).toBe(1) // unchanged because Source.create didn't emit
  })

  it("dispose propagates to source", () => {
    const [source, handle] = Source.create<number>()
    const coll = Collection.from(source)

    const changes: CollectionChange[] = []
    coll.subscribe(cs => {
      changes.push(...cs.changes)
    })

    coll.dispose()

    handle.set("a", 1)
    expect(changes).toHaveLength(0)
  })

  it("multiple subscribers all receive changes", () => {
    const [source, handle] = Source.create<number>()
    const coll = Collection.from(source)

    const changes1: CollectionChange[] = []
    const changes2: CollectionChange[] = []
    coll.subscribe(cs => { changes1.push(...cs.changes) })
    coll.subscribe(cs => { changes2.push(...cs.changes) })

    handle.set("x", 1)

    expect(changes1).toEqual([{ type: "added", key: "x" }])
    expect(changes2).toEqual([{ type: "added", key: "x" }])
  })

  it("unsubscribe stops delivery to that subscriber", () => {
    const [source, handle] = Source.create<number>()
    const coll = Collection.from(source)

    const changes: CollectionChange[] = []
    const unsub = coll.subscribe(cs => {
      changes.push(...cs.changes)
    })

    handle.set("a", 1)
    expect(changes).toHaveLength(1)

    unsub()

    handle.set("b", 2)
    expect(changes).toHaveLength(1)
  })
})
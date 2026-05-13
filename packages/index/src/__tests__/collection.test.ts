import { hasChangefeed } from "@kyneta/changefeed"
import { describe, expect, it } from "vitest"
import type { CollectionChange } from "../collection.js"
import { Collection, integrate } from "../collection.js"
import { Source } from "../source.js"

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
    coll.subscribe(cs => {
      changes1.push(...cs.changes)
    })
    coll.subscribe(cs => {
      changes2.push(...cs.changes)
    })

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

// ---------------------------------------------------------------------------
// Equivariance: union overlapping keys + non-injective map
// ---------------------------------------------------------------------------

describe("Collection.from — union with overlapping keys", () => {
  it("(bootstrap path) keeps entry when one of two upstreams removes a shared key", () => {
    const [a, hA] = Source.create<number>()
    const [b, hB] = Source.create<number>()
    hA.set("shared", 1)
    hB.set("shared", 2)

    // Mutations happen BEFORE Collection.from — exercises snapshot bootstrap
    const coll = Collection.from(Source.union(a, b))

    expect(coll.has("shared")).toBe(true)

    hB.delete("shared")

    // shared should still be present because A still has it (refcount = 1)
    expect(coll.has("shared")).toBe(true)
    expect(coll.size).toBe(1)

    hA.delete("shared")

    // Now both removed → refcount = 0 → entry gone
    expect(coll.has("shared")).toBe(false)
    expect(coll.size).toBe(0)
  })

  it("(delta path) keeps entry when one of two upstreams removes a shared key", () => {
    const [a, hA] = Source.create<number>()
    const [b, hB] = Source.create<number>()

    // Collection.from BEFORE mutations — exercises live-delta path
    const coll = Collection.from(Source.union(a, b))

    hA.set("shared", 1)
    hB.set("shared", 2)

    expect(coll.has("shared")).toBe(true)

    hB.delete("shared")
    expect(coll.has("shared")).toBe(true)

    hA.delete("shared")
    expect(coll.has("shared")).toBe(false)
  })

  it("entry remains present throughout intermediate weight states", () => {
    const [a, hA] = Source.create<number>()
    const [b, hB] = Source.create<number>()

    const coll = Collection.from(Source.union(a, b))
    const presenceTrail: boolean[] = []
    const changes: CollectionChange[] = []
    coll.subscribe(cs => changes.push(...cs.changes))

    hA.set("k", 1)
    presenceTrail.push(coll.has("k")) // weight 1 → present
    hB.set("k", 2)
    presenceTrail.push(coll.has("k")) // weight 2 → present
    hB.delete("k")
    presenceTrail.push(coll.has("k")) // weight 1 → still present (this is the discriminator)
    hA.delete("k")
    presenceTrail.push(coll.has("k")) // weight 0 → gone

    expect(presenceTrail).toEqual([true, true, true, false])
    expect(changes).toEqual([
      { type: "added", key: "k" },
      { type: "removed", key: "k" },
    ])
  })
})

describe("integrate (functional core)", () => {
  it("transitions only at clampedWeight boundaries (0↔positive)", () => {
    // 0 → +1 emits added; intermediate +1↔+2 silent; +1 → 0 emits removed.
    let weights = new Map<string, number>()

    let step = integrate(weights, {
      delta: new Map([["a", 1]]),
      values: new Map([["a", "v"]]),
    })
    expect(step.transitions).toEqual([{ type: "added", key: "a" }])
    expect(step.valueUpdates.get("a")).toBe("v")
    weights = new Map(step.weights)

    step = integrate(weights, {
      delta: new Map([["a", 1]]),
      values: new Map([["a", "v2"]]),
    })
    expect(step.transitions).toEqual([])
    expect(step.valueUpdates.get("a")).toBe("v2") // refresh on positive delta
    weights = new Map(step.weights)

    step = integrate(weights, {
      delta: new Map([["a", -1]]),
      values: new Map(),
    })
    expect(step.transitions).toEqual([])
    weights = new Map(step.weights)

    step = integrate(weights, {
      delta: new Map([["a", -1]]),
      values: new Map(),
    })
    expect(step.transitions).toEqual([{ type: "removed", key: "a" }])
    expect(step.valueDeletes).toEqual(["a"])
    expect(step.weights.has("a")).toBe(false)
  })

  it("paired remove+add in one delta orders removed before added", () => {
    const step = integrate(new Map([["a", 1]]), {
      delta: new Map([
        ["a", -1],
        ["b", 1],
      ]),
      values: new Map([["b", "vb"]]),
    })
    expect(step.transitions).toEqual([
      { type: "removed", key: "a" },
      { type: "added", key: "b" },
    ])
  })

  it("empty delta is a no-op", () => {
    const step = integrate(new Map([["a", 1]]), {
      delta: new Map(),
      values: new Map(),
    })
    expect(step.transitions).toEqual([])
    expect([...step.weights]).toEqual([["a", 1]])
  })
})

describe("Collection.from — non-injective Source.map", () => {
  it("(bootstrap path) keeps target key while another source key still maps to it", () => {
    const [source, handle] = Source.create<number>()
    handle.set("k1", 10)
    handle.set("k2", 20)

    const merged = Source.map(source, () => "merged")
    const coll = Collection.from(merged)

    expect(coll.has("merged")).toBe(true)

    handle.delete("k1")
    expect(coll.has("merged")).toBe(true) // k2 still maps here

    handle.delete("k2")
    expect(coll.has("merged")).toBe(false)
  })

  it("(delta path) keeps target key while another source key still maps to it", () => {
    const [source, handle] = Source.create<number>()
    const merged = Source.map(source, () => "merged")
    const coll = Collection.from(merged)

    handle.set("k1", 10)
    handle.set("k2", 20)

    expect(coll.has("merged")).toBe(true)

    handle.delete("k1")
    expect(coll.has("merged")).toBe(true)

    handle.delete("k2")
    expect(coll.has("merged")).toBe(false)
  })
})

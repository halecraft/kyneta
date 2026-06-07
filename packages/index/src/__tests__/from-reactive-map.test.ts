// Source.fromReactiveMap — the changefeed-ReactiveMap → ℤ-set-Source adapter.
// FC (`diffValueMaps`) tested pure; the constructor tested through Collection /
// Index over a live `createReactiveMap`. Context: jj:qwzkmzvy.

import { createReactiveMap, type ReactiveMapHandle } from "@kyneta/changefeed"
import { describe, expect, it } from "vitest"
import { Collection, type CollectionChange } from "../collection.js"
import { Index } from "../index.js"
import type { KeySpec } from "../key-spec.js"
import { diffValueMaps, Source } from "../source.js"

type MapChange = { type: "set" | "delete"; key: string }

function setEmit<V>(
  handle: ReactiveMapHandle<string, V, MapChange>,
  key: string,
  value: V,
): void {
  handle.set(key, value)
  handle.emit({ changes: [{ type: "set", key }] })
}

function delEmit<V>(
  handle: ReactiveMapHandle<string, V, MapChange>,
  key: string,
): void {
  handle.delete(key)
  handle.emit({ changes: [{ type: "delete", key }] })
}

// ---------------------------------------------------------------------------
// Functional core — diffValueMaps (pure, no live map)
// ---------------------------------------------------------------------------

describe("diffValueMaps (functional core)", () => {
  const eq = Object.is
  const m = (entries: Array<[string, number]>): Map<string, number> =>
    new Map(entries)

  it("add-only → [insert]", () => {
    const events = diffValueMaps(m([]), m([["a", 1]]), eq)
    expect(events).toHaveLength(1)
    expect([...events[0]!.delta]).toEqual([["a", 1]])
    expect(events[0]!.values.get("a")).toBe(1)
  })

  it("remove-only → [retract]", () => {
    const events = diffValueMaps(m([["a", 1]]), m([]), eq)
    expect(events).toHaveLength(1)
    expect([...events[0]!.delta]).toEqual([["a", -1]])
    expect(events[0]!.values.size).toBe(0)
  })

  it("value change (eq false) → [retract, insert], key at -1 then +1(newV)", () => {
    const events = diffValueMaps(m([["a", 1]]), m([["a", 2]]), eq)
    expect(events).toHaveLength(2)
    expect([...events[0]!.delta]).toEqual([["a", -1]]) // retract precedes
    expect(events[0]!.values.size).toBe(0)
    expect([...events[1]!.delta]).toEqual([["a", 1]])
    expect(events[1]!.values.get("a")).toBe(2) // new value
  })

  it("value unchanged (eq true) → []", () => {
    expect(diffValueMaps(m([["a", 1]]), m([["a", 1]]), eq)).toEqual([])
  })

  it("mixed batch → [retract{remove,update}, insert{add,update}]", () => {
    const known = m([
      ["keep", 0],
      ["drop", 1],
      ["upd", 2],
    ])
    const current = m([
      ["keep", 0],
      ["upd", 99],
      ["add", 3],
    ])
    const events = diffValueMaps(known, current, eq)
    expect(events).toHaveLength(2)
    const [retract, insert] = events
    // retract: drop (removed) + upd (changed); never `keep` (unchanged)
    expect(new Map(retract!.delta)).toEqual(
      new Map([
        ["drop", -1],
        ["upd", -1],
      ]),
    )
    expect(retract!.values.size).toBe(0)
    // insert: add (new) + upd (new value); never `keep`
    expect(new Map(insert!.delta)).toEqual(
      new Map([
        ["upd", 1],
        ["add", 1],
      ]),
    )
    expect(insert!.values.get("add")).toBe(3)
    expect(insert!.values.get("upd")).toBe(99)
    expect(insert!.values.has("keep")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Integration — Source.fromReactiveMap → Collection
// ---------------------------------------------------------------------------

describe("Source.fromReactiveMap → Collection", () => {
  it("bootstraps from a pre-populated map", () => {
    const [map, handle] = createReactiveMap<string, number, MapChange>()
    handle.set("a", 1) // populate the internal map (no emit)
    const coll = Collection.from(Source.fromReactiveMap(map))
    expect(coll.get("a")).toBe(1)
    expect(coll.size).toBe(1)
  })

  it("set new key → added; delete → removed", () => {
    const [map, handle] = createReactiveMap<string, number, MapChange>()
    const coll = Collection.from(Source.fromReactiveMap(map))
    const changes: CollectionChange[] = []
    coll.subscribe(cs => changes.push(...cs.changes))

    setEmit(handle, "a", 1)
    expect(changes).toEqual([{ type: "added", key: "a" }])
    expect(coll.get("a")).toBe(1)

    changes.length = 0
    delEmit(handle, "a")
    expect(changes).toEqual([{ type: "removed", key: "a" }])
    expect(coll.has("a")).toBe(false)
  })

  it("in-place value update propagates as removed+added and refreshes value", () => {
    const [map, handle] = createReactiveMap<string, number, MapChange>()
    setEmit(handle, "a", 1)
    const coll = Collection.from(Source.fromReactiveMap(map))
    const changes: CollectionChange[] = []
    coll.subscribe(cs => changes.push(...cs.changes))

    setEmit(handle, "a", 2) // the gap Source.create leaves — now propagates
    expect(changes).toEqual([
      { type: "removed", key: "a" },
      { type: "added", key: "a" },
    ])
    expect(coll.get("a")).toBe(2) // refreshed
  })

  it("equal re-set with a structural `equals` → no downstream emission", () => {
    type Box = { n: number }
    const equals = (a: Box, b: Box): boolean => a.n === b.n
    const [map, handle] = createReactiveMap<string, Box, MapChange>()
    setEmit(handle, "a", { n: 1 })
    const coll = Collection.from(Source.fromReactiveMap(map, { equals }))
    const changes: CollectionChange[] = []
    coll.subscribe(cs => changes.push(...cs.changes))

    setEmit(handle, "a", { n: 1 }) // new object, equal by value → no-op
    expect(changes).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Integration — Source.fromReactiveMap → Index.by
// ---------------------------------------------------------------------------

describe("Source.fromReactiveMap → Index.by", () => {
  type Entry = { id: string; group: string; v: number }
  const byGroup: KeySpec<Entry> = { groupKeys: (_k, e) => [e.group] }

  it("regroups on a value-derived key change; stable key keeps membership + refreshes value", () => {
    const [map, handle] = createReactiveMap<string, Entry, MapChange>()
    const coll = Collection.from(Source.fromReactiveMap(map))
    const index = Index.by(coll, byGroup)

    setEmit(handle, "x", { id: "x", group: "A", v: 1 })
    expect([...(index.current.get("A") ?? [])]).toEqual(["x"])

    // value change that CHANGES the group key → x moves A → B
    setEmit(handle, "x", { id: "x", group: "B", v: 1 })
    expect(index.current.get("A")?.size ?? 0).toBe(0)
    expect([...(index.current.get("B") ?? [])]).toEqual(["x"])

    // value change with a STABLE group key → stays in B, value refreshed
    setEmit(handle, "x", { id: "x", group: "B", v: 2 })
    expect([...(index.current.get("B") ?? [])]).toEqual(["x"])
    expect(coll.get("x")?.v).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Ownership — dispose
// ---------------------------------------------------------------------------

describe("Source.fromReactiveMap — dispose", () => {
  it("unsubscribes but does not dispose the underlying map", () => {
    const [map, handle] = createReactiveMap<string, number, MapChange>()
    const coll = Collection.from(Source.fromReactiveMap(map))
    const changes: CollectionChange[] = []
    coll.subscribe(cs => changes.push(...cs.changes))

    coll.dispose() // Collection.dispose → source.dispose → map-unsubscribe

    setEmit(handle, "a", 1)
    expect(changes).toHaveLength(0) // no propagation after dispose
    // the map is intact and still usable — the adapter never owned it
    expect(map.get("a")).toBe(1)
    expect(map.size).toBe(1)
  })
})

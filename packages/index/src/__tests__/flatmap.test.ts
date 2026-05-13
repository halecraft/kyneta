import { describe, expect, it } from "vitest"
import { Collection } from "../collection.js"
import type { SourceEvent } from "../source.js"
import { Source } from "../source.js"
import { toAdded, toRemoved } from "../zset.js"

describe("Source.flatMap", () => {
  // -------------------------------------------------------------------------
  // 1. Bootstrap: outer has 2 entries with inner sources pre-populated
  // -------------------------------------------------------------------------

  it("bootstrap — flat snapshot has all inner entries with namespaced keys", () => {
    const [outer, outerHandle] = Source.create<number>()
    outerHandle.set("a", 1)
    outerHandle.set("b", 2)

    const innerHandles = new Map<
      string,
      {
        handle: ReturnType<typeof Source.create<string>>[1]
        source: ReturnType<typeof Source.create<string>>[0]
      }
    >()

    const flat = Source.flatMap(outer, (key, _value) => {
      const [innerSource, innerHandle] = Source.create<string>()
      innerHandles.set(key, { handle: innerHandle, source: innerSource })
      return innerSource
    })

    // Populate inner sources after flatMap construction
    // (flatMap subscribes to inners, so mutations propagate)
    innerHandles.get("a")?.handle.set("x", "a-x")
    innerHandles.get("a")?.handle.set("y", "a-y")
    innerHandles.get("b")?.handle.set("x", "b-x")

    const snap = flat.snapshot()

    expect(snap.size).toBe(3)
    expect(snap.get("a\0x")).toBe("a-x")
    expect(snap.get("a\0y")).toBe("a-y")
    expect(snap.get("b\0x")).toBe("b-x")
  })

  // -------------------------------------------------------------------------
  // 2. Outer arrival: new outer entry after construction
  // -------------------------------------------------------------------------

  it("outer arrival — inner source created, entries appear as +1 deltas", () => {
    const [outer, outerHandle] = Source.create<number>()

    const innerHandles = new Map<
      string,
      {
        handle: ReturnType<typeof Source.create<string>>[1]
        source: ReturnType<typeof Source.create<string>>[0]
      }
    >()

    const flat = Source.flatMap(outer, (key, _value) => {
      const [innerSource, innerHandle] = Source.create<string>()
      // Pre-populate the inner source before returning it so flatMap
      // picks up entries from the snapshot during addInner
      innerHandle.set("p", `${key}-p`)
      innerHandle.set("q", `${key}-q`)
      innerHandles.set(key, { handle: innerHandle, source: innerSource })
      return innerSource
    })

    const events: SourceEvent<string>[] = []
    flat.subscribe(e => events.push(e))

    // Adding an outer entry triggers inner source creation
    outerHandle.set("c", 3)

    expect(innerHandles.has("c")).toBe(true)

    // The snapshot emission from addInner should have produced additions
    const allAdded = events.flatMap(e => toAdded(e.delta))
    expect(allAdded).toContain("c\0p")
    expect(allAdded).toContain("c\0q")

    // Values should be present
    const allValues = new Map(events.flatMap(e => [...e.values]))
    expect(allValues.get("c\0p")).toBe("c-p")
    expect(allValues.get("c\0q")).toBe("c-q")

    // Snapshot should also reflect the new entries
    const snap = flat.snapshot()
    expect(snap.get("c\0p")).toBe("c-p")
    expect(snap.get("c\0q")).toBe("c-q")
  })

  // -------------------------------------------------------------------------
  // 3. Outer departure: outer entry removed → inner retracted + disposed
  // -------------------------------------------------------------------------

  it("outer departure — all inner entries retracted, inner source disposed", () => {
    const [outer, outerHandle] = Source.create<number>()
    outerHandle.set("a", 1)

    const innerHandles = new Map<
      string,
      {
        handle: ReturnType<typeof Source.create<string>>[1]
        source: ReturnType<typeof Source.create<string>>[0]
      }
    >()

    const flat = Source.flatMap(outer, (key, _value) => {
      const [innerSource, innerHandle] = Source.create<string>()
      innerHandles.set(key, { handle: innerHandle, source: innerSource })
      return innerSource
    })

    // Populate inner source
    innerHandles.get("a")?.handle.set("x", "a-x")
    innerHandles.get("a")?.handle.set("y", "a-y")

    const events: SourceEvent<string>[] = []
    flat.subscribe(e => events.push(e))

    // Remove the outer entry
    outerHandle.delete("a")

    // Should have retraction deltas for all inner entries
    const allRemoved = events.flatMap(e => toRemoved(e.delta))
    expect(allRemoved).toContain("a\0x")
    expect(allRemoved).toContain("a\0y")

    // Snapshot should be empty now
    expect(flat.snapshot().size).toBe(0)

    // Inner source was disposed — further mutations should not propagate
    const postEvents: SourceEvent<string>[] = []
    flat.subscribe(e => postEvents.push(e))

    innerHandles.get("a")?.handle.set("z", "a-z")
    expect(postEvents).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // 4. Inner delta: item added to inner source → appears in flat stream
  // -------------------------------------------------------------------------

  it("inner delta — item added to inner source appears with namespaced key", () => {
    const [outer, outerHandle] = Source.create<number>()
    outerHandle.set("a", 1)

    const innerHandles = new Map<
      string,
      {
        handle: ReturnType<typeof Source.create<string>>[1]
        source: ReturnType<typeof Source.create<string>>[0]
      }
    >()

    const flat = Source.flatMap(outer, (key, _value) => {
      const [innerSource, innerHandle] = Source.create<string>()
      innerHandles.set(key, { handle: innerHandle, source: innerSource })
      return innerSource
    })

    const events: SourceEvent<string>[] = []
    flat.subscribe(e => events.push(e))

    // Add an item to the inner source after construction
    innerHandles.get("a")?.handle.set("m", "val-m")

    expect(events).toHaveLength(1)
    expect(events[0].delta.get("a\0m")).toBe(1)
    expect(events[0].values.get("a\0m")).toBe("val-m")

    expect(flat.snapshot().get("a\0m")).toBe("val-m")
  })

  // -------------------------------------------------------------------------
  // 5. Inner removal: item removed from inner source → retracted
  // -------------------------------------------------------------------------

  it("inner removal — item removed from inner source is retracted from flat stream", () => {
    const [outer, outerHandle] = Source.create<number>()
    outerHandle.set("a", 1)

    const innerHandles = new Map<
      string,
      {
        handle: ReturnType<typeof Source.create<string>>[1]
        source: ReturnType<typeof Source.create<string>>[0]
      }
    >()

    const flat = Source.flatMap(outer, (key, _value) => {
      const [innerSource, innerHandle] = Source.create<string>()
      innerHandles.set(key, { handle: innerHandle, source: innerSource })
      return innerSource
    })

    // Add then remove
    innerHandles.get("a")?.handle.set("m", "val-m")

    const events: SourceEvent<string>[] = []
    flat.subscribe(e => events.push(e))

    innerHandles.get("a")?.handle.delete("m")

    expect(events).toHaveLength(1)
    expect(events[0].delta.get("a\0m")).toBe(-1)

    expect(flat.snapshot().has("a\0m")).toBe(false)
  })

  // -------------------------------------------------------------------------
  // 6. Key namespacing: two outer entries with same inner key → distinct flat keys
  // -------------------------------------------------------------------------

  it("key namespacing — same inner key under different outers produces distinct flat keys", () => {
    const [outer, outerHandle] = Source.create<number>()
    outerHandle.set("a", 1)
    outerHandle.set("b", 2)

    const innerHandles = new Map<
      string,
      {
        handle: ReturnType<typeof Source.create<string>>[1]
        source: ReturnType<typeof Source.create<string>>[0]
      }
    >()

    const flat = Source.flatMap(outer, (key, _value) => {
      const [innerSource, innerHandle] = Source.create<string>()
      innerHandles.set(key, { handle: innerHandle, source: innerSource })
      return innerSource
    })

    // Both inner sources use the same key "shared"
    innerHandles.get("a")?.handle.set("shared", "from-a")
    innerHandles.get("b")?.handle.set("shared", "from-b")

    const snap = flat.snapshot()

    expect(snap.size).toBe(2)
    expect(snap.get("a\0shared")).toBe("from-a")
    expect(snap.get("b\0shared")).toBe("from-b")
  })

  // -------------------------------------------------------------------------
  // 7. Custom key function
  // -------------------------------------------------------------------------

  it("custom key function overrides default namespacing", () => {
    const [outer, outerHandle] = Source.create<number>()
    outerHandle.set("a", 1)

    const innerHandles = new Map<
      string,
      {
        handle: ReturnType<typeof Source.create<string>>[1]
        source: ReturnType<typeof Source.create<string>>[0]
      }
    >()

    const flat = Source.flatMap(
      outer,
      (key, _value) => {
        const [innerSource, innerHandle] = Source.create<string>()
        innerHandles.set(key, { handle: innerHandle, source: innerSource })
        return innerSource
      },
      { key: (outerKey, innerKey) => `${outerKey}:${innerKey}` },
    )

    const events: SourceEvent<string>[] = []
    flat.subscribe(e => events.push(e))

    innerHandles.get("a")?.handle.set("x", "val")

    expect(events).toHaveLength(1)
    expect(events[0].delta.get("a:x")).toBe(1)
    expect(events[0].values.get("a:x")).toBe("val")

    const snap = flat.snapshot()
    expect(snap.get("a:x")).toBe("val")

    // Verify the default NUL-separated key is NOT used
    expect(snap.has("a\0x")).toBe(false)
  })

  // -------------------------------------------------------------------------
  // 8. Dispose: tears down outer + all inner subscriptions
  // -------------------------------------------------------------------------

  it("dispose tears down outer and all inner subscriptions", () => {
    const [outer, outerHandle] = Source.create<number>()
    outerHandle.set("a", 1)
    outerHandle.set("b", 2)

    const innerHandles = new Map<
      string,
      {
        handle: ReturnType<typeof Source.create<string>>[1]
        source: ReturnType<typeof Source.create<string>>[0]
      }
    >()

    const flat = Source.flatMap(outer, (key, _value) => {
      const [innerSource, innerHandle] = Source.create<string>()
      innerHandles.set(key, { handle: innerHandle, source: innerSource })
      return innerSource
    })

    innerHandles.get("a")?.handle.set("x", "a-x")
    innerHandles.get("b")?.handle.set("y", "b-y")

    const events: SourceEvent<string>[] = []
    flat.subscribe(e => events.push(e))

    flat.dispose()

    // No further events from inner mutations
    innerHandles.get("a")?.handle.set("z", "a-z")
    innerHandles.get("b")?.handle.set("w", "b-w")
    expect(events).toHaveLength(0)

    // No further events from outer mutations
    outerHandle.set("c", 3)
    expect(events).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // 9. Composition: Source.filter(Source.flatMap(...), pred) works
  // -------------------------------------------------------------------------

  it("composition — Source.filter on flat stream works correctly", () => {
    const [outer, outerHandle] = Source.create<number>()
    outerHandle.set("a", 1)

    const innerHandles = new Map<
      string,
      {
        handle: ReturnType<typeof Source.create<string>>[1]
        source: ReturnType<typeof Source.create<string>>[0]
      }
    >()

    const flat = Source.flatMap(outer, (key, _value) => {
      const [innerSource, innerHandle] = Source.create<string>()
      innerHandles.set(key, { handle: innerHandle, source: innerSource })
      return innerSource
    })

    // Filter: only allow values starting with "keep"
    const filtered = Source.filter(flat, (_key, value) =>
      value.startsWith("keep"),
    )

    innerHandles.get("a")?.handle.set("x", "keep-this")
    innerHandles.get("a")?.handle.set("y", "drop-this")
    innerHandles.get("a")?.handle.set("z", "keep-also")

    // Snapshot should only have the "keep" entries
    const snap = filtered.snapshot()
    expect(snap.size).toBe(2)
    expect(snap.get("a\0x")).toBe("keep-this")
    expect(snap.get("a\0z")).toBe("keep-also")
    expect(snap.has("a\0y")).toBe(false)

    // Events should also be filtered
    const events: SourceEvent<string>[] = []
    filtered.subscribe(e => events.push(e))

    innerHandles.get("a")?.handle.set("w", "drop-nope")
    expect(events).toHaveLength(0)

    innerHandles.get("a")?.handle.set("v", "keep-yes")
    expect(events).toHaveLength(1)
    expect(events[0].delta.get("a\0v")).toBe(1)
    expect(events[0].values.get("a\0v")).toBe("keep-yes")
  })

  it("custom keyFn collisions are refcounted through Collection", () => {
    // A keyFn that ignores the outer entirely produces colliding flat keys
    // for the same inner key across different outers — the integrator must
    // preserve multiplicity so partial retraction does not destroy state.
    const [outer, outerHandle] = Source.create<number>()
    const innerHandles = new Map<
      string,
      ReturnType<typeof Source.create<string>>[1]
    >()

    const flat = Source.flatMap(
      outer,
      key => {
        const [innerSource, innerHandle] = Source.create<string>()
        innerHandles.set(key, innerHandle)
        return innerSource
      },
      { key: (_outerKey, innerKey) => innerKey }, // collision: outer-agnostic
    )
    const coll = Collection.from(flat)

    outerHandle.set("p1", 1)
    outerHandle.set("p2", 2)
    innerHandles.get("p1")!.set("shared", "from-p1")
    innerHandles.get("p2")!.set("shared", "from-p2")

    expect(coll.has("shared")).toBe(true)

    // Remove p1's inner contribution → p2 still contributes → still present
    innerHandles.get("p1")!.delete("shared")
    expect(coll.has("shared")).toBe(true)

    innerHandles.get("p2")!.delete("shared")
    expect(coll.has("shared")).toBe(false)
  })
})

import { change, createDoc, json, Schema } from "@kyneta/schema"
import { describe, expect, it } from "vitest"
import { Collection } from "../collection.js"
import type { SourceEvent } from "../source.js"
import { Source } from "../source.js"
import { toAdded, toRemoved } from "../zset.js"

// ---------------------------------------------------------------------------
// Source.create — manual source
// ---------------------------------------------------------------------------

describe("Source.create", () => {
  it("returns a [source, handle] tuple", () => {
    const [source, handle] = Source.create<number>()
    expect(source).toBeDefined()
    expect(handle).toBeDefined()
    expect(typeof source.subscribe).toBe("function")
    expect(typeof source.snapshot).toBe("function")
    expect(typeof source.dispose).toBe("function")
    expect(typeof handle.set).toBe("function")
    expect(typeof handle.delete).toBe("function")
  })

  it("snapshot is initially empty", () => {
    const [source] = Source.create<number>()
    expect(source.snapshot().size).toBe(0)
  })

  it("set(key, value) on new key → snapshot includes it, emits delta with +1", () => {
    const [source, handle] = Source.create<number>()
    const events: SourceEvent<number>[] = []
    source.subscribe(e => events.push(e))

    handle.set("a", 42)

    expect(source.snapshot().get("a")).toBe(42)
    expect(events).toHaveLength(1)
    expect(events[0].delta.get("a")).toBe(1)
    expect(events[0].values.get("a")).toBe(42)
  })

  it("set(key, value) on existing key → silent replace, no delta", () => {
    const [source, handle] = Source.create<number>()
    handle.set("a", 42)

    const events: SourceEvent<number>[] = []
    source.subscribe(e => events.push(e))

    handle.set("a", 99)

    expect(source.snapshot().get("a")).toBe(99)
    expect(events).toHaveLength(0) // no emission
  })

  it("delete(key) on existing key → emits delta with -1", () => {
    const [source, handle] = Source.create<number>()
    handle.set("a", 42)

    const events: SourceEvent<number>[] = []
    source.subscribe(e => events.push(e))

    handle.delete("a")

    expect(source.snapshot().has("a")).toBe(false)
    expect(events).toHaveLength(1)
    expect(events[0].delta.get("a")).toBe(-1)
    expect(events[0].values.size).toBe(0) // no values for removal
  })

  it("delete(key) on missing key → no-op, no emission", () => {
    const [source, handle] = Source.create<number>()

    const events: SourceEvent<number>[] = []
    source.subscribe(e => events.push(e))

    handle.delete("nonexistent")

    expect(events).toHaveLength(0)
  })

  it("dispose() clears subscribers", () => {
    const [source, handle] = Source.create<number>()

    const events: SourceEvent<number>[] = []
    source.subscribe(e => events.push(e))

    source.dispose()

    handle.set("a", 1)
    expect(events).toHaveLength(0)
  })

  it("unsubscribe stops delivery to that subscriber", () => {
    const [source, handle] = Source.create<number>()

    const events: SourceEvent<number>[] = []
    const unsub = source.subscribe(e => events.push(e))

    handle.set("a", 1)
    expect(events).toHaveLength(1)

    unsub()

    handle.set("b", 2)
    expect(events).toHaveLength(1) // no new events
  })
})

// ---------------------------------------------------------------------------
// Source.fromRecord — record ref adapter
// ---------------------------------------------------------------------------

const recordSchema = Schema.struct({
  members: Schema.record(Schema.struct({ role: Schema.string() })),
})
const RecordDoc = json.bind(recordSchema)

describe("Source.fromRecord", () => {
  it("snapshot reflects initial record state", () => {
    const doc = createDoc(RecordDoc) as any
    change(doc, (d: any) => {
      d.members.set("alice", { role: "admin" })
      d.members.set("bob", { role: "viewer" })
    })

    const source = Source.fromRecord(doc.members)
    const snap = source.snapshot()

    expect(snap.size).toBe(2)
    expect(snap.has("alice")).toBe(true)
    expect(snap.has("bob")).toBe(true)
  })

  it("adding a key emits delta with +1", () => {
    const doc = createDoc(RecordDoc) as any
    change(doc, (d: any) => {
      d.members.set("alice", { role: "admin" })
    })

    const source = Source.fromRecord(doc.members)
    const events: SourceEvent<any>[] = []
    source.subscribe(e => events.push(e))

    change(doc, (d: any) => {
      d.members.set("bob", { role: "viewer" })
    })

    expect(events.length).toBeGreaterThanOrEqual(1)
    const allAdded = events.flatMap(e => toAdded(e.delta))
    expect(allAdded).toContain("bob")
  })

  it("removing a key emits delta with -1", () => {
    const doc = createDoc(RecordDoc) as any
    change(doc, (d: any) => {
      d.members.set("alice", { role: "admin" })
      d.members.set("bob", { role: "viewer" })
    })

    const source = Source.fromRecord(doc.members)
    const events: SourceEvent<any>[] = []
    source.subscribe(e => events.push(e))

    change(doc, (d: any) => {
      d.members.delete("alice")
    })

    expect(events.length).toBeGreaterThanOrEqual(1)
    const allRemoved = events.flatMap(e => toRemoved(e.delta))
    expect(allRemoved).toContain("alice")
  })

  it("mutating a value inside a record member does NOT emit (subscribeNode fix)", () => {
    const doc = createDoc(RecordDoc) as any
    change(doc, (d: any) => {
      d.members.set("alice", { role: "admin" })
    })

    const source = Source.fromRecord(doc.members)
    const events: SourceEvent<any>[] = []
    source.subscribe(e => events.push(e))

    // Mutate the role of an existing member — should NOT fire
    change(doc, (d: any) => {
      d.members.at("alice").role.set("viewer")
    })

    expect(events).toHaveLength(0)
  })

  it("dispose stops subscription", () => {
    const doc = createDoc(RecordDoc) as any
    change(doc, (d: any) => {
      d.members.set("alice", { role: "admin" })
    })

    const source = Source.fromRecord(doc.members)
    const events: SourceEvent<any>[] = []
    source.subscribe(e => events.push(e))

    source.dispose()

    change(doc, (d: any) => {
      d.members.set("bob", { role: "viewer" })
    })

    expect(events).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Source.fromList — list ref adapter
// ---------------------------------------------------------------------------

const itemSchema = Schema.struct({
  id: Schema.string(),
  name: Schema.string(),
})
const listSchema = Schema.struct({
  items: Schema.list(itemSchema),
})
const ListDoc = json.bind(listSchema)

describe("Source.fromList", () => {
  it("snapshot reflects initial list state", () => {
    const doc = createDoc(ListDoc) as any
    change(doc, (d: any) => {
      d.items.push({ id: "a", name: "Alice" })
      d.items.push({ id: "b", name: "Bob" })
    })

    const source = Source.fromList(doc.items, (ref: any) => ref.id)
    const snap = source.snapshot()

    expect(snap.size).toBe(2)
    expect(snap.has("a")).toBe(true)
    expect(snap.has("b")).toBe(true)
  })

  it("pushing an item emits delta with +1", () => {
    const doc = createDoc(ListDoc) as any
    change(doc, (d: any) => {
      d.items.push({ id: "a", name: "Alice" })
    })

    const source = Source.fromList(doc.items, (ref: any) => ref.id)
    const events: SourceEvent<any>[] = []
    source.subscribe(e => events.push(e))

    change(doc, (d: any) => {
      d.items.push({ id: "b", name: "Bob" })
    })

    expect(events.length).toBeGreaterThanOrEqual(1)
    const allAdded = events.flatMap(e => toAdded(e.delta))
    expect(allAdded).toContain("b")
  })

  it("deleting an item emits delta with -1", () => {
    const doc = createDoc(ListDoc) as any
    change(doc, (d: any) => {
      d.items.push({ id: "a", name: "Alice" })
    })

    const source = Source.fromList(doc.items, (ref: any) => ref.id)
    const events: SourceEvent<any>[] = []
    source.subscribe(e => events.push(e))

    change(doc, (d: any) => {
      d.items.delete(0)
    })

    expect(events.length).toBeGreaterThanOrEqual(1)
    const allRemoved = events.flatMap(e => toRemoved(e.delta))
    expect(allRemoved).toContain("a")
  })

  it("mutating the key field re-keys: emits paired -1/+1 delta", () => {
    const doc = createDoc(ListDoc) as any
    change(doc, (d: any) => {
      d.items.push({ id: "old-key", name: "Alice" })
    })

    const source = Source.fromList(doc.items, (ref: any) => ref.id)
    const events: SourceEvent<any>[] = []
    source.subscribe(e => events.push(e))

    // Get the first item ref and change its key
    const itemRef = [...doc.items][0]
    change(doc, (_d: any) => {
      itemRef.id.set("new-key")
    })

    expect(events.length).toBeGreaterThanOrEqual(1)
    const allAdded = events.flatMap(e => toAdded(e.delta))
    const allRemoved = events.flatMap(e => toRemoved(e.delta))
    expect(allRemoved).toContain("old-key")
    expect(allAdded).toContain("new-key")
  })

  it("mutating a non-key field does NOT emit", () => {
    const doc = createDoc(ListDoc) as any
    change(doc, (d: any) => {
      d.items.push({ id: "a", name: "Alice" })
    })

    const source = Source.fromList(doc.items, (ref: any) => ref.id)
    const events: SourceEvent<any>[] = []
    source.subscribe(e => events.push(e))

    // Mutate name, not id — should not emit
    const itemRef = [...doc.items][0]
    change(doc, (_d: any) => {
      itemRef.name.set("Alicia")
    })

    expect(events).toHaveLength(0)
  })

  it("dispose stops all subscriptions", () => {
    const doc = createDoc(ListDoc) as any
    change(doc, (d: any) => {
      d.items.push({ id: "a", name: "Alice" })
    })

    const source = Source.fromList(doc.items, (ref: any) => ref.id)
    const events: SourceEvent<any>[] = []
    source.subscribe(e => events.push(e))

    source.dispose()

    change(doc, (d: any) => {
      d.items.push({ id: "b", name: "Bob" })
    })

    expect(events).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Source.filter — linear composition
// ---------------------------------------------------------------------------

describe("Source.filter", () => {
  it("snapshot returns only entries matching predicate", () => {
    const [source, handle] = Source.create<number>()
    handle.set("a", 1)
    handle.set("b", 2)
    handle.set("c", 3)

    const filtered = Source.filter(source, (_key, value) => value > 1)
    const snap = filtered.snapshot()

    expect(snap.size).toBe(2)
    expect(snap.has("a")).toBe(false)
    expect(snap.has("b")).toBe(true)
    expect(snap.has("c")).toBe(true)
  })

  it("additions that don't match predicate are filtered out", () => {
    const [source, handle] = Source.create<number>()
    const filtered = Source.filter(source, (_key, value) => value > 5)

    const events: SourceEvent<number>[] = []
    filtered.subscribe(e => events.push(e))

    handle.set("a", 1) // doesn't match
    expect(events).toHaveLength(0)

    handle.set("b", 10) // matches
    expect(events).toHaveLength(1)
    expect(events[0].delta.get("b")).toBe(1)
  })

  it("removals are passed through (downstream no-ops if not present)", () => {
    const [source, handle] = Source.create<number>()
    handle.set("a", 10)

    const filtered = Source.filter(source, (_key, value) => value > 5)

    const events: SourceEvent<number>[] = []
    filtered.subscribe(e => events.push(e))

    handle.delete("a")
    expect(events).toHaveLength(1)
    expect(events[0].delta.get("a")).toBe(-1)
  })

  it("dispose propagates to underlying source", () => {
    const [source, handle] = Source.create<number>()
    const filtered = Source.filter(source, () => true)

    const events: SourceEvent<number>[] = []
    filtered.subscribe(e => events.push(e))

    filtered.dispose()

    handle.set("a", 1)
    expect(events).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // Equivariance: filter with watch for mutable-value predicates
  // -------------------------------------------------------------------------

  // Helper: a mutable value plus a tiny notifier. Subscribers fire on `mutate`.
  function makeNotifier<T extends object>(initial: T) {
    const listeners = new Set<() => void>()
    const value = { ...initial }
    return {
      value,
      mutate(patch: Partial<T>): void {
        Object.assign(value, patch)
        for (const cb of listeners) cb()
      },
      watch(_k: string, _v: typeof value, onChange: () => void): () => void {
        listeners.add(onChange)
        return () => listeners.delete(onChange)
      },
    }
  }

  it("(live transition) watch re-evaluates predicate on internal mutation", () => {
    type Entry = { status: string }
    const [source, handle] = Source.create<Entry>()
    const notifierFor = new Map<
      string,
      ReturnType<typeof makeNotifier<Entry>>
    >()

    const filtered = Source.filter(
      source,
      (_k, v) => v.status === "active",
      (k, _v, onChange) => notifierFor.get(k)!.watch(k, _v, onChange),
    )

    const coll = Collection.from(filtered)

    const n = makeNotifier<Entry>({ status: "active" })
    notifierFor.set("e1", n)
    handle.set("e1", n.value)

    expect(coll.has("e1")).toBe(true)

    // Mutate value internally — no source.set call
    n.mutate({ status: "inactive" })

    expect(coll.has("e1")).toBe(false)
  })

  it("(bootstrap watcher install) admitted snapshot entries get watchers", () => {
    type Entry = { status: string }
    const [source, handle] = Source.create<Entry>()
    const notifierFor = new Map<
      string,
      ReturnType<typeof makeNotifier<Entry>>
    >()

    // Seed entry BEFORE constructing filter
    const n = makeNotifier<Entry>({ status: "active" })
    notifierFor.set("e1", n)
    handle.set("e1", n.value)

    const filtered = Source.filter(
      source,
      (_k, v) => v.status === "active",
      (k, _v, onChange) => notifierFor.get(k)!.watch(k, _v, onChange),
    )
    const coll = Collection.from(filtered)

    expect(coll.has("e1")).toBe(true)

    n.mutate({ status: "inactive" })

    // Bootstrap-time watcher must have been installed so this mutation retracts
    expect(coll.has("e1")).toBe(false)
  })

  it("(no watch) silently misses internal mutations — documents precondition", () => {
    type Entry = { status: string }
    const [source, handle] = Source.create<Entry>()
    const filtered = Source.filter(source, (_k, v) => v.status === "active")
    const coll = Collection.from(filtered)

    const val: Entry = { status: "active" }
    handle.set("e1", val)
    expect(coll.has("e1")).toBe(true)

    val.status = "inactive" // mutation invisible to filter without watch

    // Without watch, filter cannot detect the transition
    expect(coll.has("e1")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Source.union — linear composition
// ---------------------------------------------------------------------------

describe("Source.union", () => {
  it("snapshot merges both sources", () => {
    const [a, handleA] = Source.create<number>()
    const [b, handleB] = Source.create<number>()

    handleA.set("x", 1)
    handleB.set("y", 2)

    const merged = Source.union(a, b)
    const snap = merged.snapshot()

    expect(snap.size).toBe(2)
    expect(snap.get("x")).toBe(1)
    expect(snap.get("y")).toBe(2)
  })

  it("events from both sides are forwarded", () => {
    const [a, handleA] = Source.create<number>()
    const [b, handleB] = Source.create<number>()

    const merged = Source.union(a, b)

    const events: SourceEvent<number>[] = []
    merged.subscribe(e => events.push(e))

    handleA.set("x", 1)
    handleB.set("y", 2)

    expect(events).toHaveLength(2)
  })

  it("dispose disposes both sources", () => {
    const [a, handleA] = Source.create<number>()
    const [b, handleB] = Source.create<number>()

    const merged = Source.union(a, b)

    const events: SourceEvent<number>[] = []
    merged.subscribe(e => events.push(e))

    merged.dispose()

    handleA.set("x", 1)
    handleB.set("y", 2)

    expect(events).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Source.map — linear composition (key remapping)
// ---------------------------------------------------------------------------

describe("Source.map", () => {
  it("snapshot returns remapped keys", () => {
    const [source, handle] = Source.create<number>()
    handle.set("a", 1)
    handle.set("b", 2)

    const mapped = Source.map(source, key => `prefix:${key}`)
    const snap = mapped.snapshot()

    expect(snap.size).toBe(2)
    expect(snap.get("prefix:a")).toBe(1)
    expect(snap.get("prefix:b")).toBe(2)
  })

  it("fn returning null filters out the entry", () => {
    const [source, handle] = Source.create<number>()
    handle.set("keep", 1)
    handle.set("drop", 2)

    const mapped = Source.map(source, key => (key === "drop" ? null : key))
    const snap = mapped.snapshot()

    expect(snap.size).toBe(1)
    expect(snap.has("keep")).toBe(true)
    expect(snap.has("drop")).toBe(false)
  })

  it("events have remapped keys", () => {
    const [source, handle] = Source.create<number>()
    const mapped = Source.map(source, key => `ns:${key}`)

    const events: SourceEvent<number>[] = []
    mapped.subscribe(e => events.push(e))

    handle.set("x", 42)

    expect(events).toHaveLength(1)
    expect(events[0].delta.get("ns:x")).toBe(1)
    expect(events[0].values.get("ns:x")).toBe(42)
  })

  it("non-injective map → Collection: weight trajectory 0→1→2→1→0 emits exactly one added + one removed", async () => {
    const { Collection: Coll } = await import("../collection.js")
    const [source, handle] = Source.create<number>()
    const merged = Source.map(source, () => "merged")
    const coll = Coll.from(merged)

    const changes: { type: string; key: string }[] = []
    coll.subscribe(cs => changes.push(...cs.changes))

    handle.set("k1", 10) // weight: 0 → 1, emit added
    handle.set("k2", 20) // weight: 1 → 2, no emission
    handle.delete("k1") // weight: 2 → 1, no emission
    handle.delete("k2") // weight: 1 → 0, emit removed

    expect(changes).toEqual([
      { type: "added", key: "merged" },
      { type: "removed", key: "merged" },
    ])
  })

  it("dispose propagates", () => {
    const [source, handle] = Source.create<number>()
    const mapped = Source.map(source, key => key)

    const events: SourceEvent<number>[] = []
    mapped.subscribe(e => events.push(e))

    mapped.dispose()

    handle.set("x", 1)
    expect(events).toHaveLength(0)
  })
})

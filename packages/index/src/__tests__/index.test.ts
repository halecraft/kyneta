import { hasChangefeed } from "@kyneta/changefeed"
import { change, createDoc, json, Schema } from "@kyneta/schema"
import { describe, expect, it } from "vitest"
import { Collection } from "../collection.js"
import type { IndexChange } from "../index-impl.js"
import { by } from "../index-impl.js"
import { field, keys } from "../key-spec.js"
import { Source } from "../source.js"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const itemSchema = Schema.struct({
  ownerId: Schema.string(),
  status: Schema.string(),
  name: Schema.string(),
})
const ItemDoc = json.bind(itemSchema)

const taggedSchema = Schema.struct({
  tags: Schema.record(Schema.struct({ label: Schema.string() })),
})
const TaggedDoc = json.bind(taggedSchema)

const simpleSchema = Schema.struct({ title: Schema.string() })
const SimpleDoc = json.bind(simpleSchema)

const makeItemRef = (): any => createDoc(ItemDoc)
const makeTaggedRef = (): any => createDoc(TaggedDoc)
const makeSimpleRef = (): any => createDoc(SimpleDoc)

// ---------------------------------------------------------------------------
// Index.by with field (scalar FK)
// ---------------------------------------------------------------------------

describe("Index.by with field (scalar FK)", () => {
  function setup() {
    const [source, handle] = Source.create<any>()

    const ref1 = makeItemRef()
    change(ref1, (d: any) => {
      d.ownerId.set("user:alice")
      d.name.set("Item 1")
      d.status.set("active")
    })
    handle.set("item1", ref1)

    const ref2 = makeItemRef()
    change(ref2, (d: any) => {
      d.ownerId.set("user:alice")
      d.name.set("Item 2")
      d.status.set("active")
    })
    handle.set("item2", ref2)

    const coll = Collection.from(source)
    const index = by(
      coll,
      field((ref: any) => ref.ownerId),
    )

    return { source, handle, ref1, ref2, coll, index }
  }

  it("get(groupKey).size reflects group entry count", () => {
    const { index } = setup()
    const group = index.get("user:alice")
    expect(group.size).toBe(2)
  })

  it("get(groupKey).has(entryKey) tests membership", () => {
    const { index } = setup()
    const group = index.get("user:alice")
    expect(group.has("item1")).toBe(true)
    expect(group.has("item2")).toBe(true)
    expect(group.has("nonexistent")).toBe(false)
  })

  it("get(groupKey).get(entryKey) returns the value", () => {
    const { index, ref1 } = setup()
    const group = index.get("user:alice")
    expect(group.get("item1")).toBe(ref1)
  })

  it("iteration yields [entryKey, value] pairs", () => {
    const { index } = setup()
    const group = index.get("user:alice")
    const entries = [...group].sort(([a], [b]) => a.localeCompare(b))
    expect(entries).toHaveLength(2)
    expect(entries[0][0]).toBe("item1")
    expect(entries[1][0]).toBe("item2")
  })

  it("groupKeysFor returns the group key for an entry", () => {
    const { index } = setup()
    expect(index.groupKeysFor("item1")).toEqual(["user:alice"])
  })

  it("adding an entry updates the group and emits group-added", () => {
    const { handle, index } = setup()

    const group = index.get("user:bob")
    expect(group.size).toBe(0) // empty initially

    const changes: IndexChange[] = []
    group.subscribe(cs => {
      changes.push(...cs.changes)
    })

    const ref3 = makeItemRef()
    change(ref3, (d: any) => {
      d.ownerId.set("user:bob")
      d.name.set("Item 3")
      d.status.set("active")
    })
    handle.set("item3", ref3)

    expect(group.size).toBe(1)
    expect(group.has("item3")).toBe(true)
    expect(changes).toEqual([
      { type: "group-added", groupKey: "user:bob", entryKey: "item3" },
    ])
    expect(index.keys().sort()).toEqual(["user:alice", "user:bob"])
    expect(index.size).toBe(2)
  })

  it("removing an entry updates the group and emits group-removed", () => {
    const { handle, index } = setup()

    const group = index.get("user:alice")
    const changes: IndexChange[] = []
    group.subscribe(cs => {
      changes.push(...cs.changes)
    })

    handle.delete("item1")

    expect(group.size).toBe(1)
    expect(group.has("item1")).toBe(false)
    expect(group.has("item2")).toBe(true)
    expect(changes).toEqual([
      { type: "group-removed", groupKey: "user:alice", entryKey: "item1" },
    ])
  })

  it("mutating the FK moves the entry between groups", () => {
    const { ref1, index } = setup()

    const aliceGroup = index.get("user:alice")
    const bobGroup = index.get("user:bob")

    const aliceChanges: IndexChange[] = []
    const bobChanges: IndexChange[] = []
    aliceGroup.subscribe(cs => {
      aliceChanges.push(...cs.changes)
    })
    bobGroup.subscribe(cs => {
      bobChanges.push(...cs.changes)
    })

    change(ref1, (d: any) => {
      d.ownerId.set("user:bob")
    })

    expect(aliceGroup.size).toBe(1) // only item2
    expect(aliceGroup.has("item1")).toBe(false)
    expect(bobGroup.size).toBe(1) // item1 moved here
    expect(bobGroup.has("item1")).toBe(true)

    expect(aliceChanges).toEqual([
      { type: "group-removed", groupKey: "user:alice", entryKey: "item1" },
    ])
    expect(bobChanges).toEqual([
      { type: "group-added", groupKey: "user:bob", entryKey: "item1" },
    ])
  })

  it("get(groupKey) does NOT emit for changes to other groups", () => {
    const { handle, index } = setup()

    const aliceGroup = index.get("user:alice")
    const changes: IndexChange[] = []
    aliceGroup.subscribe(cs => {
      changes.push(...cs.changes)
    })

    // Add to bob's group — should not affect alice's group
    const ref3 = makeItemRef()
    change(ref3, (d: any) => {
      d.ownerId.set("user:bob")
      d.name.set("Item 3")
      d.status.set("active")
    })
    handle.set("item3", ref3)

    expect(changes).toHaveLength(0)
  })

  it("get on nonexistent group returns empty reactive map", () => {
    const { index } = setup()
    const group = index.get("user:nobody")
    expect(group.size).toBe(0)
    expect([...group]).toEqual([])
  })

  it("hasChangefeed(get(groupKey)) returns true", () => {
    const { index } = setup()
    const group = index.get("user:alice")
    expect(hasChangefeed(group)).toBe(true)
  })

  it("dispose tears down subscriptions", () => {
    const { ref1, index } = setup()

    const changes: IndexChange[] = []
    index.subscribe(cs => {
      changes.push(...cs.changes)
    })

    index.dispose()

    change(ref1, (d: any) => {
      d.ownerId.set("user:carol")
    })

    expect(changes).toEqual([])
  })

  it("hasChangefeed(index) returns true", () => {
    const { index } = setup()
    expect(hasChangefeed(index)).toBe(true)
  })

  it("index.current returns the group map", () => {
    const { index } = setup()
    const current = index.current
    expect(current).toBeInstanceOf(Map)
    expect(current.has("user:alice")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Index.by with field (compound key)
// ---------------------------------------------------------------------------

describe("Index.by with field (compound key)", () => {
  it("groups by compound key with \\0 separator", () => {
    const [source, handle] = Source.create<any>()

    const ref1 = makeItemRef()
    change(ref1, (d: any) => {
      d.ownerId.set("alice")
      d.status.set("active")
      d.name.set("Item 1")
    })
    handle.set("item1", ref1)

    const coll = Collection.from(source)
    const index = by(
      coll,
      field(
        (r: any) => r.ownerId,
        (r: any) => r.status,
      ),
    )

    expect(index.groupKeysFor("item1")).toEqual(["alice\0active"])
    const group = index.get("alice\0active")
    expect(group.size).toBe(1)
    expect(group.has("item1")).toBe(true)
  })

  it("mutating one field of compound key regroups", () => {
    const [source, handle] = Source.create<any>()

    const ref1 = makeItemRef()
    change(ref1, (d: any) => {
      d.ownerId.set("alice")
      d.status.set("active")
      d.name.set("Item 1")
    })
    handle.set("item1", ref1)

    const coll = Collection.from(source)
    const index = by(
      coll,
      field(
        (r: any) => r.ownerId,
        (r: any) => r.status,
      ),
    )

    const changes: IndexChange[] = []
    index.subscribe(cs => {
      changes.push(...cs.changes)
    })

    change(ref1, (d: any) => {
      d.status.set("archived")
    })

    expect(changes).toEqual([
      { type: "group-removed", groupKey: "alice\0active", entryKey: "item1" },
      { type: "group-added", groupKey: "alice\0archived", entryKey: "item1" },
    ])
  })
})

// ---------------------------------------------------------------------------
// Index.by with keys (record fan-out)
// ---------------------------------------------------------------------------

describe("Index.by with keys (record fan-out)", () => {
  function setup() {
    const [source, handle] = Source.create<any>()

    const ref1 = makeTaggedRef()
    change(ref1, (d: any) => {
      d.tags.set("tag1", { label: "Tag 1" })
      d.tags.set("tag2", { label: "Tag 2" })
    })
    handle.set("entry1", ref1)

    const coll = Collection.from(source)
    const index = by(
      coll,
      keys((ref: any) => ref.tags),
    )

    return { source, handle, ref1, coll, index }
  }

  it("entry fans out to all tag groups", () => {
    const { index } = setup()
    const tag1 = index.get("tag1")
    const tag2 = index.get("tag2")
    expect(tag1.size).toBe(1)
    expect(tag1.has("entry1")).toBe(true)
    expect(tag2.size).toBe(1)
    expect(tag2.has("entry1")).toBe(true)
  })

  it("adding a tag emits group-added", () => {
    const { ref1, index } = setup()

    const changes: IndexChange[] = []
    index.subscribe(cs => {
      changes.push(...cs.changes)
    })

    change(ref1, (d: any) => {
      d.tags.set("tag3", { label: "Tag 3" })
    })

    const addedChanges = changes.filter(c => c.type === "group-added")
    expect(addedChanges).toEqual([
      { type: "group-added", groupKey: "tag3", entryKey: "entry1" },
    ])
  })

  it("removing a tag emits group-removed", () => {
    const { ref1, index } = setup()

    const changes: IndexChange[] = []
    index.subscribe(cs => {
      changes.push(...cs.changes)
    })

    change(ref1, (d: any) => {
      d.tags.delete("tag1")
    })

    const removedChanges = changes.filter(c => c.type === "group-removed")
    expect(removedChanges).toEqual([
      { type: "group-removed", groupKey: "tag1", entryKey: "entry1" },
    ])
  })

  it("adding an entry fans out to all its tag groups", () => {
    const { handle, index } = setup()

    const changes: IndexChange[] = []
    index.subscribe(cs => {
      changes.push(...cs.changes)
    })

    const ref2 = makeTaggedRef()
    change(ref2, (d: any) => {
      d.tags.set("tag2", { label: "Also Tag 2" })
      d.tags.set("tag4", { label: "Tag 4" })
    })
    handle.set("entry2", ref2)

    const addedChanges = changes
      .filter(c => c.type === "group-added")
      .sort((a, b) => a.groupKey.localeCompare(b.groupKey))
    expect(addedChanges).toEqual([
      { type: "group-added", groupKey: "tag2", entryKey: "entry2" },
      { type: "group-added", groupKey: "tag4", entryKey: "entry2" },
    ])

    expect(index.get("tag2").size).toBe(2)
  })

  it("removing an entry removes from all groups", () => {
    const { handle, index } = setup()

    const changes: IndexChange[] = []
    index.subscribe(cs => {
      changes.push(...cs.changes)
    })

    handle.delete("entry1")

    const removedChanges = changes
      .filter(c => c.type === "group-removed")
      .sort((a, b) => a.groupKey.localeCompare(b.groupKey))
    expect(removedChanges).toEqual([
      { type: "group-removed", groupKey: "tag1", entryKey: "entry1" },
      { type: "group-removed", groupKey: "tag2", entryKey: "entry1" },
    ])
  })

  it("dispose tears down subscriptions", () => {
    const { ref1, index } = setup()

    const changes: IndexChange[] = []
    index.subscribe(cs => {
      changes.push(...cs.changes)
    })

    index.dispose()

    change(ref1, (d: any) => {
      d.tags.set("tag99", { label: "Nope" })
    })

    expect(changes).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Index.by (identity — no keySpec)
// ---------------------------------------------------------------------------

describe("Index.by (identity — no keySpec)", () => {
  function setup() {
    const [source, handle] = Source.create<any>()

    const ref1 = makeSimpleRef()
    change(ref1, (d: any) => {
      d.title.set("First")
    })
    handle.set("item1", ref1)

    const ref2 = makeSimpleRef()
    change(ref2, (d: any) => {
      d.title.set("Second")
    })
    handle.set("item2", ref2)

    const coll = Collection.from(source)
    const index = by(coll)

    return { source, handle, ref1, ref2, coll, index }
  }

  it("each entry has its own group (key = group key)", () => {
    const { index } = setup()
    expect(index.keys().sort()).toEqual(["item1", "item2"])
    expect(index.size).toBe(2)
  })

  it("get(key) returns a reactive map with exactly that entry", () => {
    const { ref1, index } = setup()
    const group = index.get("item1")
    expect(group.size).toBe(1)
    expect(group.get("item1")).toBe(ref1)
  })

  it("adding an entry emits group-added", () => {
    const { handle, index } = setup()

    const changes: IndexChange[] = []
    index.subscribe(cs => {
      changes.push(...cs.changes)
    })

    const ref3 = makeSimpleRef()
    change(ref3, (d: any) => {
      d.title.set("Third")
    })
    handle.set("item3", ref3)

    expect(changes).toEqual([
      { type: "group-added", groupKey: "item3", entryKey: "item3" },
    ])
  })

  it("removing an entry emits group-removed", () => {
    const { handle, index } = setup()

    const changes: IndexChange[] = []
    index.subscribe(cs => {
      changes.push(...cs.changes)
    })

    handle.delete("item1")

    expect(changes).toEqual([
      { type: "group-removed", groupKey: "item1", entryKey: "item1" },
    ])
  })

  it("dispose tears down subscriptions", () => {
    const { handle, index } = setup()

    const changes: IndexChange[] = []
    index.subscribe(cs => {
      changes.push(...cs.changes)
    })

    index.dispose()

    const ref3 = makeSimpleRef()
    handle.set("item3", ref3)

    expect(changes).toEqual([])
  })
})
